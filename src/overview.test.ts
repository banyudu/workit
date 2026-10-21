import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, JobStore, type Stage } from "./lifecycle.js";
import { overview } from "./overview.js";

function job() {
  return createJob({ issue: { backend: "github", identifier: "1", title: "A durable task", labels: [],
    url: "https://github.com/example/project/issues/1", body: "## Acceptance Criteria\n- [ ] `[test:one]` One\n- [ ] `[test:two]` Two" },
    repoRoot: "/fixture", worktree: "/fixture/tree", githubRepo: "example/project", agent: "fixture", acceptance: "local" });
}

test("overview retains jobs without conversations, bounds output and omits executable/private state", () => {
  const jobs = (["implementing", "waiting-ci", "needs-you", "paused", "verified", "cancelled"] as Stage[]).map((stage, index) => ({ ...job(), stage, id: String(index) }));
  jobs[0].controlCommand = ["private-command"];
  jobs[0].detail = "token=fixture-secret /private/work/tree";
  const view = overview(jobs);
  assert.equal(view.jobs.length, 6);
  assert.deepEqual(new Set(view.jobs.map(item => item.group)), new Set(["working", "waiting", "needs-you", "paused", "verified", "cancelled"]));
  assert.doesNotMatch(JSON.stringify(view), /private-command|fixture-secret|private\/work/);
  assert.equal(overview(jobs, 2).truncated, true);
  assert.equal(overview(jobs, 2).total, 6);
  assert.throws(() => overview(jobs, 1001));
  delete jobs[0].lastProgressAt;
  assert.equal(overview([jobs[0]]).jobs[0].lastProgressAt, undefined);
});

test("heartbeat bookkeeping never appears as meaningful progress; checkpoints do", t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-overview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JobStore(directory); const original = job(); store.insert(original);
  const later = new Date(Date.now() + 60_000);
  store.update(original.id, current => { current.claim = { token: "fixture", process: "fixture" }; current.nextWakeAt = later.toISOString(); }, later);
  assert.equal(store.get(original.id).lastProgressAt, original.lastProgressAt);
  store.update(original.id, current => { current.detail = "Implementation ready for review"; current.stage = "reviewing"; }, later);
  assert.equal(store.get(original.id).lastProgressAt, later.toISOString());
});
