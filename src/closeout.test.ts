import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, SourceProvenanceError, acceptance, checkpoint, createJob, tick, validateReport,
  assertLocalAcceptance, type Deployment, type Job, type LifecycleAdapter, type PRSnapshot, type Session, type VerifierPlan, type VerifierRun, type VerificationReport } from "./lifecycle.js";
import { attention, checkVerification, completeVerification, correctAcceptance, readableAttention, reconcileVerifier, verifierBinding } from "./closeout.js";

const at = new Date("2026-01-02T00:00:00Z");
const mergeSha = "a".repeat(40);
const body = "## Acceptance Criteria\n- [ ] `[test:cli]` The CLI command passes its isolated fixtures.\n- [ ] `[code:types]` The exported type contract is documented.";
const issue = { backend: "github" as const, identifier: "23", title: "CLI and types", body, labels: [], url: "https://github.com/example/project/issues/23" };
const deployment: Deployment = { environment: "fixture", target: "widget", sourceSha: "b".repeat(40), version: "serving-1" };
class Adapter implements LifecycleAdapter {
  wakes: string[] = []; launches: VerifierRun[] = []; sessions = 0; projections = 0; reads = 0;
  snapshot: PRSnapshot = { fingerprint: "merged", merged: true, mergeSha, ready: false };
  issue = { ...issue, state: "CLOSED" }; deploy: Deployment | undefined = deployment;
  plan: VerifierPlan = { enabled: true, agent: "fixture-review", command: "fixture-review", concurrency: 1, maxAttempts: 2, timeoutSeconds: 60 };
  async session(job: Job): Promise<Session> { this.sessions++; return { id: job.sessionID, status: "idle" }; }
  async project() { this.projections++; }
  async wake(_job: Job, id: string) { this.wakes.push(id); }
  async pr() { this.reads++; return this.snapshot; }
  async deployment() { return this.deploy; }
  async containsMerge() { return true; }
  async currentIssue() { return this.issue; }
  async verifierPlan() { return this.plan; }
  async launchVerifier(_job: Job, run: VerifierRun) { this.launches.push(run); }
}
function fixture(t: { after: (fn: () => void) => void }, profile: "local" | "deployed" = "local") {
  const directory = mkdtempSync(join(tmpdir(), "workit-closeout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  const job = createJob({ issue, repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture-implementer",
    acceptance: profile, config: { verification: "deployed", deploymentProbe: ["fixture-probe"] }, now: at });
  job.pr = "https://github.com/example/project/pull/42"; job.mergeSha = mergeSha; job.stage = "verifying";
  if (profile === "deployed") job.deployment = deployment;
  store.insert(job);
  const adapter = new Adapter();
  const run = (now = new Date(at.getTime() + 60_000)) => tick(store, adapter, { now, process: "fixture:owner", alive: () => true });
  return { directory, store, job, adapter, run };
}
function report(job: Job, runID = "independent-fixture"): VerificationReport {
  return { jobID: job.id, issueURL: job.issue.url, acHash: job.acHash, mergeSha, checkedAt: new Date(at.getTime() + 60_000).toISOString(),
    reviewer: { runID, independent: true }, criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [{ kind: "test", reference: "artifact://fixture", observed: "Contract passed" }] })) };
}
function handoff(run: VerifierRun, value: VerificationReport) {
  writeFileSync(run.reportPath, JSON.stringify(value)); writeFileSync(run.outcomePath, JSON.stringify({ status: "complete" }));
}

test("acceptance-profile-selection: explicit local launch overrides deployed defaults and audited correction accepts independent local evidence", async t => {
  const { store, job, adapter } = fixture(t);
  assert.equal(job.config.verification, "local");
  const checked = await checkVerification(adapter, job, report(job), new Date(at.getTime() + 60_000));
  assert.equal(completeVerification(store, job, checked.report).stage, "verified");
  const correctedFixture = fixture(t, "deployed");
  checkpoint(correctedFixture.store, correctedFixture.job.id, { stage: "needs-you", detail: "Wrong launch profile; owner hold" }, at);
  const previous = correctedFixture.store.get(correctedFixture.job.id);
  const corrected = correctAcceptance(correctedFixture.store, previous.id, { profile: "local", reason: "All current CLI/type ACs have isolated local probes",
    expectedRevision: previous.revision, expectedAcHash: previous.acHash }, issue, at);
  assert.equal(corrected.stage, "needs-you"); assert.equal(corrected.nextWakeAt, undefined);
  assert.equal(corrected.deployment, undefined); assert.equal(corrected.verification, undefined);
  assert.equal(corrected.acceptanceHistory?.length, 1);
  assert.equal(corrected.acceptanceHistory![0].from, "deployed");
  assert.match(corrected.acceptanceHistory![0].reason, /local probes/);
  assert.equal(corrected.holdDetail, previous.holdDetail);
  validateReport(corrected, report(corrected), body, new Date(at.getTime() + 60_000));
});

test("acceptance-scope-preserved: corrections reject deployed/human ACs, stale revision/hash and missing reasons without mutation", t => {
  const { store, job } = fixture(t, "deployed");
  const input = { profile: "local" as const, reason: "Local fixtures cover the ACs", expectedRevision: 0, expectedAcHash: job.acHash };
  for (const [changed, value] of [
    [issue, { ...input, expectedRevision: 99 }], [issue, { ...input, expectedAcHash: "stale" }], [issue, { ...input, reason: "" }],
    ...["`[deploy:runtime]` The serving version passes the deployed journey.", "`[human:approval]` Owner accepts the result.",
      "`[test:runtime]` The behavior passes.\n  Run this on the deployed environment."].map(line => {
      const changed = { ...issue, body: `## Acceptance Criteria\n- [ ] ${line}\n- [ ] \`[code:types]\` The type contract exists.` };
      return [changed, { ...input, expectedAcHash: acceptance(changed.body).acHash }];
    }),
  ] as Array<[typeof issue, typeof input]>) {
    assert.throws(() => correctAcceptance(store, job.id, value, changed, at));
    assert.deepEqual(store.get(job.id), job);
  }
  for (const change of [
    (value: VerificationReport) => { value.reviewer.runID = job.sessionID; },
    (value: VerificationReport) => { value.criteria.pop(); },
    (value: VerificationReport) => { value.criteria[0].evidence = []; },
  ]) {
    const value = report(job); change(value);
    assert.throws(() => validateReport({ ...job, config: { verification: "local" } }, value, body, new Date(at.getTime() + 60_000)));
  }
});

test("held-job-fact-refresh and authority-preserved: merge/conflict facts replace stale readiness while retaining owner holds and wake audit", async t => {
  for (const merged of [true, false]) {
    const { store, job, adapter, run } = fixture(t);
    const held = checkpoint(store, job.id, { stage: "needs-you", detail: "Awaiting permission to merge" }, at);
    store.update(job.id, current => {
      delete current.mergeSha;
      current.wake = { id: "uncertain-original-wake", reason: "continue", revision: held.revision };
      current.facts = { pr: { merged: false, ready: true, fingerprint: "old-green", headSha: "c".repeat(40) }, observedAt: at.toISOString(), nextCheckAt: at.toISOString() };
    }, at);
    adapter.snapshot = merged ? { fingerprint: "merged", merged: true, mergeSha, ready: false }
      : { fingerprint: "conflict", merged: false, ready: false, headSha: "d".repeat(40), mergeState: "DIRTY", checks: "pass" };
    const before = store.get(job.id);
    await run();
    const refreshed = store.get(job.id);
    assert.equal(refreshed.stage, "needs-you"); assert.equal(refreshed.nextWakeAt, undefined);
    assert.equal(refreshed.sessionID, job.sessionID); assert.deepEqual(refreshed.wake, before.wake);
    assert.equal(refreshed.holdDetail, "Awaiting permission to merge");
    assert.equal(refreshed.facts!.pr!.ready, false); assert.equal(adapter.sessions, 0);
    assert.equal(adapter.wakes.length, 0); assert.equal(adapter.launches.length, 0);
    const view = attention([refreshed]);
    assert.ok(view.items.some(item => item.reason === "owner-hold"));
    assert.ok(!view.items.some(item => item.nextAction.includes("merge only")));
    assert.equal(refreshed.mergeSha, merged ? mergeSha : undefined);
    assert.match(refreshed.detail, merged ? /PR is merged/ : /not currently ready/);
    assert.deepEqual(refreshed.issue, before.issue);
    await run(); assert.equal(adapter.reads, 1);
  }
});

test("blocker-grouping: configured shared provenance groups once without leaking dependency identity and separates owners/tools/waits", async t => {
  const { store, job, adapter, run } = fixture(t, "deployed");
  store.update(job.id, current => {
    current.stage = "waiting-deploy"; delete current.deployment;
    current.config.deploymentDependency = "private-service-key?token=fixture-secret";
  }, at);
  adapter.deployment = async () => { throw new SourceProvenanceError("Missing built source"); };
  await run();
  const blocked = store.get(job.id);
  const shared = { ...structuredClone(blocked), id: "second" };
  const unrelated = { ...structuredClone(blocked), id: "third", blocker: { ...blocked.blocker!, dependency: "different-opaque-dependency" } };
  const owner = { ...structuredClone(job), id: "owner", stage: "paused" as const };
  const waiting = { ...structuredClone(job), id: "waiting", stage: "waiting-deploy" as const, deployment: undefined, config: { verification: "deployed" as const } };
  const runner = { ...structuredClone(job), id: "runner", blocker: { ...blocked.blocker!, reason: "runner-error" as const, owner: "system" as const, dependency: undefined } };
  const view = attention([blocked, shared, unrelated, owner, waiting, runner]);
  assert.deepEqual(view.items.find(item => item.reason === "source-provenance")!.jobIDs, [job.id, "second"]);
  assert.equal(view.items.filter(item => item.reason === "source-provenance").length, 2);
  for (const reason of ["owner-hold", "external-wait", "runner-error"]) assert.ok(view.items.some(item => item.reason === reason));
  assert.ok(view.items.some(item => item.owner === "verifier"));
  assert.doesNotMatch(JSON.stringify(view), /private-service-key|fixture-secret|token=/);
  assert.match(readableAttention(view), /Next:.*Repair/);
});

test("verifier-dispatch-deduplication: concurrent ticks, repeated ticks and restart persist one independent identity and report handoff", async t => {
  const { directory, store, job, adapter } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.launchVerifier = async (_job, run) => { adapter.launches.push(run); await gate; };
  const now = new Date(at.getTime() + 60_000);
  const first = tick(store, adapter, { now, process: "first", alive: () => true });
  const second = tick(new JobStore(directory), adapter, { now, process: "second", alive: () => true });
  release(); await Promise.all([first, second]);
  assert.equal(adapter.launches.length, 1);
  const run = store.get(job.id).verifier!;
  assert.notEqual(run.id, job.sessionID); assert.notEqual(run.sessionID, job.sessionID);
  assert.equal(run.state, "running"); assert.equal(run.delivery, "delivered");
  assert.equal(run.binding, verifierBinding(job));
  assert.match(run.reportPath, /report\.json$/);
  await tick(new JobStore(directory), adapter, { now: new Date(at.getTime() + 120_000), process: "restart", alive: () => false });
  assert.equal(adapter.launches.length, 1); assert.equal(adapter.wakes.length, 0);
  handoff(run, report(job, run.id));
  await tick(new JobStore(directory), adapter, { now: new Date(at.getTime() + 180_000), process: "restart", alive: () => false });
  assert.equal(store.get(job.id).stage, "verified");
  assert.equal(store.get(job.id).verifier!.state, "accepted");
  assert.equal(store.get(job.id).nextWakeAt, undefined);
  assert.equal(store.get(job.id).verification!.reviewer.runID, run.id);
});

test("verifier-dispatch-deduplication: lost launch response and crashed reservation hold for inspection without replay", async t => {
  for (const crash of [false, true]) {
    const { directory, store, job, adapter, run } = fixture(t);
    if (crash) store.update(job.id, current => {
      current.verifier = { id: "reserved-run", sessionID: "reserved-session", agent: "fixture-review", binding: verifierBinding(current),
        reportPath: join(directory, "report.json"), outcomePath: join(directory, "outcome.json"), state: "reserved", reservedAt: at.toISOString(), timeoutSeconds: 60 };
      current.claim = { process: "dead", token: "crashed" };
    }, at);
    else adapter.launchVerifier = async (_job, verifier) => { adapter.launches.push(verifier); throw new Error("Lost response with private token"); };
    await tick(store, adapter, { now: new Date(at.getTime() + 60_000), process: "new", alive: () => false });
    const held = store.get(job.id);
    assert.equal(held.stage, "needs-you"); assert.equal(held.verifier!.state, "uncertain");
    assert.equal(held.nextWakeAt, undefined); assert.doesNotMatch(held.detail, /private token/);
    await run(new Date(at.getTime() + 120_000));
    assert.equal(adapter.launches.length, crash ? 0 : 1);
    const recovered = reconcileVerifier(store, job.id, { runID: held.verifier!.id, expectedRevision: store.get(job.id).revision,
      outcome: "not-delivered", reason: "Inspected original verifier session; no prompt delivered" });
    assert.equal(recovered.stage, "needs-you"); assert.equal(recovered.verifier!.state, "failed");
  }
});

test("verifier-dispatch-bounds: disabled/unavailable dispatch, retry budgets and all holds have concrete actions and no launches", async t => {
  for (const mode of ["disabled", "unavailable", "budget", "paused", "cancelled", "needs-you"] as const) {
    const { store, job, adapter, run } = fixture(t);
    if (mode === "disabled") adapter.plan.enabled = false;
    if (mode === "unavailable") delete adapter.plan.command;
    if (mode === "budget") store.update(job.id, current => { current.verifierAttempts = 2; }, at);
    if (["paused", "cancelled", "needs-you"].includes(mode)) checkpoint(store, job.id, { stage: mode as "paused", detail: "Owner decision" }, at);
    await run();
    assert.equal(adapter.launches.length, 0); assert.equal(adapter.wakes.length, 0);
    if (mode !== "cancelled") assert.ok(attention(store.list()).items.some(item => item.nextAction.length > 10));
  }
  const { store, job, adapter, run } = fixture(t);
  adapter.plan.maxAttempts = 1;
  await run();
  writeFileSync(store.get(job.id).verifier!.outcomePath, JSON.stringify({ status: "failed" }));
  await run(new Date(at.getTime() + 120_000));
  await run(new Date(at.getTime() + 180_000));
  assert.equal(adapter.launches.length, 1);
  assert.equal(store.get(job.id).blocker!.reason, "runner-error");
  assert.match(store.get(job.id).blocker!.nextAction, /budget exhausted/);
});

test("verifier-dispatch-bounds: SQLite capacity reservation serializes separate worker processes", async t => {
  const { directory, store, job } = fixture(t);
  const second = { ...structuredClone(job), id: "second-job", sessionID: "second-implementer" };
  store.insert(second);
  const worker = `import {JobStore} from './src/lifecycle.ts';
const store=new JobStore(process.argv[1]); const job=store.get(process.argv[2]);
const run={id:'run-'+job.id,sessionID:'verifier-'+job.id,agent:'fixture',binding:'fixture',state:'reserved',reportPath:'fixture-report',outcomePath:'fixture-outcome',reservedAt:new Date().toISOString(),timeoutSeconds:60};
process.stdout.write(JSON.stringify(Boolean(store.reserveVerifier(job,run,1,2,new Date()))));`;
  const exec = promisify(execFile);
  const results = await Promise.all([job.id, second.id].map(id => exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", worker, directory, id])));
  assert.equal(results.filter(result => result.stdout.trim() === "true").length, 1);
  assert.equal(store.list().filter(current => current.verifier).length, 1);
});

test("verified-closeout: deployed evidence stays unfinished until actual serving-bound journeys and current ACs pass; tracker completion remains external", async t => {
  const { store, job, adapter, run } = fixture(t, "deployed");
  adapter.issue.state = "OPEN";
  await run();
  const verifier = store.get(job.id).verifier!;
  const local = report(job, verifier.id);
  handoff(verifier, local);
  await run(new Date(at.getTime() + 120_000));
  assert.equal(store.get(job.id).stage, "verifying");
  assert.equal(store.get(job.id).verifier!.state, "failed");
  await run(new Date(at.getTime() + 180_000));
  const retry = store.get(job.id).verifier!;
  const valid = report(job, retry.id); valid.deployment = deployment;
  valid.criteria[0].evidence = [{ kind: "journey", reference: "artifact://actual-fixture-journey", observed: "Expected deployed behavior", deployment }];
  handoff(retry, valid);
  adapter.deploy = { ...deployment, version: "serving-2" };
  await assert.rejects(checkVerification(adapter, store.get(job.id), valid, new Date(at.getTime() + 240_000)), /Serving deployment changed/);
  adapter.deploy = deployment;
  await run(new Date(at.getTime() + 240_000));
  assert.equal(store.get(job.id).stage, "verifying");
  assert.equal(store.get(job.id).verifier!.state, "report-ready");
  assert.equal(store.get(job.id).blocker!.reason, "tracker-closeout");
  assert.equal(adapter.issue.state, "OPEN");
  adapter.issue.state = "CLOSED";
  await run(new Date(at.getTime() + 300_000));
  assert.equal(store.get(job.id).stage, "verified");
  assert.equal(adapter.launches.length, 2);
  assert.equal(adapter.wakes.length, 0);
});

test("acceptance changes invalidate cached report/deployment/dispatch while retaining explicit pause and uncertain identity", async t => {
  const { store, job, adapter, run } = fixture(t, "deployed");
  await run();
  checkpoint(store, job.id, { stage: "paused", detail: "Explicit owner pause" }, at);
  const before = store.get(job.id);
  const corrected = correctAcceptance(store, job.id, { profile: "local", reason: "Current ACs are CLI/type checks", expectedRevision: before.revision, expectedAcHash: job.acHash }, issue, new Date(at.getTime() + 120_000));
  assert.equal(corrected.stage, "paused"); assert.equal(corrected.nextWakeAt, undefined);
  assert.equal(corrected.verifier!.state, "invalidated"); assert.equal(corrected.verifier!.id, before.verifier!.id);
  assert.equal(corrected.deployment, undefined); assert.equal(corrected.verification, undefined);
  assert.throws(() => validateReport(corrected, report(corrected), body, new Date(at.getTime() + 180_000)), /time/);
  await run(new Date(at.getTime() + 180_000));
  assert.equal(adapter.launches.length, 1);
});

test("authority-preserved: a pause racing a verifier launch retains its identity without resuming, replaying or granting completion", async t => {
  const { store, job, adapter, run } = fixture(t);
  let started!: () => void, release!: () => void;
  const launchStarted = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  adapter.launchVerifier = async (_job, verifier) => { adapter.launches.push(verifier); started(); await gate; };
  const running = run(); await launchStarted;
  const reserved = store.get(job.id);
  checkpoint(store, job.id, { stage: "paused", detail: "Owner holds the launch", expectedRevision: reserved.revision, expectedSessionID: job.sessionID });
  release(); await running;
  const paused = store.get(job.id);
  assert.equal(paused.stage, "paused"); assert.equal(paused.nextWakeAt, undefined);
  assert.equal(paused.verifier!.id, reserved.verifier!.id);
  assert.equal(paused.verification, undefined); assert.equal(paused.sessionID, job.sessionID);
  await run(new Date(at.getTime() + 120_000));
  assert.equal(adapter.launches.length, 1); assert.equal(adapter.wakes.length, 0);
});

test("authority-preserved: cancellation does not resume an in-flight verifier and inspected completion can release its capacity", async t => {
  const { store, job, adapter, run } = fixture(t);
  await run();
  const cancelled = checkpoint(store, job.id, { stage: "cancelled", detail: "Owner cancelled the scope" });
  assert.ok(attention(store.list()).items.some(item => item.reason === "uncertain-delivery"));
  const reconciled = reconcileVerifier(store, job.id, { runID: cancelled.verifier!.id, expectedRevision: cancelled.revision, outcome: "completed", reason: "Inspected bounded verifier outcome; process finished" });
  assert.equal(reconciled.stage, "cancelled"); assert.equal(reconciled.nextWakeAt, undefined);
  assert.equal(reconciled.verifier, undefined); assert.equal(reconciled.verifierHistory!.length, 1);
  await run(new Date(at.getTime() + 120_000));
  assert.equal(adapter.launches.length, 1); assert.equal(adapter.wakes.length, 0);
});

test("owner acceptance and stale current ACs remain separate from recoverable verification work", async t => {
  for (const human of [false, true]) {
    const { store, job, adapter, run } = fixture(t, "deployed");
    const changedIssue = { ...issue, body: body + `\n- [ ] ${human ? "`[human:owner]` Owner accepts the result." : "`[test:extra]` An extra local test passes."}` };
    adapter.issue = { ...changedIssue, state: "OPEN" };
    if (human) store.update(job.id, current => { Object.assign(current, acceptance(changedIssue.body)); current.issue = changedIssue; }, at);
    const result = await run();
    assert.equal(result[0].result, human ? "owner-acceptance-required" : "acceptance-stale");
    assert.equal(store.get(job.id).blocker!.reason, "acceptance-decision");
    assert.equal(adapter.launches.length, 0); assert.equal(adapter.wakes.length, 0);
  }
});

test("acceptance-scope-preserved: every explicit deployed criterion needs current serving-bound journey evidence", t => {
  const { job } = fixture(t, "deployed");
  const required = body + "\n- [ ] `[deploy:actual-journey]` The deployed journey passes.";
  Object.assign(job, acceptance(required));
  const value = report(job); value.deployment = deployment;
  value.criteria.forEach(item => { item.evidence = [{ kind: "journey", reference: "artifact://journey", observed: "Actual deployed behavior", deployment }]; });
  value.criteria.at(-1)!.evidence[0].deployment = { ...deployment, version: "stale-serving-version" };
  assert.throws(() => validateReport(job, value, required, new Date(at.getTime() + 60_000)), /Every deployed AC/);
  assert.throws(() => validateReport(job, { ...value, reviewer: { runID: "fixture-independent", independent: "yes" } }, required, new Date(at.getTime() + 60_000)), /independent reviewer/);
});

test("held fact failures hide stale readiness, reject missing merge provenance and sanitize tool details", async t => {
  for (const malformed of [false, true]) {
    const { store, job, adapter, run } = fixture(t);
    checkpoint(store, job.id, { stage: "paused", detail: "Owner hold" }, at);
    store.update(job.id, current => { current.facts = { pr: { fingerprint: "old-ready", ready: true, merged: false }, observedAt: at.toISOString(), nextCheckAt: at.toISOString() }; }, at);
    if (malformed) adapter.snapshot = { fingerprint: "invalid", merged: true, ready: true };
    else adapter.pr = async () => { throw new Error("https://example.invalid/private?token=fixture-secret /private/source/path"); };
    await run();
    const held = store.get(job.id);
    assert.equal(held.facts!.pr, undefined); assert.equal(held.mergeSha, mergeSha);
    assert.equal(held.stage, "paused"); assert.equal(adapter.wakes.length, 0);
    assert.doesNotMatch(JSON.stringify(attention(store.list())), /fixture-secret|private\/source|old-ready/);
    assert.ok(attention(store.list()).items.some(item => item.reason === "runner-error" && item.owner === "system"));
  }
});

test("local fixture/documentation contracts can describe deployed and human gates without waiving actual requirements", () => {
  const descriptions = "## Acceptance Criteria\n- [ ] `[test:gates]` Tests reject reports missing deployed journeys or human acceptance.\n- [ ] `[code:guide]` Documentation describes deployed verification and human acceptance.";
  assert.doesNotThrow(() => assertLocalAcceptance(descriptions));
  for (const requirement of [
    "`[deploy:runtime]` A fixture contract requires the deployed journey.",
    "`[human:owner]` Documentation describes owner acceptance.",
    "`[test:runtime]` Tests cover the probes; run the actual deployed journey.",
    "`[code:owner]` Documentation describes the flow; obtain human acceptance.",
    "`[code:runtime]` Documentation describes the flow; the actual deployed journey must pass.",
    "`[code:owner]` Documentation describes the flow; human acceptance is required.",
  ]) assert.throws(() => assertLocalAcceptance(`## Acceptance Criteria\n- [ ] ${requirement}\n- [ ] \`[code:types]\` Types exist.`), /cannot bypass/);
});
