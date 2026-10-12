import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { createJob } from "./lifecycle.js";

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
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) as Record<string, string> : undefined;
    requests.push({ path: request.url, token: request.headers["x-banyan-token"] as string, body });
    if (request.url === "/workflow-set" && body) session.workflow = {
      owner: body.owner, jobID: body.jobID, revision: Number(body.revision), state: body.state,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: request.url === "/list" ? { workflowProtocol: 1, sessions: [session] } : { ok: true } }));
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
  await adapter.wake(job, "wake-a", "Continue\nverification");
  assert.ok(requests.every(request => request.token === "fixture-token"));
  const wake = requests.find(request => request.path === "/workflow-wake");
  assert.equal(wake?.body?.apiVersion, "v1");
  assert.equal(wake?.body?.jobID, job.id);
  assert.equal(wake?.body?.wakeID, "wake-a");
  assert.equal(wake?.body?.text, "Continue\nverification");
});
