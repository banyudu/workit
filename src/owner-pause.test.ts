import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, createJob, tick } from "./lifecycle.js";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";

test("owner-pause-contract: exact argv guards revision/session, returns projection status and retains uncertain wake audit", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-pause-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctl = join(directory, "banyanctl");
  writeFileSync(ctl, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true}));\n', { mode: 0o700 });
  const store = new JobStore(directory);
  const job = createJob({ issue: { backend: "github", identifier: "23", title: "CLI contract", labels: [],
    url: "https://github.com/example/project/issues/23",
    body: "## Acceptance Criteria\n- [ ] `[test:pause]` Pause persists.\n- [ ] `[code:contract]` Contract exists." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
    config: { verification: "local" } });
  job.wake = { id: "uncertain-wake", reason: "unfinished work", revision: 0, counted: false };
  store.insert(job);
  const run = (revision: string, sessionID: string) => JSON.parse(execFileSync(process.execPath,
    ["--import", "tsx", "src/cli.ts", "job", "pause", job.id, "--detail", "Owner requested a hold",
      "--expected-revision", revision, "--expected-session-id", sessionID],
    { encoding: "utf8", env: { ...process.env, WORKIT_STATE_DIR: directory, WORKIT_BANYANCTL: ctl }, stdio: ["ignore", "pipe", "pipe"] }));
  for (const [revision, sessionID] of [["1", job.sessionID], ["0", "different-session"], ["NaN", job.sessionID]]) {
    assert.throws(() => run(revision, sessionID));
    assert.deepEqual(store.get(job.id), job);
  }
  const paused = run("0", job.sessionID);
  assert.equal(paused.stage, "paused");
  assert.equal(paused.nextWakeAt, undefined);
  assert.deepEqual(paused.wake, job.wake);
  assert.deepEqual(paused.issue, job.issue);
  assert.equal(paused.acHash, job.acHash);
  assert.deepEqual(paused.projection, { status: "confirmed", sessionID: job.sessionID, revision: 1 });
  assert.throws(() => run("0", job.sessionID));
  // A control outage cannot undo the durable pause or pretend Banyan observed it.
  writeFileSync(ctl, '#!/usr/bin/env node\nprocess.exit(69);\n', { mode: 0o700 });
  const pending = run("1", job.sessionID);
  assert.equal(pending.stage, "paused");
  assert.equal(pending.projection.status, "pending");
  assert.equal(store.get(job.id).projectedRevision, 1);
  assert.equal(store.get(job.id).revision, 2);
  await tick(store, new BanyanLifecycleAdapter(ctl));
  assert.equal(store.get(job.id).nextWakeAt, undefined);
  assert.deepEqual(store.get(job.id).wake, job.wake);
  // Optional guards preserve the original caller contract.
  const legacy = JSON.parse(execFileSync(process.execPath,
    ["--import", "tsx", "src/cli.ts", "job", "pause", job.id, "--detail", "Keep held"],
    { encoding: "utf8", env: { ...process.env, WORKIT_STATE_DIR: directory, WORKIT_BANYANCTL: ctl }, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(legacy.stage, "paused");
});
