import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acceptance, assertLocalAcceptance, createJob, JobStore, tick, validateReport, type VerificationReport } from "./lifecycle.js";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { lifecycleCLI } from "./lifecycle-cli.js";

// Synthetic published-source investigation; no incident or customer evidence.
const body = `## Acceptance Criteria
- [ ] \`[query:attribution]\` 从固定已发布材料核对历史 production 归因；证据不足时明确记录未证。
- [ ] \`[query:versions]\` Correlate the historical production installation and serving version from published sources; record any unproven alignment.
- [ ] \`[query:settlement]\` 核对下游结算记录，并区分已证事实与材料中无法证明的结论。
`;
const sources = ["https://github.com/example/project/commit/" + "b".repeat(40), "https://example.invalid/published/record-2025-01-01"];
const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit"];
const fake = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const file=process.env.WORKIT_FIXTURE_FILE,f=JSON.parse(fs.readFileSync(file,'utf8'));
const name=path.basename(process.argv[1]),args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
f.calls.push([name,...args]);fs.writeFileSync(file,JSON.stringify(f));
let output;
if(name==='probe') { process.stderr.write('Unauthorized fixture deployment probe'); process.exit(99); }
else if(name==='gh') { process.stderr.write('Historical investigation must not read PRs'); process.exit(98); }
else if(name==='linear'&&args[0]==='issue'&&args[1]==='view') output={...f.issue,labels:[]};
else if(name==='banyanctl'&&args[0]==='session'&&args[1]==='list') output={workflowProtocol:1,sessions:[f.session].filter(Boolean)};
else if(name==='banyanctl'&&args[0]==='workflow'&&args[1]==='set') output={ok:true};
else if(name==='banyanctl'&&args[0]==='workflow'&&args[1]==='wake') output={ok:true};
else if(name==='banyanctl'&&args[0]==='session'&&args[1]==='new') output={ok:true};
else { process.stderr.write('Unexpected fixture command: '+name+' '+args.join(' ')); process.exit(97); }
process.stdout.write(JSON.stringify(output));
`;

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "workit-historical-"));
  const savedEnv = { ...process.env };
  const issue = { id: "fixture-issue", identifier: "TASK-31", title: "Published historical investigation", description: body,
    url: "https://linear.app/fixture/issue/TASK-31", updatedAt: "revision-1", archivedAt: null, snoozedUntilAt: null,
    state: { id: "review", name: "In Review", type: "started", position: 1 },
    labels: { nodes: [] as Array<{ name: string }>, pageInfo: { hasNextPage: false } },
    team: { id: "fixture-team", states: { nodes: [{ id: "done", name: "Accepted", type: "completed", position: 2 }], pageInfo: { hasNextPage: false } } } };
  const effects = { writes: [] as Array<{ description?: string; stateId?: string }>, unreadable: 0, loseReadback: false };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (payload.query.includes("mutation CloseoutUpdate")) {
      const input = payload.variables.input as { description?: string; stateId?: string };
      assert.equal(payload.variables.id, issue.id);
      effects.writes.push(input);
      if (input.description !== undefined) issue.description = input.description;
      if (input.stateId !== undefined) { assert.equal(input.stateId, "done"); issue.state = issue.team.states.nodes[0]; }
      issue.updatedAt = "revision-" + (effects.writes.length + 1);
      if (effects.loseReadback) { effects.unreadable++; effects.loseReadback = false; res.writeHead(503); res.end("response lost"); return; }
      res.end(JSON.stringify({ data: { issueUpdate: { success: true } } }));
    } else {
      if (effects.unreadable) { effects.unreadable--; res.writeHead(503); res.end("readback unavailable"); return; }
      res.end(JSON.stringify({ data: { issue } }));
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    await new Promise<void>(done => server.close(() => done()));
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  for (const name of ["gh", "linear", "banyanctl", "probe"]) writeFileSync(join(directory, name), fake, { mode: 0o700 });
  const file = join(directory, "fixture.json");
  writeFileSync(file, JSON.stringify({ issue, calls: [] }));
  Object.assign(process.env, { PATH: directory + ":" + process.env.PATH, LINEAR_API_KEY: "isolated-fixture-key",
    WORKIT_FIXTURE_FILE: file, WORKIT_STATE_DIR: join(directory, "state"), WORKIT_BANYANCTL: join(directory, "banyanctl") });
  writeFileSync(join(directory, ".workit.yml"), JSON.stringify({ codingAgents: null, provider: "linear", default: "fixture",
    linear: { apiUrl: `http://127.0.0.1:${port}/graphql` },
    agents: { fixture: { command: "fixture-implementer", weight: 1 } },
    launch: { target: "banyan", logFile: join(directory, "launch.log") },
    worktree: { copyEnv: false, baseBranch: "main" },
    lifecycle: { verification: "deployed", deploymentProbe: [join(directory, "probe")], verifier: { enabled: false } } }));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  git(directory, ["init", "-b", "main"]); git(directory, ["add", ".workit.yml"]);
  git(directory, [...commit, "-m", "isolated source"]); git(directory, ["remote", "add", "origin", "https://github.com/example/project.git"]);
  const sourcesPath = join(directory, "sources.json"); writeFileSync(sourcesPath, JSON.stringify(sources));
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const launch = async (historical: boolean) => {
    await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cliPath, "--managed", "--agent", "fixture", "--none",
      ...(historical ? ["--delivery", "investigation", "--acceptance", "local", "--historical-sources", sourcesPath] : []), "TASK-31"],
    { cwd: directory, env: process.env });
    const f = JSON.parse(readFileSync(file, "utf8"));
    const command = f.calls.find((call: string[]) => call[1] === "session" && call[2] === "new");
    const promptPath = command[command.indexOf("--command") + 1].match(/cat '([^']+)'/)[1];
    t.after(() => rmSync(promptPath, { force: true }));
    return readFileSync(promptPath, "utf8");
  };
  const store = new JobStore();
  t.mock.method(console, "log", () => {});
  const cli = (...args: string[]) => lifecycleCLI(["job", ...args]);
  const report = (): VerificationReport => {
    const job = store.list()[0];
    return { jobID: job.id, issueURL: job.issue.url, acHash: job.acHash, sourceSha: job.observedSourceSha,
      checkedAt: new Date().toISOString(), reviewer: { runID: "independent-historical-fixture", independent: true },
      criteria: job.acLabels.map((label, i) => ({ label, status: "pass", evidence: [{ kind: "historical", reference: sources[i % sources.length],
        observed: "Published record inspected: supported facts and the expressly permitted unproven conclusion are distinguished." }] })) };
  };
  const reportPath = join(directory, "report.json");
  const verify = async (value = report()) => { writeFileSync(reportPath, JSON.stringify(value)); await cli("verify", store.list()[0].id, "--report", reportPath); };
  const assertNoProbe = () => {
    const calls: string[][] = JSON.parse(readFileSync(file, "utf8")).calls;
    assert.equal(calls.filter(call => call[0] === "probe").length, 0);
    assert.equal(calls.filter(call => call[0] === "gh").length, 0);
  };
  return { directory, issue, effects, store, sourcesPath, cli, launch, git, report, verify, assertNoProbe, file };
}

test("historical CLI launch, independent partial/complete reports and uncertain closeout retry never probe deployment", async t => {
  const f = await fixture(t);
  const prompt = await f.launch(true);
  let job = f.store.list()[0];
  assert.deepEqual(job.config.historicalSources, sources);
  writeFileSync(f.sourcesPath, JSON.stringify(["artifact://changed-manifest"]));
  assert.equal(job.config.delivery, "investigation"); assert.equal(job.config.verification, "local");
  assert.equal(job.observedSourceSha, f.git(job.worktree, ["rev-parse", "HEAD"]));
  assert.match(prompt, /never access runtime to submit a report/);
  assert.doesNotMatch(prompt, /Superdog|commit and push|create_goal/);
  await assert.rejects(f.cli("checkpoint", job.id, "--stage", "waiting-deploy", "--detail", "Unnecessary wait"), /directly to verifying/);
  await f.cli("checkpoint", job.id, "--stage", "verifying", "--detail", "Published findings ready");
  const partial = f.report(); partial.criteria = partial.criteria.slice(0, 2); partial.criteria[1].status = "blocked"; partial.criteria[1].evidence = [];
  f.effects.loseReadback = true;
  await assert.rejects(f.verify(partial), /GraphQL|HTTP|503/);
  job = f.store.get(job.id);
  assert.deepEqual(job.verification, partial); assert.equal(job.stage, "verifying");
  assert.equal(job.closeout?.checklistConfirmed, false); assert.equal(f.effects.writes.length, 1);
  assert.equal(f.issue.state.type, "started");
  await f.cli("closeout", job.id);
  assert.equal(f.effects.writes.length, 1, "applied uncertain write is read back, not replayed");
  assert.match(f.issue.description, /\[x\] `\[query:attribution\]`/);
  assert.match(f.issue.description, /\[ \] `\[query:versions\]`/);
  assert.equal(f.store.get(job.id).stage, "verifying");
  const mixed = f.report(); mixed.criteria[0].status = "fail"; mixed.criteria[2].status = "blocked"; mixed.criteria[2].evidence = [];
  await f.verify(mixed);
  assert.match(f.issue.description, /\[ \] `\[query:attribution\]`/);
  assert.match(f.issue.description, /\[x\] `\[query:versions\]`/);
  assert.equal(f.issue.state.type, "started");
  // Heartbeat preflight and manual verifier handoff share the no-serving scope.
  const state = JSON.parse(readFileSync(f.file, "utf8")); state.session = { id: job.sessionID, cwd: job.worktree, status: "idle" };
  writeFileSync(f.file, JSON.stringify(state));
  await tick(f.store, new BanyanLifecycleAdapter(), { jobID: job.id, now: new Date(f.store.get(job.id).nextWakeAt!) });
  await f.verify(); await f.cli("closeout", job.id);
  job = f.store.get(job.id);
  assert.equal(job.stage, "verified"); assert.equal(f.issue.state.type, "completed");
  assert.equal((f.issue.description.match(/\[x\]/g) ?? []).length, 3);
  assert.equal(acceptance(f.issue.description).acHash, acceptance(body).acHash);
  assert.equal(job.pr, undefined); assert.equal(job.mergeSha, undefined); assert.equal(job.deployment, undefined);
  assert.ok(job.verification!.criteria.every(item => item.evidence.every(entry => entry.kind === "historical" && !entry.deployment)));
  assert.deepEqual(job.config.historicalSources, sources, "launch snapshots fixed references instead of rereading a mutable manifest");
  f.assertNoProbe();
});

test("historical CLI correction binds current revision/ACs, clean source and audit while retaining owner holds", async t => {
  const f = await fixture(t); await f.launch(false);
  const job = f.store.list()[0];
  await f.cli("checkpoint", job.id, "--stage", "needs-you", "--detail", "Original control session must release hold");
  const correct = (revision: number, hash = job.acHash) => f.cli("acceptance", job.id, "--profile", "local", "--delivery", "investigation",
    "--historical-sources", f.sourcesPath, "--reason", "Only fixed published historical facts are required by unchanged query ACs",
    "--expected-revision", String(revision), "--expected-ac-hash", hash);
  const held = f.store.get(job.id);
  await assert.rejects(correct(held.revision - 1), /revision mismatch/);
  await assert.rejects(correct(held.revision, "stale"), /AC binding is stale/);
  assert.deepEqual(f.store.get(job.id), held);
  writeFileSync(join(job.worktree, ".workit.yml"), "dirty source");
  await assert.rejects(correct(held.revision), /Command failed/);
  f.git(job.worktree, ["restore", ".workit.yml"]);
  await correct(held.revision);
  const changed = f.store.get(job.id);
  assert.equal(changed.stage, "needs-you"); assert.equal(changed.holdDetail, held.holdDetail); assert.equal(changed.nextWakeAt, undefined);
  assert.equal(changed.acHash, job.acHash); assert.equal(changed.issue.body, body);
  assert.equal(changed.observedSourceSha, f.git(job.worktree, ["rev-parse", "HEAD"]));
  const audit = changed.acceptanceHistory!.at(-1)!;
  assert.deepEqual(audit.toHistoricalSources, sources); assert.equal(audit.fromDelivery, "implementation");
  assert.equal(audit.oldAcHash, job.acHash); assert.equal(audit.acHash, job.acHash); assert.equal(audit.revision, changed.revision);
  await assert.rejects(f.verify(), /must be in verifying/);
  await f.cli("acceptance", job.id, "--historical-sources", "none", "--profile", "deployed", "--reason", "Explicitly remove fixed-source scope",
    "--expected-revision", String(changed.revision), "--expected-ac-hash", changed.acHash);
  const removed = f.store.get(job.id);
  assert.equal(removed.config.historicalSources, undefined); assert.equal(removed.stage, "needs-you");
  assert.deepEqual(removed.acceptanceHistory!.at(-1)!.fromHistoricalSources, sources);
  await correct(removed.revision);
  await f.cli("resume", job.id, "--detail", "Fixture owner explicitly releases hold");
  await f.cli("checkpoint", job.id, "--stage", "verifying", "--detail", "Historical findings ready");
  await assert.rejects(f.verify({ ...f.report(), checkedAt: job.createdAt }), /verification time/);
  await f.verify(); assert.equal(f.store.get(job.id).stage, "verified");
  f.assertNoProbe();
});

test("historical heartbeat dispatch preserves independent verifier identity and original-source guidance without probes", async t => {
  const f = await fixture(t); await f.launch(true);
  const job = f.store.list()[0];
  const configPath = join(f.directory, ".workit.yml");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.codingAgents = { agents: { "fixture-review": { command: "fixture-review", tags: ["review"], weight: 1 } } };
  config.lifecycle.verifier = { enabled: true, agent: "fixture-review", concurrency: 1, maxAttempts: 1, timeoutSeconds: 60 };
  writeFileSync(configPath, JSON.stringify(config));
  const state = JSON.parse(readFileSync(f.file, "utf8")); state.session = { id: job.sessionID, cwd: job.worktree, status: "idle" };
  writeFileSync(f.file, JSON.stringify(state));
  await f.cli("checkpoint", job.id, "--stage", "verifying", "--detail", "Ready for independent fixed-source review");
  await tick(f.store, new BanyanLifecycleAdapter(), { jobID: job.id, now: new Date(f.store.get(job.id).nextWakeAt!) });
  const run = f.store.get(job.id).verifier!;
  assert.equal(run.state, "running");
  const calls: string[][] = JSON.parse(readFileSync(f.file, "utf8")).calls;
  const command = calls.find(call => call[1] === "session" && call[2] === "new" && call.includes(run.id))!;
  assert.match(command[command.indexOf("--command") + 1], /Do not access current runtime/);
  assert.match(command[command.indexOf("--command") + 1], /kind historical/);
  await assert.rejects(f.verify(), /existing verifier/);
  await f.verify({ ...f.report(), reviewer: { runID: run.id, independent: true } });
  assert.equal(f.store.get(job.id).stage, "verified");
  assert.equal(f.store.get(job.id).verifier?.state, "accepted");
  f.assertNoProbe();
});

test("historical report and closeout preserve source/AC/reviewer/tracker gates before any tracker write", async t => {
  const f = await fixture(t); await f.launch(true);
  const job = f.store.list()[0]; await f.cli("checkpoint", job.id, "--stage", "verifying", "--detail", "Ready");
  const valid = f.report();
  for (const invalid of [
    { ...valid, sourceSha: "c".repeat(40) }, { ...valid, acHash: "stale" },
    { ...valid, reviewer: { runID: job.sessionID, independent: true } },
    { ...valid, criteria: valid.criteria.map(item => ({ ...item, evidence: [{ kind: "estimate", reference: sources[0], observed: "Local estimate" }] })) },
    { ...valid, criteria: valid.criteria.map(item => ({ ...item, evidence: [{ kind: "historical", reference: "artifact://summary-only", observed: "No original" }] })) },
    { ...valid, criteria: valid.criteria.map(item => ({ ...item, evidence: [{ kind: "journey", reference: sources[0], observed: "Fabricated runtime journey" }] })) },
  ]) await assert.rejects(f.verify(invalid));
  f.issue.description = body.replace("下游结算记录", "不同的验收要求");
  await assert.rejects(f.verify(), /AC binding/); f.issue.description = body;
  f.issue.labels.nodes = [{ name: "owner-hold" }];
  await assert.rejects(f.verify(), /owner hold/); f.issue.labels.nodes = [];
  const id = f.issue.identifier; f.issue.identifier = "TASK-OTHER";
  await assert.rejects(f.verify(), /identity changed/); f.issue.identifier = id;
  writeFileSync(join(job.worktree, ".workit.yml"), "dirty");
  await assert.rejects(f.verify()); f.git(job.worktree, ["restore", ".workit.yml"]);
  f.git(job.worktree, [...commit, "--allow-empty", "-m", "different source"]);
  await assert.rejects(f.verify(), /source changed/);
  assert.equal(f.effects.writes.length, 0); f.assertNoProbe();
});

test("historical contract cannot narrow current runtime/deploy/human ACs, or replace required CI evidence", () => {
  const config = { delivery: "investigation" as const, verification: "local" as const, historicalSources: sources };
  const make = (currentBody: string, overrides = {}) => createJob({ issue: { backend: "github", identifier: "31", title: "Fixture", body: currentBody,
    url: "https://github.com/example/project/issues/31", labels: [] }, repoRoot: "/fixture", worktree: "/fixture", githubRepo: "example/project",
    agent: "fixture", config: { ...config, ...overrides }, observedSourceSha: "a".repeat(40) });
  for (const criterion of [
    "[deploy:runtime] Historical report plus a deployed journey.",
    "[query:runtime] Verify the current production serving version.",
    "[query:runtime] Run the production journey and record the serving version.",
    "[query:runtime] Verify production runtime behavior.",
    "[query:runtime] The production serving version must match the merged source.",
    "[query:runtime] Probe production health.",
    "[query:runtime] 当前 production serving version 与目标版本对齐。",
    "[query:runtime] 调用生产服务验证运行行为。",
    "[human:owner] Owner accepts the historical report.",
    "[query:runtime] Obtain human acceptance of the report.",
    "[query:runtime] node smoke.mjs --env=production passes.",
    "[code:runtime] The production serving version aligns with the target; [query] metadata is also recorded.",
  ]) assert.throws(() => make(body + "- [ ] " + criterion), /cannot bypass/, criterion);
  assert.throws(() => make(body, { delivery: "implementation" }), /require investigation/);
  assert.throws(() => make(body, { verification: "deployed", deploymentProbe: ["probe"] }), /local acceptance/);
  for (const refs of [[], [""], [sources[0], sources[0]]]) assert.throws(() => make(body, { historicalSources: refs }), /Historical sources/);
  assert.throws(() => assertLocalAcceptance(body), /cannot bypass/, "no implicit historical classification");
  assert.doesNotThrow(() => make(body + "- [ ] `[query:source-state]` Current published evidence records historical production serving version facts."));
  // Reuse #27/#28's CI-only contract: artifacts mention production, real CI remains required.
  const ciBody = body + "- [ ] `[test:workflow]` `node --test .github/scripts/production-workflow.test.mjs` passes.\n" +
    "- [ ] `[ci:shards]` All shards pass in non-production CI; record measured durations.";
  const job = make(ciBody);
  const value: VerificationReport = { jobID: job.id, issueURL: job.issue.url, acHash: job.acHash, sourceSha: job.observedSourceSha,
    checkedAt: new Date().toISOString(), reviewer: { runID: "independent", independent: true },
    criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [{ kind: "historical", reference: sources[0], observed: "Published record" }] })) };
  assert.throws(() => validateReport(job, value, ciBody), /actual CI evidence/);
  value.criteria.at(-1)!.evidence = [{ kind: "ci", reference: "https://github.com/example/project/actions/runs/31", observed: "Actual shards passed with measured durations" }];
  assert.doesNotThrow(() => validateReport(job, value, ciBody));
});
