import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { DependencyMode, ResolvedConfig, WorkitConfig, WorktreeResult } from "./types.js";
import { registerWorktree } from "./gc/engine.js";

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

function allowDirenv(target: string): void {
  // Best-effort: direnv has no wildcard allow, so each new worktree (its own
  // git toplevel with its own .envrc) must be allowed individually. The .envrc
  // is tracked from a trusted base branch, same trust as the main checkout.
  // Never fail worktree creation because direnv is missing or denies.
  try {
    if (!existsSync(join(target, ".envrc"))) return;
    spawnSync("direnv", ["allow", target], { stdio: "ignore" });
    // Nested .envrc files that chain via `source_up` (e.g. apps/mobile/.envrc)
    // need their own allow. Walk depth <= 2, skipping heavy/irrelevant dirs.
    const queue: Array<{ dir: string; depth: number }> = [{ dir: target, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.pop()!;
      if (depth > 0 && existsSync(join(dir, ".envrc"))) {
        spawnSync("direnv", ["allow", dir], { stdio: "ignore" });
      }
      if (depth >= 2) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".direnv") continue;
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
  } catch {
    // ignore: worktree is usable without direnv, tools just won't be on PATH
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
    registerWorktree(existing.path, { role: "implementation", pid: process.pid, phase: "preparing" });
    allowDirenv(existing.path);
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
  allowDirenv(target);
  return { path: target, branch: tempBranch, sourceBranch: branch, port, resumed: false };
}

function packageManager(root: string): string | undefined {
  const manifest = join(root, "package.json");
  if (existsSync(manifest)) {
    const declared = JSON.parse(readFileSync(manifest, "utf8")).packageManager as unknown;
    if (typeof declared === "string" && /^(bun|pnpm|yarn|npm)@/.test(declared)) {
      return declared.split("@")[0];
    }
  }
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
  const manifest = join(target, "package.json");
  const declared = existsSync(manifest)
    ? String(JSON.parse(readFileSync(manifest, "utf8")).packageManager ?? "")
    : "";
  const modernYarn = /^yarn@(\d+)/.exec(declared)?.[1];
  const args = manager === "bun"
    ? ["install", "--frozen-lockfile", "--ignore-scripts"]
    : manager === "pnpm"
      ? ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"]
      : manager === "yarn"
        ? (Number(modernYarn) >= 2 || existsSync(join(target, ".yarnrc.yml")))
          ? ["install", "--immutable", "--mode=skip-build"]
          : ["install", "--frozen-lockfile", "--ignore-scripts"]
        : existsSync(join(target, "package-lock.json")) || existsSync(join(target, "npm-shrinkwrap.json"))
          ? ["ci", "--ignore-scripts", "--prefer-offline"]
          : ["install", "--ignore-scripts"];
  // Use the checkout's pinned toolchain when it has a direnv environment.
  const useDirenv = existsSync(join(target, ".envrc")) &&
    spawnSync("direnv", ["version"], { stdio: "ignore" }).status === 0;
  const result = useDirenv
    ? spawnSync("direnv", ["exec", target, manager, ...args], { cwd: target, stdio: "inherit" })
    : spawnSync(manager, args, { cwd: target, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${manager} install failed`);
}

function dependencyDirectories(target: string): string[] {
  const realTarget = realpathSync(target);
  return [target, ...workspaceDirectories(target)]
    .filter((directory) => isWithin(target, directory) && isWithin(realTarget, realpathSync(directory)))
    .map((directory) => join(directory, "node_modules"));
}

function sameDependencyInputs(root: string, target: string): boolean {
  const files = [
    "package.json", "bun.lock", "bun.lockb", "bunfig.toml", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", ".yarnrc.yml", ".npmrc",
    ...dependencyDirectories(target).slice(1).map((directory) => join(relative(target, dirname(directory)), "package.json")),
  ];
  return files.every((file) => {
    const source = join(root, file);
    const destination = join(target, file);
    if (!existsSync(source) || !existsSync(destination)) return !existsSync(source) && !existsSync(destination);
    return readFileSync(source).equals(readFileSync(destination));
  });
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !rel.startsWith("/"));
}

function rebaseDependencyLinks(directory: string, root: string, target: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const link = readlinkSync(path);
      if (link.startsWith("/") && isWithin(root, link)) {
        unlinkSync(path);
        symlinkSync(relative(dirname(path), join(target, relative(root, link))), path);
      }
    } else if (entry.isDirectory()) {
      rebaseDependencyLinks(path, root, target);
    }
  }
}

function dependencyLinksStayLocal(directory: string, target: string): boolean {
  return readdirSync(directory, { withFileTypes: true }).every((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        return isWithin(target, realpathSync(path));
      } catch {
        return false;
      }
    }
    return !entry.isDirectory() || dependencyLinksStayLocal(path, target);
  });
}

function cloneDependencies(root: string, target: string): boolean {
  if (!directoryExists(join(root, "node_modules")) || !sameDependencyInputs(root, target)) return false;
  const created: string[] = [];
  try {
    for (const destination of dependencyDirectories(target)) {
      if (pathExists(destination)) continue;
      const source = join(root, relative(target, destination));
      if (!directoryExists(source)) continue;
      const args = process.platform === "darwin"
        ? ["-cR", realpathSync(source), destination]
        : ["--reflink=always", "-R", realpathSync(source), destination];
      created.push(destination);
      const result = spawnSync("cp", args, { stdio: "ignore" });
      if (result.status !== 0) return false;
    }
    for (const directory of created) rebaseDependencyLinks(directory, root, target);
    if (!created.every((directory) => dependencyLinksStayLocal(directory, realpathSync(target)))) return false;
    // All copies succeeded. Only newly-created directories are rolled back on failure.
    created.length = 0;
    return true;
  } catch {
    return false;
  } finally {
    for (const directory of created) rmSync(directory, { recursive: true, force: true });
  }
}

export function prepareDependencies(
  root: string,
  target: string,
  mode: DependencyMode,
): void {
  if (mode === "none") return;
  if (realpathSync(root) === realpathSync(target)) {
    throw new Error("Dependency preparation requires a separate worktree");
  }
  const source = join(root, "node_modules");
  if (mode === "symlink" && existsSync(source)) {
    linkWorkspaceNodeModules(root, target);
    return;
  }
  // An explicit clone/install must upgrade old symlink-based worktrees. Unlink
  // only the redirect; never remove the source checkout's dependencies.
  for (const directory of dependencyDirectories(target)) {
    if (pathExists(directory) && lstatSync(directory).isSymbolicLink()) unlinkSync(directory);
    else if (directoryExists(directory) && !dependencyLinksStayLocal(directory, realpathSync(target))) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (mode === "clone" && cloneDependencies(root, target)) return;
  const manager = packageManager(target);
  if (manager) runInstall(target, manager);
  for (const directory of dependencyDirectories(target)) {
    if (directoryExists(directory) && !dependencyLinksStayLocal(directory, realpathSync(target))) {
      throw new Error(`Dependencies still resolve outside the worktree or contain broken links: ${directory}`);
    }
  }
}

/** Prepare a linked worktree without fetching or mutating an issue. */
export function prepareExistingWorktree(target: string, config: WorkitConfig, mode: DependencyMode): void {
  const root = repositoryRoot(target);
  const top = git(["rev-parse", "--show-toplevel"], target);
  if (realpathSync(top) !== realpathSync(target) || realpathSync(root) === realpathSync(target)) {
    throw new Error("--worktree must name the root of a linked Git worktree");
  }
  copyEnvFiles(root, target, config);
  allowDirenv(target);
  prepareDependencies(root, target, mode);
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
