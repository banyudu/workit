import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, checkpoint, createJob, tick, type VerificationReport } from "./lifecycle.js";
import { BanyanLifecycleAdapter, githubRepository } from "./lifecycle-adapter.js";
import { lifecycleCLI } from "./lifecycle-cli.js";

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
    process.stdout.write(JSON.stringify({ok: false, error: {code: "workflow_refused", message: fixture.refusal.message}}));
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
} else output = fixture.deployment;
fs.writeFileSync(file, JSON.stringify(fixture));
process.stdout.write(JSON.stringify(output));
`;

test("real CLI/adapters drive deployment wait, version invalidation and evidence-backed closeout using private fixtures", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-integration-"));
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
  await assert.rejects(lifecycleCLI(["job", "verify", job.id, "--report", reportPath]), /close it/);
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
  for (const [index, operation] of ["set", "wake"].entries()) {
    const message = operation === "set" ? "stale workflow revision" : "workflow is needs-you";
    const job = createJob({ issue: { backend: "github", identifier: String(index), title: "Resume", labels: [],
      url: `https://github.com/example/project/issues/${index + 1}`,
      body: "## Acceptance Criteria\n- [ ] `[test:retry]` Retry succeeds.\n- [ ] `[code:detail]` Refusal is visible." },
      repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "codex",
      config: { verification: "local", intervalSeconds: 17, maxWakeups: 1, maxErrors: 2 },
      now: new Date(Date.now() - 60_000) });
    store.insert(job);
    writeFileSync(file, JSON.stringify({ session: { id: job.sessionID, cwd: directory, status: "idle" },
      refusal: { operation, message }, attempts: [], wakes: [] }));
    await lifecycleCLI(["tick", "--job", job.id]);
    assert.deepEqual(JSON.parse(logs.at(-1)!), [{ id: job.id, result: "workflow-refused", detail: message }]);
    await lifecycleCLI(["job", "status", job.id]);
    assert.equal(JSON.parse(logs.at(-1)!).detail, message);
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
