import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { resolveConfig } from "../config.js";
import { CACHE_NAMES, readJSON } from "./metadata.js";
import { preserveLocalState, restoreLocalState, verifyLocalState } from "./local-state.js";
import { python, Registry, SQLITE, type Role, type WorktreeRecord } from "./store.js";

export interface GCConfig {
  enabled?: boolean;
  repositories?: string[];
  excludedRepositories?: string[];
  archiveDirectory?: string;
  archiveVolumeUUID?: string;
  banyanctl?: string;
  reviewGraceHours?: number;
  mergedIdleHours?: number;
  cacheIdleDays?: number;
  archiveIdleDays?: number;
  retireIdleDays?: number;
  poolIdleDays?: number;
  warmPoolSize?: number;
  minFreeGB?: number;
  maxActions?: number;
  maxRunMinutes?: number;
  targetWorktrees?: number;
  /** Idle allowance in addition to protected live work; overrides total target. */
  idleWorktrees?: number;
  /** Preserve only unique local files internally before retiring a clean checkout. */
  preserveLocalState?: boolean;
  maxLocalStateMB?: number;
  excessIdleHours?: number;
  archiveUnclassified?: boolean;
  archiveExternalWorktrees?: boolean;
  archiveDirtyReviews?: boolean;
  recycleUnclassified?: boolean;
  recycleExternalWorktrees?: boolean;
  /** Exact repo-relative files/directories whose local contents are disposable. */
  disposablePaths?: string[];
  cleanupRemnants?: boolean;
  remnantIdleHours?: number;
  repositoryPolicies?: Record<string, Omit<GCConfig, "repositoryPolicies" | "repositories">>;
}
export interface GitWorktree { path: string; head: string; branch?: string; locked: boolean; prunable: boolean; main: boolean }
export interface ReviewMetadata { id: string; issue: string; repo: string; worktree: string; gitDir: string; baseSha: string; keepWorktree: boolean }
export interface Activity {
  uncertain: string[];
  sessions: Array<{ cwd: string; id: string; command: string }>;
  processes: Array<{ pid: number; cwd: string }>;
  history: Array<{ cwd: string; at: number }>;
}
export type Action = "protect" | "retain" | "trim" | "recycle";
export interface Decision { path: string; role: Role; action: Action; reason: string; idleHours: number; archive?: string; result?: string; operation?: "delete" | "trim" | "retain" | "defer"; durationMs?: number; archiveBytes?: number; restoredBytes?: number; localState?: string[]; retainedStateDirectory?: string; retainedStateBytes?: number }
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEFAULTS = { reviewGraceHours: 1, mergedIdleHours: 24, cacheIdleDays: 14, archiveIdleDays: 30, poolIdleDays: 7, warmPoolSize: 2, minFreeGB: 100, maxActions: 4, maxRunMinutes: 2, excessIdleHours: 1, remnantIdleHours: 24 };
export function expand(path: string): string { return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path); }
export function within(path: string, parent: string): boolean { return path === parent || path.startsWith(parent + sep); }
export function git(path: string, args: string[]): string {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}
function tryGit(path: string, args: string[]): string | undefined { try { return git(path, args); } catch { return undefined; } }
export function processIdentity(pid: number): string {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}
export function ownerAlive(owner: WorktreeRecord["owner"]): boolean {
  return !!owner && !!owner.identity && processIdentity(owner.pid) === owner.identity;
}

// All creators/lease mutations and final GC actions use the same per-checkout
// mutex. SQLite makes ownership checks/reclamation atomic, including two
// sweepers concurrently recovering a crashed owner. PID start time prevents
// reuse of a dead owner's PID from making a stale lease permanent.
export function withLock<T>(registry: Registry, key: string, operation: () => T): T {
  const owner = { pid: process.pid, identity: processIdentity(process.pid) };
  if (!owner.identity) throw new Error("Cannot determine GC lock owner identity");
  const token = randomUUID();
  const deadline = Date.now() + 15_000;
  while (!registry.lock(key, token, owner)) {
    if (Date.now() >= deadline) throw new Error("Worktree is busy with another GC/launcher operation; retry shortly");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try { return operation(); } finally { registry.unlock(key, token); }
}

export function listWorktrees(repo: string): GitWorktree[] {
  const raw = git(repo, ["worktree", "list", "--porcelain", "-z"]);
  return raw.split("\0\0").filter(Boolean).map((block, index) => {
    const fields = block.split("\0");
    return { path: fields.find(x => x.startsWith("worktree "))!.slice(9), head: fields.find(x => x.startsWith("HEAD "))?.slice(5) || "", branch: fields.find(x => x.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, ""), locked: fields.some(x => x === "locked" || x.startsWith("locked ")), prunable: fields.some(x => x === "prunable" || x.startsWith("prunable ")), main: index === 0 };
  });
}

function identity(path: string, inventory?: { repo: string; entry: GitWorktree }): { path: string; repo: string; gitDir: string; birth: number; head: string; branch?: string } {
  if (lstatSync(path).isSymbolicLink()) throw new Error("Symlink worktree roots require explicit migration; refusing redirect");
  path = realpathSync(path);
  if (realpathSync(git(path, ["rev-parse", "--show-toplevel"])) !== path) throw new Error("Expected a checkout root");
  const common = realpathSync(git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const repo = dirname(common);
  if (repo === path || !lstatSync(join(path, ".git")).isFile()) throw new Error("Primary/bare checkouts cannot be registered for GC");
  if (inventory && realpathSync(inventory.repo) !== repo) throw new Error("Checkout repository changed during discovery");
  const entry = inventory?.entry || listWorktrees(repo).find(x => x.path === path);
  if (!entry || entry.path !== path || entry.main || entry.locked || entry.prunable) throw new Error("Checkout is missing, locked or prunable");
  return { path, repo, gitDir: realpathSync(git(path, ["rev-parse", "--absolute-git-dir"])), birth: statSync(join(path, ".git")).birthtimeMs, head: entry.head, branch: entry.branch };
}

export function registerWorktree(path: string, options: { role?: Role; jobFile?: string; issue?: string; keep?: boolean; pid?: number; phase?: WorktreeRecord["phase"] } = {}, registry = new Registry()): WorktreeRecord {
  path = realpathSync(expand(path));
  return withLock(registry, path, () => {
    const found = identity(path);
    const old = registry.read().find(x => x.path === path && x.gitDir === found.gitDir && x.birth === found.birth && x.phase !== "retired");
    const pid = options.pid;
    const processStart = pid ? processIdentity(pid) : "";
    if (pid && !processStart) throw new Error("Lease owner is not alive");
    const record: WorktreeRecord = { ...found, id: old?.id || randomUUID(), role: options.role || old?.role || "unclassified", phase: options.phase || old?.phase || "idle", createdAt: old?.createdAt || Date.now(), lastActivity: Date.now(), keep: options.keep ?? old?.keep ?? false, jobFile: options.jobFile ? expand(options.jobFile) : old?.jobFile, issue: options.issue || old?.issue, owner: pid ? { pid, identity: processStart } : old?.owner };
    if (old && ownerAlive(old.owner) && old.owner?.pid !== pid) throw new Error("Another live owner holds this worktree lease");
    if (record.role === "review") {
      if (!record.jobFile) throw new Error("Review registration requires --job-file");
      validateReview(record);
    }
    registry.write([record]);
    return record;
  });
}

export function setLifecycle(path: string, update: { keep?: boolean; phase?: WorktreeRecord["phase"]; pid?: number; release?: boolean }, registry = new Registry()): WorktreeRecord {
  path = realpathSync(expand(path));
  return withLock(registry, path, () => {
    const record = registry.read().find(x => x.path === path);
    if (!record) throw new Error("Register this checkout first");
    const current = identity(path);
    if (record.gitDir !== current.gitDir || record.birth !== current.birth) throw new Error("Checkout identity changed; register it again");
    if (ownerAlive(record.owner) && record.owner?.pid !== update.pid) throw new Error("Lifecycle is held by another live owner");
    if (update.keep !== undefined) record.keep = update.keep;
    if (update.phase) record.phase = update.phase;
    if (update.phase === "finished" || update.phase === "interrupted") record.finishedAt = Date.now();
    if (update.release) record.owner = undefined;
    record.lastActivity = Date.now();
    registry.write([record]);
    return record;
  });
}

function validateReview(record: WorktreeRecord): ReviewMetadata {
  const job = readJSON<ReviewMetadata>(record.jobFile!);
  if (!/^[a-f0-9]{24}$/.test(job.id) || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(job.issue)) throw new Error("Invalid review job identity");
  if (realpathSync(job.repo) !== record.repo || job.worktree !== record.path || job.gitDir !== record.gitDir || job.baseSha !== record.head || record.branch) throw new Error("Review checkout ownership/revision changed");
  if (record.path !== join(record.repo, ".worktrees", `review-${job.issue.toLowerCase()}-${job.id}`)) throw new Error("Review path does not match owner metadata");
  return job;
}

export function collectActivity(config: GCConfig, includeHistory = true): Activity {
  const activity: Activity = { uncertain: [], sessions: [], processes: [], history: [] };
  const fallback = join(homedir(), "dev", "yudu", "banyan", "dist", "bin", "banyanctl");
  const ctl = config.banyanctl ? expand(config.banyanctl) : existsSync(fallback) ? fallback : undefined;
  if (ctl) {
    try {
      let payload;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Closed rows can still carry deep-resume/recovery protection, even
          // when the caller does not need historical activity timestamps.
          payload = JSON.parse(execFileSync(ctl, ["list", "--all"], { encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
      }
      if (!payload.ok || !Array.isArray(payload.data?.sessions)) throw new Error("Invalid session inventory");
      for (const session of payload.data.sessions) {
        if (typeof session.cwd !== "string" || typeof session.status !== "string") throw new Error("Invalid session row");
        if (session.status !== "closed" || session.isDeepResuming || session.deepRecoveryIsUncertain) activity.sessions.push({ cwd: session.cwd, id: session.id, command: session.command || "" });
        const at = Date.parse(session.updatedAt);
        if (includeHistory && Number.isFinite(at)) activity.history.push({ cwd: session.cwd, at });
      }
    } catch (error) { activity.uncertain.push(`Banyan inventory unavailable: ${(error as Error).message}`); }
  }
  const listing = spawnSync("lsof", ["-nP", "-Fpn"], { encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
  if (listing.error || listing.status !== 0) activity.uncertain.push("Process cwd inventory unavailable");
  else {
    let pid = 0;
    for (const line of listing.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("n/") && pid) activity.processes.push({ pid, cwd: line.slice(1) });
    }
  }
  const codex = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "state_5.sqlite");
  if (includeHistory && existsSync(codex)) {
    try { for (const [cwd, at] of python<Array<[string, number]>>(SQLITE, { op: "activity", path: codex })) activity.history.push({ cwd, at: at * 1000 }); }
    catch { activity.uncertain.push("Codex activity unavailable"); }
  }
  return activity;
}

function recentActivity(record: WorktreeRecord, activity: Activity): number {
  let latest = record.lastActivity;
  for (const row of activity.history) if (within(row.cwd, record.path)) latest = Math.max(latest, row.at);
  const reflog = record.orphan || record.remnant ? undefined : tryGit(record.path, ["reflog", "-1", "--format=%gD", "--date=unix", "HEAD"]);
  const epoch = reflog?.match(/@\{(\d+)\}/)?.[1];
  if (epoch) latest = Math.max(latest, Number(epoch) * 1000);
  try { latest = Math.max(latest, statSync(join(record.gitDir, "index")).mtimeMs); } catch {}
  // Unique local files/edits are retained regardless of age. Disposable caches
  // must not refresh a checkout's lifetime or require recursive content scans.
  if (record.orphan || record.remnant) latest = Math.max(latest, statSync(record.path).mtimeMs);
  const claude = join(homedir(), ".claude", "projects", record.path.replace(/[^a-zA-Z0-9_-]/g, "-"));
  if (existsSync(claude)) for (const name of readdirSync(claude)) if (name.endsWith(".jsonl")) latest = Math.max(latest, statSync(join(claude, name)).mtimeMs);
  return latest;
}

export function protection(record: WorktreeRecord, activity: Activity, completionOwner?: number): string | undefined {
  if (record.keep) return "explicit keep flag";
  if (activity.uncertain.length) return activity.uncertain.join("; ");
  if (ownerAlive(record.owner)) return "live lifecycle lease";
  const ownReview = record.role === "review" && record.phase === "finished" && !!completionOwner && !!processIdentity(completionOwner);
  if (activity.sessions.some(s => within(s.cwd, record.path) && !(ownReview && record.jobFile && s.command.includes(record.jobFile)))) return "open Banyan session";
  if (activity.processes.some(p => within(p.cwd, record.path) && !(ownReview && p.pid === completionOwner))) return "live process in checkout";
  return undefined;
}

interface CheckoutState {
  dirty: boolean;
  tracked: string[];
  localState: string[];
  caches: string[];
}

/** Enumerate local roots independently from generated caches. Never read source contents. */
export function inspectCheckout(record: WorktreeRecord, config: GCConfig): CheckoutState {
  const noGit = record.orphan || record.remnant;
  if (!noGit && git(record.path, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"])) {
    return { dirty: true, tracked: [], localState: [], caches: [] };
  }
  const index = noGit ? [] : git(record.path, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean);
  // These flags hide local changes from ordinary status. Retain such checkouts.
  if (index.some(row => row[0] === "S" || row[0] !== row[0].toUpperCase())) {
    return { dirty: true, tracked: [], localState: ["index uses skip-worktree or assume-unchanged"], caches: [] };
  }
  const tracked = index.map(row => row.slice(2));
  const files = new Set(tracked), parents = new Set<string>();
  for (const path of tracked) {
    let parent = dirname(path);
    while (parent !== ".") { parents.add(parent); parent = dirname(parent); }
  }
  const roots = noGit ? readdirSync(record.path) : [
    ...git(record.path, ["ls-files", "--others", "--exclude-standard", "--directory", "-z"]).split("\0"),
    ...git(record.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).split("\0"),
  ].filter(Boolean).map(path => path.replace(/\/$/, ""));
  const caches = new Set<string>(), localState = new Set<string>(), visited = new Set<string>();
  const disposable = (path: string) => config.disposablePaths?.some(root => within(path, root)) ||
    (!noGit && (path.split(sep).some(part => CACHE_NAMES.has(part)) || within(path, join(".direnv", "nix-sources"))));
  const visit = (path: string) => {
    if (files.has(path) || visited.has(path)) return;
    if (visited.size >= 100_000) throw new Error("Local-state inventory too large; checkout retained");
    visited.add(path);
    const full = join(record.path, path);
    const st = lstatSync(full);
    // A cache with a tracked marker only permits deleting generated siblings.
    if (disposable(path) && !parents.has(path)) { caches.add(full); return; }
    // Git reports untracked parents and ignored descendants independently.
    // Enumerate unique leaves consistently before/after cache deletion; never
    // preserve an ancestor containing generated caches. Empty directories have
    // no local file data. Nested repositories remain an explicit veto.
    if (st.isDirectory() && !st.isSymbolicLink() && basename(path) !== ".git") {
      for (const item of readdirSync(full)) visit(join(path, item));
    } else localState.add(path);
  };
  for (const root of new Set(roots)) visit(root);
  const cacheRoots: string[] = [];
  for (const path of [...caches].sort((a, b) => a.length - b.length)) if (!cacheRoots.some(parent => within(path, parent))) cacheRoots.push(path);
  return { dirty: false, tracked, localState: [...localState], caches: cacheRoots };
}

// Match the exact PR head, never just its issue number or an ancestor on main:
// a branch may contain new commits after its earlier PR was squash-merged.
export function mergedPR(record: WorktreeRecord, heads?: Set<string>): boolean {
  if (!record.branch) return false;
  if (heads) return heads.has(`${record.branch}\0${record.head}`);
  try {
    const rows = JSON.parse(execFileSync("gh", ["pr", "list", "--state", "merged", "--head", record.branch, "--limit", "10", "--json", "headRefOid,mergedAt"], { cwd: record.repo, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }));
    return Array.isArray(rows) && rows.some(row => row.headRefOid === record.head && !!row.mergedAt);
  } catch { return false; }
}

export function decide(record: WorktreeRecord, config: GCConfig, activity: Activity, context: { now?: number; dirty: boolean; merged?: boolean; excessPool?: boolean; excessCapacity?: boolean; warmIdle?: boolean; activityAt?: number; completionOwner?: number } ): Decision {
  const policy = { ...DEFAULTS, ...config };
  const now = context.now ?? Date.now();
  let idleHours = 0;
  const result = (action: Action, reason: string): Decision => ({ path: record.path, role: record.role, action, reason, idleHours: Math.round(idleHours * 10) / 10 });
  if (config.enabled === false || config.excludedRepositories?.some(p => within(record.repo, expand(p)))) return result("protect", "repository excluded");
  const guard = protection(record, activity, context.completionOwner);
  if (guard) return result("protect", guard);
  if (record.phase === "retired") return result("retain", "already retired");
  if (record.role === "unclassified" && !record.remnant && !(policy.recycleUnclassified ?? policy.archiveUnclassified)) return result("retain", "ownership is unclassified; register explicitly");
  idleHours = Math.max(0, (now - (context.activityAt ?? recentActivity(record, activity))) / HOUR);
  if (context.dirty) return result("retain", "checkout has local changes; retained without backup");
  if (record.remnant) return policy.cleanupRemnants && idleHours >= policy.remnantIdleHours
    ? result("recycle", "inactive residual directory contains only explicitly disposable contents")
    : result("retain", "residual directory recovery grace or cleanup disabled");
  if (record.role === "review") {
    if (record.phase === "finished") return result("recycle", "review runner finished at its pinned revision");
    if (idleHours >= policy.reviewGraceHours) return result("recycle", "review owner exited; recovery grace elapsed");
    return result("retain", "review recovery grace period");
  }
  if (context.warmIdle) return result("retain", "warm idle checkout allowance");
  if (context.excessCapacity && idleHours >= policy.excessIdleHours) {
    if (record.role === "unclassified" && (!(policy.recycleUnclassified ?? policy.archiveUnclassified) || (!(policy.recycleExternalWorktrees ?? policy.archiveExternalWorktrees) && !within(record.path, join(record.repo, ".worktrees"))))) return result("retain", "unclassified checkout outside opted-in repository worktree directory");
    return result("recycle", "repository above working-set target; remove inactive clean checkout");
  }
  if (record.role === "unclassified") return result("retain", "unclassified checkout within working-set allowance or recovery grace");
  if (record.role === "pool") {
    if (context.dirty) return result("retain", "pool slot has local changes");
    if (context.excessPool && idleHours >= policy.poolIdleDays * 24) return result("recycle", "excess unleased pool slot");
    return result("retain", "warm or recently used pool slot");
  }
  if (!context.dirty && context.merged && idleHours >= policy.mergedIdleHours) return result("recycle", "exact PR head merged and checkout idle");
  if (idleHours >= (policy.retireIdleDays ?? policy.archiveIdleDays) * 24) return result("recycle", "cold clean implementation; retain branch and commit reference");
  if (idleHours >= policy.cacheIdleDays * 24) return result("trim", "idle implementation; trim only rebuildable caches");
  return result("retain", "implementation recently used or not yet eligible");
}

export function cachePaths(path: string, tracked: string[]): string[] {
  const result: string[] = [];
  const walk = (dir: string, insideCache = false) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === ".git" || item.name === ".worktrees") continue;
      const full = join(dir, item.name), rel = relative(path, full);
      const cache = insideCache || CACHE_NAMES.has(item.name) || rel === join(".direnv", "nix-sources");
      if (cache && !tracked.some(t => t === rel || t.startsWith(rel + "/"))) result.push(full);
      else if (item.isDirectory() && !item.isSymbolicLink()) walk(full, cache);
    }
  };
  walk(path);
  return result;
}

// Only owned private cache directories become writable. Never traverse symlinks
// into a shared Nix store or modify user source files to make deletion succeed.
export function removeCache(path: string): void {
  const makeWritable = (current: string) => {
    const s = lstatSync(current);
    if (s.isSymbolicLink() || !s.isDirectory()) return;
    if (typeof process.getuid === "function" && s.uid !== process.getuid()) throw new Error("Cache is owned by another user");
    if ((s.mode & 0o700) !== 0o700) chmodSync(current, s.mode | 0o700);
    for (const item of readdirSync(current, { withFileTypes: true })) if (item.isDirectory() && !item.isSymbolicLink()) makeWritable(join(current, item.name));
  };
  makeWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function readReviewJobs(extraFiles: string[] = [], legacy = true): Array<{ job: ReviewMetadata; file: string; at: number; finished: boolean }> {
  const root = join(homedir(), ".cache", "review-linear", "jobs");
  const files = new Set(extraFiles);
  if (legacy && existsSync(root)) for (const directory of readdirSync(root)) files.add(join(root, directory, "job.json"));
  const jobs = [];
  for (const file of files) {
    try {
      const job = readJSON<ReviewMetadata>(file);
      if (!existsSync(job.worktree)) continue;
      const result = join(dirname(file), "result.json");
      jobs.push({ job, file, at: Math.max(statSync(file).mtimeMs, existsSync(result) ? statSync(result).mtimeMs : 0), finished: existsSync(result) });
    } catch { /* Invalid metadata does not authorize cleanup. */ }
  }
  return jobs;
}

function readLaunches(): Map<string, { branch: string; at: number }> {
  const launches = new Map<string, { branch: string; at: number }>();
  const configured = resolveConfig(homedir()).config.launch?.logFile || "~/.agents/logs/workit-launches.log";
  if (!existsSync(expand(configured))) return launches;
  for (const block of readFileSync(expand(configured), "utf8").split("---")) {
    const data = Object.fromEntries(block.trim().split("\n").filter(l => l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    const at = Date.parse(data.timestamp_utc);
    if (data.worktree && data.branch && Number.isFinite(at)) launches.set(data.worktree, { branch: data.branch, at });
  }
  return launches;
}

function repositoryPolicy(config: GCConfig, repo: string, override: GCConfig = {}): GCConfig & typeof DEFAULTS {
  const local = resolveConfig(repo).config.gc || {};
  const policies = { ...config.repositoryPolicies, ...local.repositoryPolicies };
  const perRepo = Object.entries(policies).find(([path]) => expand(path) === repo)?.[1] || {};
  return { ...DEFAULTS, ...config, ...local, ...perRepo, ...override,
    excludedRepositories: [...new Set([...(config.excludedRepositories || []), ...(local.excludedRepositories || []), ...(override.excludedRepositories || [])])] };
}

function nestedGitDirectory(path: string): boolean {
  let visited = 0;
  const walk = (directory: string): boolean => {
    if (++visited > 100_000) return true; // Ambiguous/very large trees need inspection.
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name === ".git") return true;
      if (item.isDirectory() && !item.isSymbolicLink() && walk(join(directory, item.name))) return true;
    }
    return false;
  };
  return walk(path);
}

export function discover(registry: Registry, repositories: string[], apply: boolean, includeLegacy = true, target?: string, config: GCConfig = {}, onlyRepositories?: string[], remnantsOnly = false): WorktreeRecord[] {
  const previous = registry.read().filter(r => !target || r.path === target);
  const jobs = readReviewJobs(previous.flatMap(r => r.jobFile ? [r.jobFile] : []), includeLegacy).filter(j => !target || j.job.worktree === target);
  const launches = includeLegacy ? readLaunches() : new Map<string, { branch: string; at: number }>();
  const repos = new Set([...(target ? [] : repositories.map(expand)), ...previous.map(r => r.repo), ...jobs.map(r => r.job.repo)]);
  const records: WorktreeRecord[] = [];
  for (const repo of repos) {
    if (onlyRepositories && !onlyRepositories.includes(repo)) continue;
    if (!existsSync(repo)) continue;
    const entries = listWorktrees(repo);
    for (const entry of entries) {
      if (remnantsOnly) continue;
      if ((target && entry.path !== target) || entry.main || entry.locked || entry.prunable || !existsSync(join(entry.path, ".git"))) continue;
      try {
        // Reuse this sweep's repository inventory. Re-listing hundreds of
        // siblings for every checkout makes discovery quadratic in worktrees.
        // The mutation path always obtains a fresh inventory under its lock.
        const current = identity(entry.path, { repo, entry });
        const old = previous.find(r => r.path === current.path && r.gitDir === current.gitDir && r.birth === current.birth && r.phase !== "retired");
        if (old) { records.push({ ...old, head: current.head, branch: current.branch }); continue; }
        const job = jobs.find(j => j.job.worktree === current.path);
        const record: WorktreeRecord = { ...current, id: randomUUID(), role: "unclassified", phase: "idle", createdAt: current.birth || Date.now(), lastActivity: current.birth || Date.now(), keep: false };
        if (job) {
          record.jobFile = job.file; record.role = "review"; record.keep = job.job.keepWorktree;
          record.phase = job.finished ? "finished" : "interrupted"; record.lastActivity = job.at;
          try { validateReview(record); } catch { record.keep = true; }
        } else {
          const launch = launches.get(current.path);
          if (launch && launch.branch === current.branch && basename(current.path) === launch.branch.replace(/\//g, "-")) {
            record.role = "implementation"; record.lastActivity = Math.max(record.lastActivity, launch.at);
          }
        }
        records.push(record);
      } catch { /* Symlink/unknown ownership cannot become a candidate. */ }
    }
    // Recovery of partially removed review jobs is based on the full immutable
    // owner identity, never on a directory prefix. Control directories such as
    // .verify-pool-locks are not worktrees and do not enter this inventory.
    for (const owned of jobs.filter(j => j.job.repo === repo)) {
      const job = owned.job;
      if (existsSync(join(job.worktree, ".git")) || records.some(r => r.path === job.worktree)) continue;
      if (existsSync(join(job.gitDir, "locked"))) continue;
      if (!/^[a-f0-9]{24}$/.test(job.id) || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(job.issue) || job.worktree !== join(repo, ".worktrees", `review-${job.issue.toLowerCase()}-${job.id}`)) continue;
      if (lstatSync(job.worktree).isSymbolicLink() || !lstatSync(job.worktree).isDirectory()) continue;
      if (!tryGit(repo, ["cat-file", "-e", `${job.baseSha}^{commit}`])) {
        // cat-file succeeds with empty stdout; use an explicit rev-parse below.
        if (!tryGit(repo, ["rev-parse", "--verify", `${job.baseSha}^{commit}`])) continue;
      }
      const old = previous.find(r => r.path === job.worktree && r.jobFile === owned.file && r.gitDir === job.gitDir && r.head === job.baseSha && r.phase !== "retired");
      records.push({ ...(old || { id: randomUUID(), path: job.worktree, repo, gitDir: job.gitDir, head: job.baseSha, role: "review", phase: "interrupted", createdAt: owned.at, lastActivity: owned.at, keep: job.keepWorktree, jobFile: owned.file }), birth: statSync(job.worktree).birthtimeMs, orphan: true });
    }
    const policy = repositoryPolicy(config, repo);
    const root = join(repo, ".worktrees");
    if (!policy.cleanupRemnants || !existsSync(root) || lstatSync(root).isSymbolicLink() || policy.excludedRepositories?.some(p => within(repo, expand(p)))) continue;
    for (const item of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, item.name);
      if (item.name.startsWith(".") || !item.isDirectory() || item.isSymbolicLink() || (target && path !== target) || existsSync(join(path, ".git")) || entries.some(e => e.path === path) || records.some(r => r.path === path)) continue;
      const old = previous.find(r => r.path === path);
      // Never replace another owner's registration based on a directory name.
      if (old && (!old.remnant || old.phase === "retired")) continue;
      try {
        if (realpathSync(path) !== path || nestedGitDirectory(path)) continue;
        const s = statSync(path);
        records.push(old || { id: randomUUID(), path, repo, gitDir: realpathSync(join(repo, ".git")), head: "", birth: s.birthtimeMs, role: "unclassified", phase: "idle", createdAt: s.birthtimeMs, lastActivity: s.mtimeMs, keep: false, remnant: true });
      } catch { /* Unreadable/nested/redirected remnants remain untouched. */ }
    }
  }
  // Import does not replace records concurrently created by launchers.
  if (apply) registry.import(records);
  return records;
}

export interface GCReport {
  decisions: Decision[]; errors: string[]; actions: number;
  durationMs: number; archiveBytes: number; restoredBytes: number;
}

/** All destructive GC paths share one worker lock, including finish. */
function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function acquireSweepLock(registry: Registry, token: string, owner: { pid: number; identity: string }, waitMs: number): boolean {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (let delay = 500; ; delay = Math.min(delay * 2, 5_000)) {
    if (registry.lock("sweep", token, owner)) return true;
    if (Date.now() + delay > deadline) return false;
    sleepSync(delay);
  }
}

export function runGC(options: Parameters<typeof runGCWorker>[0] = {}): GCReport {
  const started = Date.now(), registry = options.registry || new Registry();
  const deferred = (reason: string): GCReport => ({
    decisions: options.worktree ? [{ path: expand(options.worktree), role: registry.read().find(r => r.path === expand(options.worktree!))?.role || "unclassified", action: "retain", reason, idleHours: 0, operation: "defer", result: "deferred: " + reason, durationMs: 0, archiveBytes: 0, restoredBytes: 0 }] : [],
    errors: [], actions: 0, durationMs: Date.now() - started, archiveBytes: 0, restoredBytes: 0,
  });
  if (options.policy?.enabled !== true && resolveConfig(homedir()).config.gc?.enabled === false) return deferred("GC disabled");
  const execute = () => {
    const report = runGCWorker({ ...options, registry, includeLegacy: options.includeLegacy ?? !options.registry });
    for (const decision of report.decisions) {
      decision.operation ??= decision.result?.startsWith("deferred:") ? "defer" : "retain";
      decision.durationMs ??= 0;
      decision.archiveBytes = 0; decision.restoredBytes = 0;
    }
    return { ...report, durationMs: Date.now() - started, archiveBytes: 0, restoredBytes: 0 };
  };
  if (!options.apply) return execute();
  const token = randomUUID(), owner = { pid: process.pid, identity: processIdentity(process.pid) };
  if (!owner.identity) throw new Error("Cannot determine cleanup worker identity");
  // Launchers, finish hooks and the periodic sweep all contend for this lock.
  // Giving up immediately produced an empty report and exit 0, which looked
  // exactly like "nothing to clean" while the disk filled up.
  const waitMs = Math.max(0, options.lockWaitMs ?? 0), waitStarted = Date.now();
  if (!acquireSweepLock(registry, token, owner, waitMs)) {
    const report = deferred("cleanup worker busy; lifecycle remains pending");
    // Callers that asked to wait treat exhaustion as a failure. Nonblocking
    // lifecycle callers keep the existing silent-defer contract.
    if (waitMs > 0) report.errors.push(`cleanup worker busy after ${((Date.now() - waitStarted) / 1000).toFixed(1)}s; another GC operation held the sweep lock`);
    return report;
  }
  try { return execute(); } finally { registry.unlock("sweep", token); }
}

function runGCWorker(options: { apply?: boolean; worktree?: string; repositories?: string[]; onlyRepositories?: string[]; remnantsOnly?: boolean; maxActions?: number; lockWaitMs?: number; completionOwner?: number; registry?: Registry; activity?: Activity; now?: number; includeLegacy?: boolean; policy?: GCConfig } = {}): { decisions: Decision[]; errors: string[]; actions: number } {
  const started = Date.now();
  const registry = options.registry || new Registry();
  const userPolicy = resolveConfig(homedir()).config.gc || {};
  const config = { ...DEFAULTS, ...userPolicy };
  const target = options.worktree ? expand(options.worktree) : undefined;
  const legacy = options.includeLegacy ?? !options.registry;
  const onlyRepositories = options.onlyRepositories?.map(expand);
  const records = discover(registry, [...(legacy ? config.repositories || [] : []), ...(options.repositories || []), ...(onlyRepositories || [])], !!options.apply, legacy, target, { ...config, ...options.policy }, onlyRepositories, options.remnantsOnly);
  const inspected = registry.inspections();
  // Retained/dirty records must not monopolize successive bounded sweeps.
  // Checkpoints use immutable registration IDs and do not mutate lifecycle age.
  records.sort((a, b) => (inspected[a.id] || 0) - (inspected[b.id] || 0) || Number(b.role === "review") - Number(a.role === "review") || a.lastActivity - b.lastActivity);
  if (target && !records.length) throw new Error("Target is not a registered, unlocked linked checkout");
  const activity = options.activity || collectActivity(config);
  // Discovery and machine inventory happen before the inspection/action budget.
  // Each successful inspection advances persistent progress, even if retained.
  const deadline = Date.now() + (options.policy?.maxRunMinutes ?? config.maxRunMinutes) * 60_000;
  const decisions: Decision[] = [], errors: string[] = [...activity.uncertain];
  const inventories = new Map<string, GitWorktree[]>();
  const knownRecords = registry.read();
  const hasNested = (record: WorktreeRecord, fresh = false) => {
    if (fresh || !inventories.has(record.repo)) inventories.set(record.repo, listWorktrees(record.repo));
    return inventories.get(record.repo)!.some(other => other.path !== record.path && within(other.path, record.path) && existsSync(other.path)) ||
      (fresh ? registry.read() : knownRecords).some(other => other.path !== record.path && !other.remnant && within(other.path, record.path) && existsSync(join(other.path, ".git")));
  };
  const mergedHeads = new Map<string, Set<string>>();
  const merged = (record: WorktreeRecord) => {
    if (!mergedHeads.has(record.repo)) {
      const heads = new Set<string>();
      try {
        // One bounded inventory per repository, rather than one network request
        // per checkout. Older PRs outside this window simply lack merge proof.
        const rows = JSON.parse(execFileSync("gh", ["pr", "list", "--state", "merged", "--limit", "500", "--json", "headRefName,headRefOid,mergedAt"], { cwd: record.repo, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
        if (Array.isArray(rows)) for (const row of rows) if (row.headRefName && row.headRefOid && row.mergedAt) heads.add(`${row.headRefName}\0${row.headRefOid}`);
      } catch { /* No merge proof; age/archival policy still applies. */ }
      mergedHeads.set(record.repo, heads);
    }
    return mergedPR(record, mergedHeads.get(record.repo));
  };
  let actions = 0;
  const actionLimit = options.maxActions ?? config.maxActions;
  const repoActions = new Map<string, number>();
  const pools = new Map<string, WorktreeRecord[]>();
  const policies = new Map<string, GCConfig & typeof DEFAULTS>();
  for (const record of records) if (!policies.has(record.repo)) policies.set(record.repo, repositoryPolicy(config, record.repo, options.policy));
  const excess = new Set<string>();
  const warmIdle = new Set<string>();
  for (const [repo, policy] of policies) {
    if (policy.targetWorktrees === undefined && policy.idleWorktrees === undefined) continue;
    const group = records.filter(r => r.repo === repo && !r.remnant);
    const protectedCount = group.filter(r => !!protection(r, activity)).length;
    // Disposable reviews do not consume the idle implementation allowance.
    const candidates = group.filter(r => r.role !== "review" && !protection(r, activity));
    const hint = (r: WorktreeRecord) => Math.max(r.lastActivity, ...activity.history.filter(h => within(h.cwd, r.path)).map(h => h.at));
    candidates.sort((a, b) => hint(b) - hint(a));
    const allowance = policy.idleWorktrees ?? Math.max(0, policy.targetWorktrees! - protectedCount);
    if (policy.idleWorktrees !== undefined) for (const record of candidates.slice(0, allowance)) warmIdle.add(record.path);
    for (const record of candidates.slice(allowance)) excess.add(record.path);
  }
  // Active slots are protected separately and do not consume the warm-idle
  // allowance. Keep two reusable idle slots even when a third slot is leased.
  for (const record of records.filter(r => r.role === "pool" && !protection(r, activity))) {
    try { const state = inspectCheckout(record, policies.get(record.repo)!); if (state.dirty || state.localState.length) continue; } catch { continue; }
    pools.set(record.repo, [...(pools.get(record.repo) || []), record]);
  }
  for (const pool of pools.values()) pool.sort((a, b) => b.lastActivity - a.lastActivity);
  for (const record of records) {
    try {
      const policy = policies.get(record.repo)!;
      if (hasNested(record) || records.some(other => other.path !== record.path && within(other.path, record.path))) {
        decisions.push({ path: record.path, role: record.role, action: "protect", reason: "contains another linked checkout", idleHours: 0 });
        continue;
      }
      if (policy.enabled === false || policy.excludedRepositories?.some(p => within(record.repo, expand(p))) || protection(record, activity, options.completionOwner) || (record.role === "unclassified" && !record.remnant && !(policy.recycleUnclassified ?? policy.archiveUnclassified))) {
        decisions.push(decide(record, policy, activity, { dirty: false, completionOwner: options.completionOwner, now: options.now }));
        continue;
      }
      if (options.apply && (actions >= actionLimit || Date.now() >= deadline || (repoActions.get(record.repo) || 0) >= policy.maxActions)) {
        decisions.push({ path: record.path, role: record.role, action: "retain", reason: "not evaluated after run budget exhausted", idleHours: 0, result: "deferred: per-run limit" });
        continue;
      }
      if (options.apply) registry.inspected(record.id);
      const current = inspectCheckout(record, policy);
      const baseline = { ...record };
      // A review's saved baseline is immutable. HEAD changes cannot silently
      // update the registration and make a changed checkout look disposable.
      if (record.role === "review" && !record.orphan) validateReview(record);
      const activityAt = current.dirty ? record.lastActivity : recentActivity(record, activity);
      const isMerged = record.role === "implementation" && !excess.has(record.path) && !current.dirty && activityAt <= (options.now || Date.now()) - policy.mergedIdleHours * HOUR ? merged(record) : false;
      const pool = pools.get(record.repo) || [];
      const decision = decide(record, policy, activity, { dirty: current.dirty, merged: isMerged, excessPool: pool.indexOf(record) >= policy.warmPoolSize, excessCapacity: excess.has(record.path), warmIdle: warmIdle.has(record.path), activityAt, completionOwner: options.completionOwner, now: options.now });
      if (current.localState.length) {
        decision.localState = current.localState;
        if (decision.action === "recycle" && (!policy.preserveLocalState || record.remnant || record.orphan)) {
          // Unknown local files veto retirement, but never veto independent
          // deletion of proven generated caches from a valid clean checkout.
          decision.action = current.caches.length && !current.dirty && !record.remnant && !record.orphan ? "trim" : "retain";
          decision.reason = "unique local state retained; only generated caches are disposable";
        }
      }
      if (decision.action === "trim" && !current.caches.length) { decision.action = "retain"; decision.reason = "idle implementation; no rebuildable caches remain"; }
      decisions.push(decision);
      if (!options.apply || !["trim", "recycle"].includes(decision.action)) continue;
      if (actions >= actionLimit || (repoActions.get(record.repo) || 0) >= policy.maxActions) { decision.result = "deferred: per-run limit"; continue; }
      const at = Date.now();
      withLock(registry, record.path, () => {
        const saved = registry.read().find(r => r.path === record.path);
        if (!saved || saved.id !== record.id || saved.lastActivity !== baseline.lastActivity || saved.keep !== baseline.keep || ownerAlive(saved.owner)) throw new Error("Lifecycle changed while planning; deferred");
        if (hasNested(record, true)) throw new Error("Nested checkout appeared; parent retained");
        if (record.remnant) {
          if (lstatSync(record.path).isSymbolicLink() || realpathSync(record.path) !== record.path || statSync(record.path).birthtimeMs !== record.birth || existsSync(join(record.path, ".git")) || listWorktrees(record.repo).some(e => e.path === record.path) || nestedGitDirectory(record.path)) throw new Error("Residual directory acquired Git ownership or changed identity");
        } else if (record.orphan) {
          if (existsSync(join(record.gitDir, "locked")) || existsSync(join(record.path, ".git")) || lstatSync(record.path).isSymbolicLink() || statSync(record.path).birthtimeMs !== record.birth) throw new Error("Residual review identity changed or is locked");
          const job = readJSON<ReviewMetadata>(record.jobFile!);
          if (job.worktree !== record.path || job.repo !== record.repo || job.gitDir !== record.gitDir || job.baseSha !== record.head || job.keepWorktree) throw new Error("Residual review owner metadata changed");
        } else {
          const found = identity(record.path);
          if (found.gitDir !== record.gitDir || found.birth !== record.birth || found.head !== record.head || found.branch !== record.branch) throw new Error("Checkout identity or revision changed");
        }
        // One fresh machine inventory immediately before the destructive step.
        const guard = protection(saved, options.activity || collectActivity(policy, false), options.completionOwner);
        if (guard) throw new Error("Protected at execution: " + guard);
        const fresh = inspectCheckout(record, policy);
        if (fresh.dirty) throw new Error("Local changes appeared during cleanup");
        if (decision.action === "recycle" && fresh.localState.length && (!policy.preserveLocalState || record.remnant || record.orphan)) throw new Error("Unique files appeared during cleanup");
        if (decision.action === "recycle" && !record.remnant) {
          const ref = `refs/workit-gc/retired/${record.id}-${record.head}`;
          git(record.repo, ["update-ref", ref, record.head]);
          saved.recoveryRef = ref;
          // Persist recovery identity before deletion; the ref pins detached commits.
          registry.write([saved]);
        }
        let retainedDirectory: string | undefined;
        if (decision.action === "recycle" && fresh.localState.length) {
          try {
            const retained = preserveLocalState({ ...record, recoveryRef: saved.recoveryRef }, fresh.localState, registry.path, policy.maxLocalStateMB);
            saved.retainedStateDirectory = retained.directory;
            registry.write([saved]);
            decision.retainedStateDirectory = retained.directory;
            decision.retainedStateBytes = retained.bytes;
            retainedDirectory = retained.directory;
          } catch (error) {
            if (!fresh.caches.length) throw error;
            // A large or unreadable local file must not pin gigabytes of
            // independent generated caches. Original local files stay put.
            decision.action = "trim";
            decision.reason = "checkout retained; local-state preservation failed: " + (error as Error).message;
          }
        }
        for (const cache of fresh.caches) removeCache(cache);
        if (decision.action === "recycle") {
          if (record.remnant || record.orphan) removeCache(record.path);
          // Git still checks dirty and untracked files; never force removal.
          else {
            // Cache deletion/copying can take time. Recheck activity and source
            // identity before removing the (now verified) unique local files.
            const found = identity(record.path);
            if (found.gitDir !== record.gitDir || found.birth !== record.birth || found.head !== record.head || found.branch !== record.branch) throw new Error("Checkout identity changed during cleanup");
            const guard = protection(saved, options.activity || collectActivity(policy, false), options.completionOwner);
            if (guard) throw new Error("Protected before removal: " + guard);
            const state = inspectCheckout(record, policy);
            if (state.dirty || [...state.localState].sort().join("\0") !== [...fresh.localState].sort().join("\0")) throw new Error("Local state changed while preserving; originals retained");
            if (retainedDirectory) {
              verifyLocalState(record.path, retainedDirectory);
              for (const path of state.localState) removeCache(join(record.path, path));
            }
            const finalState = inspectCheckout(record, policy);
            if (finalState.dirty || finalState.localState.length) throw new Error("Checkout changed before removal; retained state remains recoverable");
            if (git(record.path, ["rev-parse", "HEAD"]) !== record.head) throw new Error("Revision changed before removal");
            execFileSync("git", ["-C", record.repo, "worktree", "remove", record.path], { timeout: 300_000, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
          }
          saved.phase = "retired"; saved.head = record.head; saved.branch = record.branch;
        }
        registry.write([saved]);
        decision.operation = decision.action === "trim" ? "trim" : "delete";
        decision.result = decision.action === "trim" ? "caches trimmed" : "removed";
        decision.durationMs = Date.now() - at;
        decision.archiveBytes = 0; decision.restoredBytes = 0;
        registry.event({ ...decision, recordId: record.id, recoveryRef: saved.recoveryRef });
        actions++;
        repoActions.set(record.repo, (repoActions.get(record.repo) || 0) + 1);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${record.path}: ${message}`);
      const decision = decisions.find(d => d.path === record.path);
      if (decision) decision.result = `retained: ${message}`;
      else decisions.push({ path: record.path, role: record.role, action: "protect", reason: message, idleHours: 0 });
    }
  }
  return { decisions, errors, actions };
}

/** Recreate committed source from its pinned ref, then restore only local data. */
export function restoreRetiredWorktree(directory: string, target?: string, registry = new Registry()): WorktreeRecord {
  directory = realpathSync(expand(directory));
  const original = readJSON<WorktreeRecord>(join(directory, "record.json"));
  if (!/^[a-f0-9-]{36}$/.test(original.id) || !/^[a-f0-9]{40,64}$/.test(original.head)) throw new Error("Invalid retained checkout identity");
  const ref = original.recoveryRef || `refs/workit-gc/retired/${original.id}`;
  if (!/^refs\/workit-gc\/retired\/[a-f0-9-]+$/.test(ref)) throw new Error("Invalid retained revision reference");
  if (git(original.repo, ["rev-parse", "--verify", ref]) !== original.head) throw new Error("Pinned revision is missing or changed");
  const path = expand(target || original.path);
  try { lstatSync(path); throw new Error("Restore target already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(dirname(path), { recursive: true });
  if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("Restore target parent is redirected");
  git(original.repo, ["worktree", "add", "--detach", path, ref]);
  restoreLocalState(path, directory);
  return registerWorktree(path, { role: "implementation" }, registry);
}

export function pressureGC(repo: string): void {
  const config = resolveConfig(repo).config.gc;
  if (!config?.enabled) return;
  const disk = statfsSync(repo);
  if (disk.bavail * disk.bsize >= (config.minFreeGB ?? DEFAULTS.minFreeGB) * 1024 ** 3) return;
  // Cache-only pressure relief keeps allocation latency bounded. It never
  // broadens retirement policy or performs an SSD archive during a launch.
  const registry = new Registry();
  const excluded = [...(resolveConfig(homedir()).config.gc?.excludedRepositories || []), ...(config.excludedRepositories || [])];
  if (excluded.some(p => within(repo, expand(p)))) return;
  // Batch launches must not all enumerate thousands of sessions/open files.
  // Elect one scan per repository per five minutes, without making the other
  // launchers wait for it. This also bounds cache churn during a launch burst.
  const key = "sweep", token = randomUUID();
  const stamp = join(dirname(registry.path), `pressure-${createHash("sha256").update(repo).digest("hex")}.json`);
  try { if (Date.now() - readJSON<{ at: number }>(stamp).at < 300_000) return; } catch {}
  try {
    if (!registry.lock(key, token, { pid: process.pid, identity: processIdentity(process.pid) })) return;
    try {
      try { if (Date.now() - readJSON<{ at: number }>(stamp).at < 300_000) return; } catch {}
      writeFileSync(stamp, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
      const activity = collectActivity(config);
      let count = 0;
      for (const record of registry.read().filter(r => r.repo === repo && r.phase !== "retired")) {
        if (count >= 2) break;
        if (!existsSync(record.path)) continue;
        // An old checkout can leave a directory after its Git metadata is
        // removed. Allocation-time cleanup must leave such stale records alone.
        if (!record.orphan && !record.remnant && !existsSync(join(record.path, ".git"))) continue;
        try {
          if (listWorktrees(repo).some(other => other.path !== record.path && within(other.path, record.path) && existsSync(other.path))) continue;
          const data = inspectCheckout(record, config);
          if (decide(record, config, activity, { dirty: data.dirty }).action !== "trim") continue;
          withLock(registry, record.path, () => {
            const saved = registry.read().find(r => r.id === record.id);
            const found = identity(record.path);
            if (!saved || saved.lastActivity !== record.lastActivity || found.gitDir !== record.gitDir || found.birth !== record.birth || protection(saved, collectActivity(config))) return;
            const fresh = inspectCheckout(record, config);
            if (fresh.dirty) return;
            for (const cache of fresh.caches) removeCache(cache);
            registry.event({ path: record.path, action: "trim", reason: "disk pressure before launch" });
            count++;
          });
        } catch { /* Allocation proceeds; the periodic report captures failures. */ }
      }
    } finally { registry.unlock(key, token); }
  } catch { /* Cache relief is optional; a failed scan must not block launching. */ }
}
