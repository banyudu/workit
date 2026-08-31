import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { DependencyMode, ResolvedConfig, WorkitConfig, WorktreeResult } from "./types.js";

function git(args: string[], cwd: string, allowFailure = false): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return "";
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export function repositoryRoot(cwd = process.cwd()): string {
  // Inside a worktree `git rev-parse --show-toplevel` returns the worktree
  // path itself, so resolving `.worktrees/<branch>` against it would nest
  // new worktrees under the current worktree (e.g. `.worktrees/A/.worktrees/B`).
  // `git rev-parse --git-common-dir` always points at the main repo's `.git`
  // (absolute by default, or resolvable relative to cwd), so its parent is
  // the true repository root regardless of where workit is invoked.
  const commonDir =
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, true) ||
    git(["rev-parse", "--git-common-dir"], cwd, true);
  if (commonDir) {
    return dirname(resolve(cwd, commonDir));
  }
  const root = git(["rev-parse", "--show-toplevel"], cwd, true);
  if (!root) throw new Error("workit must be run inside a Git repository");
  return root;
}

export function originRemote(root: string): string | undefined {
  return git(["remote", "get-url", "origin"], root, true) || undefined;
}

function currentBranch(root: string): string | undefined {
  return git(["branch", "--show-current"], root, true) || undefined;
}

function defaultBranch(root: string, configured?: string): string {
  if (configured && configured !== "auto") return configured;
  const remoteHead = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root, true);
  if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  for (const candidate of ["main", "master", currentBranch(root)]) {
    if (candidate && git(["show-ref", "--verify", `refs/remotes/origin/${candidate}`], root, true)) {
      return candidate;
    }
  }
  return currentBranch(root) ?? "main";
}

function sanitizeWorktreeName(branch: string): string {
  return branch.replace(/\//g, "-");
}

function worktreeRecords(root: string): Array<{ path: string; branch?: string }> {
  const output = git(["worktree", "list", "--porcelain"], root, true);
  const records: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      records.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return records;
}

function ensureSourceBranch(root: string, branch: string, baseBranch: string): void {
  if (git(["show-ref", "--verify", `refs/heads/${branch}`], root, true)) return;
  if (git(["show-ref", "--verify", `refs/remotes/origin/${baseBranch}`], root, true)) {
    git(["branch", branch, `refs/remotes/origin/${baseBranch}`], root);
    return;
  }
  if (git(["show-ref", "--verify", `refs/heads/${baseBranch}`], root, true)) {
    git(["branch", branch, baseBranch], root);
    return;
  }
  git(["fetch", "--quiet", "origin", `${baseBranch}:refs/remotes/origin/${baseBranch}`], root);
  git(["branch", branch, `refs/remotes/origin/${baseBranch}`], root);
}

function nextPort(root: string, config: WorkitConfig): number | undefined {
  const portBase = config.worktree?.portBase;
  const portStep = config.worktree?.portStep;
  if (typeof portBase !== "number" || !Number.isInteger(portBase) ||
      typeof portStep !== "number" || !Number.isInteger(portStep)) return undefined;
  const directory = resolve(root, config.worktree?.directory ?? ".worktrees");
  const used = new Set<number>();
  if (existsSync(directory)) {
    for (const record of worktreeRecords(root)) {
      const offsetFile = join(record.path, ".port-offset");
      if (existsSync(offsetFile)) {
        const offset = Number(readFileSync(offsetFile, "utf8").trim());
        if (Number.isInteger(offset)) used.add(offset);
      }
    }
  }
  let offset = 1;
  while (used.has(offset)) offset += 1;
  return portBase + offset * portStep;
}

function existingPort(path: string, config: WorkitConfig): number | undefined {
  const portBase = config.worktree?.portBase;
  const portStep = config.worktree?.portStep;
  if (typeof portBase !== "number" || !Number.isInteger(portBase) ||
      typeof portStep !== "number" || !Number.isInteger(portStep)) return undefined;
  const offsetFile = join(path, ".port-offset");
  if (!existsSync(offsetFile)) return undefined;
  const offset = Number(readFileSync(offsetFile, "utf8").trim());
  return Number.isInteger(offset) ? portBase + offset * portStep : undefined;
}

function copyEnvFiles(root: string, target: string, config: WorkitConfig): void {
  if (config.worktree?.copyEnv === false) return;
  for (const envPath of config.worktree?.envPaths ?? ["."]) {
    const relativeDir = envPath.replace(/^\.\/?/, "");
    const source = join(root, relativeDir, ".env.local");
    if (!existsSync(source)) continue;
    const destination = join(target, relativeDir, ".env.local");
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(source));
  }
}

export function createOrResumeWorktree(
  resolved: ResolvedConfig,
  branch: string,
): WorktreeResult {
  const { root, config } = resolved;
  const existing = worktreeRecords(root).find(
    (record) => record.branch === branch || record.branch?.match(new RegExp(`^${escapeRegExp(branch)}-[0-9a-f]{6}$`)),
  );
  if (existing?.branch) {
    return {
      path: existing.path,
      branch: existing.branch,
      sourceBranch: branch,
      port: existingPort(existing.path, config),
      resumed: true,
    };
  }

  const baseBranch = defaultBranch(root, config.worktree?.baseBranch);
  ensureSourceBranch(root, branch, baseBranch);
  const tempBranch = `${branch}-${randomBytes(3).toString("hex")}`;
  const worktreeDirectory = resolve(root, config.worktree?.directory ?? ".worktrees");
  const target = join(worktreeDirectory, sanitizeWorktreeName(tempBranch));
  mkdirSync(worktreeDirectory, { recursive: true });
  git(["worktree", "add", target, "-b", tempBranch, branch], root);

  copyEnvFiles(root, target, config);
  const port = nextPort(root, config);
  if (port !== undefined) {
    const offset = Math.round((port - (config.worktree?.portBase ?? 3001)) / (config.worktree?.portStep ?? 10));
    writeFileSync(join(target, ".port-offset"), `${offset}\n`);
    const envFile = join(target, ".env.local");
    const existingEnv = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    const withoutPort = existingEnv.replace(/^PORT=.*(?:\n|$)/gm, "");
    writeFileSync(envFile, `${withoutPort}${withoutPort.endsWith("\n") || !withoutPort ? "" : "\n"}PORT=${port}\n`);
  }
  return { path: target, branch: tempBranch, sourceBranch: branch, port, resumed: false };
}

function packageManager(root: string): string | undefined {
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package.json"))) return "npm";
  return undefined;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function workspacePatterns(root: string): string[] {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return [];

  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      workspaces?: unknown;
    };
    if (Array.isArray(packageJson.workspaces)) {
      return packageJson.workspaces.filter((pattern): pattern is string => typeof pattern === "string");
    }
    if (packageJson.workspaces && typeof packageJson.workspaces === "object") {
      const packages = (packageJson.workspaces as { packages?: unknown }).packages;
      if (Array.isArray(packages)) {
        return packages.filter((pattern): pattern is string => typeof pattern === "string");
      }
    }
  } catch {
    // A malformed or non-workspace package manifest should not make the
    // best-effort dependency preparation fail before the package manager can
    // report the real problem.
  }
  return [];
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
  if (pattern.startsWith("!")) return [];

  let candidates = [root];
  for (const segment of pattern.split("/").filter(Boolean)) {
    if (segment.includes("*")) {
      const matcher = new RegExp(`^${segment.split("*").map(escapeRegExp).join(".*")}$`);
      candidates = candidates.flatMap((parent) => {
        if (!directoryExists(parent)) return [];
        try {
          return readdirSync(parent, { withFileTypes: true })
            .filter((entry) => matcher.test(entry.name) && directoryExists(join(parent, entry.name)))
            .map((entry) => join(parent, entry.name));
        } catch {
          return [];
        }
      });
    } else {
      candidates = candidates
        .map((parent) => join(parent, segment))
        .filter(directoryExists);
    }
  }

  return candidates.filter((directory) => existsSync(join(directory, "package.json")));
}

function workspaceDirectories(root: string): string[] {
  const directories = new Set<string>();
  for (const pattern of workspacePatterns(root)) {
    for (const directory of expandWorkspacePattern(root, pattern)) directories.add(directory);
  }
  return [...directories];
}

function linkWorkspaceNodeModules(root: string, target: string): void {
  const source = join(root, "node_modules");
  if (!existsSync(source)) return;
  const rootTarget = join(target, "node_modules");
  if (!pathExists(rootTarget)) symlinkSync(source, rootTarget, "dir");

  // Bun keeps dependencies that are not hoisted in each workspace's own
  // node_modules. A root link alone therefore makes `target/node_modules`
  // visible but leaves e.g. `target/infra/d1-backup/node_modules` absent.
  // Resolve the target manifest so branch-specific workspace additions are
  // handled, then link only workspace-local dependency directories that are
  // already installed in the source checkout.
  for (const workspaceDirectory of workspaceDirectories(target)) {
    const relativeWorkspace = relative(target, workspaceDirectory);
    if (!relativeWorkspace || relativeWorkspace.startsWith("..")) continue;
    const sourceWorkspaceNodeModules = join(root, relativeWorkspace, "node_modules");
    if (!existsSync(sourceWorkspaceNodeModules)) continue;
    const targetWorkspaceNodeModules = join(workspaceDirectory, "node_modules");
    if (pathExists(targetWorkspaceNodeModules)) continue;
    mkdirSync(dirname(targetWorkspaceNodeModules), { recursive: true });
    symlinkSync(sourceWorkspaceNodeModules, targetWorkspaceNodeModules, "dir");
  }
}

function runInstall(target: string, manager: string): void {
  const args = manager === "bun"
    ? ["install", "--frozen-lockfile", "--ignore-scripts"]
    : manager === "pnpm"
      ? ["install", "--recursive", "--prefer-offline", "--ignore-scripts"]
      : manager === "yarn"
        ? ["install", "--prefer-offline", "--ignore-scripts"]
        : ["install"];
  const result = spawnSync(manager, args, { cwd: target, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${manager} install failed`);
}

export function prepareDependencies(
  root: string,
  target: string,
  mode: DependencyMode,
): void {
  if (mode === "none") return;
  const source = join(root, "node_modules");
  if (mode === "symlink" && existsSync(source)) {
    linkWorkspaceNodeModules(root, target);
    return;
  }
  if (pathExists(join(target, "node_modules"))) return;
  if (mode === "clone" && existsSync(source)) {
    const result = spawnSync("cp", ["-cR", source, join(target, "node_modules")], {
      cwd: target,
      stdio: "inherit",
    });
    if (result.status === 0) return;
  }
  const manager = packageManager(root);
  if (manager) runInstall(target, manager);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function branchForIssue(
  backend: "linear" | "github",
  identifier: string,
  title: string,
  config: WorkitConfig,
): string {
  const prefix = config.worktree?.branchPrefix ?? "yudu";
  if (backend === "linear") return `${prefix}/${identifier.toLowerCase()}`;
  return `${prefix}/${identifier}-${slugifyForBranch(title)}`;
}

function slugifyForBranch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "") || "issue";
}
