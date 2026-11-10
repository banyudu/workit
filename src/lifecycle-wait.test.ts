import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, checkpoint, createJob, tick, workflowState,
  type Deployment, type Job, type LifecycleAdapter, type PRSnapshot, type Session } from "./lifecycle.js";
import { waitForJob } from "./lifecycle-wait.js";
import { managedInstructions } from "./lifecycle-cli.js";

const start = new Date("2026-01-02T00:00:00Z");
const body = "## Acceptance Criteria\n- [ ] `[test:behavior]` The target journey passes.\n- [ ] `[code:contract]` The contract is documented.";
const issue = { backend: "github" as const, identifier: "7", number: 7, title: "Fix widget", body,
  labels: [], url: "https://github.com/example/project/issues/7" };
const pending: PRSnapshot = { fingerprint: "pending", ready: false, merged: false, headSha: "c".repeat(40), checks: "pending",
  pendingChecks: [{ name: "build" }] };
const failing: PRSnapshot = { fingerprint: "failing", ready: false, merged: false, headSha: "c".repeat(40), checks: "fail",
  failingChecks: [{ name: "lint" }] };

class FakeAdapter implements LifecycleAdapter {
  current: Session; wakes: string[] = []; reviews = 0; snapshot = pending; deploy?: Deployment;
  constructor(job: Job) { this.current = { id: job.sessionID, status: "idle" }; }
  async session() { return this.current; }
  async project(job: Job) {
    this.current.workflow = { owner: "workit", jobID: job.id, revision: job.revision,
      state: workflowState(job.stage), wake: this.current.workflow?.wake };
  }
  async wake(_job: Job, wakeID: string) {
    this.wakes.push(wakeID);
    this.current.workflow!.wake = { id: wakeID, status: "delivered" };
  }
  async pr() { return this.snapshot; }
  async deployment() { return this.deploy; }
  async containsMerge() { return true; }
  async markInReview() { this.reviews++; }
  async markDone() { return true; }
}

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "workit-wait-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  const job = createJob({ issue, repoRoot: directory, worktree: join(directory, "tree"), githubRepo: "example/project",
    agent: "claude", config: { intervalSeconds: 60, deploymentProbe: ["probe"] }, now: start });
  store.insert(job);
  checkpoint(store, job.id, { stage: "waiting-ci", detail: "CI pending", pr: "https://github.com/example/project/pull/9" }, start);
  const adapter = new FakeAdapter(job);
  let clock = start.getTime();
  const now = () => new Date(clock);
  const live = new Set(["agent:1", "heartbeat:1"]);
  const alive = (identity: string) => live.has(identity);
  const heartbeat = () => tick(store, adapter, { now: now(), process: "heartbeat:1", alive });
  let onSleep: () => Promise<void> = async () => {};
  const wait = (timeoutSeconds = 600) => waitForJob(store, adapter, job.id, { timeoutSeconds, intervalSeconds: 60,
    now, process: "agent:1", alive, sleep: async ms => { clock += ms; await onSleep(); } });
  return { store, job, adapter, now, live, alive, heartbeat, wait, setOnSleep: (fn: () => Promise<void>) => { onSleep = fn; } };
}

test("job wait returns the next action to a busy agent without typing into its terminal", async t => {
  const { store, job, adapter, wait } = fixture(t);
  adapter.current.status = "executing";
  adapter.snapshot = failing;
  const result = await wait();
  assert.equal(result.outcome, "action");
  assert.match(result.text, /Workit update for 7: PR has failing checks/);
  assert.match(result.text, /Fix failing checks: lint/);
  assert.deepEqual(adapter.wakes, []);
  const saved = store.get(job.id);
  assert.equal(saved.waiter, undefined);
  assert.equal(saved.wakeups, 1);
  assert.equal(saved.wake, undefined);
});

test("the heartbeat leaves a waited job alone until the wait reports the merge", async t => {
  const { store, job, adapter, heartbeat, wait, setOnSleep } = fixture(t);
  const heartbeatResults: string[] = [];
  setOnSleep(async () => {
    heartbeatResults.push(...(await heartbeat()).map(item => item.result));
    adapter.snapshot = { fingerprint: "merged", ready: false, merged: true, mergeSha: "a".repeat(40) };
  });
  const result = await wait();
  assert.equal(result.outcome, "action");
  assert.match(result.text, /PR merged\. Continue post-merge verification\./);
  assert.deepEqual(heartbeatResults, ["agent-waiting"]);
  assert.deepEqual(adapter.wakes, []);
  assert.equal(adapter.reviews, 1);
  assert.equal(store.get(job.id).stage, "waiting-deploy");
  assert.equal(store.get(job.id).waiter, undefined);
});

test("job wait times out with a still-waiting summary and hands the job back to the heartbeat", async t => {
  const { store, job, adapter, heartbeat, wait, now } = fixture(t);
  const result = await wait(150);
  assert.equal(result.outcome, "timeout");
  assert.match(result.text, /7 is still waiting-ci: waiting for 1 pending checks\. Run `workit job wait .+` again/);
  assert.equal(store.get(job.id).waiter, undefined);
  adapter.snapshot = failing;
  // Due again after the wait's last check: the heartbeat resumes ownership.
  store.update(job.id, current => { current.nextWakeAt = now().toISOString(); }, now());
  assert.deepEqual((await heartbeat()).map(item => item.result), ["woken"]);
});

test("job wait exits when the job leaves its external wait", async t => {
  const { store, job, wait, setOnSleep, now } = fixture(t);
  setOnSleep(async () => { checkpoint(store, job.id, { stage: "paused", detail: "Owner hold" }, now()); });
  const result = await wait();
  assert.equal(result.outcome, "changed");
  assert.match(result.text, /the job is now paused\. Owner hold/);
});

test("job wait refuses outside external waits and while another live wait owns the job", async t => {
  const { store, job, adapter, alive, live, heartbeat, now } = fixture(t);
  const other = (process: string) => waitForJob(store, adapter, job.id, { now, process, alive, sleep: async () => {} });
  store.update(job.id, current => { current.waiter = { process: "agent:1", until: new Date(now().getTime() + 600_000).toISOString() }; }, now());
  live.add("agent:2");
  await assert.rejects(other("agent:2"), /Another job wait already owns/);
  // A crashed waiter no longer blocks the heartbeat.
  live.delete("agent:1");
  assert.notDeepEqual((await heartbeat()).map(item => item.result), ["agent-waiting"]);
  checkpoint(store, job.id, { stage: "implementing", detail: "Back to work" }, now());
  await assert.rejects(other("agent:2"), /job wait applies to waiting-ci\/waiting-deploy/);
});

test("managed instructions tell the agent to wait with job wait", t => {
  const { job } = fixture(t);
  const guidance = managedInstructions(job).join("\n");
  assert.match(guidance, new RegExp(`checkpoint waiting-ci, then run \`workit job wait ${job.id}\``));
  assert.match(guidance, /exit status 2 means still waiting/);
  assert.doesNotMatch(guidance, /checkpoint waiting-ci and end the turn/);
});
