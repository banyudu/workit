import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { lifecycleCLI } from "./lifecycle-cli.js";
import { createJob, JobStore, type Session } from "./lifecycle.js";

// Model the native receipt guard: Workit's persisted intent does not imply
// that Banyan admitted delivery and created a matching receipt.
const nativeCLI = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.WORKIT_RECOVERY_FIXTURE;
const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
fixture.calls.push(args);
const refuse = () => {
  fs.writeFileSync(file, JSON.stringify(fixture));
  console.log(JSON.stringify({ok:false,error:{code:"workflow_refused",message:"matching native receipt required"}}));
  process.exit(75);
};
let output;
if (args[0] === "session" && args[1] === "list") {
  if (fixture.listUnavailable) { fs.writeFileSync(file, JSON.stringify(fixture)); process.exit(69); }
  output = {workflowProtocol: fixture.protocol, sessions: fixture.sessions ?? [fixture.session]};
} else if (args[0] === "workflow" && args[1] === "set") {
  const previous = fixture.session.workflow;
  if (previous && (previous.owner !== value("--owner") || previous.jobID !== value("--job-id") ||
    previous.revision > Number(value("--revision")))) refuse();
  fixture.session.workflow = {owner:value("--owner"),jobID:value("--job-id"),
    revision:Number(value("--revision")),state:value("--state"),wake:previous?.wake};
  output = {ok:true};
} else if (args[0] === "workflow" && args[1] === "resolve") {
  const workflow = fixture.session.workflow;
  if (fixture.changeBeforeResolve) { workflow.revision += 1; workflow.state = "paused"; }
  if (!workflow || workflow.jobID !== value("--job-id") || workflow.revision !== Number(value("--revision")) ||
    workflow.wake?.id !== value("--wake-id")) refuse();
  if (value("--outcome") === "delivered") workflow.wake.status = "delivered";
  else if (value("--outcome") === "not-delivered") delete workflow.wake;
  else refuse();
  output = {ok:true};
} else refuse();
fs.writeFileSync(file, JSON.stringify(fixture));
console.log(JSON.stringify(output));
`;

function fixture(t: TestContext, wake?: { id: string; status: string }) {
  const directory = mkdtempSync(join(tmpdir(), "workit-wake-recovery-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  const cli = join(directory, "banyanctl");
  writeFileSync(cli, nativeCLI, { mode: 0o700 });
  const file = join(directory, "native.json");
  Object.assign(process.env, { WORKIT_STATE_DIR: join(directory, "state"), WORKIT_BANYANCTL: cli,
    WORKIT_RECOVERY_FIXTURE: file });
  t.mock.method(console, "log", () => {});
  const job = createJob({ issue: { backend: "github", identifier: "7", title: "Recovery", labels: [],
    url: "https://github.com/example/project/issues/7",
    body: "## Acceptance Criteria\n- [ ] `[test:recovery]` Recovery passes.\n- [ ] `[code:hold]` Holds remain." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
    config: { verification: "deployed", deploymentProbe: ["must-not-run"] } });
  job.stage = "needs-you";
  delete job.nextWakeAt;
  job.pr = "https://github.com/example/project/pull/8";
  job.mergeSha = "a".repeat(40);
  job.wake = { id: "undelivered-intent", reason: "unfinished work", revision: job.revision, counted: false };
  const store = new JobStore();
  store.insert(job);
  const session: Session = { id: job.sessionID, cwd: directory, status: "executing",
    workflow: { owner: "workit", jobID: job.id, revision: job.revision, state: "needs-you", wake } };
  writeFileSync(file, JSON.stringify({ protocol: 1, session, calls: [] }));
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const write = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  return { job, store, session, read, write, adapter: new BanyanLifecycleAdapter(cli) };
}

for (const prior of [undefined, { id: "older-wake", status: "delivered" },
  { id: "older-wake", status: "not-delivered" }] as const) {
  test(`explicit recovery clears an undelivered Workit-only intent with ${prior ? "an older receipt" : "no native receipt"}`, async t => {
    const f = fixture(t, prior);
    await lifecycleCLI(["job", "reconcile", f.job.id, "--delivery", "not-delivered", "--detail", "Inspected original conversation; no prompt delivered"]);
    const held = f.store.get(f.job.id);
    assert.equal(held.stage, "needs-you");
    assert.equal(held.wake, undefined);
    assert.equal(held.nextWakeAt, undefined);
    assert.equal(held.lastRecovery?.wakeID, f.job.wake!.id);
    assert.equal(held.lastRecovery?.outcome, "not-delivered");
    assert.deepEqual(f.read().session.workflow.wake, prior);
    assert.ok(f.read().calls.every((args: string[]) => args[1] === "set" || args[0] === "session"));
    await lifecycleCLI(["job", "resume", f.job.id, "--detail", "Continue the original merged job"]);
    assert.equal(f.store.get(f.job.id).stage, "waiting-deploy");
    assert.equal(f.store.get(f.job.id).sessionID, f.job.sessionID);
    assert.ok(f.read().calls.every((args: string[]) => args[1] !== "wake"));
  });
}

for (const status of ["pending", "uncertain", "delivered", "not-delivered"]) {
  for (const outcome of ["delivered", "not-delivered"]) {
    test(`matching ${status} receipt still uses guarded native ${outcome} resolution`, async t => {
      const f = fixture(t, { id: "undelivered-intent", status });
      await lifecycleCLI(["job", "reconcile", f.job.id, "--delivery", outcome, "--detail", "Inspected original conversation"]);
      assert.equal(f.store.get(f.job.id).stage, "needs-you");
      assert.equal(f.store.get(f.job.id).wake, undefined);
      assert.equal(f.store.get(f.job.id).lastRecovery?.outcome, outcome);
      assert.deepEqual(f.read().session.workflow.wake, outcome === "delivered"
        ? { id: "undelivered-intent", status: "delivered" } : undefined);
      const resolutions = f.read().calls.filter((args: string[]) => args[1] === "resolve");
      assert.equal(resolutions.length, 1);
      assert.ok(resolutions[0].includes(f.job.wake!.id));
      assert.ok(resolutions[0].includes(outcome));
      assert.ok(f.read().calls.every((args: string[]) => args[1] !== "wake"));
    });
  }
}

test("a missing or different receipt never establishes delivered", async t => {
  const f = fixture(t);
  for (const prior of [undefined, { id: "older-wake", status: "delivered" }]) {
    const native = f.read();
    native.session.workflow.wake = prior;
    f.write(native);
    await assert.rejects(lifecycleCLI(["job", "reconcile", f.job.id, "--delivery", "delivered", "--detail", "Inspected"]));
    assert.equal(f.store.get(f.job.id).stage, "needs-you");
    assert.deepEqual(f.store.get(f.job.id).wake, f.job.wake);
    assert.equal(f.store.get(f.job.id).lastRecovery, undefined);
    assert.deepEqual(f.read().session.workflow.wake, prior);
  }
  assert.ok(f.read().calls.every((args: string[]) => args[1] !== "resolve" && args[1] !== "wake"));
});

test("unresolved or malformed different receipts retain the held intent", async t => {
  const f = fixture(t);
  for (const prior of [
    { id: "older-wake", status: "pending" }, { id: "older-wake", status: "uncertain" },
    { id: "older-wake", status: "future-status" }, { id: "older-wake" }, { status: "delivered" },
  ]) {
    const native = f.read();
    native.session.workflow.wake = prior;
    f.write(native);
    await assert.rejects(lifecycleCLI(["job", "reconcile", f.job.id, "--delivery", "not-delivered", "--detail", "Inspected"]));
    assert.deepEqual(f.store.get(f.job.id).wake, f.job.wake);
    assert.equal(f.store.get(f.job.id).lastRecovery, undefined);
    assert.deepEqual(f.read().session.workflow.wake, prior);
  }
  assert.ok(f.read().calls.every((args: string[]) => args[1] !== "resolve" && args[1] !== "wake"));
});

test("recovery rejects unavailable, ambiguous, unreadable or stale native ownership", async t => {
  const f = fixture(t, { id: "older-wake", status: "delivered" });
  const original = f.read();
  // Read the adapter directly so CLI projection cannot repair deliberately stale
  // fixtures before we check that they fail closed.
  const invalid = [
    { ...original, protocol: undefined }, { ...original, protocol: 2 },
    { ...original, sessions: [] }, { ...original, sessions: [original.session, original.session] },
    { ...original, session: { ...original.session, id: "different-session" } },
    { ...original, session: { ...original.session, cwd: "/different-worktree" } },
    { ...original, session: { ...original.session, cwd: undefined } },
    { ...original, session: { ...original.session, workflowRecoveryError: "journal unreadable" } },
    { ...original, session: { ...original.session, workflow: undefined } },
    ...[{ owner: "another-owner" }, { jobID: "another-job" }, { revision: f.job.revision + 1 },
      { revision: f.job.revision - 1 }, { state: "running" }].map(change => ({ ...original,
        session: { ...original.session, workflow: { ...original.session.workflow, ...change } } })),
    { ...original, listUnavailable: true },
  ];
  for (const value of invalid) {
    f.write(value);
    const before = f.read();
    await assert.rejects(f.adapter.reconcile(f.job, "not-delivered", "Inspected"));
    assert.deepEqual(f.store.get(f.job.id), f.job);
    assert.deepEqual(f.read().session, before.session);
    assert.ok(f.read().calls.every((args: string[]) => args[0] === "session"));
  }
});

test("a concurrent human pause wins over intent reconciliation", async t => {
  const f = fixture(t, { id: "older-wake", status: "delivered" });
  const reconcile = BanyanLifecycleAdapter.prototype.reconcile;
  t.mock.method(BanyanLifecycleAdapter.prototype, "reconcile", async function (this: BanyanLifecycleAdapter,
    ...args: Parameters<typeof reconcile>) {
    await reconcile.apply(this, args);
    f.store.update(f.job.id, current => { current.stage = "paused"; current.detail = "New human hold"; });
  });
  await assert.rejects(lifecycleCLI(["job", "reconcile", f.job.id, "--delivery", "not-delivered", "--detail", "Inspected"]),
    /Job changed during reconciliation/);
  const held = f.store.get(f.job.id);
  assert.equal(held.stage, "paused");
  assert.equal(held.detail, "New human hold");
  assert.deepEqual(held.wake, f.job.wake);
  assert.equal(held.lastRecovery, undefined);
  assert.deepEqual(f.read().session.workflow.wake, { id: "older-wake", status: "delivered" });
});

test("a native revision change after inspection still blocks matched receipt resolution", async t => {
  const f = fixture(t, { id: "undelivered-intent", status: "uncertain" });
  f.write({ ...f.read(), changeBeforeResolve: true });
  await assert.rejects(lifecycleCLI(["job", "reconcile", f.job.id, "--delivery", "not-delivered", "--detail", "Inspected"]),
    /matching native receipt required/);
  assert.deepEqual(f.store.get(f.job.id), f.job);
  assert.equal(f.read().session.workflow.state, "paused");
  assert.equal(f.read().session.workflow.revision, f.job.revision + 1);
  assert.deepEqual(f.read().session.workflow.wake, { id: "undelivered-intent", status: "uncertain" });
});
