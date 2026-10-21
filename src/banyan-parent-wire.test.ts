import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

for (const scenario of [
  { name: "explicit missing parent", session: "caller-session", override: "missing-parent", parent: "missing-parent", fallback: true },
  { name: "inherited missing parent", session: "missing-parent", override: undefined, parent: "", fallback: false },
  { name: "inherited active parent", session: "caller-session", override: undefined, parent: "caller-session", fallback: false },
  { name: "explicit active parent", session: "caller-session", override: "chosen-parent", parent: "chosen-parent", fallback: false },
  { name: "outside Banyan", session: undefined, override: undefined, parent: "", fallback: false },
]) {
  test(`workit preserves ${scenario.name} behavior through the compiled Banyan CLI`, {
    skip: !process.env.WORKIT_TEST_BANYANCTL,
  }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "workit-parent-wire-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "Banyan"));
    writeFileSync(join(directory, "Banyan/control-token"), "fixture-token", { mode: 0o600 });
    const requests: Array<{ token?: string; body: Record<string, string> }> = [];
    const server = createServer(async (request, response) => {
      if (request.method === "GET") {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const id = url.searchParams.get("id") ?? scenario.session ?? "";
        const status = id === "missing-parent" ? "closed" : "need-input";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ apiVersion: "v1", ok: true,
          data: { sessions: id ? [{ id, status }] : [], shellAvailable: true, puckAvailable: false } }));
        return;
      }
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text) as Record<string, string>;
      requests.push({ token: request.headers["x-banyan-token"] as string, body });
      if (body.parent === "missing-parent") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ apiVersion: "v1", ok: false,
          error: { code: "bad_request", message: "No active parent session found for id 'missing-parent'" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ apiVersion: "v1", ok: true, data: { session: { id: body.id } } }));
    });
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const script = `
  import { launch } from ${JSON.stringify(new URL("./launch.ts", import.meta.url).href)};
  const directory = process.env.WORKIT_PARENT_FIXTURE;
  launch({ config: { launch: { logFile: directory + '/launch.log' } }, root: directory, configFiles: [], aliasIndex: {} },
    { backend: 'github', identifier: '1', title: 'Fixture', body: '', labels: [], url: 'https://github.com/example/project/issues/1' },
    { path: directory, branch: 'test/parent-fallback', sourceBranch: 'main', resumed: false },
    'fixture', { command: 'fixture-agent' },
    { identifiers: ['1'], prompt: false, agentLaunch: true, review: false, dryRun: false, verbose: false, sessionID: 'fixture-session' });
  `;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      timeout: 15_000,
      env: (() => {
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          WORKIT_PARENT_FIXTURE: directory,
          WORKIT_BANYANCTL: process.env.WORKIT_TEST_BANYANCTL,
          BANYAN_FIXTURE_DATA_HOME: directory,
          BANYAN_FIXTURE_CONTROL_URL: `http://127.0.0.1:${address.port}`,
        };
        delete environment.TMUX;
        delete environment.TMUX_PANE;
        delete environment.BANYAN_SESSION_ID;
        delete environment.BANYAN_PARENT_SESSION_ID;
        if (scenario.session !== undefined) environment.BANYAN_SESSION_ID = scenario.session;
        if (scenario.override !== undefined) environment.BANYAN_PARENT_SESSION_ID = scenario.override;
        return environment;
      })(),
    });
    if (scenario.fallback) assert.match(result.stderr, /is inactive; launching a top-level session/);
    else assert.doesNotMatch(result.stderr, /is inactive; launching a top-level session/);
    assert.equal(requests.length, scenario.fallback ? 2 : 1);
    assert.ok(requests.every(request => request.token === "fixture-token"));
    assert.equal(requests[0].body.parent, scenario.parent);
    const last = requests.at(-1)!;
    if (scenario.fallback) assert.equal(last.body.parent, "");
    for (const field of ["id", "cwd", "command", "title", "apiVersion"]) {
      assert.equal(requests[0].body[field], last.body[field]);
    }
    assert.equal(last.body.id, "fixture-session");
  });
}
