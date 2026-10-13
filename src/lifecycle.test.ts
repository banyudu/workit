import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, WorkflowRefusedError, acceptance, checkpoint, createJob, tick, validateReport, workflowState,
  type Deployment, type Job, type LifecycleAdapter, type PRSnapshot, type Session, type VerificationReport } from "./lifecycle.js";
import { heartbeatPlist } from "./heartbeat.js";

const now = new Date("2026-01-02T00:00:00Z");
const mergeSha = "a".repeat(40), deployedSha = "b".repeat(40);
const body = "## Acceptance Criteria\n- [ ] `[test:behavior]` The target journey passes.\n- [ ] `[code:contract]` The contract is documented.";
const issue = { backend: "github" as const, identifier: "7", number: 7, title: "Fix widget", body,
  labels: [], url: "https://github.com/example/project/issues/7" };
const deployment: Deployment = { environment: "dev", target: "widget", sourceSha: deployedSha, version: "version-1" };

function fixture(t: { after: (fn: () => void) => void }, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), "workit-lifecycle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  const job = createJob({ issue, repoRoot: directory, worktree: join(directory, "tree"),
    githubRepo: "example/project", agent: "codex", config: { deploymentProbe: ["probe"], ...config }, now });
  store.insert(job);
  const adapter = new FakeAdapter(job);
  const run = (at = new Date(now.getTime() + 60_000)) => tick(store, adapter, { now: at, process: "test:owner", alive: () => true });
  return { directory, store, job, adapter, run };
}
class FakeAdapter implements LifecycleAdapter {
  current: Session; wakes: string[] = []; projections = 0; deploy?: Deployment;
  snapshot: PRSnapshot = { fingerprint: "pending", ready: false, merged: false };
  contains = true; failSession = false; loseResponse = false;
  constructor(job: Job) { this.current = { id: job.sessionID, status: "idle" }; }
  async session() { if (this.failSession) throw new Error("offline"); return this.current; }
  async project(job: Job) {
    this.projections++;
    this.current.workflow = { owner: "workit", jobID: job.id, revision: job.revision,
      state: workflowState(job.stage), wake: this.current.workflow?.wake };
  }
  async wake(_job: Job, wakeID: string) {
    if (this.current.workflow?.wake?.id !== wakeID) this.wakes.push(wakeID);
    this.current.workflow!.wake = { id: wakeID, status: "delivered" };
    if (this.loseResponse) throw new Error("lost response");
  }
  async pr() { return this.snapshot; }
  async deployment() { return this.deploy; }
  async containsMerge() { return this.contains; }
}

test("job identity is repository-scoped, checkpoints persist across restart, and checked boxes preserve AC binding", t => {
  const { directory, store, job } = fixture(t);
  const another = createJob({ issue, repoRoot: directory + "-other", worktree: "/tmp/tree", githubRepo: "example/project",
    agent: "claude", config: { verification: "local" }, now });
  assert.notEqual(another.id, job.id);
  checkpoint(store, job.id, { stage: "reviewing", detail: "PR ready" }, now);
  assert.equal(new JobStore(directory).get(job.id).stage, "reviewing");
  assert.deepEqual(acceptance(body.replace("[ ]", "[x]")), acceptance(body));
  assert.throws(() => checkpoint(store, job.id, { stage: "verified", detail: "exit 0" }), /verification report/);
  assert.throws(() => createJob({ issue, repoRoot: directory, worktree: "/tmp/tree", githubRepo: "example/project",
    agent: "claude", now }), /deploymentProbe before launch/);
});

test("unchanged CI consumes no agent turn; a changed review wakes the original session", async t => {
  const { store, job, adapter, run } = fixture(t);
  checkpoint(store, job.id, { stage: "waiting-ci", detail: "CI pending", pr: "https://github.com/example/project/pull/9" }, now);
  await run();
  assert.equal(adapter.wakes.length, 0);
  adapter.snapshot.fingerprint = "review-added";
  await run(new Date(now.getTime() + 120_000));
  assert.equal(adapter.wakes.length, 1);
  assert.equal(store.get(job.id).sessionID, job.sessionID);
});

test("merged source waits for an actual containing deployment before verification", async t => {
  const { store, job, adapter, run } = fixture(t);
  checkpoint(store, job.id, { stage: "waiting-deploy", detail: "Waiting", pr: "https://github.com/example/project/pull/9", mergeSha }, now);
  adapter.snapshot = { merged: true, mergeSha, ready: true, fingerprint: "merged" };
  await run();
  assert.equal(adapter.wakes.length, 0);
  adapter.deploy = deployment;
  await run(new Date(now.getTime() + 120_000));
  assert.equal(adapter.wakes.length, 1);
  assert.equal(store.get(job.id).stage, "verifying");
  assert.deepEqual(store.get(job.id).deployment, deployment);
});

test("wrong deployment ancestry never wakes a verifier", async t => {
  const { store, job, adapter, run } = fixture(t);
  checkpoint(store, job.id, { stage: "waiting-deploy", detail: "Waiting", pr: "https://github.com/example/project/pull/9", mergeSha }, now);
  adapter.snapshot = { merged: true, mergeSha, ready: true, fingerprint: "merged" };
  adapter.deploy = deployment; adapter.contains = false;
  await run();
  assert.equal(adapter.wakes.length, 0);
  assert.equal(store.get(job.id).stage, "waiting-deploy");
  assert.match(store.get(job.id).detail, /does not contain/);
});

test("competing ticks claim the same job only once", async t => {
  const { store, job, adapter } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.session = async () => { await gate; return adapter.current; };
  const at = new Date(now.getTime() + 60_000);
  const first = tick(store, adapter, { now: at, process: "first", alive: () => true });
  const second = tick(store, adapter, { now: at, process: "second", alive: () => true });
  release(); await Promise.all([first, second]);
  assert.equal(adapter.wakes.length, 1);
  assert.equal(store.get(job.id).claim, undefined);
});

test("a lost delivery response reconciles the persisted receipt without replay", async t => {
  const { store, job, adapter, run } = fixture(t);
  adapter.loseResponse = true;
  await run();
  assert.ok(store.get(job.id).wake);
  adapter.loseResponse = false;
  await run(new Date(now.getTime() + 120_000));
  assert.equal(adapter.wakes.length, 1);
  assert.equal(store.get(job.id).wake, undefined);
});

test("crashed claim recovery preserves the original wake identity", async t => {
  const { store, job, adapter } = fixture(t);
  const saved = store.update(job.id, current => {
    current.claim = { process: "dead", token: "crashed" };
    current.wake = { id: "one-wake", revision: current.revision, reason: "Resume verification" };
  }, now);
  adapter.current.workflow = { owner: "workit", jobID: job.id, revision: saved.revision,
    state: "working", wake: { id: "one-wake", status: "delivered" } };
  await tick(store, adapter, { now: new Date(now.getTime() + 60_000), process: "new", alive: () => false });
  assert.equal(adapter.wakes.length, 0);
  assert.equal(store.get(job.id).wake, undefined);
});

test("uncertain delivery becomes a human gate instead of replaying", async t => {
  const { store, job, adapter, run } = fixture(t);
  store.update(job.id, current => { current.wake = { id: "uncertain", revision: 0, reason: "resume" }; }, now);
  adapter.current.workflow = { owner: "workit", jobID: job.id, revision: 0, state: "working",
    wake: { id: "uncertain", status: "pending" } };
  await run();
  assert.equal(adapter.wakes.length, 0);
  assert.equal(store.get(job.id).stage, "needs-you");
});

test("a proven pre-delivery refusal retries the same persisted wake", async t => {
  const { store, job, adapter, run } = fixture(t);
  store.update(job.id, current => { current.wake = { id: "retry-safe", revision: 0, reason: "resume" }; }, now);
  adapter.current.workflow = { owner: "workit", jobID: job.id, revision: 0, state: "working",
    wake: { id: "retry-safe", status: "not-delivered" } };
  const ids: string[] = [];
  adapter.wake = async (_job, id) => { ids.push(id); };
  await run();
  assert.deepEqual(ids, ["retry-safe"]);
  assert.equal(store.get(job.id).wake, undefined);
  assert.notEqual(store.get(job.id).stage, "needs-you");
});

test("workflow_refused keeps a changed-review wake runnable without spending either budget", async t => {
  for (const operation of ["project", "wake"] as const) {
    const { store, job, adapter, run } = fixture(t, { intervalSeconds: 17, maxErrors: 2, maxWakeups: 1 });
    checkpoint(store, job.id, { stage: "waiting-ci", detail: "CI pending", pr: "https://github.com/example/project/pull/9" }, now);
    await run();
    adapter.snapshot.fingerprint = "review-added";
    const original = { project: adapter.project, wake: adapter.wake };
    const attempts: string[] = [];
    const message = operation === "project" ? "stale workflow revision" : "agent is busy, unobserved, or awaiting human input";
    adapter[operation] = async current => {
      if (current.wake) attempts.push(current.wake.id);
      throw new WorkflowRefusedError(message);
    };
    let wakeID: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const at = new Date(store.get(job.id).nextWakeAt!);
      const result = await run(at);
      const current = store.get(job.id);
      assert.equal(current.stage, "waiting-ci");
      assert.equal(current.errors, 0);
      assert.equal(current.wakeups, 0);
      assert.equal(current.detail, message);
      assert.equal(current.claim, undefined);
      assert.equal(current.nextWakeAt, new Date(at.getTime() + 17_000).toISOString());
      assert.ok(current.wake);
      wakeID ??= current.wake.id;
      assert.equal(current.wake.id, wakeID);
      assert.equal(current.wake.reason, "PR checks or reviews changed");
      assert.deepEqual(result, [{ id: job.id, result: "workflow-refused", detail: message }]);
    }
    assert.ok(attempts.every(id => id === wakeID));
    assert.equal(adapter.wakes.length, 0);
    Object.assign(adapter, original);
    await run(new Date(store.get(job.id).nextWakeAt!));
    assert.deepEqual(adapter.wakes, [wakeID]);
    assert.equal(store.get(job.id).wakeups, 1);
    assert.equal(store.get(job.id).wake, undefined);
    adapter.snapshot.ready = true;
    await run(new Date(store.get(job.id).nextWakeAt!));
    assert.equal(store.get(job.id).stage, "needs-you");
    assert.equal(adapter.wakes.length, 1);
  }
});

test("a lost delivery response charges the wakeup budget exactly once when reconciled", async t => {
  const { store, job, adapter, run } = fixture(t, { maxWakeups: 1 });
  adapter.loseResponse = true;
  await run();
  assert.equal(store.get(job.id).wakeups, 0);
  assert.ok(store.get(job.id).wake);
  await run(new Date(store.get(job.id).nextWakeAt!));
  assert.equal(store.get(job.id).wakeups, 1);
  assert.equal(store.get(job.id).errors, 0);
  assert.equal(store.get(job.id).wake, undefined);
  assert.equal(adapter.wakes.length, 1);
});

test("legacy pending wakes retain their previously charged budget on retry or reconciliation", async t => {
  for (const delivered of [false, true]) {
    const { store, job, adapter, run } = fixture(t, { maxWakeups: 1 });
    store.update(job.id, current => {
      current.wakeups = 1;
      current.wake = { id: "legacy-wake", revision: 0, reason: "resume" };
    }, now);
    if (delivered) adapter.current.workflow = { owner: "workit", jobID: job.id, revision: 0, state: "working",
      wake: { id: "legacy-wake", status: "delivered" } };
    await run();
    assert.equal(store.get(job.id).wakeups, 1);
    assert.equal(store.get(job.id).wake, undefined);
    assert.equal(store.get(job.id).stage, "implementing");
  }
});

test("busy, human-prompt, parked, frozen and closed sessions never receive wake input", async t => {
  for (const state of [{ status: "executing" }, { status: "need-input" }, { status: "asking" },
    { status: "closed" }, { status: "idle", isSuspended: true }, { status: "idle", isFrozen: true },
    { status: "idle", isDeepSuspended: true }]) {
    const { adapter, run } = fixture(t);
    Object.assign(adapter.current, state); await run();
    assert.equal(adapter.wakes.length, 0, JSON.stringify(state));
  }
});

test("paused, cancelled and human-blocked jobs stop waking; settled projections stop polling", async t => {
  for (const stage of ["paused", "cancelled", "needs-you"] as const) {
    const { store, job, adapter, run } = fixture(t);
    checkpoint(store, job.id, { stage, detail: "Hold" }, now);
    await run(); const count = adapter.projections; await run();
    assert.equal(adapter.wakes.length, 0);
    assert.equal(adapter.projections, count);
    assert.throws(() => checkpoint(store, job.id, { stage: "implementing", detail: "Ignore hold" }), /resume|Finished/);
  }
});

test("transient errors back off and become visible after a bounded number of retries", async t => {
  const { store, job, adapter } = fixture(t, { maxErrors: 3 });
  adapter.failSession = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = store.get(job.id).nextWakeAt!;
    await tick(store, adapter, { now: new Date(next), process: "owner", alive: () => true });
  }
  assert.equal(store.get(job.id).stage, "needs-you");
  assert.equal(store.get(job.id).nextWakeAt, undefined);
});

test("real wake failures still back off and park at maxErrors", async t => {
  for (const message of ["timed out", "did not return JSON", "server unavailable", "server returned HTTP 503"]) {
    const { store, job, adapter, run } = fixture(t, { intervalSeconds: 17, maxErrors: 3, maxWakeups: 1 });
    const ids: string[] = [];
    adapter.wake = async (_job, id) => { ids.push(id); throw new Error(message); };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const at = new Date(store.get(job.id).nextWakeAt!);
      await run(at);
      const current = store.get(job.id);
      assert.equal(current.errors, attempt);
      assert.equal(current.detail, message);
      assert.equal(current.stage, attempt < 3 ? "implementing" : "needs-you");
      assert.equal(current.nextWakeAt, attempt < 3 ? new Date(at.getTime() + 60_000 * 2 ** (attempt - 1)).toISOString() : undefined);
    }
    assert.equal(ids.length, 3);
    assert.ok(ids.every(id => id === ids[0]));
  }
});

function report(job: Job): VerificationReport {
  return { jobID: job.id, issueURL: job.issue.url, acHash: job.acHash, mergeSha, checkedAt: now.toISOString(),
    reviewer: { runID: "independent-review", independent: true }, deployment,
    criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [
      { kind: "journey", reference: "artifact://run-123", observed: "Expected behavior", deployment },
    ] })) };
}

test("completion rejects stale ACs, failed/missing evidence, unmerged source, self-review and wrong deployed version", t => {
  const { job } = fixture(t); job.mergeSha = mergeSha; job.deployment = deployment;
  const valid = report(job);
  assert.deepEqual(validateReport(job, valid, body, now), valid);
  for (const change of [
    (value: VerificationReport) => { value.criteria.pop(); },
    (value: VerificationReport) => { value.criteria[0].status = "fail"; },
    (value: VerificationReport) => { value.criteria[0].evidence = []; },
    (value: VerificationReport) => { value.reviewer.independent = false; },
    (value: VerificationReport) => { value.mergeSha = "c".repeat(40); },
    (value: VerificationReport) => { value.deployment!.version = "old"; },
    (value: VerificationReport) => { value.criteria[0].evidence[0].deployment!.version = "old"; value.criteria[1].evidence = []; },
  ]) {
    const invalid = structuredClone(valid); change(invalid);
    assert.throws(() => validateReport(job, invalid, body, now));
  }
  assert.throws(() => validateReport(job, valid, body + "\n- [ ] New AC", now), /stale/);
});

test("local-only acceptance is explicit and still needs complete independent AC evidence", t => {
  const { job } = fixture(t, { verification: "local" }); job.mergeSha = mergeSha;
  const valid = report(job); delete valid.deployment;
  valid.criteria.forEach(item => item.evidence.forEach(entry => { entry.kind = "test"; delete entry.deployment; }));
  validateReport(job, valid, body, now);
  const deployed = { ...job, config: { ...job.config, verification: "deployed" as const } };
  assert.throws(() => validateReport(deployed, valid, body, now), /journey/);
});

test("launchd uses pinned argv and XML escaping, and does not serialize credentials", () => {
  const plist = heartbeatPlist({ node: "/node", cli: "/some & path/cli.js", path: "/bin", logs: "/logs", state: "/state", interval: 60 });
  assert.match(plist, /some &amp; path/);
  assert.match(plist, /<integer>60<\/integer>/);
  assert.match(plist, /<string>tick<\/string>/);
  assert.doesNotMatch(plist, /API_KEY|TOKEN/);
  assert.throws(() => heartbeatPlist({ node: "", cli: "", path: "", logs: "", state: "", interval: 0 }));
});
