import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { createJob, WorkflowRefusedError, type Session } from "./lifecycle.js";

// Optional cross-repository check: use the actual compiled companion CLI with
// an isolated authenticated HTTP fixture. No user app, daemon or agent is used.
test("compiled Banyan CLI preserves capabilities, workflow metadata and authenticated wake payloads", {
  skip: !process.env.WORKIT_TEST_BANYANCTL,
}, async t => {
  const cli = process.env.WORKIT_TEST_BANYANCTL!;
  const directory = mkdtempSync(join(tmpdir(), "workit-banyan-wire-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, "Banyan"));
  writeFileSync(join(directory, "Banyan", "control-token"), "fixture-token", { mode: 0o600 });
  const job = createJob({ issue: { backend: "github", identifier: "23", title: "Widget", labels: [],
    url: "https://github.com/example/project/issues/23",
    body: "## Acceptance Criteria\n- [ ] `[test:journey]` Journey passes.\n- [ ] `[code:contract]` Contract is documented." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "codex", config: { verification: "local" } });
  job.stage = "waiting-ci";
  const session: Record<string, unknown> = { id: job.sessionID, cwd: directory, status: "completed" };
  const requests: Array<{ path?: string; token?: string; body?: Record<string, string> }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) as Record<string, string> : undefined;
    requests.push({ path: request.url, token: request.headers["x-banyan-token"] as string, body });
    if (request.url === "/workflow-set" && body) session.workflow = {
      owner: body.owner, jobID: body.jobID, revision: Number(body.revision), state: body.state,
      wake: (session.workflow as Session["workflow"])?.wake,
    };
    if (request.url === "/workflow-resolve" && body) {
      const workflow = session.workflow as Session["workflow"];
      if (!workflow || workflow.jobID !== body.jobID || workflow.revision !== Number(body.revision) ||
          workflow.wake?.id !== body.wakeID) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: { code: "workflow_refused", message: "matching receipt required" } }));
        return;
      }
      if (body.outcome === "delivered") workflow.wake.status = "delivered";
      else delete workflow.wake;
    }
    response.writeHead(200, { "content-type": "application/json" });
    const matches = !url.searchParams.has("id") || url.searchParams.get("id") === session.id;
    response.end(JSON.stringify({ ok: true, data: url.pathname === "/list" ? { workflowProtocol: 1, sessions: matches ? [session] : [] } : { ok: true } }));
  });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  Object.assign(process.env, { BANYAN_FIXTURE_DATA_HOME: directory, PUCK_HOME: join(directory, "puck"),
    BANYAN_FIXTURE_CONTROL_URL: `http://127.0.0.1:${address.port}` });
  const adapter = new BanyanLifecycleAdapter(cli);
  await adapter.requireWorkflowSupport(directory);
  await adapter.project(job);
  const observed = await adapter.session(job);
  assert.equal(observed?.workflow?.state, "waiting");
  assert.equal(observed?.status, "completed");
  assert.ok(requests.some(request => request.path === `/list?id=${job.sessionID}`));
  await adapter.wake(job, "wake-a", "Continue\nverification");
  assert.ok(requests.every(request => request.token === "fixture-token"));
  const wake = requests.find(request => request.path === "/workflow-wake");
  assert.equal(wake?.body?.apiVersion, "v1");
  assert.equal(wake?.body?.jobID, job.id);
  assert.equal(wake?.body?.wakeID, "wake-a");
  assert.equal(wake?.body?.text, "Continue\nverification");

  job.stage = "needs-you";
  job.wake = { id: "wake-a", reason: "unfinished work", revision: job.revision };
  (session.workflow as NonNullable<Session["workflow"]>).wake = { id: "wake-a", status: "uncertain" };
  await adapter.project(job);
  await adapter.reconcile(job, "delivered", "Inspected original conversation");
  const resolution = requests.find(request => request.path === "/workflow-resolve");
  assert.equal(resolution?.body?.jobID, job.id);
  assert.equal(Number(resolution?.body?.revision), job.revision);
  assert.equal(resolution?.body?.wakeID, "wake-a");
  assert.equal(resolution?.body?.outcome, "delivered");

  job.wake.id = "workit-only-intent";
  await adapter.reconcile(job, "not-delivered", "Inspected original conversation; no prompt sent");
  assert.deepEqual((session.workflow as Session["workflow"])?.wake, { id: "wake-a", status: "delivered" });
  await assert.rejects(adapter.reconcile(job, "delivered", "Inspected"));
  assert.equal(requests.filter(request => request.path === "/workflow-resolve").length, 1);
  assert.equal(requests.filter(request => request.path === "/workflow-wake").length, 1);
  assert.ok(requests.every(request => request.token === "fixture-token"));
});

test("compiled Banyan CLI preserves HTTP 409 refusal codes and never mutates fixture delivery", {
  skip: !process.env.WORKIT_TEST_BANYANCTL,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-banyan-refusal-wire-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, "Banyan"));
  writeFileSync(join(directory, "Banyan", "control-token"), "fixture-token", { mode: 0o600 });
  const job = createJob({ issue: { backend: "github", identifier: "24", title: "Refusal", labels: [],
    url: "https://github.com/example/project/issues/24",
    body: "## Acceptance Criteria\n- [ ] `[test:refusal]` Refusal is retained.\n- [ ] `[code:receipt]` Receipts are unchanged." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture", config: { verification: "local" } });
  const session: Session = { id: job.sessionID, cwd: directory, status: "idle", workflow: {
    owner: "workit", jobID: job.id, revision: job.revision, state: "working",
  } };
  let code = "workflow_refused";
  const reason = "agent is busy, unobserved, or awaiting human input";
  const requests: string[] = [];
  const fixtureState = { session, turnCount: 3 };
  const server = createServer(async (request, response) => {
    requests.push(request.url!);
    assert.equal(request.headers["x-banyan-token"], "fixture-token");
    let text = "";
    for await (const chunk of request) text += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/workflow-wake") {
      const body = JSON.parse(text);
      assert.equal(body.apiVersion, "v1");
      assert.equal(body.id, job.sessionID);
      assert.equal(body.jobID, job.id);
      assert.equal(Number(body.revision), job.revision);
      assert.equal(body.wakeID, "held-wake");
      response.writeHead(409);
      response.end(JSON.stringify({ ok: false, error: { code, message: reason } }));
    } else if (request.url === `/list?id=${job.sessionID}`) {
      response.end(JSON.stringify({ ok: true, data: { workflowProtocol: 1, sessions: [session] } }));
    } else {
      response.writeHead(500); response.end(JSON.stringify({ ok: false }));
    }
  });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  Object.assign(process.env, { BANYAN_FIXTURE_DATA_HOME: directory, PUCK_HOME: join(directory, "puck"),
    BANYAN_FIXTURE_CONTROL_URL: `http://127.0.0.1:${address.port}` });
  const adapter = new BanyanLifecycleAdapter(process.env.WORKIT_TEST_BANYANCTL!);
  for (code of ["workflow_refused", "workflow_wake_refused"]) {
    for (const status of [undefined, "pending", "uncertain", "delivered", "not-delivered"]) {
      session.workflow!.wake = status ? { id: "held-wake", status } : undefined;
      const before = JSON.stringify(fixtureState);
      await assert.rejects(adapter.wake(job, "held-wake", "Fixture continuation"), error =>
        error instanceof WorkflowRefusedError && error.code === code && error.reason === reason && error.message === reason &&
        error.delivery === (status === "delivered" ? "delivered" : !status || status === "not-delivered" ? "not-delivered" : "uncertain"));
      assert.equal(JSON.stringify(fixtureState), before);
    }
  }
  assert.equal(requests.filter(path => path === "/workflow-wake").length, 10);
  assert.equal(requests.filter(path => path.startsWith("/list?")).length, 10);
  assert.ok(requests.every(path => path === "/workflow-wake" || path === `/list?id=${job.sessionID}`));
});
