import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { archiveWorktree, assertArchiveDestination, verifyArchiveSource } from "./archive.js";
import { cachePaths, collectActivity, decide, inspectCheckout, listWorktrees, mergedPR, processIdentity, registerWorktree, removeCache, restoreRetiredWorktree, runGC as engineGC, setLifecycle, withLock, type Activity } from "./engine.js";
import { preserveLocalState, verifyLocalState } from "./local-state.js";
import { resolveConfig } from "../config.js";
import { Registry, type WorktreeRecord } from "./store.js";

const quiet: Activity = { uncertain: [], sessions: [], processes: [], history: [] };
function runGC(options: Parameters<typeof engineGC>[0]) {
  return engineGC({ ...options, policy: { enabled: true, archiveVolumeUUID: undefined, excludedRepositories: [], archiveIdleDays: 30, cacheIdleDays: 14, reviewGraceHours: 1, targetWorktrees: undefined, idleWorktrees: undefined, preserveLocalState: false, maxLocalStateMB: undefined, archiveUnclassified: false, archiveDirtyReviews: false, cleanupRemnants: false, repositoryPolicies: undefined, retireIdleDays: undefined, recycleUnclassified: undefined, recycleExternalWorktrees: undefined, disposablePaths: [], ...options?.policy } });
}
function fixture(t: { after: (fn: () => void) => void }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "workit-gc-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo with spaces"), archives = join(base, "archives");
  mkdirSync(repo); mkdirSync(archives);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  writeFileSync(join(repo, "source.txt"), "baseline\n");
  writeFileSync(join(repo, "deleted.txt"), "delete this in the worktree\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.direnv/\n.wrangler/\n.env.local\n.worktrees/\n");
  git("add", "."); git("commit", "-m", "baseline");
  // Resolve user config independently but omit optional fields entirely rather
  // than overriding them with invalid empty strings.
  writeFileSync(join(repo, ".workit.json"), JSON.stringify({ gc: { archiveDirectory: archives, maxActions: 4 } }));
  const registry = new Registry(join(base, "state.sqlite"));
  const add = (name: string, detached = false) => {
    const path = join(repo, ".worktrees", name);
    git("worktree", "add", ...(detached ? ["--detach"] : ["-b", name]), path, "HEAD");
    return path;
  };
  return { base, repo, archives, registry, git, add };
}

test("working-set targets delete clean excess checkouts while retaining dirty, active and warm work", t => {
  const f = fixture(t);
  const rows = ["old-implementation", "old-manual", "warm", "active"].map((name, i) => ({
    ...registerWorktree(f.add(name), { role: name === "old-manual" ? "unclassified" : "implementation" }, f.registry),
    lastActivity: Date.now() + i * 1000,
  }));
  f.registry.write(rows);
  writeFileSync(join(rows[0].path, "source.txt"), "unfinished implementation\n");
  const report = runGC({ apply: true, registry: f.registry, activity: { ...quiet, sessions: [{ cwd: rows[3].path, id: "active", command: "codex" }] }, now: Date.now() + 2 * 86400000,
    policy: { targetWorktrees: 2, archiveUnclassified: true, archiveIdleDays: 365, cacheIdleDays: 365 } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1);
  assert.equal(existsSync(rows[0].path), true); assert.equal(existsSync(rows[1].path), false);
  assert.ok(existsSync(rows[2].path)); assert.ok(existsSync(rows[3].path));
  assert.equal(readFileSync(join(rows[0].path, "source.txt"), "utf8"), "unfinished implementation\n");
  assert.ok(f.git("show-ref", "--verify", "refs/heads/old-implementation"));
});

test("capacity targets are soft, respect recent activity and never archive unknown external checkouts", t => {
  const f = fixture(t), path = f.add("idle"), record = registerWorktree(path, {}, f.registry);
  const now = Date.now();
  assert.equal(decide(record, { targetWorktrees: 0, archiveUnclassified: true }, quiet, { dirty: true, excessCapacity: true, activityAt: now, now }).action, "retain");
  assert.equal(decide({ ...record, path: join(f.base, "manual-outside") }, { archiveUnclassified: true }, quiet, { dirty: false, excessCapacity: true, activityAt: now - 7200000, now }).action, "retain");
  assert.equal(decide({ ...record, path: join(f.base, "manual-outside") }, { archiveUnclassified: true, archiveExternalWorktrees: true }, quiet, { dirty: false, excessCapacity: true, activityAt: now - 7200000, now }).action, "recycle");
  const active = { ...quiet, sessions: [{ cwd: path, id: "active", command: "codex" }] };
  const report = runGC({ apply: true, registry: f.registry, activity: active, policy: { targetWorktrees: 0, archiveUnclassified: true }, now: now + 60 * 86400000 });
  assert.equal(report.actions, 0); assert.ok(existsSync(path)); assert.equal(report.decisions[0].action, "protect");
});

test("focused sweeps preserve registered repositories outside the selected scope", t => {
  const a = fixture(t), b = fixture(t);
  const first = a.add("selected"), other = b.add("other-repository");
  registerWorktree(first, { role: "implementation" }, a.registry);
  registerWorktree(other, { role: "implementation" }, a.registry);
  const report = runGC({ apply: true, registry: a.registry, onlyRepositories: [a.repo], activity: quiet, now: Date.now() + 2 * 86400000, policy: { targetWorktrees: 0 } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1); assert.equal(report.decisions.length, 1);
  assert.equal(existsSync(first), false); assert.ok(existsSync(other));
});

test("focused cleanup protects a parent containing a checkout from an unselected repository", t => {
  const a = fixture(t), b = fixture(t), parent = a.add("parent"), child = join(parent, "foreign-child");
  b.git("worktree", "add", "--detach", child, "HEAD");
  registerWorktree(parent, { role: "implementation" }, a.registry);
  registerWorktree(child, { role: "implementation" }, a.registry);
  const report = runGC({ apply: true, registry: a.registry, onlyRepositories: [a.repo], activity: quiet, now: Date.now() + 60 * 86400000 });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 0); assert.equal(report.decisions[0].reason, "contains another linked checkout");
  assert.ok(existsSync(parent)); assert.ok(existsSync(child));
});

test("repository-specific working-set targets override defaults and reject invalid limits", t => {
  const f = fixture(t), path = f.add("override"); registerWorktree(path, { role: "implementation" }, f.registry);
  const config = { gc: { archiveDirectory: f.archives, targetWorktrees: 20, repositoryPolicies: { [f.repo]: { targetWorktrees: 0 } } } };
  writeFileSync(join(f.repo, ".workit.json"), JSON.stringify(config));
  const result = engineGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000, policy: { enabled: true, archiveVolumeUUID: undefined, cleanupRemnants: false, disposablePaths: [], idleWorktrees: undefined, preserveLocalState: false } });
  assert.deepEqual(result.errors, []); assert.equal(result.actions, 1); assert.equal(existsSync(path), false);
  config.gc.repositoryPolicies[f.repo].targetWorktrees = -1;
  writeFileSync(join(f.repo, ".workit.json"), JSON.stringify(config));
  assert.throws(() => resolveConfig(f.repo), /targetWorktrees/);
});

test("Banyan activity retries transient failures and fails closed when all attempts fail", t => {
  const f = fixture(t), bin = join(f.base, "bin"); mkdirSync(bin);
  const ctl = join(bin, "banyanctl"), count = join(bin, "attempts"), argsLog = join(bin, "args.json");
  const payload = { ok: true, data: { sessions: [
    { cwd: f.repo, id: "waiting", status: "need-input", updatedAt: new Date().toISOString() },
    { cwd: f.repo, id: "recovering", status: "closed", deepRecoveryIsUncertain: true, updatedAt: new Date().toISOString() },
  ] } };
  writeFileSync(ctl, `#!${process.execPath}\nconst fs=require("node:fs");const p=${JSON.stringify(count)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;fs.writeFileSync(p,String(n+1));fs.writeFileSync(${JSON.stringify(argsLog)},JSON.stringify(process.argv.slice(2)));if(n===0)process.exit(69);process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`, { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!${process.execPath}\nprocess.exit(0);`, { mode: 0o755 });
  const oldPath = process.env.PATH, oldCodex = process.env.CODEX_HOME;
  process.env.PATH = `${bin}:${oldPath}`; process.env.CODEX_HOME = join(f.base, "no-codex");
  t.after(() => { process.env.PATH = oldPath; if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex; });
  const activity = collectActivity({ banyanctl: ctl });
  assert.deepEqual(activity.uncertain, []); assert.equal(activity.sessions[0].id, "waiting"); assert.equal(readFileSync(count, "utf8"), "2");
  assert.deepEqual(JSON.parse(readFileSync(argsLog, "utf8")), ["list", "--all"]);
  const activeOnly = collectActivity({ banyanctl: ctl }, false);
  assert.deepEqual(JSON.parse(readFileSync(argsLog, "utf8")), ["list", "--all"]);
  assert.ok(activeOnly.sessions.some(session => session.id === "recovering"));
  assert.deepEqual(activeOnly.history, []);
  writeFileSync(ctl, `#!${process.execPath}\nprocess.exit(69);`, { mode: 0o755 });
  assert.match(collectActivity({ banyanctl: ctl }).uncertain[0], /Banyan inventory unavailable/);
});

test("remnant cleanup retains unknown files and links without backups, excluding controls and nested Git directories", t => {
  const f = fixture(t), root = join(f.repo, ".worktrees"); mkdirSync(root);
  const checkout = f.add("real-checkout"); registerWorktree(checkout, { role: "implementation" }, f.registry);
  const remnant = join(root, "old-folder"), controls = join(root, ".verify-pool-locks"), nested = join(root, "nested-repository");
  mkdirSync(join(remnant, "node_modules"), { recursive: true });
  writeFileSync(join(remnant, "node_modules", "valuable-unknown-content"), "preserve even cache-shaped contents\n");
  mkdirSync(join(remnant, ".claude")); writeFileSync(join(remnant, ".claude", "session.jsonl"), "session data\n");
  const external = join(f.base, "external"); mkdirSync(external); writeFileSync(join(external, "keep"), "keep\n");
  symlinkSync(external, join(remnant, "external-link"));
  mkdirSync(controls); mkdirSync(join(nested, ".git"), { recursive: true });
  symlinkSync(external, join(root, "redirect"));
  const report = runGC({ apply: true, registry: f.registry, repositories: [f.repo], remnantsOnly: true, activity: quiet, now: Date.now() + 2 * 86400000, policy: { cleanupRemnants: true } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 0); assert.ok(existsSync(remnant));
  assert.ok(existsSync(controls)); assert.ok(existsSync(nested)); assert.ok(existsSync(join(external, "keep")));
  assert.ok(existsSync(checkout)); assert.equal(report.decisions.length, 1);
  assert.equal(readFileSync(join(remnant, ".claude", "session.jsonl"), "utf8"), "session data\n");
  assert.equal(f.registry.read().find(r => r.remnant)?.archive, undefined);
});

test("dirty reviews remain retained even with the legacy archive opt-in", t => {
  const f = reviewFixture(t);
  writeFileSync(join(f.path, "source.txt"), "validator output\n");
  setLifecycle(f.path, { phase: "finished", release: true, pid: process.pid }, f.registry);
  const report = runGC({ apply: true, registry: f.registry, worktree: f.path, activity: quiet, policy: { archiveDirtyReviews: true } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 0); assert.ok(existsSync(f.path));
  assert.ok(existsSync(f.file)); assert.equal(f.registry.read()[0].archive, undefined);
});

test("different archived revisions share a self-contained sweep history bundle", t => {
  const f = fixture(t), first = f.add("first-head"), second = f.add("second-head");
  writeFileSync(join(second, "source.txt"), "new commit\n");
  f.git("-C", second, "add", "source.txt"); f.git("-C", second, "commit", "-m", "second revision");
  const a = registerWorktree(first, {}, f.registry), b = registerWorktree(second, {}, f.registry), heads = [a.head, b.head];
  const aa = archiveWorktree(a, f.archives, ["source.txt", "deleted.txt", ".gitignore"], undefined, heads);
  const bb = archiveWorktree(b, f.archives, ["source.txt", "deleted.txt", ".gitignore"], undefined, heads);
  assert.equal(statSync(join(aa, "history.bundle")).ino, statSync(join(bb, "history.bundle")).ino);
  const output = execFileSync("git", ["bundle", "list-heads", join(aa, "history.bundle")], { encoding: "utf8" });
  assert.ok(output.includes(a.head)); assert.ok(output.includes(b.head));
});

test("large tracked deletions are retained without materializing a diff or archive", t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "large.txt"), ("x".repeat(1023) + "\n").repeat(70 * 1024));
  f.git("add", "large.txt"); f.git("commit", "-m", "large tracked fixture");
  const path = f.add("large-deletion"); registerWorktree(path, { role: "implementation" }, f.registry);
  rmSync(join(path, "large.txt"));
  const report = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000, policy: { targetWorktrees: 0 } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 0);
  assert.equal(report.decisions[0].action, "retain"); assert.ok(existsSync(path));
  assert.equal(f.registry.read()[0].archive, undefined);
});

test("registry identifies detached checkouts and refuses primary/redirected roots", t => {
  const f = fixture(t), path = f.add("detached", true);
  const r = registerWorktree(path, { role: "pool" }, f.registry);
  assert.equal(r.branch, undefined);
  assert.equal(listWorktrees(f.repo).filter(x => !x.main).length, 1);
  assert.throws(() => registerWorktree(f.repo, {}, f.registry), /Primary/);
  const alias = join(f.base, "redirect"); symlinkSync(path, alias);
  // Registration normalizes an explicit alias; GC discovery never follows a
  // replaced root and stored identity is the canonical Git checkout.
  assert.equal(registerWorktree(alias, {}, f.registry).path, path);
  f.registry.write([{ ...r, keep: true }]);
  assert.equal(registerWorktree(path, {}, f.registry).keep, true);
});

test("active sessions, open files, uncertain inventories and explicit keep protect checkouts", t => {
  const f = fixture(t), path = f.add("task"), r = registerWorktree(path, { role: "implementation" }, f.registry);
  for (const activity of [
    { ...quiet, sessions: [{ cwd: path, id: "waiting", command: "codex" }] },
    { ...quiet, processes: [{ cwd: join(path, "source.txt"), pid: 123 }] },
    { ...quiet, uncertain: ["Banyan unavailable"] },
  ]) assert.equal(decide(r, {}, activity, { dirty: false, merged: true, now: Date.now() + 60 * 86400000 }).action, "protect");
  assert.equal(decide({ ...r, keep: true }, {}, quiet, { dirty: false, merged: true }).action, "protect");
  assert.equal(decide(r, { excludedRepositories: [f.repo] }, quiet, { dirty: false }).reason, "repository excluded");
});

test("live leases cannot be stolen or released by a different owner", t => {
  const f = fixture(t), path = f.add("leased");
  registerWorktree(path, { role: "implementation", pid: process.pid }, f.registry);
  assert.throws(() => setLifecycle(path, { release: true, pid: process.ppid }, f.registry), /another live owner/);
  assert.equal(decide(f.registry.read()[0], {}, quiet, { dirty: false }).action, "protect");
  setLifecycle(path, { release: true, pid: process.pid }, f.registry);
  assert.equal(f.registry.read()[0].owner, undefined);
});

test("dry run is read-only, keeps unknown ownership, and preserves dirty review work", t => {
  const f = fixture(t), path = f.add("manual", true);
  const report = runGC({ registry: f.registry, repositories: [f.repo], activity: quiet });
  assert.equal(existsSync(f.registry.path), false);
  assert.equal(report.decisions[0].action, "retain");
  assert.equal(existsSync(path), true);
  const jobId = "a".repeat(24), review = f.add(`review-task-42-${jobId}`, true), directory = join(f.base, "job"); mkdirSync(directory);
  const file = join(directory, "job.json");
  const head = f.git("rev-parse", "HEAD"), gitDir = execFileSync("git", ["-C", review, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(file, JSON.stringify({ id: jobId, issue: "TASK-42", repo: f.repo, worktree: review, gitDir, baseSha: head, keepWorktree: false }));
  registerWorktree(review, { role: "review", jobFile: file }, f.registry);
  setLifecycle(review, { phase: "finished" }, f.registry);
  writeFileSync(join(review, "source.txt"), "unsaved review fix\n");
  const result = runGC({ apply: true, registry: f.registry, worktree: review, activity: quiet });
  assert.equal(result.decisions[0].action, "retain");
  assert.equal(readFileSync(join(review, "source.txt"), "utf8"), "unsaved review fix\n");
});

test("cold dirty work preserves staging, ignored databases and local files without backup", t => {
  const f = fixture(t), path = f.add("cold");
  registerWorktree(path, { role: "implementation" }, f.registry);
  writeFileSync(join(path, "source.txt"), "staged\n"); execFileSync("git", ["-C", path, "add", "source.txt"]);
  writeFileSync(join(path, "source.txt"), "unstaged\n"); rmSync(join(path, "deleted.txt"));
  writeFileSync(join(path, ".env.local"), "fixture local state\n");
  mkdirSync(join(path, ".wrangler")); writeFileSync(join(path, ".wrangler", "local.sqlite"), "valuable database");
  mkdirSync(join(path, "node_modules")); writeFileSync(join(path, "node_modules", "generated"), "disposable");
  const result = runGC({ apply: true, registry: f.registry, worktree: path, activity: quiet, now: Date.now() + 60 * 86400000 });
  assert.deepEqual(result.errors, []); assert.equal(result.actions, 0); assert.ok(existsSync(path));
  assert.equal(readFileSync(join(path, "source.txt"), "utf8"), "unstaged\n");
  assert.equal(execFileSync("git", ["-C", path, "show", ":source.txt"], { encoding: "utf8" }), "staged\n");
  assert.equal(readFileSync(join(path, ".wrangler", "local.sqlite"), "utf8"), "valuable database");
  assert.equal(f.registry.read()[0].archive, undefined);
});

test("clean deletion has no SSD dependency and changed checkout identities stay protected", t => {
  const f = fixture(t), path = f.add("missing-ssd"); registerWorktree(path, { role: "implementation" }, f.registry);
  writeFileSync(join(f.repo, ".workit.json"), JSON.stringify({ gc: { archiveDirectory: join(f.base, "not-mounted"), archiveVolumeUUID: "00000000-0000-0000-0000-000000000000" } }));
  const result = runGC({ apply: true, registry: f.registry, worktree: path, activity: quiet, now: Date.now() + 60 * 86400000 });
  assert.deepEqual(result.errors, []); assert.equal(result.actions, 1); assert.equal(existsSync(path), false);
  assert.equal(f.registry.read()[0].archive, undefined);
  const second = f.add("changed-identity"), old = registerWorktree(second, {}, f.registry);
  f.registry.write([{ ...old, gitDir: old.gitDir + "-wrong" }]);
  assert.throws(() => setLifecycle(second, { keep: true }, f.registry), /identity changed/);
});

test("private read-only cache removal preserves external symlink targets and tracked cache files", t => {
  const f = fixture(t), path = f.add("caches");
  const external = join(f.base, "shared"); mkdirSync(external); writeFileSync(join(external, "important"), "keep");
  const nix = join(path, ".direnv", "nix-sources", "hash", "source"); mkdirSync(nix, { recursive: true });
  writeFileSync(join(nix, "generated"), "cache"); symlinkSync(external, join(nix, "external")); chmodSync(nix, 0o555);
  mkdirSync(join(path, ".build")); writeFileSync(join(path, ".build", "tracked-marker"), "keep");
  writeFileSync(join(path, ".build", "generated"), "remove");
  const candidates = cachePaths(path, ["source.txt", ".build/tracked-marker"]);
  assert.equal(candidates.includes(join(path, ".build")), false);
  for (const candidate of candidates) removeCache(candidate);
  assert.equal(readFileSync(join(external, "important"), "utf8"), "keep");
  assert.equal(readFileSync(join(path, ".build", "tracked-marker"), "utf8"), "keep");
  assert.equal(existsSync(join(path, ".build", "generated")), false);
});

test("mutex ownership is atomic, ignores wrong unlock tokens and recovers a dead process", async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  assert.ok(child.pid);
  const owner = { pid: child.pid, identity: processIdentity(child.pid) };
  assert.equal(f.registry.lock("a", "first", owner), true);
  assert.equal(f.registry.lock("a", "second", { pid: process.pid, identity: processIdentity(process.pid) }), false);
  f.registry.unlock("a", "wrong");
  assert.equal(f.registry.lock("a", "second", owner), false);
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL"); await exited;
  assert.equal(withLock(f.registry, "a", () => 42), 42);
});

function reviewFixture(t: { after: (fn: () => void) => void }) {
  const f = fixture(t), id = "b".repeat(24), path = f.add(`review-task-77-${id}`, true);
  const file = join(f.base, "job.json"), head = f.git("rev-parse", "HEAD");
  const gitDir = execFileSync("git", ["-C", path, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(file, JSON.stringify({ id, issue: "TASK-77", repo: f.repo, worktree: path, gitDir, baseSha: head, keepWorktree: false }));
  registerWorktree(path, { role: "review", jobFile: file, pid: process.pid }, f.registry);
  return { ...f, path, file };
}

test("clean finished detached reviews delete without archives and remain reconstructible after Git GC", t => {
  const f = reviewFixture(t);
  setLifecycle(f.path, { phase: "finished", release: true, pid: process.pid }, f.registry);
  // Give the detached checkout a commit unreachable from ordinary branches.
  execFileSync("git", ["-C", f.path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "detached revision"]);
  const head = execFileSync("git", ["-C", f.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(f.file, JSON.stringify({ ...JSON.parse(readFileSync(f.file, "utf8")), baseSha: head }));
  f.registry.write(f.registry.read().map(row => ({ ...row, head })));
  const resultFile = join(f.base, "result.json"); writeFileSync(resultFile, "{\"verified\":true}");
  const guard = join(f.base, "python-guard");
  writeFileSync(guard, '#!/usr/bin/env python3\nimport os,sys\nassert not any(x in sys.argv[2] for x in ("tarfile", "hashlib", "gzip")), "Archive helper invoked"\nos.execvp("python3", ["python3"]+sys.argv[1:])\n', { mode: 0o755 });
  const oldPython = process.env.WORKIT_PYTHON; process.env.WORKIT_PYTHON = guard;
  t.after(() => { if (oldPython === undefined) delete process.env.WORKIT_PYTHON; else process.env.WORKIT_PYTHON = oldPython; });
  const report = runGC({ apply: true, registry: f.registry, worktree: f.path, activity: quiet });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1); assert.equal(existsSync(f.path), false);
  assert.equal(report.decisions[0].operation, "delete"); assert.equal(report.archiveBytes, 0); assert.equal(report.restoredBytes, 0);
  const saved = f.registry.read()[0]; assert.equal(saved.phase, "retired"); assert.ok(saved.recoveryRef); assert.equal(saved.archive, undefined);
  f.git("reflog", "expire", "--expire=now", "--all"); f.git("gc", "--prune=now");
  assert.equal(f.git("rev-parse", saved.recoveryRef!), head);
  const restored = join(f.base, "reconstructed"); f.git("worktree", "add", "--detach", restored, saved.recoveryRef!);
  assert.equal(readFileSync(join(restored, "source.txt"), "utf8"), "baseline\n");
  assert.ok(existsSync(f.file)); assert.equal(readFileSync(resultFile, "utf8"), "{\"verified\":true}");
});

test("clean Git status cannot discard ignored databases or untracked local files", t => {
  const f = fixture(t), path = f.add("local-state"), record = registerWorktree(path, { role: "implementation" }, f.registry);
  mkdirSync(join(path, ".wrangler")); writeFileSync(join(path, ".wrangler", "local.sqlite"), "database");
  writeFileSync(join(path, "notes.txt"), "uncommitted notes");
  assert.equal(execFileSync("git", ["-C", path, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }), "");
  assert.deepEqual(inspectCheckout(record, {}).localState.sort(), [".wrangler/local.sqlite", "notes.txt"]);
  const report = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 60 * 86400000 });
  assert.equal(report.actions, 0); assert.equal(readFileSync(join(path, ".wrangler", "local.sqlite"), "utf8"), "database");
});

test("hidden index changes are retained and explicit disposable paths preserve tracked markers", t => {
  const f = fixture(t), path = f.add("index-flags"), record = registerWorktree(path, { role: "implementation" }, f.registry);
  for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
    execFileSync("git", ["-C", path, "update-index", flag, "source.txt"]);
    assert.equal(inspectCheckout(record, {}).dirty, true);
    execFileSync("git", ["-C", path, "update-index", flag === "--skip-worktree" ? "--no-skip-worktree" : "--no-assume-unchanged", "source.txt"]);
  }
  mkdirSync(join(path, ".build")); writeFileSync(join(path, ".build", "marker"), "tracked");
  execFileSync("git", ["-C", path, "add", ".build/marker"]);
  execFileSync("git", ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "marker"]);
  writeFileSync(join(path, ".build", "generated"), "cache");
  mkdirSync(join(path, ".direnv")); writeFileSync(join(path, ".direnv", "dev-tools"), "generated");
  writeFileSync(join(path, ".direnv", "private-state"), "keep");
  const state = inspectCheckout(record, { disposablePaths: [".direnv/dev-tools"] });
  assert.deepEqual(state.localState, [".direnv/private-state"]);
  assert.ok(state.caches.includes(join(path, ".build", "generated"))); assert.ok(!state.caches.includes(join(path, ".build")));
  for (const bad of ["../outside", "/absolute", ".git/config", ".worktrees/child", "node_modules/../notes"]) {
    writeFileSync(join(f.repo, ".workit.json"), JSON.stringify({ gc: { disposablePaths: [bad] } }));
    assert.throws(() => resolveConfig(f.repo), /disposablePaths/);
  }
});

test("unknown remnant files stay while explicitly disposable residual files can be deleted", t => {
  const f = fixture(t), path = join(f.repo, ".worktrees", "old-residual");
  mkdirSync(join(path, ".greptile"), { recursive: true }); writeFileSync(join(path, ".greptile", "config.json"), "{}");
  const options = { apply: true, registry: f.registry, repositories: [f.repo], remnantsOnly: true, activity: quiet, now: Date.now() + 2 * 86400000, policy: { cleanupRemnants: true } };
  assert.equal(runGC(options).actions, 0); assert.ok(existsSync(path));
  const report = runGC({ ...options, policy: { ...options.policy, disposablePaths: [".greptile/config.json"] } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1); assert.equal(existsSync(path), false);
  assert.equal(report.decisions[0].operation, "delete");
});

test("simultaneous finish commands and sweeps share one worker and leave deferred reviews pending", { timeout: 120_000 }, async t => {
  const f = fixture(t), paths: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const id = String(n).repeat(24), path = f.add(`review-task-${n}-${id}`, true), file = join(f.base, `job-${n}.json`);
    const gitDir = execFileSync("git", ["-C", path, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
    writeFileSync(file, JSON.stringify({ id, issue: `TASK-${n}`, repo: f.repo, worktree: path, gitDir, baseSha: f.git("rev-parse", "HEAD"), keepWorktree: false }));
    registerWorktree(path, { role: "review", jobFile: file }, f.registry); paths.push(path);
  }
  const bin = join(f.base, "bin"), home = join(f.base, "home"); mkdirSync(bin); mkdirSync(home);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const ready = join(f.base, "ready"), release = join(f.base, "release"), events = join(f.base, "events.jsonl");
  writeFileSync(join(bin, "git"), `#!/usr/bin/env python3\nimport json,os,subprocess,sys,time\na=sys.argv[1:]\nis_remove='worktree' in a and a[a.index('worktree')+1]=='remove'\nif is_remove:\n with open(${JSON.stringify(events)},'a') as f:f.write(json.dumps({'event':'start','pid':os.getpid()})+'\\n')\n open(${JSON.stringify(ready)},'w').close()\n end=time.time()+15\n while not os.path.exists(${JSON.stringify(release)}) and time.time()<end:time.sleep(.02)\np=subprocess.run([${JSON.stringify(realGit)}]+a)\nif is_remove:\n with open(${JSON.stringify(events)},'a') as f:f.write(json.dumps({'event':'end','pid':os.getpid()})+'\\n')\nsys.exit(p.returncode)\n`, { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const ctl = join(bin, "banyanctl"); writeFileSync(ctl, `#!${process.execPath}\nprocess.stdout.write('{"ok":true,"data":{"sessions":[]}}');\n`, { mode: 0o755 });
  const config = join(f.base, "config.json"); writeFileSync(config, JSON.stringify({ gc: { enabled: true, repositories: [f.repo], banyanctl: ctl, maxActions: 4, cleanupRemnants: false } }));
  const runner = join(f.base, "cli.mjs"); writeFileSync(runner, `import { gcCLI } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/gc/cli.ts")).href)}; gcCLI(process.argv.slice(2));\n`);
  const env = { ...process.env, HOME: home, WORKIT_CONFIG: config, WORKIT_GC_STATE: f.registry.path, CODEX_HOME: join(home, ".codex"), PATH: `${bin}:${process.env.PATH}` };
  const children: ReturnType<typeof spawn>[] = [];
  t.after(() => { if (existsSync(f.base)) writeFileSync(release, ""); for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); });
  const invoke = (args: string[]) => {
    const child = spawn(process.execPath, ["--import", "tsx", runner, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
    const pending = new Promise<any>((resolve, reject) => {
      let output = "", error = ""; child.stdout!.on("data", chunk => output += chunk); child.stderr!.on("data", chunk => error += chunk);
      child.once("error", reject); child.once("exit", code => { try { assert.equal(code, 0, error); resolve(JSON.parse(output)); } catch (e) { reject(e); } });
    });
    // Cleanup can stop a worker before the test reaches its final await.
    void pending.catch(() => {});
    return pending;
  };
  const finish = (path: string) => ["finish", "--worktree", path, "--pid", String(process.pid), "--apply", "--json"];
  const first = invoke(finish(paths[0]));
  const until = Date.now() + 45_000;
  while (!existsSync(ready) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(existsSync(ready), "first worker reached deletion");
  const contenders = await Promise.all([invoke(finish(paths[1])), invoke(finish(paths[2])), invoke(["--apply", "--json"])]);
  assert.ok(contenders.every(report => report.actions === 0));
  for (const report of contenders.slice(0, 2)) assert.equal(report.decisions[0].operation, "defer");
  for (const path of paths.slice(1)) assert.equal(f.registry.read().find(row => row.path === path)?.phase, "finished");
  writeFileSync(release, ""); assert.equal((await first).actions, 1);
  assert.equal((await invoke(["--apply", "--json"])).actions, 2);
  let active = 0, peak = 0;
  for (const line of readFileSync(events, "utf8").trim().split("\n")) { active += JSON.parse(line).event === "start" ? 1 : -1; peak = Math.max(peak, active); }
  assert.equal(peak, 1); assert.equal(active, 0); assert.ok(paths.every(path => !existsSync(path)));
});

test("review completion retains ignored local state after lease handoff", t => {
  const f = reviewFixture(t);
  writeFileSync(join(f.path, ".env.local"), "review local state");
  setLifecycle(f.path, { pid: process.pid, release: true }, f.registry);
  registerWorktree(f.path, { pid: process.pid, phase: "running" }, f.registry);
  setLifecycle(f.path, { phase: "finished", release: true, pid: process.pid }, f.registry);
  const report = runGC({ apply: true, registry: f.registry, worktree: f.path, activity: quiet });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 0);
  assert.equal(existsSync(f.path), true);
  const saved = f.registry.read()[0]; assert.equal(saved.phase, "finished");
  assert.equal(saved.archive, undefined); assert.equal(readFileSync(join(f.path, ".env.local"), "utf8"), "review local state");
  assert.equal(existsSync(f.file), true);
});

test("interrupted reviews with lost .git retain unique source and local state", t => {
  const f = reviewFixture(t);
  setLifecycle(f.path, { release: true, pid: process.pid }, f.registry);
  const cache = join(f.path, ".direnv", "nix-sources", "hash", "source"); mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "generated"), "cache"); chmodSync(cache, 0o555);
  writeFileSync(join(f.path, ".env.local"), "residual state");
  rmSync(join(f.path, ".git"));
  const report = runGC({ apply: true, registry: f.registry, worktree: f.path, activity: quiet, now: Date.now() + 86400000 });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 0);
  assert.equal(existsSync(f.path), true);
  assert.equal(existsSync(f.file), true); chmodSync(cache, 0o755);
});

test("verification detects source changes and archives skip generated siblings of tracked markers", t => {
  const f = fixture(t), path = f.add("verification");
  mkdirSync(join(path, ".build")); writeFileSync(join(path, ".build", "marker"), "keep");
  writeFileSync(join(path, ".build", "generated"), "cache");
  const record = registerWorktree(path, { role: "implementation" }, f.registry);
  const tracked = ["source.txt", "deleted.txt", ".gitignore", ".build/marker"];
  const archive = archiveWorktree(record, f.archives, tracked);
  const manifest = readFileSync(join(archive, "checkout.tar.gz.manifest.json"), "utf8");
  assert.ok(manifest.includes(".build/marker")); assert.ok(!manifest.includes("generated"));
  writeFileSync(join(path, "source.txt"), "changed during cleanup");
  assert.throws(() => verifyArchiveSource(path, archive, tracked), /changed after archiving/);
});

test("policy separates merged implementations, cold work and excess pool slots", t => {
  const f = fixture(t), path = f.add("policy"), r = registerWorktree(path, { role: "implementation" }, f.registry);
  const now = Date.now() + 2 * 86400000;
  assert.equal(decide(r, {}, quiet, { dirty: false, merged: true, now }).action, "recycle");
  assert.equal(decide(r, {}, quiet, { dirty: true, merged: true, now }).action, "retain");
  assert.equal(decide({ ...r, role: "pool" }, {}, quiet, { dirty: false, excessPool: true, now: now + 10 * 86400000 }).action, "recycle");
  assert.equal(decide({ ...r, role: "pool" }, {}, quiet, { dirty: false, excessPool: false, now: now + 10 * 86400000 }).action, "retain");
});

test("an apply run respects its action budget", t => {
  const f = fixture(t);
  for (const name of ["first", "second"]) registerWorktree(f.add(name), { role: "implementation" }, f.registry);
  const report = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 60 * 86400000, maxActions: 1 });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1);
  assert.equal(report.decisions.filter(d => d.result === "deferred: per-run limit").length, 1);
});

test("merged proof requires the exact PR head, including squash merges and subsequent branch work", t => {
  const f = fixture(t), path = f.add("merged-proof"), record = registerWorktree(path, { role: "implementation" }, f.registry);
  const bin = join(f.base, "bin"); mkdirSync(bin);
  const data = join(bin, "heads.json");
  writeFileSync(join(bin, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(require("node:path").join(__dirname,"heads.json")))\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  writeFileSync(data, JSON.stringify([{ headRefOid: record.head, mergedAt: "2026-01-01T00:00:00Z" }]));
  assert.equal(mergedPR(record), true);
  assert.equal(mergedPR({ ...record, head: "a".repeat(40) }), false);
  writeFileSync(data, JSON.stringify([{ headRefOid: record.head, mergedAt: null }]));
  assert.equal(mergedPR(record), false);
});

test("leased pool slots do not consume the two warm idle slots", t => {
  const f = fixture(t);
  const records = ["old", "warm-one", "warm-two", "dirty", "active"].map((name, i) => ({ ...registerWorktree(f.add(name, true), { role: "pool", ...(name === "active" ? { pid: process.pid } : {}) }, f.registry), lastActivity: Date.now() + i * 1000 }));
  writeFileSync(join(records[3].path, "source.txt"), "unfinished pool state\n");
  f.registry.write(records);
  const report = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 60 * 86400000 });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1);
  assert.equal(existsSync(records[0].path), false);
  for (const record of records.slice(1)) assert.equal(existsSync(record.path), true);
});

test("cold parents containing another linked checkout are retained, including targeted cleanup", t => {
  const f = fixture(t), parent = f.add("parent");
  registerWorktree(parent, { role: "implementation" }, f.registry);
  const child = join(parent, ".worktrees", "manual-child");
  f.git("worktree", "add", "--detach", child, "HEAD");
  for (const worktree of [undefined, parent]) {
    const report = runGC({ apply: true, registry: f.registry, worktree, activity: quiet, now: Date.now() + 60 * 86400000 });
    assert.deepEqual(report.errors, []); assert.equal(report.actions, 0);
    assert.equal(report.decisions.find(d => d.path === parent)?.reason, "contains another linked checkout");
    assert.equal(existsSync(child), true); assert.equal(existsSync(parent), true);
  }
});

test("cache trimming preserves all local roots and still reaches caches after eight unknown files", t => {
  const f = fixture(t), path = f.add("cache-with-local-data");
  registerWorktree(path, { role: "implementation" }, f.registry);
  for (let i = 0; i < 12; i++) writeFileSync(join(path, `a-local-${i}`), `unique ${i}\n`);
  mkdirSync(join(path, "node_modules")); writeFileSync(join(path, "node_modules", "generated"), "rebuildable");
  mkdirSync(join(path, ".wrangler")); writeFileSync(join(path, ".wrangler", "database.sqlite"), "local data");
  const state = inspectCheckout(f.registry.read()[0], {});
  assert.equal(state.localState.length, 13);
  assert.ok(state.caches.includes(join(path, "node_modules")));
  const result = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 20 * 86400000 });
  assert.deepEqual(result.errors, []); assert.equal(result.actions, 1);
  assert.equal(result.decisions[0].operation, "trim");
  assert.equal(existsSync(join(path, "node_modules")), false);
  assert.equal(readFileSync(join(path, "a-local-11"), "utf8"), "unique 11\n");
  assert.equal(readFileSync(join(path, ".wrangler", "database.sqlite"), "utf8"), "local data");
});

test("idle allowance keeps two warm checkouts in addition to protected sessions", t => {
  const f = fixture(t);
  const records = ["old", "warm-one", "warm-two", "live"].map((name, i) => ({
    ...registerWorktree(f.add(name), { role: "implementation" }, f.registry), lastActivity: Date.now() + i * 1000,
  }));
  f.registry.write(records);
  const report = runGC({ apply: true, registry: f.registry,
    activity: { ...quiet, sessions: [{ cwd: records[3].path, id: "live", command: "codex" }] },
    now: Date.now() + 60 * 86400000, policy: { idleWorktrees: 2, targetWorktrees: 50 } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1);
  assert.equal(existsSync(records[0].path), false);
  for (const record of records.slice(1)) assert.ok(existsSync(record.path));
  assert.equal(report.decisions.find(x => x.path === records[1].path)?.reason, "warm idle checkout allowance");
});

test("retirement preserves only local data and restores exact revision, modes and symlinks", t => {
  const f = fixture(t), path = f.add("local-state-retirement", true);
  const record = registerWorktree(path, { role: "implementation" }, f.registry);
  const external = join(f.base, "external-session-history"); writeFileSync(external, "keep history\n");
  writeFileSync(join(path, ".env.local"), "unique local configuration\n", { mode: 0o600 });
  mkdirSync(join(path, ".wrangler"));
  writeFileSync(join(path, ".wrangler", "database.sqlite"), "unique database\n", { mode: 0o640 });
  symlinkSync(external, join(path, "history-link"));
  mkdirSync(join(path, "draft-package", "node_modules"), { recursive: true });
  chmodSync(join(path, "draft-package"), 0o700);
  writeFileSync(join(path, "draft-package", "notes.txt"), "unique untracked draft\n");
  writeFileSync(join(path, "draft-package", "node_modules", "generated"), "nested cache\n");
  mkdirSync(join(path, "node_modules")); writeFileSync(join(path, "node_modules", "generated"), "rebuildable\n");
  const report = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000,
    policy: { idleWorktrees: 0, preserveLocalState: true } });
  assert.deepEqual(report.errors, []); assert.equal(report.actions, 1); assert.equal(existsSync(path), false);
  const saved = f.registry.read()[0]; assert.equal(saved.phase, "retired");
  assert.ok(saved.retainedStateDirectory); assert.equal(saved.archive, undefined);
  assert.equal(existsSync(join(saved.retainedStateDirectory, "files", "source.txt")), false);
  assert.equal(existsSync(join(saved.retainedStateDirectory, "files", "node_modules")), false);
  assert.equal(existsSync(join(saved.retainedStateDirectory, "files", "draft-package", "node_modules")), false);
  f.git("reflog", "expire", "--expire=now", "--all"); f.git("gc", "--prune=now");
  assert.equal(f.git("rev-parse", saved.recoveryRef!), record.head);
  const target = join(f.repo, ".worktrees", "restored-local-state");
  const restored = restoreRetiredWorktree(saved.retainedStateDirectory, target, f.registry);
  assert.equal(restored.head, record.head);
  assert.equal(readFileSync(join(target, "source.txt"), "utf8"), "baseline\n");
  assert.equal(readFileSync(join(target, ".env.local"), "utf8"), "unique local configuration\n");
  assert.equal(statSync(join(target, ".env.local")).mode & 0o777, 0o600);
  assert.equal(statSync(join(target, ".wrangler", "database.sqlite")).mode & 0o777, 0o640);
  assert.equal(readlinkSync(join(target, "history-link")), external);
  assert.equal(readFileSync(join(target, "draft-package", "notes.txt"), "utf8"), "unique untracked draft\n");
  assert.equal(statSync(join(target, "draft-package")).mode & 0o777, 0o700);
  assert.equal(existsSync(join(target, "draft-package", "node_modules")), false);
  assert.equal(readFileSync(external, "utf8"), "keep history\n");
  assert.equal(existsSync(join(target, "node_modules")), false);
  // Legacy snapshots did not record modes of ancestors outside their roots.
  const manifestPath = join(saved.retainedStateDirectory, "manifest.json");
  const legacy = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete legacy.version;
  for (const key of Object.keys(legacy.entries)) if (legacy.roots.some((root: string) => root.startsWith(key + "/"))) delete legacy.entries[key];
  writeFileSync(manifestPath, JSON.stringify(legacy));
  const legacyTarget = join(f.repo, ".worktrees", "restored-legacy-state");
  restoreRetiredWorktree(saved.retainedStateDirectory, legacyTarget, f.registry);
  assert.equal(readFileSync(join(legacyTarget, ".wrangler", "database.sqlite"), "utf8"), "unique database\n");
  assert.equal(readFileSync(join(legacyTarget, "draft-package", "notes.txt"), "utf8"), "unique untracked draft\n");
});

test("local-state size limits and changed copies retain original files", t => {
  const f = fixture(t), path = f.add("state-too-large");
  const record = registerWorktree(path, { role: "implementation" }, f.registry);
  writeFileSync(join(path, ".env.local"), "unique data\n");
  const report = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000,
    policy: { idleWorktrees: 0, preserveLocalState: true, maxLocalStateMB: 0 } });
  assert.equal(report.actions, 0); assert.match(report.errors[0], /size limit exceeded/);
  assert.equal(readFileSync(join(path, ".env.local"), "utf8"), "unique data\n");
  const copy = preserveLocalState(record, [".env.local"], f.registry.path);
  writeFileSync(join(path, ".env.local"), "changed after copy\n");
  assert.throws(() => verifyLocalState(path, copy.directory), /changed after preservation/);
  assert.equal(readFileSync(join(path, ".env.local"), "utf8"), "changed after copy\n");
  mkdirSync(join(path, "node_modules")); writeFileSync(join(path, "node_modules", "generated"), "cache\n");
  const trimmed = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000,
    policy: { idleWorktrees: 0, preserveLocalState: true, maxLocalStateMB: 0 } });
  assert.deepEqual(trimmed.errors, []); assert.equal(trimmed.actions, 1);
  assert.equal(trimmed.decisions[0].operation, "trim");
  assert.ok(existsSync(path)); assert.equal(existsSync(join(path, "node_modules")), false);
  assert.equal(readFileSync(join(path, ".env.local"), "utf8"), "changed after copy\n");
});

test("bounded sweeps persist progress past retained records without changing lifecycle age", t => {
  const f = fixture(t);
  const records = ["dirty-first", "eligible-one", "eligible-two"].map((name, i) => ({
    ...registerWorktree(f.add(name), { role: "implementation" }, f.registry), lastActivity: Date.now() + i * 1000,
  }));
  f.registry.write(records); writeFileSync(join(records[0].path, "source.txt"), "keep local edits\n");
  runGC({ registry: f.registry, activity: quiet, policy: { idleWorktrees: 0 } });
  assert.deepEqual(f.registry.inspections(), {});
  const options = { apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000, maxActions: 1, policy: { idleWorktrees: 0 } };
  const first = runGC(options); assert.deepEqual(first.errors, []); assert.equal(first.actions, 1);
  const afterFirst = f.registry.inspections();
  assert.ok(afterFirst[records[0].id]); assert.ok(afterFirst[records[1].id]);
  assert.equal(afterFirst[records[2].id], undefined);
  const second = runGC(options); assert.deepEqual(second.errors, []); assert.equal(second.actions, 1);
  assert.ok(f.registry.inspections()[records[2].id]);
  assert.equal(f.registry.inspections()[records[0].id], afterFirst[records[0].id]);
  assert.equal(f.registry.read().find(r => r.id === records[0].id)?.lastActivity, records[0].lastActivity);
  assert.ok(existsSync(records[0].path));
});

test("retirement retries keep older snapshot revisions pinned independently", t => {
  const f = fixture(t), path = f.add("retry-new-head", true);
  const original = registerWorktree(path, { role: "implementation" }, f.registry);
  writeFileSync(join(path, ".env.local"), "first local state\n");
  const failed = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000,
    policy: { idleWorktrees: 0, preserveLocalState: true, maxLocalStateMB: 0 } });
  assert.equal(failed.actions, 0);
  const firstRef = f.registry.read()[0].recoveryRef!;
  const firstState = preserveLocalState({ ...original, recoveryRef: firstRef }, [".env.local"], f.registry.path);
  writeFileSync(join(path, "source.txt"), "second revision\n");
  f.git("-C", path, "add", "source.txt"); f.git("-C", path, "commit", "-m", "second revision");
  writeFileSync(join(path, ".env.local"), "second local state\n");
  const second = runGC({ apply: true, registry: f.registry, activity: quiet, now: Date.now() + 2 * 86400000,
    policy: { idleWorktrees: 0, preserveLocalState: true } });
  assert.deepEqual(second.errors, []); assert.equal(second.actions, 1);
  const secondRef = f.registry.read()[0].recoveryRef!;
  assert.notEqual(firstRef, secondRef);
  assert.equal(f.git("rev-parse", firstRef), original.head);
  const restored = join(f.repo, ".worktrees", "first-version-restored");
  restoreRetiredWorktree(firstState.directory, restored, f.registry);
  assert.equal(readFileSync(join(restored, "source.txt"), "utf8"), "baseline\n");
  assert.equal(readFileSync(join(restored, ".env.local"), "utf8"), "first local state\n");
});
