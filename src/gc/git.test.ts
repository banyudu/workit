import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "./store.js";

const engineURL = new URL("./engine.ts", import.meta.url).href;
const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workit-git-probe-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo with spaces"), outside = join(root, "outside");
  mkdirSync(repo); mkdirSync(outside);
  execFileSync("git", ["-C", repo, "init", "-b", "main"], { stdio: ["ignore", "pipe", "pipe"] });
  const run = (script: string, env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    ["--import", loader, "--input-type=module", "-e", script], {
      cwd: outside, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined, ...env },
    });
  return { root, repo, outside, run };
}

test("GC Git checks use the selected repository from a non-Git working directory", t => {
  const f = fixture(t);
  const result = f.run(`
import { git, listWorktrees } from ${JSON.stringify(engineURL)};
console.log(JSON.stringify({ root: git(${JSON.stringify(f.repo)}, ['rev-parse', '--show-toplevel']), worktrees: listWorktrees(${JSON.stringify(f.repo)}) }));
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.root, f.repo);
  assert.equal(output.worktrees[0].path, f.repo);
});

for (const operation of ["probe", "inventory"]) {
  test(`a failed GC Git ${operation} retains error details without leaking stderr`, t => {
    const f = fixture(t);
    const result = f.run(`
import { git, listWorktrees } from ${JSON.stringify(engineURL)};
try {
  ${operation === "probe" ? `git(${JSON.stringify(f.outside)}, ['reflog', '-1']);` : `listWorktrees(${JSON.stringify(f.outside)});`}
  process.exit(1);
} catch (error) { console.log(JSON.stringify({ status: error.status, stderr: String(error.stderr) })); }
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", "caught Git failures must not look like launcher failures");
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 128);
    assert.match(output.stderr, /not a git repository/);
  });
}

test("allocation cleanup skips stale checkout directories and preserves their files and records", t => {
  const f = fixture(t);
  const state = join(f.root, "state.sqlite");
  const registry = new Registry(state);
  const record = { id: "stale-checkout", path: f.outside, repo: f.repo, gitDir: join(f.repo, ".git"),
    birth: 0, head: "", role: "implementation" as const, phase: "idle" as const,
    createdAt: 0, lastActivity: 0, keep: false };
  registry.write([record]);
  writeFileSync(join(f.outside, "local.txt"), "preserve local contents\n");
  const config = join(f.root, "config.json");
  const ctl = join(f.root, "fixture-banyanctl");
  writeFileSync(config, JSON.stringify({ gc: { enabled: true, minFreeGB: 1e9, excludedRepositories: [], banyanctl: ctl } }));
  const result = f.run(`
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const execute = childProcess.execFileSync, spawn = childProcess.spawnSync, exists = fs.existsSync;
const calls = [];
childProcess.execFileSync = (command, args, options) => {
  if (command === ${JSON.stringify(ctl)}) return JSON.stringify({ ok: true, data: { sessions: [] } });
  if (command === 'git') calls.push(args);
  return execute(command, args, options);
};
childProcess.spawnSync = (command, args, options) => command === 'lsof'
  ? { status: 0, stdout: '', stderr: '' } : spawn(command, args, options);
fs.existsSync = path => String(path).endsWith('/state_5.sqlite') ? false : exists(path);
syncBuiltinESMExports();
const { pressureGC } = await import(${JSON.stringify(engineURL)});
pressureGC(${JSON.stringify(f.repo)});
console.log(JSON.stringify({ calls, scanned: fs.readdirSync(${JSON.stringify(f.root)}).some(name => name.startsWith('pressure-')) }));
`, { WORKIT_GC_STATE: state, WORKIT_CONFIG: config });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.scanned, true, "exercise allocation cleanup with isolated activity fixtures");
  assert.deepEqual(output.calls, [], "stale directories must be skipped before Git inspection");
  assert.equal(readFileSync(join(f.outside, "local.txt"), "utf8"), "preserve local contents\n");
  assert.deepEqual(registry.read(), [record]);
});
