import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, JobStore, tick, type Job, type LifecycleAdapter } from "./lifecycle.js";
import { heldRefreshBudget } from "./lifecycle-schedule.js";

const now = new Date("2026-01-02T00:05:00Z");
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "workit-schedule-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  function add(id: string, stage: Job["stage"], due = "2026-01-02T00:04:00Z") {
    const job = createJob({ issue: { backend: "github", identifier: id, title: id,
      body: "## Acceptance Criteria\n- [ ] `[test:schedule]` Continue due work.\n- [ ] `[test:holds]` Preserve owner holds.", labels: [],
      url: "https://github.com/example/project/issues/1" }, repoRoot: directory,
      worktree: directory, githubRepo: "example/project", agent: "fixture",
      config: { verification: "local", intervalSeconds: 60 }, now: new Date("2026-01-02T00:00:00Z") });
    Object.assign(job, { id, sessionID: id, stage, pr: "https://github.com/example/project/pull/1", nextWakeAt: due });
    if (stage === "paused" || stage === "needs-you") delete job.nextWakeAt;
    store.insert(job);
    return job;
  }
  const wakes: string[] = [];
  const reads: string[] = [];
  const adapter: LifecycleAdapter = {
    session: async job => ({ id: job.sessionID, status: "idle" }),
    project: async () => {},
    wake: async job => { wakes.push(job.id); },
    pr: async job => { reads.push(job.id); return { ready: true, merged: false, fingerprint: job.id }; },
    deployment: async () => undefined,
    containsMerge: async () => true,
    markInReview: async () => {},
    markDone: async () => false,
  };
  const run = (at = now) => tick(store, adapter, { now: at, process: "fixture", alive: () => true });
  return { store, add, adapter, wakes, reads, run };
}

test("due PRs wake oldest first before a slow held-job probe, without waking future jobs", async t => {
  const f = fixture(t);
  f.add("a-held", "paused");
  f.add("b-future", "waiting-ci", "2026-01-02T00:06:00Z");
  f.add("y-newer", "waiting-ci");
  f.add("z-oldest", "waiting-ci", "2026-01-02T00:03:00Z");
  let release!: () => void;
  const slowProbe = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredProbe = new Promise<void>(resolve => { entered = resolve; });
  const read = f.adapter.pr;
  f.adapter.pr = async job => {
    if (job.stage === "paused") { entered(); await slowProbe; }
    return read(job);
  };
  const running = f.run();
  await enteredProbe;
  try {
    assert.deepEqual(f.wakes, ["z-oldest", "y-newer"]);
    assert.equal(f.store.get("b-future").wakeups, 0);
  } finally { release(); await running; }
  assert.equal(f.store.get("a-held").stage, "paused");
});

test("held maintenance is bounded and rotates to previously unobserved jobs on the next tick", async t => {
  const f = fixture(t);
  for (let i = 0; i < 14; i++) f.add(`held-${String(i).padStart(2, "0")}`, i % 2 ? "needs-you" : "paused");
  await f.run();
  assert.equal(f.reads.length, 10);
  assert.deepEqual(f.wakes, []);
  f.reads.length = 0;
  await f.run(new Date(now.getTime() + 60_000));
  assert.equal(f.reads.length, 10);
  assert.deepEqual(f.reads.slice(0, 4), ["held-10", "held-11", "held-12", "held-13"]);
  assert.ok(f.store.list().every(job => job.facts?.observedAt));
  assert.ok(f.store.list().every(job => ["paused", "needs-you"].includes(job.stage)));
});

test("maintenance stops starting probes after its time budget and cached facts consume no budget", t => {
  const f = fixture(t);
  const held = f.add("held", "paused");
  let elapsed = 0;
  const refresh = heldRefreshBudget(() => elapsed);
  const cached = { ...held, facts: { observedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + 60_000).toISOString() } };
  for (let i = 0; i < 20; i++) assert.equal(refresh(cached, now), false);
  assert.equal(refresh(held, now), true);
  elapsed = 30_000;
  assert.equal(refresh(held, now), false);
});
