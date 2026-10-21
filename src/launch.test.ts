import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, promptFor } from "./launch.js";
import type { CliOptions, IssueDetails, ResolvedConfig, WorktreeResult } from "./types.js";

const issue: IssueDetails = {
  backend: "linear",
  identifier: "ENG-123",
  title: "Fix the widget",
  body: "Widgets explode when poked.",
  labels: ["bug"],
  url: "https://linear.app/2en/issue/ENG-123",
};

const worktree: WorktreeResult = {
  path: "/tmp/worktrees/fix-the-widget",
  branch: "yudu/eng-123-fix-the-widget",
  sourceBranch: "main",
  resumed: false,
};

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    prompt: true,
    agentLaunch: true,
    review: false,
    dryRun: false,
    verbose: false,
    identifiers: ["ENG-123"],
    ...overrides,
  };
}

test("instructions are appended verbatim to the issue prompt", () => {
  const prompt = promptFor(issue, worktree, options({
    instructions: ["Open a pull request when done.", "Then fix its review comments."],
  }));
  assert.match(prompt, /Open a pull request when done\./);
  assert.match(prompt, /Then fix its review comments\./);
  // The block sits between the issue body and the provenance footer.
  assert.ok(prompt.indexOf("Open a pull request when done.") < prompt.indexOf("Launcher provenance"));
});

test("blank instruction lines are dropped", () => {
  const prompt = promptFor(issue, worktree, options({ instructions: ["  ", "Real guidance."] }));
  const matches = prompt.split("Real guidance.").length - 1;
  assert.equal(matches, 1);
});

test("an empty or absent instruction list adds no guidance", () => {
  const withEmpty = promptFor(issue, worktree, options({ instructions: [] }));
  const withAbsent = promptFor(issue, worktree, options());
  assert.equal(withEmpty, withAbsent);
  assert.doesNotMatch(withAbsent, /pull request/i);
});

test("resumed worktrees point the agent at existing history", () => {
  const prompt = promptFor(issue, { ...worktree, resumed: true }, options());
  assert.match(prompt, /This worktree already exists\./);
});

interface Reply { status: number; stdout?: string; stderr?: string }
interface Call { args: string[]; session: string | null; parent: string | null }
const missingParent = (parent = "missing-parent"): Reply => ({
  status: 64,
  stdout: JSON.stringify({ ok: false, error: { code: "bad_request", message: `No active parent session found for id '${parent}'` } }),
  stderr: "banyanctl: server returned HTTP 400\n",
});

function banyanFixture(t: TestContext, replies: Reply[] = [{ status: 0 }]) {
  const directory = mkdtempSync(join(tmpdir(), "workit-parent-"));
  const log = join(directory, "calls.jsonl");
  const cli = join(directory, "banyanctl");
  const keys = ["WORKIT_BANYANCTL", "BANYAN_SESSION_ID", "BANYAN_PARENT_SESSION_ID"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
const replies = ${JSON.stringify(replies)};
const count = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').length : 0;
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), session: process.env.BANYAN_SESSION_ID ?? null, parent: process.env.BANYAN_PARENT_SESSION_ID ?? null }) + '\\n');
const reply = replies[Math.min(count, replies.length - 1)];
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.status);
`, { mode: 0o755 });
  Object.assign(process.env, { WORKIT_BANYANCTL: cli, BANYAN_SESSION_ID: "caller-session" });
  delete process.env.BANYAN_PARENT_SESSION_ID;
  const resolved: ResolvedConfig = {
    config: { launch: { logFile: join(directory, "launch.log") } },
    root: directory, configFiles: [], aliasIndex: {},
  };
  return {
    resolved,
    run: (overrides: Partial<CliOptions> = {}) => launch(resolved, issue, worktree, "fixture",
      { command: "fixture-agent" }, options({ prompt: false, sessionID: "managed-fixture", ...overrides })),
    calls: (): Call[] => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)),
  };
}

test("Banyan launches inherit the calling session and clear only the CLI environment", t => {
  const f = banyanFixture(t);
  f.run();
  const [call] = f.calls();
  assert.deepEqual(call.args.slice(-2), ["--parent", "caller-session"]);
  assert.ok(!call.args.includes("--no-parent"));
  assert.equal(call.session, null);
  assert.equal(call.parent, null);
  assert.equal(process.env.BANYAN_SESSION_ID, "caller-session", "only the child's environment is cleared");
});

for (const sessionID of [undefined, " \t "]) {
  test(`Banyan launches without a session identity (${JSON.stringify(sessionID)}) stay top-level`, t => {
    const f = banyanFixture(t);
    if (sessionID === undefined) delete process.env.BANYAN_SESSION_ID;
    else process.env.BANYAN_SESSION_ID = sessionID;
    f.run();
    assert.ok(f.calls()[0].args.includes("--no-parent"));
    assert.ok(!f.calls()[0].args.includes("--parent"));
  });
}

test("an explicit Banyan parent is preserved when the launch succeeds", t => {
  const f = banyanFixture(t);
  process.env.BANYAN_PARENT_SESSION_ID = " live-parent ";
  f.run();
  const calls = f.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-2), ["--parent", "live-parent"]);
  assert.equal(calls[0].session, null);
  assert.equal(calls[0].parent, null);
});

test("a blank parent override falls back to the trimmed calling session identity", t => {
  const f = banyanFixture(t);
  process.env.BANYAN_PARENT_SESSION_ID = " \t ";
  process.env.BANYAN_SESSION_ID = " caller-session ";
  f.run();
  assert.deepEqual(f.calls()[0].args.slice(-2), ["--parent", "caller-session"]);
});

test("a missing inherited parent falls back once without retargeting the launch", t => {
  const f = banyanFixture(t, [missingParent("caller-session"), { status: 0 }]);
  f.run();
  const [first, second, ...more] = f.calls();
  assert.deepEqual(first.args.slice(-2), ["--parent", "caller-session"]);
  assert.equal(second.args.at(-1), "--no-parent");
  assert.deepEqual(first.args.slice(0, -2), second.args.slice(0, -1));
  assert.deepEqual(more, []);
});

test("strict parent configuration also rejects a missing inherited parent", t => {
  const f = banyanFixture(t, [missingParent("caller-session")]);
  f.resolved.config.launch!.parentFallback = false;
  assert.throws(() => f.run(), /banyanctl exited with status 64/);
  assert.equal(f.calls().length, 1);
});

test("a confirmed missing parent falls back once with the same session id and command", t => {
  const f = banyanFixture(t, [missingParent(), { status: 0 }]);
  process.env.BANYAN_PARENT_SESSION_ID = "missing-parent";
  f.run();
  const [first, second, ...more] = f.calls();
  assert.deepEqual(first.args.slice(-2), ["--parent", "missing-parent"]);
  assert.equal(second.args.at(-1), "--no-parent");
  assert.deepEqual(first.args.slice(0, -2), second.args.slice(0, -1));
  assert.equal(first.args[first.args.indexOf("--id") + 1], "managed-fixture");
  assert.equal(first.session, null);
  assert.equal(second.session, null);
  assert.deepEqual(more, []);
});

test("strict parent configuration rejects a missing parent without retrying", t => {
  const f = banyanFixture(t, [missingParent()]);
  f.resolved.config.launch!.parentFallback = false;
  process.env.BANYAN_PARENT_SESSION_ID = "missing-parent";
  assert.throws(() => f.run(), /banyanctl exited with status 64/);
  assert.equal(f.calls().length, 1);
});

for (const parentFallback of [false, true]) {
  test(`invocation parentFallback=${parentFallback} overrides configuration`, t => {
    const f = banyanFixture(t, [missingParent(), { status: 0 }]);
    f.resolved.config.launch!.parentFallback = !parentFallback;
    process.env.BANYAN_PARENT_SESSION_ID = "missing-parent";
    if (parentFallback) f.run({ parentFallback });
    else assert.throws(() => f.run({ parentFallback }), /banyanctl exited with status 64/);
    assert.equal(f.calls().length, parentFallback ? 2 : 1);
  });
}

for (const [name, reply] of Object.entries({
  "unrelated rejection": { ...missingParent(), stdout: JSON.stringify({ ok: false, error: { code: "unknown_profile", message: "unknown agent profile" } }) },
  "transport failure": { status: 69, stderr: "banyanctl: Banyan control server is unavailable\n" },
  "server failure": { ...missingParent(), stderr: "banyanctl: server returned HTTP 500\n" },
  "malformed response": { ...missingParent(), stdout: "{invalid" },
  "different missing parent": missingParent("another-parent"),
  "successful response": { ...missingParent(), stdout: JSON.stringify({ ok: true, error: { code: "bad_request", message: "No active parent session found for id 'missing-parent'" } }) },
})) {
  test(`${name} never triggers a parent fallback`, t => {
    const f = banyanFixture(t, [reply]);
    process.env.BANYAN_PARENT_SESSION_ID = "missing-parent";
    assert.throws(() => f.run(), /banyanctl exited with status/);
    assert.equal(f.calls().length, 1);
  });
}

test("a failed top-level fallback is reported without a third launch attempt", t => {
  const f = banyanFixture(t, [missingParent(), { status: 69, stderr: "banyanctl: Banyan control server is unavailable\n" }]);
  process.env.BANYAN_PARENT_SESSION_ID = "missing-parent";
  assert.throws(() => f.run(), /banyanctl exited with status 69/);
  assert.equal(f.calls().length, 2);
});
