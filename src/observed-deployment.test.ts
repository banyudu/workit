import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpoint, createJob, digest, JobStore, parseDeploymentSourceBinding, reportComplete, validateReport,
  type Deployment, type Job, type LifecycleConfig, type VerificationReport } from "./lifecycle.js";
import { closeoutJob, type CloseoutAdapter } from "./lifecycle-closeout.js";
import { correctAcceptance, verifierBinding } from "./closeout.js";

const observer = "b".repeat(40);
const runtime: Deployment = { environment: "lab", target: "fixture-worker", sourceSha: "a".repeat(40), version: "existing-v1" };
const body = "## Acceptance Criteria\n" +
  "- [ ] `[query:behavior]` Observe the current dev runtime behavior and record the result.\n" +
  "- [ ] `[deploy:version]` Record the serving-source and version of the observed service.\n" +
  "- [ ] `[code:explanation]` Explain the finding against the pinned source.";
const issue = { backend: "github" as const, identifier: "33", title: "Observe existing runtime", state: "CLOSED", labels: [] as string[],
  url: "https://github.com/example/project/issues/33", body };

function report(job: Job, kind = "observation"): VerificationReport {
  return { jobID: job.id, issueURL: job.issue.url, acHash: job.acHash, sourceSha: job.observedSourceSha,
    checkedAt: new Date().toISOString(), reviewer: { runID: "independent-runtime-observer", independent: true },
    deployment: job.deployment,
    criteria: job.acLabels.map((label, index) => ({ label, status: "pass", evidence: [{
      kind: index < 2 ? kind : "code", reference: `artifact://fixture/observation-${index}`,
      observed: index < 2 ? "The service returned the measured behavior with its serving version" : "Pinned source explains the finding",
      ...(index < 2 ? { deployment: job.deployment } : {}),
    }] })) };
}

function fixture(t: TestContext, config: Partial<LifecycleConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "workit-observed-deployment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JobStore(directory);
  const job = createJob({ issue: structuredClone(issue), repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
    config: { delivery: "investigation", verification: "deployed", deploymentProbe: ["fixture-read-only-probe"],
      deploymentSourceBinding: "observe-existing", ...config }, observedSourceSha: observer,
    now: new Date(Date.now() - 60_000) });
  job.stage = "verifying"; job.deployment = runtime;
  if (job.config.delivery === "implementation") { job.pr = "https://github.com/example/project/pull/34"; job.mergeSha = observer; }
  store.insert(job);
  const calls = { ancestry: 0, writes: 0, prs: 0 };
  const adapter: CloseoutAdapter = {
    session: async () => undefined, project: async () => {}, wake: async () => {},
    pr: async () => { calls.prs++; return { merged: true, mergeSha: observer, fingerprint: "fixture", ready: false }; },
    observedSource: async () => observer, deployment: async () => runtime,
    containsMerge: async () => { calls.ancestry++; return false; }, currentIssue: async () => issue,
    markInReview: async () => {}, markDone: async () => false,
    updateIssue: async () => { calls.writes++; throw new Error("No tracker writes are expected for the closed GitHub fixture"); },
  };
  return { store, job, adapter, calls };
}

test("source binding is explicit and observe-existing is confined to deployed investigations", t => {
  for (const value of ["contains-source", "observe-existing"] as const) assert.equal(parseDeploymentSourceBinding(value), value);
  for (const value of [undefined, null, "", "observe", true, ["observe-existing"]]) assert.throws(() => parseDeploymentSourceBinding(value));
  for (const config of [
    { delivery: "implementation" }, { delivery: undefined }, { verification: "local" },
    { historicalSources: ["artifact://published-record"] },
    { verification: "local", historicalSources: ["artifact://published-record"] },
    { deploymentSourceBinding: "unknown" },
  ]) assert.throws(() => fixture(t, config as Partial<LifecycleConfig>), /source|observ|investigation|deployed|historical/i);
  for (const deploymentSourceBinding of [undefined, "contains-source"] as const) {
    const { job } = fixture(t, { deploymentSourceBinding });
    assert.equal(job.config.deploymentSourceBinding, deploymentSourceBinding);
  }
});

test("closeout accepts older serving source only for explicit observation and preserves observer identity", async t => {
  for (const kind of ["observation", "journey"]) {
    const f = fixture(t);
    const value = report(f.job, kind);
    const result = await closeoutJob(f.store, f.adapter, f.job.id, { report: value });
    assert.equal(result.stage, "verified");
    assert.equal(result.verification!.sourceSha, observer);
    assert.deepEqual(result.verification!.deployment, runtime);
    assert.notEqual(result.verification!.sourceSha, result.verification!.deployment!.sourceSha);
    assert.equal(result.pr, undefined); assert.equal(result.mergeSha, undefined);
    assert.equal(f.calls.ancestry, 0); assert.equal(f.calls.prs, 0); assert.equal(f.calls.writes, 0);
  }
  for (const config of [
    { deploymentSourceBinding: undefined }, { deploymentSourceBinding: "contains-source" as const },
    { delivery: "implementation" as const, deploymentSourceBinding: undefined },
  ]) {
    const f = fixture(t, config);
    const value = report(f.job, "journey");
    if (config.delivery === "implementation") { delete value.sourceSha; value.mergeSha = observer; }
    await assert.rejects(closeoutJob(f.store, f.adapter, f.job.id, { report: value }), /deployment|source|contain/i);
    assert.ok(f.calls.ancestry > 0, "the original ancestry gate remains required");
    assert.equal(f.store.get(f.job.id).stage, "verifying");
  }
});

test("every deployed AC and overall completion require actual serving-bound observation evidence", t => {
  const { job } = fixture(t);
  assert.doesNotThrow(() => validateReport(job, report(job), body));
  for (const index of [0, 1]) {
    for (const kind of ["query", "code"]) {
      const value = report(job); value.criteria[index].evidence[0].kind = kind;
      assert.throws(() => validateReport(job, value, body), /serving|observation|journey/i);
    }
    const unbound = report(job); delete unbound.criteria[index].evidence[0].deployment;
    assert.throws(() => validateReport(job, unbound, body), /serving|deployment|observation/i);
  }
  const noReportBinding = report(job); delete noReportBinding.deployment;
  assert.throws(() => validateReport(job, noReportBinding, body), /serving|deployment|observation/i);
  for (const field of ["environment", "target", "sourceSha", "version"] as const) {
    const stale = report(job);
    stale.criteria[1].evidence[0].deployment = { ...runtime, [field]: field === "sourceSha" ? observer : "wrong" };
    assert.throws(() => validateReport(job, stale, body), /serving|deployment|observation/i);
  }
  const genericBody = "## Acceptance Criteria\n- [ ] `[query:finding]` Record the finding.\n- [ ] `[code:explanation]` Explain the source.";
  const generic = createJob({ issue: { ...issue, body: genericBody }, repoRoot: job.repoRoot, worktree: job.worktree,
    githubRepo: job.githubRepo, agent: job.agent, config: job.config, observedSourceSha: observer });
  generic.deployment = runtime;
  const unbound = report(generic);
  for (const item of unbound.criteria) item.evidence = [{ kind: "query", reference: "artifact://summary", observed: "A source-only conclusion" }];
  assert.equal(reportComplete(generic, unbound), false, "a deployment header alone cannot prove observation");
  assert.throws(() => validateReport(generic, unbound, genericBody), /Completion/);
  unbound.criteria[0].evidence = report(generic).criteria[0].evidence;
  assert.doesNotThrow(() => validateReport(generic, unbound, genericBody));
  for (const deploymentSourceBinding of [undefined, "contains-source"] as const) {
    const unchanged = { ...generic, config: { ...generic.config, deploymentSourceBinding } };
    assert.equal(reportComplete(unchanged, unbound), false, "observation cannot replace default journey evidence even without a deployed AC");
    assert.throws(() => validateReport(unchanged, unbound, genericBody), /Completion/);
  }
  const legacy = { ...job, config: { ...job.config, deploymentSourceBinding: undefined } };
  assert.throws(() => validateReport(legacy, report(legacy), body), /journey/i);
});

test("observed closeout retains source, AC, reviewer, serving-version and target freshness gates", async t => {
  const f = fixture(t);
  for (const patch of [
    { sourceSha: runtime.sourceSha }, { mergeSha: observer }, { acHash: "stale" },
    { reviewer: { runID: f.job.sessionID, independent: true } },
    { reviewer: { runID: "independent-runtime-observer", independent: false } },
  ]) await assert.rejects(closeoutJob(f.store, f.adapter, f.job.id, { report: { ...report(f.job), ...patch } }));
  f.adapter.currentIssue = async () => ({ ...issue, body: body.replace("record the result", "prove a different result") });
  await assert.rejects(closeoutJob(f.store, f.adapter, f.job.id, { report: report(f.job) }), /AC binding/i);
  f.adapter.currentIssue = async () => issue;
  f.adapter.observedSource = async () => { throw new Error("Tracked observer worktree is dirty"); };
  await assert.rejects(closeoutJob(f.store, f.adapter, f.job.id, { report: report(f.job) }), /unavailable|dirty/i);
  f.adapter.observedSource = async () => "c".repeat(40);
  await assert.rejects(closeoutJob(f.store, f.adapter, f.job.id, { report: report(f.job) }), /source changed/i);
  f.adapter.observedSource = async () => observer;
  for (const field of ["environment", "target", "sourceSha", "version"] as const) {
    f.adapter.deployment = async () => ({ ...runtime, [field]: field === "sourceSha" ? "c".repeat(40) : "changed" });
    await assert.rejects(closeoutJob(f.store, f.adapter, f.job.id, { report: report(f.job) }), /Serving deployment changed/i);
  }
  f.adapter.deployment = async () => undefined;
  await assert.rejects(closeoutJob(f.store, f.adapter, f.job.id, { report: report(f.job) }), /Serving deployment changed/i);
  assert.equal(f.store.get(f.job.id).stage, "verifying");
  assert.equal(f.store.get(f.job.id).verification, undefined); assert.equal(f.calls.writes, 0);
  const named = fixture(t, { deploymentBinding: { environment: "lab", target: "different-configured-worker" } });
  await assert.rejects(closeoutJob(named.store, named.adapter, named.job.id, { report: report(named.job) }), /named target/i);
});

test("audited source-binding correction preserves holds and invalidates stale reports and verifier identities", t => {
  const f = fixture(t, { deploymentSourceBinding: undefined });
  checkpoint(f.store, f.job.id, { stage: "paused", detail: "Owner must explicitly release this hold" });
  f.store.update(f.job.id, current => {
    current.verification = report(current, "journey"); current.closeout = { checklistConfirmed: true, stateConfirmed: true }; current.trackerDone = true;
    current.verifier = { id: "existing-verifier", sessionID: "existing-verifier", agent: "fixture", binding: verifierBinding(current),
      reportPath: "/fixture/report.json", outcomePath: "/fixture/outcome.json", state: "running", reservedAt: new Date().toISOString(), timeoutSeconds: 60 };
  });
  const held = f.store.get(f.job.id);
  const input = { profile: "deployed" as const, deploymentSourceBinding: "observe-existing" as const, observedSourceSha: observer,
    expectedRevision: held.revision, expectedAcHash: held.acHash, reason: "Observe the existing runtime from a newer clean source checkout" };
  for (const invalid of [
    { ...input, expectedRevision: held.revision - 1 }, { ...input, expectedAcHash: "stale" }, { ...input, reason: "" },
    { ...input, delivery: "implementation" as const }, { ...input, historicalSources: ["artifact://original"] },
  ]) {
    assert.throws(() => correctAcceptance(f.store, held.id, invalid, issue));
    assert.deepEqual(f.store.get(held.id), held, "rejected correction must be atomic");
  }
  const correctedAt = new Date(Date.now() + 1_000);
  const changed = correctAcceptance(f.store, held.id, input, issue, correctedAt);
  assert.equal(changed.config.deploymentSourceBinding, "observe-existing");
  assert.equal(changed.stage, "paused"); assert.equal(changed.holdDetail, held.holdDetail); assert.equal(changed.nextWakeAt, undefined);
  assert.equal(changed.observedSourceSha, observer); assert.equal(changed.acHash, held.acHash);
  assert.equal(changed.deployment, undefined); assert.equal(changed.verification, undefined); assert.equal(changed.closeout, undefined); assert.equal(changed.trackerDone, undefined);
  assert.equal(changed.verifier!.id, held.verifier!.id); assert.equal(changed.verifier!.state, "invalidated");
  assert.notEqual(verifierBinding(changed), held.verifier!.binding);
  const audit = changed.acceptanceHistory!.at(-1)!;
  assert.equal(audit.fromDeploymentSourceBinding ?? "contains-source", "contains-source");
  assert.equal(audit.toDeploymentSourceBinding, "observe-existing"); assert.equal(audit.priorSourceSha, observer);
  assert.equal(audit.revision, changed.revision); assert.equal(audit.acHash, held.acHash);
  assert.throws(() => validateReport({ ...changed, verifier: undefined, deployment: runtime }, held.verification!, body, correctedAt), /verification time/);
  const restored = correctAcceptance(f.store, changed.id, { ...input, deploymentSourceBinding: "contains-source", expectedRevision: changed.revision }, issue, correctedAt);
  assert.equal(restored.config.deploymentSourceBinding, "contains-source"); assert.equal(restored.stage, "paused");
  assert.equal(restored.acceptanceHistory!.at(-1)!.fromDeploymentSourceBinding, "observe-existing");
});

test("observation changes verifier binding while existing and historical bindings remain compatible", t => {
  const { job } = fixture(t, { deploymentSourceBinding: undefined });
  const oldBinding = [job.acHash, job.observedSourceSha, job.config.delivery, job.config.deploymentTarget,
    job.config.verification, job.acceptanceChangedAt, job.deployment];
  assert.equal(verifierBinding(job), digest(JSON.stringify(oldBinding)));
  assert.equal(verifierBinding({ ...job, config: { ...job.config, deploymentSourceBinding: "contains-source" } }), verifierBinding(job));
  const historical = { ...job, config: { ...job.config, verification: "local" as const, historicalSources: ["artifact://original"] } };
  assert.equal(verifierBinding(historical), digest(JSON.stringify([oldBinding[0], oldBinding[1], oldBinding[2], oldBinding[3],
    "local", oldBinding[5], oldBinding[6], historical.config.historicalSources])));
  const observed = { ...job, config: { ...job.config, deploymentSourceBinding: "observe-existing" as const } };
  assert.notEqual(verifierBinding(observed), verifierBinding(job));
  assert.notEqual(verifierBinding(observed), verifierBinding({ ...observed, deployment: { ...runtime, version: "new-version" } }));
});

const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit"];
const fakeCommand = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const file=process.env.WORKIT_FIXTURE_FILE,f=JSON.parse(fs.readFileSync(file,'utf8'));
const name=path.basename(process.argv[1]),args=process.argv.slice(2);
f.calls.push([name,...args]);fs.writeFileSync(file,JSON.stringify(f));
let output;
if(name==='probe') output={ready:true,...f.deployment};
else if(name==='gh'&&args[0]==='issue'&&args[1]==='view') output=f.issue;
else if(name==='banyanctl'&&args[0]==='session'&&args[1]==='list') output={workflowProtocol:1,sessions:[f.session].filter(Boolean)};
else if(name==='banyanctl'&&['workflow','session'].includes(args[0])&&['set','wake','new'].includes(args[1])) output={ok:true};
else { process.stderr.write('Unexpected fixture command: '+name+' '+args.join(' ')); process.exit(97); }
process.stdout.write(JSON.stringify(output));
`;

test("CLI launch and guarded correction use a clean observer while retaining the older actual serving commit", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-observed-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.json");
  for (const name of ["gh", "banyanctl", "probe"]) writeFileSync(join(directory, name), fakeCommand, { mode: 0o700 });
  const env = { ...process.env, PATH: directory + ":" + process.env.PATH, WORKIT_FIXTURE_FILE: file,
    WORKIT_STATE_DIR: join(directory, "state"), WORKIT_BANYANCTL: join(directory, "banyanctl") };
  writeFileSync(join(directory, ".workit.yml"), JSON.stringify({ codingAgents: null, provider: "github", default: "fixture",
    agents: { fixture: { command: "fixture-implementer", weight: 1 } },
    launch: { target: "banyan", logFile: join(directory, "launch.log"), instructions: [] }, worktree: { copyEnv: false, baseBranch: "main" },
    lifecycle: { verification: "deployed", deploymentProbe: [join(directory, "probe")], verifier: { enabled: false } } }));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  git(directory, ["init", "-b", "main"]); git(directory, ["add", ".workit.yml"]); git(directory, [...commit, "-m", "existing runtime source"]);
  const servingSha = git(directory, ["rev-parse", "HEAD"]);
  git(directory, [...commit, "--allow-empty", "-m", "newer observer source"]);
  const sourceSha = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  const deployment = { ...runtime, sourceSha: servingSha };
  writeFileSync(file, JSON.stringify({ issue, deployment, calls: [] }));
  const cli = (...args: string[]) => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"),
    fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args], { cwd: directory, stdio: "pipe", env, encoding: "utf8" });
  cli("--managed", "--agent", "fixture", "--none", "--delivery", "investigation", "--acceptance", "deployed", "--source-binding", "observe-existing", "33");
  const store = new JobStore(env.WORKIT_STATE_DIR);
  let job = store.list()[0];
  assert.equal(job.config.deploymentSourceBinding, "observe-existing"); assert.equal(job.observedSourceSha, sourceSha);
  assert.notEqual(job.observedSourceSha, deployment.sourceSha);
  const state = JSON.parse(readFileSync(file, "utf8"));
  const launched = state.calls.find((call: string[]) => call[1] === "session" && call[2] === "new");
  const promptPath = launched[launched.indexOf("--command") + 1].match(/cat '([^']+)'/)[1];
  t.after(() => rmSync(promptPath, { force: true }));
  assert.match(readFileSync(promptPath, "utf8"), /observe-existing|existing (?:serving|runtime|deployment)/i);
  cli("job", "pause", job.id, "--detail", "Owner hold remains in force");
  job = store.get(job.id);
  const correct = (binding: string, revision: number, hash = job.acHash) => cli("job", "acceptance", job.id, "--source-binding", binding,
    "--reason", "Explicitly choose the source relation for existing runtime observation", "--expected-revision", String(revision), "--expected-ac-hash", hash);
  assert.throws(() => correct("contains-source", job.revision - 1), /revision mismatch/);
  assert.throws(() => correct("contains-source", job.revision, "stale"), /AC binding is stale/);
  writeFileSync(join(job.worktree, ".workit.yml"), "dirty observer");
  assert.throws(() => correct("contains-source", job.revision), /Command failed/);
  assert.deepEqual(store.get(job.id), job);
  git(job.worktree, ["restore", ".workit.yml"]);
  correct("contains-source", job.revision); job = store.get(job.id);
  assert.equal(job.stage, "paused"); assert.equal(job.holdDetail, "Owner hold remains in force");
  correct("observe-existing", job.revision); job = store.get(job.id);
  assert.equal(job.acceptanceHistory!.at(-1)!.toDeploymentSourceBinding, "observe-existing");
  cli("job", "resume", job.id, "--detail", "Fixture owner releases hold");
  cli("job", "checkpoint", job.id, "--stage", "waiting-deploy", "--detail", "Observation is ready for serving provenance");
  cli("job", "refresh-deployment", job.id); job = store.get(job.id);
  assert.equal(job.stage, "verifying"); assert.deepEqual(job.deployment, deployment);
  const value = report(job); const reportPath = join(directory, "report.json");
  writeFileSync(reportPath, JSON.stringify(value));
  writeFileSync(join(job.worktree, ".workit.yml"), "dirty observer");
  assert.throws(() => cli("job", "verify", job.id, "--report", reportPath), /facts unavailable|Command failed/);
  git(job.worktree, ["restore", ".workit.yml"]);
  cli("job", "verify", job.id, "--report", reportPath);
  job = store.get(job.id);
  assert.equal(job.stage, "verified"); assert.equal(job.verification!.sourceSha, sourceSha);
  assert.deepEqual(job.verification!.deployment, deployment); assert.equal(job.pr, undefined); assert.equal(job.mergeSha, undefined);
  const calls: string[][] = JSON.parse(readFileSync(file, "utf8")).calls;
  assert.ok(calls.some(call => call[0] === "probe"));
  assert.equal(calls.filter(call => call[0] === "gh" && call[1] !== "issue").length, 0);
});
