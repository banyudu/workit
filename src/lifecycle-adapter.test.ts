import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandJSON } from "./lifecycle-adapter.js";
import { WorkflowRefusedError } from "./lifecycle.js";

const refusal = { ok: false, error: { code: "workflow_refused", message: "stale workflow revision" } };
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "workit-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = join(directory, "banyanctl");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.env.WORKIT_TEST_OUTPUT_BYTES) {
  process.stdout.write(JSON.stringify({ workflowProtocol: 1,
    sessions: [{ id: 'fixture-session', detail: 'x'.repeat(Number(process.env.WORKIT_TEST_OUTPUT_BYTES)) }] }));
} else process.stdout.write(process.env.WORKIT_TEST_OUTPUT || "");
process.stderr.write(process.env.WORKIT_TEST_STDERR || "");
if (process.env.WORKIT_TEST_SIGNAL) process.kill(process.pid, "SIGTERM");
else if (process.env.WORKIT_TEST_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.WORKIT_TEST_EXIT || 0);
`, { mode: 0o700 });
  const run = (output: unknown, env = {}, args = ["workflow", "wake"]) => commandJSON([cli, ...args], directory, {
    WORKIT_TEST_OUTPUT: JSON.stringify(output), WORKIT_TEST_STDERR: "", WORKIT_TEST_EXIT: "0",
    WORKIT_TEST_SIGNAL: "", WORKIT_TEST_HANG: "", WORKIT_TEST_OUTPUT_BYTES: "", ...env,
  });
  return { directory, run };
}

test("session inventories larger than 4 MiB remain readable", async t => {
  const { run } = fixture(t);
  const bytes = 5 * 1024 * 1024;
  const result = await run(null, { WORKIT_TEST_OUTPUT_BYTES: String(bytes) }, ["session", "list"]) as {
    workflowProtocol: number; sessions: Array<{ id: string; detail: string }>;
  };
  assert.equal(result.workflowProtocol, 1);
  assert.equal(result.sessions[0].id, "fixture-session");
  assert.equal(result.sessions[0].detail.length, bytes);
});

test("oversized JSON reports the buffer limit instead of an authentication error", async t => {
  const { run } = fixture(t);
  await assert.rejects(run(null, { WORKIT_TEST_OUTPUT_BYTES: String(33 * 1024 * 1024) }, ["session", "list"]),
    /JSON output exceeded the 32 MiB buffer limit/);
});

test("commandJSON preserves structured workflow refusals on nonzero and zero exits", async t => {
  const { run } = fixture(t);
  for (const code of ["workflow_refused", "workflow_wake_refused"] as const) {
    const response = { ...refusal, error: { ...refusal.error, code } };
    for (const exit of ["75", "0"]) {
      for (const operation of ["set", "wake", "resolve"]) {
        await assert.rejects(run(response, { WORKIT_TEST_EXIT: exit, WORKIT_TEST_STDERR: "banyanctl: server returned HTTP 409\n" }, ["workflow", operation]),
          error => error instanceof WorkflowRefusedError && error.code === code && error.reason === response.error.message && error.message === response.error.message);
      }
    }
  }
  assert.deepEqual(await run({ ok: true }), { ok: true });
});

test("non-JSON, unavailable, 5xx, malformed refusals and signal failures remain errors", async t => {
  const { directory, run } = fixture(t);
  for (const code of ["workflow_refused", "workflow_wake_refused"]) {
    const refusal = { ok: false, error: { code, message: "gate refused" } };
    for (const [value, env] of [
      [refusal, { WORKIT_TEST_STDERR: "banyanctl: server returned HTTP 401\n", WORKIT_TEST_EXIT: "64" }],
      [refusal, { WORKIT_TEST_STDERR: "banyanctl: server returned HTTP 403\n", WORKIT_TEST_EXIT: "64" }],
      [refusal, { WORKIT_TEST_STDERR: "banyanctl: server returned HTTP 503\n", WORKIT_TEST_EXIT: "64" }],
      [refusal, { WORKIT_TEST_SIGNAL: "1" }],
      [refusal, { WORKIT_TEST_OUTPUT: "not JSON" }],
      [null, { WORKIT_TEST_STDERR: "Banyan control server is unavailable", WORKIT_TEST_EXIT: "69" }],
      [{ ok: false, error: { code: "server_error", message: "unavailable" } }, { WORKIT_TEST_EXIT: "64" }],
      [{ ok: false, error: { code, message: "" } }, { WORKIT_TEST_EXIT: "75" }],
      [{ ok: false, error: { code, message: 42 } }, { WORKIT_TEST_EXIT: "75" }],
    ] as const) {
      await assert.rejects(run(value, env), error => error instanceof Error && !(error instanceof WorkflowRefusedError));
    }
    await assert.rejects(run(refusal, { WORKIT_TEST_EXIT: "75" }, ["session", "list"]),
      error => error instanceof Error && !(error instanceof WorkflowRefusedError));
  }
  await assert.rejects(commandJSON([join(directory, "missing-cli")], directory), /failed or timed out/);
});

test("a command timeout remains an error even after printing a structured refusal", async t => {
  const { run } = fixture(t);
  await Promise.all(["workflow_refused", "workflow_wake_refused"].map(code =>
    assert.rejects(run({ ok: false, error: { code, message: "gate refused" } }, { WORKIT_TEST_HANG: "1" }),
      error => error instanceof Error && !(error instanceof WorkflowRefusedError) && /failed or timed out/.test(error.message))));
});

test("refusal retains the raw reason while its display remains sanitized", async t => {
  const { run } = fixture(t);
  const reason = "busy\ninspect /tmp/private/session token=fixture-secret";
  await assert.rejects(run({ ok: false, error: { code: "workflow_wake_refused", message: reason } }), error =>
    error instanceof WorkflowRefusedError && error.reason === reason && error.code === "workflow_wake_refused" &&
    !error.message.includes("fixture-secret") && !error.message.includes("/tmp/private"));
});

test("deployment probes receive explicit observation mode with truthful observer and merge identities", async t => {
  const { directory } = fixture(t);
  const { BanyanLifecycleAdapter } = await import("./lifecycle-adapter.js");
  const { createJob } = await import("./lifecycle.js");
  const { readFileSync, existsSync } = await import("node:fs");
  const capture = join(directory, "deployment-input.json");
  const probe = join(directory, "probe.cjs");
  writeFileSync(probe, 'const fs=require("node:fs");fs.writeFileSync(process.argv[2],JSON.stringify({binding:process.env.WORKIT_DEPLOYMENT_SOURCE_BINDING,source:process.env.WORKIT_SOURCE_SHA,merge:process.env.WORKIT_MERGE_SHA}));console.log(JSON.stringify({ready:true,environment:"lab",target:"fixture-service",sourceSha:"a".repeat(40),version:"v1"}));');
  const job = createJob({ issue: { identifier: "1", backend: "github", title: "Audit",
    body: "## Acceptance Criteria\n- [ ] [query:version] Read serving version.\n- [ ] [code:report] Record the result.",
    labels: [], state: "OPEN", url: "https://github.com/example/project/issues/1" },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
    observedSourceSha: "b".repeat(40), config: { delivery: "investigation", verification: "deployed",
      deploymentProbe: [process.execPath, probe, capture], deploymentSourceBinding: "observe-existing" } });
  const adapter = new BanyanLifecycleAdapter();
  assert.equal((await adapter.deployment(job))?.sourceSha, "a".repeat(40));
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")),
    { binding: "observe-existing", source: "b".repeat(40), merge: "" });
  job.config.deploymentSourceBinding = undefined;
  await adapter.deployment(job);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).binding, "contains-source");
  rmSync(capture);
  job.config.delivery = "implementation";
  job.config.deploymentSourceBinding = "observe-existing";
  await assert.rejects(adapter.deployment(job), /requires investigation/);
  assert.equal(existsSync(capture), false);
});
