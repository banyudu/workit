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
  for (const exit of ["75", "0"]) {
    for (const operation of ["set", "wake", "resolve"]) {
      await assert.rejects(run(refusal, { WORKIT_TEST_EXIT: exit, WORKIT_TEST_STDERR: "banyanctl: server returned HTTP 409\n" }, ["workflow", operation]),
        error => error instanceof WorkflowRefusedError && error.code === "workflow_refused" && error.message === refusal.error.message);
    }
  }
  assert.deepEqual(await run({ ok: true }), { ok: true });
});

test("non-JSON, unavailable, 5xx, malformed refusals and signal failures remain errors", async t => {
  const { directory, run } = fixture(t);
  for (const [value, env] of [
    [refusal, { WORKIT_TEST_STDERR: "banyanctl: server returned HTTP 503\n", WORKIT_TEST_EXIT: "64" }],
    [refusal, { WORKIT_TEST_SIGNAL: "1" }],
    [refusal, { WORKIT_TEST_OUTPUT: "not JSON" }],
    [null, { WORKIT_TEST_STDERR: "Banyan control server is unavailable", WORKIT_TEST_EXIT: "69" }],
    [{ ok: false, error: { code: "server_error", message: "unavailable" } }, { WORKIT_TEST_EXIT: "64" }],
    [{ ok: false, error: { code: "workflow_refused", message: "" } }, { WORKIT_TEST_EXIT: "75" }],
    [{ ok: false, error: { code: "workflow_refused", message: 42 } }, { WORKIT_TEST_EXIT: "75" }],
  ] as const) {
    await assert.rejects(run(value, env), error => error instanceof Error && !(error instanceof WorkflowRefusedError));
  }
  await assert.rejects(run(refusal, { WORKIT_TEST_EXIT: "75" }, ["session", "list"]),
    error => error instanceof Error && !(error instanceof WorkflowRefusedError));
  await assert.rejects(commandJSON([join(directory, "missing-cli")], directory), /failed or timed out/);
});

test("a command timeout remains an error even after printing a structured refusal", async t => {
  const { run } = fixture(t);
  await assert.rejects(run(refusal, { WORKIT_TEST_HANG: "1" }),
    error => error instanceof Error && !(error instanceof WorkflowRefusedError) && /failed or timed out/.test(error.message));
});
