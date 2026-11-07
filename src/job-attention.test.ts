import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, JobStore } from "./lifecycle.js";
import { deliverJobAttention } from "./job-attention.js";

test("concurrent heartbeat observations deliver one notice and never release the hold", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-attention-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const at = new Date("2026-01-01T00:00:00Z");
  const job = createJob({ issue: { backend: "github", identifier: "1", title: "Private issue prose", labels: [],
    url: "https://github.com/example/project/issues/1",
    body: "## Acceptance Criteria\n- [ ] `[code:held]` Hold stays.\n- [ ] `[test:notice]` Notify once." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture", config: { verification: "local" }, now: at });
  const store = new JobStore(directory);
  job.stage = "needs-you"; job.holdDetail = "Inspect original session";
  job.attentionNotice = { id: "one-incident", createdAt: at.toISOString() };
  store.insert(job);
  let deliveries = 0;
  let finish!: () => void;
  const completion = new Promise<void>(resolve => { finish = resolve; });
  const adapter = { notifyAttention: async () => { deliveries++; await completion; } };
  const first = deliverJobAttention(store, adapter, job, at);
  await deliverJobAttention(store, adapter, store.get(job.id), at);
  assert.equal(deliveries, 1);
  finish(); await first;
  assert.ok(store.get(job.id).attentionNotice?.deliveredAt);
  await deliverJobAttention(new JobStore(directory), adapter, store.get(job.id), new Date(at.getTime() + 300_000));
  assert.equal(deliveries, 1);
  assert.equal(store.get(job.id).stage, "needs-you");
  assert.equal(store.get(job.id).holdDetail, "Inspect original session");
});
