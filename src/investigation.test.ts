import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceProvenanceError, acceptance, checkpoint, createJob, JobStore, validateReport, type LifecycleAdapter, type VerificationReport } from "./lifecycle.js";
import { closeoutJob } from "./lifecycle-closeout.js";
import { coordinateVerification, correctAcceptance } from "./closeout.js";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";

const source = "a".repeat(40);
const issue = { backend: "github" as const, identifier: "1", title: "Investigate retry behavior", state: "CLOSED", labels: [],
  url: "https://github.com/example/project/issues/1", body: "## Acceptance Criteria\n- [ ] `[query:cause]` The observed cause is recorded.\n- [ ] `[test:repro]` A fixture confirms the finding." };
const targets = { worker: { probe: ["fixture-worker-probe"], environment: "preview", target: "worker" }, backup: { probe: ["fixture-backup-probe"], environment: "lab", target: "backup" } };

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "workit-investigation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  const job = createJob({ issue, repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
    config: { delivery: "investigation", verification: "local" }, observedSourceSha: source });
  store.insert(job);
  const value: VerificationReport = { jobID: job.id, issueURL: issue.url, acHash: job.acHash, sourceSha: source,
    checkedAt: new Date().toISOString(), reviewer: { runID: "independent-observer", independent: true },
    criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [{ kind: "query", reference: "artifact://finding", observed: "Reproduction establishes the reported cause" }] })) };
  const adapter: LifecycleAdapter & { currentIssue: () => Promise<typeof issue>; updateIssue: () => Promise<void> } = {
    session: async () => undefined, project: async () => {}, wake: async () => {},
    pr: async () => { throw new Error("Investigation must not ask for a PR"); }, observedSource: async () => source,
    deployment: async () => undefined, containsMerge: async () => true, currentIssue: async () => issue,
    markInReview: async () => {}, markDone: async () => false, updateIssue: async () => { throw new Error("Unexpected write"); },
  };
  return { store, job, value, adapter };
}

test("investigation closes with pinned independent evidence and no PR, while implementation keeps its merge gate", async t => {
  const { store, job, value, adapter } = fixture(t);
  checkpoint(store, job.id, { stage: "verifying", detail: "Investigation evidence ready" });
  const result = await closeoutJob(store, adapter, job.id, { report: value });
  assert.equal(result.stage, "verified"); assert.equal(result.pr, undefined); assert.equal(result.mergeSha, undefined);
  const implementation = { ...job, config: { ...job.config, delivery: "implementation" as const } };
  assert.throws(() => validateReport(implementation, value, issue.body), /bound source/);
});

test("investigation rejects stale source/ACs, fabricated merges and implementation self-review", async t => {
  const { store, job, value, adapter } = fixture(t);
  for (const invalid of [{ ...value, sourceSha: "b".repeat(40) }, { ...value, mergeSha: source },
    { ...value, acHash: "stale" }, { ...value, reviewer: { runID: job.sessionID, independent: true } }]) {
    assert.throws(() => validateReport(job, invalid, issue.body));
  }
  assert.throws(() => checkpoint(store, job.id, { stage: "verifying", detail: "fake merge", pr: "https://github.com/example/project/pull/2", mergeSha: source }));
  checkpoint(store, job.id, { stage: "verifying", detail: "Ready" });
  adapter.observedSource = async () => "b".repeat(40);
  await assert.rejects(closeoutJob(store, adapter, job.id, { report: value }), /Investigation source changed/);
  assert.equal(store.get(job.id).stage, "verifying");
});

test("named targets are trusted choices and audited corrections invalidate evidence without releasing holds", t => {
  const { store, job, value } = fixture(t);
  const launched = createJob({ issue, repoRoot: job.repoRoot, worktree: job.worktree, githubRepo: job.githubRepo, agent: "fixture",
    config: { deploymentTargets: targets, deploymentTarget: "backup" } });
  assert.deepEqual(launched.config.deploymentProbe, targets.backup.probe);
  assert.deepEqual(launched.config.deploymentBinding, { environment: "lab", target: "backup" });
  assert.throws(() => createJob({ issue, repoRoot: job.repoRoot, worktree: job.worktree, githubRepo: job.githubRepo, agent: "fixture",
    config: { deploymentTargets: targets, deploymentTarget: "constructor" } }), /Unknown/);
  checkpoint(store, job.id, { stage: "paused", detail: "Owner hold" });
  store.update(job.id, current => { current.verification = value; current.closeout = { stateConfirmed: true }; });
  const before = store.get(job.id);
  const input = { profile: "deployed" as const, delivery: "investigation" as const, target: "backup", observedSourceSha: source,
    reason: "This investigation concerns backup serving behavior", expectedRevision: before.revision, expectedAcHash: acceptance(issue.body).acHash };
  assert.throws(() => correctAcceptance(store, job.id, { ...input, expectedRevision: 999 }, issue, new Date(), { deploymentTargets: targets }));
  assert.throws(() => correctAcceptance(store, job.id, { ...input, target: "unknown" }, issue, new Date(), { deploymentTargets: targets }));
  const changed = correctAcceptance(store, job.id, input, issue, new Date(), { deploymentTargets: targets });
  assert.equal(changed.stage, "paused"); assert.equal(changed.holdDetail, "Owner hold");
  assert.equal(changed.nextWakeAt, undefined); assert.equal(changed.verification, undefined); assert.equal(changed.closeout, undefined);
  assert.deepEqual(changed.config.deploymentProbe, targets.backup.probe);
  assert.equal(changed.acceptanceHistory?.at(-1)?.toTarget, "backup");
});

test("a named probe must report its configured target and environment", async t => {
  const { job } = fixture(t);
  const command = (target: string) => [process.execPath, "-e", `process.stdout.write(JSON.stringify({ready:true,environment:'preview',target:${JSON.stringify(target)},sourceSha:'${source}',version:'one'}))`];
  job.config = { verification: "deployed", deploymentProbe: command("worker"), deploymentBinding: { environment: "preview", target: "worker" } };
  const adapter = new BanyanLifecycleAdapter();
  assert.equal((await adapter.deployment(job))?.target, "worker");
  job.config.deploymentProbe = command("backup");
  await assert.rejects(adapter.deployment(job), /different named target/);
});


test("correcting an investigation target does not declare unfinished observations ready", t => {
  const { store, job } = fixture(t);
  store.update(job.id, current => { current.stage = "investigating"; });
  const current = store.get(job.id);
  const changed = correctAcceptance(store, job.id, { profile: "local", target: "backup", observedSourceSha: source,
    reason: "Correct the service being investigated", expectedRevision: current.revision, expectedAcHash: current.acHash },
    issue, new Date(), { deploymentTargets: targets });
  assert.equal(changed.stage, "investigating");
  assert.equal(changed.acceptanceHistory?.at(-1)?.priorSourceSha, source);
});


test("verifier coordination preserves named-target provenance errors for the attention view", async t => {
  const { store, job, adapter } = fixture(t);
  store.update(job.id, current => { current.stage = "verifying"; current.config.verification = "deployed"; current.config.deploymentProbe = ["probe"]; });
  adapter.verifierPlan = async () => ({ enabled: true, command: "fixture", agent: "fixture", concurrency: 1, maxAttempts: 1, timeoutSeconds: 60 });
  adapter.launchVerifier = async () => { throw new Error("Must not launch with invalid provenance"); };
  adapter.deployment = async () => { throw new SourceProvenanceError("Wrong target"); };
  const result = await coordinateVerification(store, adapter, store.get(job.id), new Date());
  assert.equal(result, "serving-binding-stale");
  assert.equal(store.get(job.id).blocker?.reason, "source-provenance");
  assert.equal(store.get(job.id).blocker?.owner, "external");
});
