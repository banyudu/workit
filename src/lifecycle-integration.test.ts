import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { JobStore, acceptance, checkpoint, createJob, provenChecklist, tick, type VerificationReport } from "./lifecycle.js";
import { BanyanLifecycleAdapter, githubRepository } from "./lifecycle-adapter.js";
import { lifecycleCLI, managedInstructions } from "./lifecycle-cli.js";

const fake = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.WORKIT_FIXTURE_FILE;
const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const name = path.basename(process.argv[1]);
let output;
if (name === "banyanctl") {
  if (args[0] === "workflow" && args[1] === fixture.refusal?.operation) {
    fixture.attempts.push(value("--wake-id"));
    fs.writeFileSync(file, JSON.stringify(fixture));
    process.stdout.write(JSON.stringify({ok: false, error: {code: fixture.refusal.code ?? "workflow_refused", message: fixture.refusal.message}}));
    process.stderr.write("banyanctl: server returned HTTP 409\n");
    process.exit(75);
  }
  if (args[0] === "session" && args[1] === "list") output = {workflowProtocol: 1, sessions: [fixture.session]};
  else if (args[1] === "set") {
    const previous = fixture.session.workflow || {};
    fixture.session.workflow = {owner: value("--owner"), jobID: value("--job-id"),
      revision: Number(value("--revision")), state: value("--state"), wake: previous.wake};
    output = {ok: true};
  } else if (args[1] === "wake") {
    const wakeID = value("--wake-id");
    if (fixture.session.workflow.wake?.id !== wakeID) fixture.wakes.push(wakeID);
    fixture.session.workflow.wake = {id: wakeID, status: "delivered"};
    output = {ok: true};
  } else process.exit(2);
} else if (name === "gh") {
  if (args[0] === "pr") output = {state: "MERGED", headRefOid: fixture.mergeSha,
    mergeCommit: {oid: fixture.mergeSha}, updatedAt: "2026-01-02", reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN", statusCheckRollup: []};
  else if (args[0] === "api") output = {status: "ahead"};
  else if (args[0] === "issue") output = fixture.issue;
  else process.exit(2);
} else if (name === "linear") {
  if (args[1] === "view") output = fixture.issue;
  else if (args[1] === "update") {
    const state = value("--state");
    fixture.stateUpdates.push(state);
    if (state === "Done" && fixture.failDone) {
      fs.writeFileSync(file, JSON.stringify(fixture));
      process.exit(1);
    }
    if (!(state === "Done" && fixture.ignoreDone)) {
      fixture.issue.state = {name: state, type: state === "Done" ? "completed" : "started"};
    }
    output = {success: true};
  } else process.exit(2);
} else output = fixture.deployment;
fs.writeFileSync(file, JSON.stringify(fixture));
process.stdout.write(JSON.stringify(output));
`;

test("real CLI/adapters drive deployment wait, version invalidation and evidence-backed closeout using private fixtures", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-integration-"));
  writeFileSync(join(directory, ".workit.yml"), "lifecycle:\n  verifier:\n    enabled: false\n");
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ["gh", "banyanctl", "probe"]) {
    const path = join(directory, name); writeFileSync(path, fake); chmodSync(path, 0o700);
  }
  const file = join(directory, "fixture.json");
  process.env.PATH = directory + ":" + process.env.PATH;
  process.env.WORKIT_FIXTURE_FILE = file;
  process.env.WORKIT_STATE_DIR = join(directory, "state");
  process.env.WORKIT_BANYANCTL = join(directory, "banyanctl");
  const body = "## Acceptance Criteria\n- [ ] `[test:journey]` The journey passes.\n- [ ] `[code:contract]` The contract exists.";
  const issue = { backend: "github" as const, identifier: "7", number: 7,
    title: "Widget", body, labels: [], url: "https://github.com/example/project/issues/7" };
  const created = new Date(Date.now() - 120_000);
  const job = createJob({ issue, repoRoot: directory, worktree: directory, githubRepo: "example/project",
    agent: "codex", config: { deploymentProbe: [join(directory, "probe")] }, now: created });
  const store = new JobStore();
  store.insert(job);
  const mergeSha = "a".repeat(40);
  checkpoint(store, job.id, { stage: "waiting-deploy", detail: "Awaiting batch", pr: "https://github.com/example/project/pull/8", mergeSha }, created);
  const initial = { issue: { ...issue, state: "OPEN" }, mergeSha, session: { id: job.sessionID, cwd: directory, status: "idle" },
    deployment: { ready: false }, wakes: [] as string[] };
  writeFileSync(file, JSON.stringify(initial));
  const adapter = new BanyanLifecycleAdapter(join(directory, "banyanctl"));
  await adapter.requireWorkflowSupport(directory);
  await tick(store, adapter);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).wakes.length, 0);
  const fixture = JSON.parse(readFileSync(file, "utf8"));
  fixture.deployment = { ready: true, environment: "dev", target: "widget", sourceSha: "b".repeat(40), version: "version-1" };
  writeFileSync(file, JSON.stringify(fixture));
  await tick(store, adapter, { now: new Date(Date.now() + 61_000) });
  let current = store.get(job.id);
  assert.equal(current.stage, "verifying");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).wakes.length, 1);
  const report: VerificationReport = { jobID: job.id, issueURL: issue.url, acHash: job.acHash, mergeSha,
    checkedAt: new Date().toISOString(), reviewer: { runID: "independent-run", independent: true },
    deployment: current.deployment, criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [{
      kind: "journey", reference: "artifact://journey-run", observed: "Expected behavior", deployment: current.deployment,
    }] })) };
  const reportPath = join(directory, "verification.json");
  writeFileSync(reportPath, JSON.stringify(report));
  await assert.rejects(lifecycleCLI(["job", "verify", job.id, "--report", reportPath]), /close it under repository policy/);
  const moved = JSON.parse(readFileSync(file, "utf8"));
  moved.deployment.version = "version-2";
  moved.issue.state = "CLOSED";
  writeFileSync(file, JSON.stringify(moved));
  await assert.rejects(lifecycleCLI(["job", "verify", job.id, "--report", reportPath]), /Serving deployment changed/);
  assert.equal(store.get(job.id).stage, "verifying");
  moved.deployment.version = "version-1";
  writeFileSync(file, JSON.stringify(moved));
  await lifecycleCLI(["job", "verify", job.id, "--report", reportPath]);
  current = new JobStore().get(job.id);
  assert.equal(current.stage, "verified");
  assert.equal(current.nextWakeAt, undefined);
  const projected = JSON.parse(readFileSync(file, "utf8")).session.workflow;
  assert.equal(projected.state, "verified");
  assert.equal(projected.jobID, job.id);
});

test("GitHub remote normalization strips .git without losing repository scope", () => {
  assert.equal(githubRepository("git@github.com:example/project.git"), "example/project");
  assert.equal(githubRepository("https://github.com/example/project"), "example/project");
  assert.throws(() => githubRepository("https://example.invalid/project"));
});

for (const outcome of ["immediately", "after retrying a tracker failure", "after retrying an unconfirmed write"]) {
  test(`accepted Linear verification closes the issue ${outcome}`, async t => {
    const f = await linearFixture(t);
    const pending = outcome !== "immediately";
    if (pending) f.effects.modes.state = outcome.includes("unconfirmed") ? "ignore" : "reject";
    const goodRun = f.report.reviewer.runID;
    f.report.reviewer.runID = f.job.sessionID;
    await assert.rejects(f.verify(), /independent reviewer/);
    assert.deepEqual(f.effects.writes, []);
    f.report.reviewer.runID = goodRun;
    if (pending) {
      await assert.rejects(f.verify(), /state.*(failed|confirmed)/i);
      assert.equal(f.store.get(f.job.id).stage, "verifying");
      assert.equal(f.linear.state.name, "In Review");
      delete f.effects.modes.state;
      const beforeRetry = f.effects.writes.length;
      const originalBody = f.linear.description;
      f.linear.description += "\n- [ ] `[test:added]` A new requirement.\n";
      // Change an AC inside its section, rather than unrelated delivery notes.
      f.linear.description = f.linear.description.replace("Expected behavior.", "Changed behavior.");
      const adapter = new BanyanLifecycleAdapter();
      const retry = () => tick(f.store, adapter, { jobID: f.job.id, now: new Date(Date.now() + 61_000) });
      await retry();
      assert.equal(f.effects.writes.length, beforeRetry, "changed ACs invalidate automatic closure");
      f.linear.description = originalBody;
      const review = f.linear.state;
      f.linear.state = { ...review, name: "On Hold", type: "backlog" };
      await retry();
      assert.equal(f.effects.writes.length, beforeRetry, "human holds remain authoritative");
      f.linear.state = review;
      await retry();
    } else await f.verify();
    assert.equal(f.linear.state.type, "completed");
    assert.equal(f.store.get(f.job.id).stage, "verified");
    assert.equal(f.store.get(f.job.id).trackerDone, true);
  });
}

test("a deployment-blocked local issue can correct its own mode and complete without executing a probe", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-local-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ["gh", "banyanctl"]) {
    writeFileSync(join(directory, name), fake, { mode: 0o700 });
  }
  const file = join(directory, "fixture.json");
  Object.assign(process.env, { PATH: directory + ":" + process.env.PATH, WORKIT_FIXTURE_FILE: file,
    WORKIT_STATE_DIR: join(directory, "state"), WORKIT_BANYANCTL: join(directory, "banyanctl") });
  const logs: string[] = [];
  t.mock.method(console, "log", (value: string) => logs.push(value));
  const issue = { backend: "github" as const, identifier: "7", number: 7,
    title: "Local CLI", body: "## Acceptance Criteria\n- [ ] `[test:local]` Local tests pass.\n- [ ] `[code:layout]` Output uses the new layout.",
    labels: [], url: "https://github.com/example/project/issues/7" };
  const job = createJob({ issue, repoRoot: directory, worktree: directory, githubRepo: "example/project",
    agent: "codex", config: { deploymentProbe: [join(directory, "must-not-run")] } });
  const store = new JobStore();
  store.insert(job);
  const mergeSha = "a".repeat(40);
  checkpoint(store, job.id, { stage: "needs-you", detail: "Local feature blocked by inherited deployment mode",
    pr: "https://github.com/example/project/pull/8", mergeSha });
  writeFileSync(file, JSON.stringify({ issue: { ...issue, state: "CLOSED" }, mergeSha,
    session: { id: job.sessionID, cwd: directory, status: "idle" }, wakes: [] }));
  await lifecycleCLI(["job", "checkpoint", job.id, "--stage", "needs-you", "--verification", "local",
    "--detail", "All ACs have local test/code evidence; deployment is outside scope"]);
  assert.equal(store.get(job.id).stage, "needs-you");
  assert.equal(store.get(job.id).config.verification, "local");
  assert.equal(store.get(job.id).nextWakeAt, undefined);
  await lifecycleCLI(["job", "checkpoint", job.id, "--stage", "needs-you", "--verification", "deployed", "--detail", "Restore mode to test atomic resume correction"]);
  const held = store.get(job.id);
  await assert.rejects(lifecycleCLI(["job", "resume", job.id, "--verification", "local"]), /--detail/);
  await assert.rejects(lifecycleCLI(["job", "resume", job.id, "--verification", "invalid", "--detail", "Invalid correction"]), /local or deployed/);
  assert.deepEqual(store.get(job.id), held);
  await lifecycleCLI(["job", "resume", job.id, "--verification", "local", "--detail", "All ACs have local test/code acceptance"]);
  const resumed = new JobStore().get(job.id);
  assert.equal(resumed.stage, "verifying");
  assert.equal(resumed.config.verification, "local");
  assert.equal(resumed.sessionID, job.sessionID);
  assert.equal(resumed.deployment, undefined);
  const report: VerificationReport = { jobID: job.id, issueURL: issue.url, acHash: job.acHash, mergeSha,
    checkedAt: new Date().toISOString(), reviewer: { runID: job.sessionID, independent: true },
    criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [{
      kind: "test", reference: "artifact://local-results", observed: "Expected CLI output and passing tests on the merge commit",
    }] })) };
  const reportPath = join(directory, "report.json");
  writeFileSync(reportPath, JSON.stringify(report));
  await assert.rejects(lifecycleCLI(["job", "verify", job.id, "--report", reportPath]), /independent reviewer/);
  report.reviewer.runID = "independent-local-verifier";
  writeFileSync(reportPath, JSON.stringify(report));
  await lifecycleCLI(["job", "verify", job.id, "--report", reportPath]);
  assert.equal(store.get(job.id).stage, "verified");
  assert.equal(store.get(job.id).nextWakeAt, undefined);
  assert.equal(JSON.parse(logs.at(-1)!).verification.deployment, undefined);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).session.workflow.state, "verified");
});

test("real adapter refusals survive restart, appear in status and heartbeat logs, and retry the same wake", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-refusal-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  const cli = join(directory, "banyanctl");
  writeFileSync(cli, fake, { mode: 0o700 });
  const file = join(directory, "fixture.json");
  Object.assign(process.env, { WORKIT_FIXTURE_FILE: file, WORKIT_STATE_DIR: join(directory, "state"), WORKIT_BANYANCTL: cli });
  const logs: string[] = [];
  t.mock.method(console, "log", (value: string) => logs.push(value));
  const store = new JobStore();
  const adapter = new BanyanLifecycleAdapter(cli);
  for (const [index, [operation, code]] of [["set", "workflow_refused"], ["wake", "workflow_refused"],
    ["wake", "workflow_wake_refused"]].entries()) {
    const message = operation === "set" ? "stale workflow revision" : "workflow is needs-you";
    const job = createJob({ issue: { backend: "github", identifier: String(index), title: "Resume", labels: [],
      url: `https://github.com/example/project/issues/${index + 1}`,
      body: "## Acceptance Criteria\n- [ ] `[test:retry]` Retry succeeds.\n- [ ] `[code:detail]` Refusal is visible." },
      repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "codex",
      config: { verification: "local", intervalSeconds: 17, maxWakeups: 1, maxErrors: 2 },
      now: new Date(Date.now() - 60_000) });
    store.insert(job);
    writeFileSync(file, JSON.stringify({ session: { id: job.sessionID, cwd: directory, status: "idle" },
      refusal: { operation, code, message }, attempts: [], wakes: [] }));
    await lifecycleCLI(["tick", "--job", job.id]);
    assert.deepEqual(JSON.parse(logs.at(-1)!), [{ id: job.id, result: "workflow-refused", detail: `${code}: ${message}` }]);
    await lifecycleCLI(["job", "status", job.id]);
    assert.equal(JSON.parse(logs.at(-1)!).detail, `${code}: ${message}`);
    const current = new JobStore().get(job.id);
    assert.equal(current.stage, "implementing");
    assert.equal(current.errors, 0);
    assert.equal(current.wakeups, 0);
    assert.equal(current.nextWakeAt, new Date(Date.parse(current.updatedAt) + 17_000).toISOString());
    assert.ok(current.wake);
    await tick(store, adapter, { now: new Date(current.nextWakeAt!), jobID: job.id });
    assert.equal(store.get(job.id).wake!.id, current.wake.id);
    assert.equal(store.get(job.id).stage, "implementing");
    const fixture = JSON.parse(readFileSync(file, "utf8"));
    delete fixture.refusal;
    writeFileSync(file, JSON.stringify(fixture));
    await tick(store, adapter, { now: new Date(store.get(job.id).nextWakeAt!), jobID: job.id });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).wakes, [current.wake.id]);
    assert.equal(store.get(job.id).wake, undefined);
    assert.equal(store.get(job.id).wakeups, 1);
  }
});

// A real HTTP GraphQL fixture plus private gh/Banyan executables and SQLite.
async function linearFixture(t: import("node:test").TestContext, human = false) {
  const directory = mkdtempSync(join(tmpdir(), "workit-linear-closeout-"));
  const savedEnv = { ...process.env };
  const body = "## Context\nKeep the operator's notes.\n- [ ] Unrelated task\n\n## Acceptance Criteria\n" +
    `- [ ] \`[${human ? "human" : "test"}:behavior]\` Expected behavior.\n` +
    "- [ ] `[code:contract]` Documented contract.\n\n## Delivery\nKeep this section.\n";
  const states = [
    { id: "cancel-id", name: "Done", type: "canceled", position: 0 },
    { id: "duplicate-id", name: "Duplicate", type: "duplicate", position: 1 },
    { id: "team-a-complete", name: "Accepted", type: "completed", position: 2 },
    { id: "team-a-released", name: "Released", type: "completed", position: 3 },
  ];
  const linear = { id: "fixture-uuid", identifier: "TASK-7", title: "Close widget", description: body,
    url: "https://linear.app/fixture/issue/TASK-7", updatedAt: "revision-1", archivedAt: null as string | null,
    snoozedUntilAt: null as string | null,
    state: { id: "review-id", name: "In Review", type: "started", position: 1 },
    labels: { nodes: [] as Array<{ name: string }>, pageInfo: { hasNextPage: false } },
    team: { id: "team-a", states: { nodes: states, pageInfo: { hasNextPage: false } } } };
  const effects = { reads: 0, readFailures: 0, writes: [] as Array<{ description?: string; stateId?: string }>,
    modes: {} as Record<string, string | undefined>, stages: [] as string[],
    onRead: undefined as ((count: number) => void) | undefined,
    afterWrite: undefined as ((input: { description?: string; stateId?: string }) => void) | undefined };
  const store = new JobStore(join(directory, "state"));
  let jobID = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (payload.query.includes("mutation CloseoutUpdate")) {
        const input = payload.variables.input as { description?: string; stateId?: string };
        assert.equal(payload.variables.id, linear.id);
        assert.deepEqual(Object.keys(input), input.description === undefined ? ["stateId"] : ["description"]);
        effects.writes.push(input); effects.stages.push(store.get(jobID).stage);
        const mode = effects.modes[input.description === undefined ? "state" : "description"];
        if (mode === "reject") { response.writeHead(503); response.end("unavailable"); return; }
        if (mode !== "ignore") {
          if (input.description !== undefined) linear.description = input.description;
          else linear.state = linear.team.states.nodes.find(state => state.id === input.stateId)!;
          linear.updatedAt = "revision-" + (effects.writes.length + 1);
        }
        if (mode === "unreadable") effects.readFailures++;
        effects.afterWrite?.(input);
        if (mode === "lost") { response.writeHead(503); response.end("response lost after commit"); return; }
        response.end(JSON.stringify({ data: { issueUpdate: { success: true } } }));
      } else {
        effects.reads++;
        effects.onRead?.(effects.reads);
        if (effects.readFailures > 0) { effects.readFailures--; response.writeHead(503); response.end("unavailable"); return; }
        response.end(JSON.stringify({ data: { issue: linear } }));
      }
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  writeFileSync(join(directory, ".workit.yml"), `linear:\n  apiUrl: http://127.0.0.1:${port}/graphql\n`);
  for (const name of ["gh", "banyanctl", "probe"]) writeFileSync(join(directory, name), fake, { mode: 0o700 });
  Object.assign(process.env, { PATH: directory + ":" + process.env.PATH, LINEAR_API_KEY: "fixture-only-key",
    WORKIT_FIXTURE_FILE: join(directory, "fixture.json"), WORKIT_STATE_DIR: join(directory, "state"),
    WORKIT_BANYANCTL: join(directory, "banyanctl") });
  t.mock.method(console, "log", () => {});
  const job = createJob({ issue: { backend: "linear", identifier: linear.identifier, title: linear.title,
    body, url: linear.url, labels: [] }, repoRoot: directory, worktree: directory, githubRepo: "example/project",
    agent: "codex", config: { verification: "local", deploymentProbe: [join(directory, "probe")] }, now: new Date(Date.now() - 60_000) });
  jobID = job.id; store.insert(job);
  const mergeSha = "a".repeat(40);
  checkpoint(store, job.id, { stage: "verifying", detail: "Independent acceptance", pr: "https://github.com/example/project/pull/8", mergeSha });
  const githubFile = join(directory, "fixture.json");
  const github = { issue: {}, mergeSha, session: { id: job.sessionID, cwd: directory, status: "idle" },
    deployment: { ready: true, environment: "fixture", target: "widget", sourceSha: "b".repeat(40), version: "v1" }, wakes: [] };
  writeFileSync(githubFile, JSON.stringify(github));
  const report: VerificationReport = { jobID: job.id, issueURL: job.issue.url, acHash: job.acHash, mergeSha,
    checkedAt: new Date().toISOString(), reviewer: { runID: "independent-fixture-run", independent: true },
    criteria: job.acLabels.map(label => ({ label, status: "pass", evidence: [
      { kind: "test", reference: "artifact://fixture-test", observed: "Expected behavior passed" },
    ] })) };
  const reportPath = join(directory, "report.json");
  const verify = async () => { writeFileSync(reportPath, JSON.stringify(report)); await lifecycleCLI(["job", "verify", job.id, "--report", reportPath]); };
  const retry = () => lifecycleCLI(["job", "closeout", job.id]);
  return { directory, linear, effects, store, job, report, reportPath, verify, retry, github, githubFile };
}

test("valid independent acceptance automatically checks Linear ACs and confirms team completion before verified", async t => {
  const f = await linearFixture(t);
  f.linear.description = f.linear.description.replace("operator's notes", "fresh human edits");
  const before = f.linear.description;
  await f.verify();
  assert.equal(f.linear.description, provenChecklist(before, f.job.acLabels));
  assert.equal(f.linear.state.id, "team-a-complete");
  assert.deepEqual(f.effects.writes, [{ description: f.linear.description }, { stateId: "team-a-complete" }]);
  assert.deepEqual(f.effects.stages, ["verifying", "verifying"]);
  const current = new JobStore(join(f.directory, "state")).get(f.job.id);
  assert.equal(current.stage, "verified");
  assert.equal(current.closeout?.checklistConfirmed, true);
  assert.equal(current.closeout?.stateConfirmed, true);
  assert.ok(f.effects.reads >= 7, "preflight, prewrite and final readbacks occur");
  await f.retry();
  assert.equal(f.effects.writes.length, 2, "targeted repeated closeout has no duplicate effects");
});

test("different teams and already-completed Linear workflows retain the correct completion state", async t => {
  for (const completed of [false, true]) await t.test(String(completed), async tt => {
    const f = await linearFixture(tt);
    f.linear.team.id = "team-b";
    f.linear.team.states.nodes = [{ id: "team-b-done", name: "Shipped", type: "completed", position: 1 }];
    if (completed) f.linear.state = { id: "existing-done", name: "Released", type: "completed", position: 99 };
    await f.verify();
    assert.equal(f.linear.state.id, completed ? "existing-done" : "team-b-done");
    assert.equal(f.effects.writes.filter(input => input.stateId).length, completed ? 0 : 1);
    assert.equal(f.store.get(f.job.id).stage, "verified");
  });
});

test("failed/unconfirmed mutations remain unfinished and retries reconcile before repeating effects", async t => {
  for (const field of ["description", "state"]) for (const mode of ["reject", "ignore", "unreadable", "lost"]) {
    await t.test(field + " " + mode, async tt => {
      const f = await linearFixture(tt);
      f.effects.modes[field] = mode;
      if (mode === "lost") {
        await f.verify();
        assert.equal(f.store.get(f.job.id).stage, "verified", "readback reconciles an uncertain applied response");
      } else {
        await assert.rejects(f.verify());
        const unfinished = new JobStore(join(f.directory, "state")).get(f.job.id);
        assert.equal(unfinished.stage, "verifying");
        assert.match(unfinished.detail, /job closeout/);
        assert.ok(unfinished.verification);
        if (field === "state") assert.equal(unfinished.closeout?.checklistConfirmed, true);
        delete f.effects.modes[field];
        await f.retry();
        assert.equal(f.store.get(f.job.id).stage, "verified");
      }
      const writes = f.effects.writes.length;
      await f.retry();
      assert.equal(f.effects.writes.length, writes);
      assert.equal(f.effects.writes.filter(input => input.description !== undefined).length,
        field === "description" && ["reject", "ignore"].includes(mode) ? 2 : 1);
      assert.equal(f.effects.writes.filter(input => input.stateId !== undefined).length,
        field === "state" && ["reject", "ignore"].includes(mode) ? 2 : 1);
    });
  }
});

test("actual process interruption after checklist commit recovers from persisted intent without duplicate writes", async t => {
  const f = await linearFixture(t);
  writeFileSync(f.reportPath, JSON.stringify(f.report));
  let child: ChildProcess;
  f.effects.afterWrite = input => { if (input.description !== undefined) child.kill("SIGKILL"); };
  child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "job", "verify", f.job.id, "--report", f.reportPath],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  const signal = await new Promise<NodeJS.Signals | null>((done, reject) => {
    child.once("error", reject); child.once("exit", (_code, signal) => done(signal));
  });
  assert.equal(signal, "SIGKILL", stderr);
  const interrupted = new JobStore(join(f.directory, "state")).get(f.job.id);
  assert.equal(interrupted.stage, "verifying");
  assert.ok(interrupted.closeout?.checklist);
  assert.equal(interrupted.closeout?.checklistConfirmed, false);
  f.effects.afterWrite = undefined;
  await f.retry();
  assert.equal(f.store.get(f.job.id).stage, "verified");
  assert.equal(f.effects.writes.length, 2);
});

test("acceptance and owner gates prevent every tracker write", async t => {
  for (const gate of ["stale-ac", "missing-evidence", "unknown-label", "duplicate-label", "self", "unmerged", "human", "paused", "needs-you", "cancelled",
    "tracker-hold", "hold-label", "canceled-state", "duplicate-state", "archived", "snoozed", "no-completed-state", "pending-wake"]) {
    await t.test(gate, async tt => {
      const f = await linearFixture(tt, gate === "human");
      switch (gate) {
        case "stale-ac": f.linear.description += "\n"; f.linear.description = f.linear.description.replace("Expected behavior.", "New requirement."); break;
        case "missing-evidence": f.report.criteria[0].evidence = []; break;
        case "unknown-label": f.report.criteria[0].label = "unknown"; break;
        case "duplicate-label": f.report.criteria[0].label = f.report.criteria[1].label; break;
        case "self": f.report.reviewer.runID = f.job.sessionID; break;
        case "unmerged": f.github.mergeSha = "c".repeat(40); writeFileSync(f.githubFile, JSON.stringify(f.github)); break;
        case "paused": case "needs-you": case "cancelled": checkpoint(f.store, f.job.id, { stage: gate, detail: "Owner hold" }); break;
        case "tracker-hold": f.linear.state.name = "On Hold"; break;
        case "hold-label": f.linear.labels.nodes.push({ name: "owner-hold" }); break;
        case "canceled-state": f.linear.state.type = "canceled"; f.linear.state.name = "Done"; break;
        case "duplicate-state": f.linear.state.type = "duplicate"; break;
        case "archived": f.linear.archivedAt = new Date().toISOString(); break;
        case "snoozed": f.linear.snoozedUntilAt = new Date(Date.now() + 60_000).toISOString(); break;
        case "no-completed-state": f.linear.team.states.nodes = []; break;
        case "pending-wake": f.store.update(f.job.id, current => { current.wake = { id: "uncertain", reason: "resume", revision: 1 }; }); break;
      }
      await assert.rejects(f.verify());
      assert.equal(f.effects.writes.length, 0);
      assert.notEqual(f.store.get(f.job.id).stage, "verified");
    });
  }
});

test("explicit human confirmation permits closeout without waiving human acceptance", async t => {
  const f = await linearFixture(t, true);
  f.report.criteria[0].evidence = [{ kind: "human", confirmedBy: "Fixture Owner", reference: "artifact://owner-confirmation",
    observed: "Owner explicitly accepted this criterion" }];
  await f.verify();
  assert.equal(f.store.get(f.job.id).stage, "verified");
});

test("observable prewrite conflicts retain current human edits and retry from a fresh description", async t => {
  for (const change of ["notes", "ac", "revision", "hold"]) await t.test(change, async tt => {
    const f = await linearFixture(tt);
    f.effects.onRead = count => {
      if (count !== 2) return;
      if (change === "notes") f.linear.description += "Human added this note.\n";
      if (change === "ac") f.linear.description = f.linear.description.replace("Expected behavior.", "Changed AC.");
      if (change === "revision") f.linear.updatedAt = "concurrent-revision";
      if (change === "hold") f.linear.labels.nodes.push({ name: "owner-hold" });
    };
    await assert.rejects(f.verify(), /conflict|stale|hold/);
    assert.equal(f.effects.writes.length, 0);
    if (["notes", "revision"].includes(change)) {
      await f.retry();
      assert.equal(f.store.get(f.job.id).stage, "verified");
      if (change === "notes") assert.match(f.linear.description, /Human added this note/);
    }
  });
});

test("postwrite description conflicts stop completion, retain edits and reconcile on inspected retry", async t => {
  const f = await linearFixture(t);
  f.effects.afterWrite = input => { if (input.description) f.linear.description += "Concurrent human note.\n"; };
  await assert.rejects(f.verify(), /conflict/);
  assert.equal(f.store.get(f.job.id).stage, "verifying");
  assert.equal(f.effects.writes.length, 1);
  assert.match(f.linear.description, /Concurrent human note/);
  f.effects.afterWrite = undefined;
  await f.retry();
  assert.equal(f.store.get(f.job.id).stage, "verified");
  assert.equal(f.effects.writes.length, 2);
  assert.match(f.linear.description, /Concurrent human note/);
});

test("a pause during a remote write remains held and prevents state completion", async t => {
  const f = await linearFixture(t);
  f.effects.afterWrite = () => checkpoint(f.store, f.job.id, { stage: "paused", detail: "Owner paused concurrently" });
  await assert.rejects(f.verify(), /Job changed/);
  assert.equal(f.store.get(f.job.id).stage, "paused");
  assert.equal(f.effects.writes.length, 1);
  await assert.rejects(f.retry(), /verifying/);
});

test("targeted legacy verified reconciliation revalidates stored AC/source/version evidence", async t => {
  for (const stale of ["valid", "ac", "source", "version", "missing-report", "human"]) await t.test(stale, async tt => {
    const f = await linearFixture(tt, stale === "human");
    f.store.update(f.job.id, current => {
      current.stage = "verified"; current.verification = f.report; delete current.nextWakeAt;
      if (stale === "missing-report") delete current.verification;
      if (stale === "version") {
        current.config.verification = "deployed";
        const { ready, ...deployment } = f.github.deployment;
        current.deployment = deployment; current.verification!.deployment = deployment;
        current.verification!.criteria.forEach(item => { item.evidence[0].kind = "journey"; item.evidence[0].deployment = deployment; });
      }
    });
    if (stale === "ac") f.linear.description = f.linear.description.replace("Expected behavior.", "Changed AC.");
    if (stale === "source") f.github.mergeSha = "d".repeat(40);
    if (stale === "version") f.github.deployment.version = "v2";
    writeFileSync(f.githubFile, JSON.stringify(f.github));
    if (stale === "valid") {
      await f.retry(); assert.equal(f.effects.writes.length, 2); assert.equal(f.store.get(f.job.id).stage, "verified");
    } else {
      await assert.rejects(f.retry()); assert.equal(f.effects.writes.length, 0);
      assert.equal(f.store.get(f.job.id).stage, "verifying");
    }
  });
});

test("generated managed instructions describe automatic closeout, recovery, race limits and authority", async t => {
  const f = await linearFixture(t);
  const instructions = managedInstructions(f.job).join("\n");
  assert.match(instructions, /automatically synchronizes proven Linear AC/);
  assert.match(instructions, /Submit independent partial progress/);
  assert.match(instructions, /Only evidenced pass\/fail checkbox states/);
  assert.match(instructions, /job closeout/);
  assert.match(instructions, /race/);
  assert.match(instructions, /owner holds and real human acceptance/);
  assert.match(instructions, /does not authorize a deployment/);
  assert.doesNotMatch(instructions, /before submitting the report|leave Linear in.*In Review|Never set Done/);
});

test("competing verification commands serialize through the existing durable claim", async t => {
  const f = await linearFixture(t);
  const outcomes = await Promise.allSettled([f.verify(), f.verify()]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
  assert.equal(f.effects.writes.length, 2);
  assert.equal(f.store.get(f.job.id).stage, "verified");
});

test("an uncertain pending checklist with newer unchecked content requires inspection before retry", async t => {
  const f = await linearFixture(t);
  f.effects.modes.description = "reject";
  await assert.rejects(f.verify());
  f.linear.description += "New human note.\n";
  delete f.effects.modes.description;
  await assert.rejects(f.retry(), /Pending checklist conflicts/);
  assert.equal(f.effects.writes.length, 1);
  // Operator reconciles just the proven checkboxes while retaining new content.
  f.linear.description = provenChecklist(f.linear.description, f.job.acLabels);
  await f.retry();
  assert.equal(f.effects.writes.length, 2);
  assert.match(f.linear.description, /New human note/);
  assert.equal(f.store.get(f.job.id).stage, "verified");
});

test("serving version changes prevent state completion even after the checklist was applied", async t => {
  const f = await linearFixture(t);
  const { ready, ...deployment } = f.github.deployment;
  f.store.update(f.job.id, current => { current.config.verification = "deployed"; current.deployment = deployment; });
  f.report.deployment = deployment;
  f.report.criteria.forEach(item => { item.evidence[0].kind = "journey"; item.evidence[0].deployment = deployment; });
  f.effects.afterWrite = input => {
    if (input.description) { f.github.deployment.version = "v2"; writeFileSync(f.githubFile, JSON.stringify(f.github)); }
  };
  await assert.rejects(f.verify(), /Serving deployment changed/);
  assert.equal(f.effects.writes.length, 1);
  assert.equal(f.store.get(f.job.id).stage, "verifying");
  await assert.rejects(f.retry(), /Serving deployment changed/);
  assert.equal(f.effects.writes.length, 1);
});

test("partial and mixed reports synchronize proven checkbox states while keeping the issue and job unfinished", async t => {
  for (const remaining of ["omitted", "fail", "blocked", "unproven-fail"]) await t.test(remaining, async tt => {
    const f = await linearFixture(tt);
    const complete = structuredClone(f.report);
    if (remaining === "omitted") f.report.criteria.pop();
    else {
      // A blocked/unproven result must preserve a human's existing checked box.
      f.linear.description = f.linear.description.replace("[ ] `[code:contract]`", "[x] `[code:contract]`");
      f.report.criteria[1].status = remaining === "blocked" ? "blocked" : "fail";
      if (remaining !== "fail") f.report.criteria[1].evidence = [];
    }
    const before = f.linear.description;
    await f.verify();
    const expected = before.replace("[ ] `[test:behavior]`", "[x] `[test:behavior]`");
    assert.equal(f.linear.description, remaining === "fail" ? expected.replace("[x] `[code:contract]`", "[ ] `[code:contract]`") : expected);
    assert.equal(f.linear.state.id, "review-id");
    assert.equal(f.store.get(f.job.id).stage, "verifying");
    assert.match(f.store.get(f.job.id).detail, /progress synchronized/);
    assert.deepEqual([...f.effects.writes], [{ description: f.linear.description }]);
    await f.retry();
    assert.equal(f.effects.writes.length, 1, "partial report retries are idempotent");
    assert.equal(f.store.get(f.job.id).stage, "verifying");
    Object.assign(f.report, complete);
    await f.verify();
    assert.equal(f.store.get(f.job.id).stage, "verified");
    assert.equal(f.linear.state.id, "team-a-complete");
    assert.equal(f.effects.writes.filter(input => input.stateId).length, 1);
  });
});

test("separate partial reports can check every box without accumulating evidence into completion", async t => {
  const f = await linearFixture(t);
  const complete = structuredClone(f.report);
  f.report.criteria = [complete.criteria[0]];
  await f.verify();
  f.linear.description += "Preserve this newer human note.\n";
  f.report.criteria = [complete.criteria[1]];
  await f.verify();
  assert.equal(provenChecklist(f.linear.description, f.job.acLabels), f.linear.description, "all boxes are checked");
  assert.equal(f.store.get(f.job.id).stage, "verifying", "only the latest independent report counts for completeness");
  assert.equal(f.linear.state.id, "review-id");
  assert.equal(f.effects.writes.length, 2);
  await f.retry();
  assert.equal(f.effects.writes.length, 2);
  Object.assign(f.report, complete);
  await f.verify();
  assert.equal(f.store.get(f.job.id).stage, "verified");
  assert.equal(f.effects.writes.length, 3, "complete report needs only the state update");
  assert.match(f.linear.description, /newer human note/);
});

test("partial synchronization failures and uncertain responses recover without closing the issue", async t => {
  for (const mode of ["reject", "unreadable", "lost"]) await t.test(mode, async tt => {
    const f = await linearFixture(tt);
    f.report.criteria.pop();
    f.effects.modes.description = mode;
    if (mode === "lost") await f.verify();
    else await assert.rejects(f.verify());
    const saved = new JobStore(join(f.directory, "state")).get(f.job.id);
    assert.equal(saved.stage, "verifying");
    assert.equal(saved.verification?.criteria.length, 1);
    delete f.effects.modes.description;
    await f.retry();
    assert.equal(f.store.get(f.job.id).stage, "verifying");
    assert.equal(f.linear.state.id, "review-id");
    assert.equal(f.effects.writes.length, mode === "reject" ? 2 : 1);
    assert.equal(f.effects.writes.some(input => input.stateId), false);
  });
});

test("blocked human acceptance allows other proven ACs to sync and never substitutes for confirmation", async t => {
  const f = await linearFixture(t, true);
  f.report.criteria[0].status = "blocked"; f.report.criteria[0].evidence = [];
  await f.verify();
  assert.match(f.linear.description, /\[ \] `\[human:behavior\]`/);
  assert.match(f.linear.description, /\[x\] `\[code:contract\]`/);
  assert.equal(f.store.get(f.job.id).stage, "verifying");
  const writes = f.effects.writes.length;
  f.report.criteria[0].status = "pass";
  f.report.criteria[0].evidence = [{ kind: "test", reference: "artifact://not-confirmation", observed: "Automated test" }];
  await assert.rejects(f.verify(), /human confirmation/);
  assert.equal(f.effects.writes.length, writes);
});

test("deployed progress can sync code evidence while journey acceptance remains pending", async t => {
  const f = await linearFixture(t);
  const { ready, ...deployment } = f.github.deployment;
  f.store.update(f.job.id, current => { current.config.verification = "deployed"; current.deployment = deployment; });
  const complete = structuredClone(f.report);
  f.report.criteria = [complete.criteria[1]];
  await f.verify();
  assert.equal(f.store.get(f.job.id).stage, "verifying");
  assert.equal(f.effects.writes.length, 1);
  f.github.deployment.version = "v2"; writeFileSync(f.githubFile, JSON.stringify(f.github));
  await assert.rejects(f.retry(), /Serving deployment changed/);
  assert.equal(f.effects.writes.length, 1);
  f.github.deployment.version = "v1"; writeFileSync(f.githubFile, JSON.stringify(f.github));
  Object.assign(f.report, complete);
  await f.verify();
  assert.equal(f.store.get(f.job.id).stage, "verifying", "even all-pass local results cannot close deployed acceptance without a journey");
  assert.equal(f.linear.state.id, "review-id");
  f.report.deployment = deployment;
  f.report.criteria[0].evidence = [{ kind: "journey", reference: "artifact://serving-journey", observed: "Journey passed", deployment }];
  await f.verify();
  assert.equal(f.store.get(f.job.id).stage, "verified");
});


test("a human tracker-completion hold prevents state mutation even with complete independent evidence", async t => {
  const f = await linearFixture(t);
  f.store.update(f.job.id, job => { job.config.trackerCompletion = "human"; });
  await assert.rejects(f.verify(), /authorized human/);
  assert.equal(f.linear.state.name, "In Review");
  assert.ok(f.effects.writes.every(write => write.stateId === undefined));
  assert.equal(f.store.get(f.job.id).stage, "verifying");
});
