import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore, createJob, tick } from "./lifecycle.js";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { lifecycleCLI } from "./lifecycle-cli.js";

const body = "## Acceptance Criteria\n- [ ] `[test:cli]` The CLI fixture passes.\n- [ ] `[code:types]` The types are documented.";
const issue = { backend: "github" as const, identifier: "23", title: "CLI and type change", body, labels: [], state: "CLOSED", url: "https://github.com/example/project/issues/23" };
const source = "a".repeat(40);
const fixtureCommand = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const file=process.env.WORKIT_FIXTURE_FILE;
const fixture=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
const name=path.basename(process.argv[1]);
fixture.calls.push([name,...args]);fs.writeFileSync(file,JSON.stringify(fixture));
let output;
if(name==='gh'&&args[0]==='issue'&&args[1]==='view') output=fixture.issue;
else if(name==='gh'&&args[0]==='pr'&&args[1]==='view') output={state:'MERGED',headRefOid:fixture.source,mergeCommit:{oid:fixture.source},mergeStateStatus:'CLEAN',statusCheckRollup:[]};
else if(name==='banyanctl'&&args[0]==='session'&&args[1]==='list') output={workflowProtocol:1,sessions:[fixture.session].filter(Boolean)};
else if(name==='banyanctl'&&args[0]==='workflow'&&args[1]==='set') {
  fixture.projection={jobID:value('--job-id'),revision:Number(value('--revision')),sessionID:value('--id'),state:value('--state')};
  fs.writeFileSync(file,JSON.stringify(fixture)); output={ok:true};
} else if(name==='banyanctl'&&args[0]==='session'&&args[1]==='new') {
  if(fixture.executeVerifier) {
    const result=cp.spawnSync('/bin/sh',['-lc',value('--command')],{cwd:value('--cwd'),stdio:'pipe',timeout:10000});
    if(result.status!==0) process.exit(70);
  }
  output={ok:true};
} else process.exit(2);
process.stdout.write(JSON.stringify(output));
`;
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "workit-closeout-wire-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv); rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ["gh", "banyanctl"]) writeFileSync(join(directory, name), fixtureCommand, { mode: 0o700 });
  const file = join(directory, "fixture.json");
  writeFileSync(file, JSON.stringify({ issue, source, calls: [] }));
  Object.assign(process.env, { PATH: directory + ":" + process.env.PATH, WORKIT_FIXTURE_FILE: file,
    WORKIT_STATE_DIR: join(directory, "state"), WORKIT_BANYANCTL: join(directory, "banyanctl") });
  return { directory, file, read: () => JSON.parse(readFileSync(file, "utf8")), store: new JobStore() };
}

test("acceptance-profile-selection: full managed CLI launch uses explicit local acceptance and accepts independent local report", async t => {
  const { directory, file, read, store } = fixture(t);
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git(["init", "-b", "main"]);
  // Null registry disables derived-config writes; all paths and commands are fixtures.
  writeFileSync(join(directory, ".workit.yml"), JSON.stringify({ codingAgents: null, provider: "github", default: "fixture",
    agents: { fixture: { command: "fixture-implementer", weight: 1 } },
    launch: { target: "banyan", logFile: join(directory, "launch.log"), instructions: [] },
    worktree: { copyEnv: false, baseBranch: "main" }, lifecycle: { verification: "deployed", verifier: { enabled: false } } }));
  git(["add", ".workit.yml"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture base"]);
  git(["remote", "add", "origin", "https://github.com/example/project.git"]);
  execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./cli.ts", import.meta.url)),
    "--managed", "--acceptance", "local", "--agent", "fixture", "--none", "23"], { cwd: directory, stdio: "pipe", env: process.env });
  const job = store.list()[0];
  assert.equal(store.list().length, 1); assert.equal(job.config.verification, "local");
  const command = read().calls.find((call: string[]) => call[1] === "session" && call[2] === "new");
  const promptFile = command[command.indexOf("--command") + 1].match(/cat '([^']+)'/)[1];
  t.after(() => rmSync(promptFile, { force: true }));
  const prompt = readFileSync(promptFile, "utf8");
  assert.doesNotMatch(prompt, /create_goal|Superdog/);
  assert.match(prompt, /Verification mode for this issue: local/);
  assert.equal(read().calls.filter((call: string[]) => call[0] === "gh" && call[1] !== "issue").length, 0);
  store.update(job.id, current => { current.stage = "verifying"; current.pr = "https://github.com/example/project/pull/42"; current.mergeSha = source; });
  const report = { jobID: job.id, issueURL: issue.url, acHash: job.acHash, mergeSha: source, checkedAt: new Date().toISOString(),
    reviewer: { runID: "independent-fixture-run", independent: true }, criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [{ kind: "test", reference: "artifact://cli-fixture", observed: "Expected CLI/type behavior" }] })) };
  const reportPath = join(directory, "local-report.json"); writeFileSync(reportPath, JSON.stringify(report));
  t.mock.method(console, "log", () => {});
  await lifecycleCLI(["job", "verify", job.id, "--report", reportPath]);
  assert.equal(store.get(job.id).stage, "verified");
  assert.equal(read().projection.state, "verified");
  // Exercise the supported correction command against a second isolated job.
  const deployed = createJob({ issue: { ...issue, identifier: "24", url: "https://github.com/example/project/issues/24" }, repoRoot: directory, worktree: directory,
    githubRepo: "example/project", agent: "fixture", config: { deploymentProbe: ["fixture-probe"] } });
  store.insert(deployed);
  const changed = read(); changed.issue = deployed.issue; writeFileSync(file, JSON.stringify(changed));
  await lifecycleCLI(["job", "acceptance", deployed.id, "--profile", "local", "--reason", "Current CLI/type ACs use isolated local probes",
    "--expected-revision", "0", "--expected-ac-hash", deployed.acHash]);
  assert.equal(store.get(deployed.id).config.verification, "local");
  assert.equal(store.get(deployed.id).acceptanceHistory!.length, 1);
  store.update(deployed.id, current => { current.stage = "verifying"; current.pr = "https://github.com/example/project/pull/43"; current.mergeSha = source; });
  writeFileSync(reportPath, JSON.stringify({ ...report, jobID: deployed.id, issueURL: deployed.issue.url, checkedAt: new Date().toISOString(),
    reviewer: { runID: "independent-corrected-fixture", independent: true } }));
  await lifecycleCLI(["job", "verify", deployed.id, "--report", reportPath]);
  assert.equal(store.get(deployed.id).stage, "verified");
});

test("verifier integration uses trusted review registry, bounded launch, independent report handoff and ordinary source/AC gate", async t => {
  for (const timeout of [false, true]) {
    const { directory, file, read, store } = fixture(t);
    const agentPath = join(directory, "fixture-review.cjs");
    writeFileSync(agentPath, timeout ? "setTimeout(()=>{},5000);" : String.raw`
const fs=require('node:fs');const prompt=process.argv.at(-1);
const runID=prompt.match(/Reviewer run ID: (.+)\./)[1];
const jobID=prompt.match(/managed job (.+)\. Reviewer/)[1];
const issueURL=prompt.match(/Issue: (.+)\. Merged source/)[1];
const mergeSha=prompt.match(/Merged source: (.+)\. Current AC/)[1];
const acHash=prompt.match(/Current AC hash: (.+)\./)[1];
const reportPath=prompt.match(/complete JSON VerificationReport to (.+)\./)[1];
const labels=prompt.match(/AC labels: (.+)\./)[1].split(', ');
fs.writeFileSync(reportPath,JSON.stringify({jobID,issueURL,acHash,mergeSha,checkedAt:new Date().toISOString(),reviewer:{runID,independent:true},criteria:labels.map(label=>({label,status:'pass',evidence:[{kind:'test',reference:'artifact://fixture',observed:'Expected behavior'}]}))}));
`);
    writeFileSync(join(directory, ".workit.yml"), JSON.stringify({ lifecycle: { verifier: { enabled: true, agent: "fixture-review", concurrency: 1, maxAttempts: 1, timeoutSeconds: 1 } },
      codingAgents: { agents: { "fixture-review": { command: `${process.execPath} ${agentPath}`, tags: ["review"], weight: 1 } } } }));
    const created = new Date(Date.now() - 120_000);
    const job = createJob({ issue, repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture-implementer",
      acceptance: "local", now: created });
    job.stage = "verifying"; job.pr = "https://github.com/example/project/pull/42"; job.mergeSha = source;
    store.insert(job);
    writeFileSync(file, JSON.stringify({ issue, source, session: { id: job.sessionID, cwd: directory, status: "idle" }, executeVerifier: true, calls: [] }));
    const adapter = new BanyanLifecycleAdapter(join(directory, "banyanctl"));
    await tick(store, adapter);
    const launched = store.get(job.id);
    assert.equal(launched.verifier!.agent, "fixture-review");
    assert.equal(launched.verifier!.state, "running");
    const outcome = JSON.parse(readFileSync(launched.verifier!.outcomePath, "utf8"));
    assert.equal(outcome.status, timeout ? "failed" : "complete");
    await tick(store, adapter, { now: new Date(Date.now() + 61_000) });
    assert.equal(store.get(job.id).stage, timeout ? "verifying" : "verified");
    const calls: string[][] = read().calls;
    assert.equal(calls.filter(call => call[1] === "session" && call[2] === "new").length, 1);
    assert.ok(calls.every(call => call[0] === "gh" ? ["pr", "issue"].includes(call[1]) && call[2] === "view"
      : call[1] === "session" || (call[1] === "workflow" && call[2] === "set")));
    const command = calls.find(call => call[1] === "session" && call[2] === "new")!;
    assert.equal(command[command.indexOf("--id") + 1], launched.verifier!.sessionID);
    const text = command[command.indexOf("--command") + 1];
    assert.match(text, /Do not start paid\/provider journeys/);
    assert.match(text, /No serving deployment is required/);
    assert.match(text, /actual CI evidence \(kind: ci\), not local tests or estimates/);
    assert.doesNotMatch(text, /All acceptance must be proven locally/);
    assert.match(text, /create native goals/);
    assert.doesNotMatch(text, /Persistent goal \(Codex only\)/);
  }
});

test("managed investigation CLI pins observed source and verifies without any PR lookup", async t => {
  const { directory, read, store } = fixture(t);
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(directory, ["init", "-b", "main"]);
  writeFileSync(join(directory, ".workit.yml"), JSON.stringify({ codingAgents: null, provider: "github", default: "fixture",
    agents: { fixture: { command: "fixture-implementer", weight: 1 } },
    launch: { target: "banyan", logFile: join(directory, "launch.log") },
    worktree: { copyEnv: false, baseBranch: "main" }, lifecycle: { verification: "deployed",
      deploymentTargets: { backup: { probe: ["fixture-probe"], environment: "lab", target: "backup" } } } }));
  git(directory, ["add", ".workit.yml"]);
  const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit"];
  git(directory, [...commit, "-m", "fixture source"]);
  git(directory, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./cli.ts", import.meta.url)),
    "--managed", "--delivery", "investigation", "--deployment-target", "backup", "--verification", "local", "--agent", "fixture", "--none", "23"],
    { cwd: directory, stdio: "pipe", env: process.env });
  const job = store.list()[0];
  const command = read().calls.find((call: string[]) => call[1] === "session" && call[2] === "new");
  const promptFile = command[command.indexOf("--command") + 1].match(/cat '([^']+)'/)[1];
  t.after(() => rmSync(promptFile, { force: true }));
  const prompt = readFileSync(promptFile, "utf8");
  assert.doesNotMatch(prompt, /Superdog|commit and push|create_goal/);
  assert.match(prompt, /Investigate the pinned source/);
  assert.equal(job.config.delivery, "investigation"); assert.equal(job.config.deploymentTarget, "backup");
  assert.equal(job.observedSourceSha, git(job.worktree, ["rev-parse", "HEAD"]).toString().trim());
  store.update(job.id, current => { current.stage = "verifying"; });
  const value = { jobID: job.id, issueURL: issue.url, acHash: job.acHash, sourceSha: job.observedSourceSha, checkedAt: new Date().toISOString(),
    reviewer: { runID: "independent-investigator", independent: true }, criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [{ kind: "test", reference: "artifact://investigation", observed: "Finding reproduced" }] })) };
  const path = join(directory, "report.json"); writeFileSync(path, JSON.stringify(value));
  t.mock.method(console, "log", () => {});
  await lifecycleCLI(["job", "verify", job.id, "--report", path]);
  assert.equal(store.get(job.id).stage, "verified");
  assert.ok(read().calls.every((call: string[]) => !(call[0] === "gh" && call[1] === "pr")));
  git(job.worktree, [...commit, "--allow-empty", "-m", "changed observation"]);
  await assert.rejects(lifecycleCLI(["job", "closeout", job.id]), /Investigation source changed/);
  assert.equal(store.get(job.id).stage, "verifying");
});


test("queue CLI creates a paused plan and the ordinary heartbeat launches its reserved issue exactly once", async t => {
  const { directory, file, read, store } = fixture(t);
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git(["init", "-b", "main"]);
  writeFileSync(join(directory, ".workit.yml"), JSON.stringify({ codingAgents: null, provider: "github", default: "fixture",
    agents: { fixture: { command: "fixture-implementer", weight: 1 } },
    launch: { target: "banyan", dependencies: "none", logFile: join(directory, "launch.log"), instructions: [] },
    worktree: { copyEnv: false, baseBranch: "main" }, lifecycle: { verification: "local" } }));
  git(["add", ".workit.yml"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture queue source"]);
  git(["remote", "add", "origin", "https://github.com/example/project.git"]);
  writeFileSync(file, JSON.stringify({ issue: { ...issue, state: "OPEN" }, source, calls: [] }));
  const manifest = join(directory, "plan.json");
  writeFileSync(manifest, JSON.stringify({ title: "Fixture queue", outcome: "Complete the fixture issue", deadline: new Date(Date.now() + 3600_000).toISOString(),
    maxConcurrent: 1, maxStarts: 1, maxContinuations: 1, items: [{ key: "fixture", repo: directory, issue: "23", agent: "fixture" }] }));
  const cli = (...args: string[]) => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./cli.ts", import.meta.url)), ...args],
    { cwd: directory, encoding: "utf8", stdio: "pipe", env: process.env });
  const queued = JSON.parse(cli("queue", "create", manifest));
  assert.equal(queued.state, "paused"); assert.equal(store.list().length, 0);
  cli("tick"); assert.equal(store.list().length, 0);
  cli("queue", "start", queued.id, "--expected-revision", String(queued.revision));
  cli("tick"); cli("tick");
  assert.equal(store.list().length, 1); assert.equal(store.list()[0].queue?.id, queued.id);
  const status = JSON.parse(cli("queue", "status", queued.id));
  assert.equal(status.items[0].state, "launched"); assert.equal(status.starts, 1);
  assert.equal(read().calls.filter((call: string[]) => call[0] === "banyanctl" && call[1] === "session" && call[2] === "new").length, 1);
});

test("managed-correction: CI-only profile correction is guarded, retains holds and accepts only a fresh independent CI report", async t => {
  const { directory, file, read, store } = fixture(t);
  const ciIssue = { ...issue, body: "## Acceptance Criteria\n- [ ] `[test:coverage-and-gates]` `node --test .github/scripts/deploy-test-shard.test.mjs .github/scripts/model-gateway-production-workflow.test.mjs .github/scripts/conductor-production-test-workflow.test.mjs` 通过；覆盖 agent 与 gateway inventory 恰好一次、分片失败/跳过时阻止部署以及目标选择。\n- [ ] `[ci:shard-runtime]` 在可用的非生产 CI 验证中执行所有新增分片，记录 source SHA、每片耗时及结论，确认完整覆盖并无 300 秒超时；不能以估算替代实际运行证据。" };
  const output: string[] = [];
  t.mock.method(console, "log", (value: string) => output.push(value));
  for (const stage of ["needs-you", "paused"] as const) {
    const currentIssue = { ...ciIssue, url: `${issue.url}-${stage}` };
    const job = createJob({ issue: currentIssue, repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
      config: { deploymentProbe: ["unrelated-serving-probe"] }, now: new Date(Date.now() - 60_000) });
    job.stage = stage; job.holdDetail = "Owner hold: inspect before resuming";
    job.pr = "https://github.com/example/project/pull/42"; job.mergeSha = source;
    store.insert(job);
    const setIssue = (body: string) => writeFileSync(file, JSON.stringify({ ...read(), issue: { ...currentIssue, body } }));
    setIssue(currentIssue.body);
    await lifecycleCLI(["job", "acceptance", job.id]);
    const plan = JSON.parse(output.at(-1)!);
    assert.equal(plan.profile, "deployed"); assert.equal(plan.localEligible, true);
    assert.equal(plan.current.acHash, job.acHash);
    const correct = (revision: number, hash: string) => lifecycleCLI(["job", "acceptance", job.id, "--profile", "local",
      "--reason", "CI-only ACs require real CI evidence but no serving deployment", "--expected-revision", String(revision), "--expected-ac-hash", hash]);
    await assert.rejects(correct(job.revision + 1, plan.current.acHash), /revision mismatch/);
    await assert.rejects(correct(job.revision, "stale"), /AC binding is stale/);
    assert.deepEqual(store.get(job.id), job);
    for (const requirement of [
      "`[deploy:runtime]` Run the production journey.",
      "`[test:runtime]` Tests cover `node --test ./production.test.mjs --env='production'`.",
      "`[human:owner]` Owner accepts the result.",
    ]) {
      setIssue(currentIssue.body + `\n- [ ] ${requirement}`);
      await lifecycleCLI(["job", "acceptance", job.id]);
      const changed = JSON.parse(output.at(-1)!);
      assert.equal(changed.localEligible, false);
      await assert.rejects(correct(job.revision, changed.current.acHash), /cannot bypass/);
      assert.deepEqual(store.get(job.id), job);
    }
    setIssue(currentIssue.body);
    await correct(plan.revision, plan.current.acHash);
    const corrected = store.get(job.id);
    assert.equal(corrected.config.verification, "local");
    assert.equal(corrected.stage, stage); assert.equal(corrected.holdDetail, job.holdDetail);
    assert.equal(corrected.nextWakeAt, undefined); assert.equal(corrected.deployment, undefined);
    assert.equal(corrected.acceptanceHistory?.length, 1);
    assert.equal(corrected.acceptanceHistory![0].acHash, job.acHash);
    const report = { jobID: job.id, issueURL: currentIssue.url, acHash: job.acHash, mergeSha: source,
      checkedAt: new Date().toISOString(), reviewer: { runID: "independent-ci-verifier", independent: true }, criteria: [
        { label: "coverage-and-gates", status: "pass", evidence: [{ kind: "test", reference: "artifact://targeted-tests", observed: "All targeted tests passed" }] },
        { label: "shard-runtime", status: "pass", evidence: [{ kind: "ci", reference: "https://github.com/example/project/actions/runs/40", observed: `All 40 shards passed on ${source}; actual durations below 300s` }] },
      ] };
    const reportPath = join(directory, `ci-report-${stage}.json`);
    const submit = (value: unknown) => {
      writeFileSync(reportPath, JSON.stringify(value));
      return lifecycleCLI(["job", "verify", job.id, "--report", reportPath]);
    };
    await assert.rejects(submit(report), /must be in verifying/);
    assert.equal(store.get(job.id).stage, stage);
    await lifecycleCLI(["job", "resume", job.id, "--detail", "Inspected owner hold; explicitly released for independent CI acceptance"]);
    assert.equal(store.get(job.id).stage, "verifying");
    await assert.rejects(submit({ ...report, checkedAt: job.createdAt }), /verification time/);
    await assert.rejects(submit({ ...report, acHash: "stale" }), /binding is stale/);
    await assert.rejects(submit({ ...report, mergeSha: "b".repeat(40) }), /bound source/);
    await assert.rejects(submit({ ...report, reviewer: { runID: job.sessionID, independent: true } }), /independent reviewer/);
    await assert.rejects(submit({ ...report, criteria: report.criteria.slice(0, 1) }), /every AC/);
    const localOnly = structuredClone(report); localOnly.criteria[1].evidence[0].kind = "test";
    await assert.rejects(submit(localOnly), /actual CI evidence/);
    await submit(report);
    assert.equal(store.get(job.id).stage, "verified");
    assert.equal(read().projection.state, "verified");
    assert.equal(read().issue.body, currentIssue.body);
    assert.ok(read().calls.every((call: string[]) => call[0] === "gh" ? ["pr", "issue"].includes(call[1]) && call[2] === "view"
      : call[1] === "workflow" && call[2] === "set"));
  }
});
