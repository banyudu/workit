// Linear-project → local-repo resolution for workit.
// Order per Linear issue: explicit local --repo/--repo-path > current repo
// (when its .agents/context.md declares the same project) > static map(s) >
// dynamic scan of `.agents/context.md` `linear.project` under the roots >
// current git repo fallback (or error when outside a repo).
//
// Static maps share the neutral `project: repo-path` format so
// ~/.config/workit/map.yml and ~/.config/review-linear/map.yml are
// symlink-compatible; workit reads its own map first, then the
// review-linear map as a migration fallback.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveHomePath } from "./config.js";

export const DEFAULT_WORKIT_MAP = join(homedir(), ".config", "workit", "map.yml");
export const DEFAULT_REVIEW_MAP = join(homedir(), ".config", "review-linear", "map.yml");
export const DEFAULT_ROOTS = join(homedir(), "dev");

export function expandTilde(path: string): string {
  return resolveHomePath(path);
}

/** Extract `linear: {project, project_id}` from an `.agents/context.md` body. */
export function parseContextLinear(text: string): { project: string; projectId: string } {
  const match = /^linear:[ \t]*(.*)$/im.exec(text);
  if (!match) return { project: "", projectId: "" };
  const inline = (match[1] ?? "").trim();
  let block = inline;
  if (!inline.startsWith("{")) {
    const rest = text.slice(match.index + match[0].length).split(/\r?\n/);
    const lines: string[] = [];
    for (const line of rest) {
      if (line && !/^\s/.test(line)) break;
      lines.push(line);
    }
    block = lines.join("\n");
  }

  const grab = (key: string): string => {
    // Capture the full value up to a comma, closing brace, or newline so
    // multi-word projects ("OPS — Internal Tools & Automation") survive;
    // single-word values behave exactly as before.
    const found = new RegExp("\\b" + key + ":\\s*([^\\n,}]+)", "i").exec(block);
    return found ? (found[1] ?? "").trim().replace(/^["']|["']$/g, "").trim() : "";
  };

  return { project: grab("project"), projectId: grab("project_id") };
}

export type MapEntry = { name: string; path: string };

/** Parse the static `project: repo-path` map file (project names lowercased). */
export function parseMapEntries(content: string): MapEntry[] {
  const entries: MapEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const sep = line.indexOf(":");
    const name = line.slice(0, sep).trim();
    const path = line.slice(sep + 1).trim();
    if (name && path) entries.push({ name: name.toLowerCase(), path });
  }
  return entries;
}

export function loadMapEntries(mapFile: string): MapEntry[] {
  const file = expandTilde(mapFile);
  if (!existsSync(file)) return [];
  try {
    return parseMapEntries(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export function staticLookup(entries: MapEntry[], lowerProject: string): string {
  const needle = lowerProject.toLowerCase();
  for (const entry of entries) {
    if (entry.name === needle) return entry.path;
  }
  return "";
}

export type DeclaredRepo = { name: string; repoDir: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isGitRepo(path: string): boolean {
  try {
    return existsSync(join(expandTilde(path), ".git"));
  } catch {
    return false;
  }
}

function collectContexts(dir: string, depth: number, out: string[]): void {
  const ctx = join(dir, ".agents", "context.md");
  if (existsSync(ctx)) out.push(ctx);
  if (depth >= 2) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".agents") continue;
    collectContexts(join(dir, entry.name), depth + 1, out);
  }
}

/**
 * Scan the roots for `<repo>/.agents/context.md` declarations (repo dirs up to
 * two levels below each root).
 */
export function scanDeclared(roots: string[]): DeclaredRepo[] {
  const declared: DeclaredRepo[] = [];
  for (const rawRoot of roots) {
    const root = expandTilde(rawRoot);
    if (!isDirectory(root)) continue;
    const contexts: string[] = [];
    collectContexts(root, 0, contexts);
    contexts.sort();
    for (const ctx of contexts) {
      let parsed: { project: string };
      try {
        parsed = parseContextLinear(readFileSync(ctx, "utf8"));
      } catch {
        continue;
      }
      if (!parsed.project) continue;
      declared.push({ name: parsed.project, repoDir: dirname(dirname(ctx)) });
    }
  }
  return declared;
}

/** Declared Linear project of a local repo (via its .agents/context.md). */
export function declaredProjectForRepo(repoDir: string): string {
  try {
    const ctx = join(expandTilde(repoDir), ".agents", "context.md");
    if (!existsSync(ctx)) return "";
    return parseContextLinear(readFileSync(ctx, "utf8")).project;
  } catch {
    return "";
  }
}

export interface ResolveInput {
  /** Explicit local repo override (--repo-path or path-like --repo). */
  repoOverride?: string;
  /** Current git root, when invoked inside a repo. */
  currentRoot?: string;
  /** Static map files in priority order (first hit wins). */
  mapFiles: string[];
  /** Roots scanned for .agents/context.md declarations. */
  roots: string[];
}

export interface ResolveResult {
  repo: string;
  source: string;
}

/**
 * Resolve the local repo for a Linear project.
 * Throws with actionable guidance when nothing matches.
 */
export function resolveRepoForProject(project: string, input: ResolveInput): ResolveResult {
  if (input.repoOverride) {
    const repo = expandTilde(input.repoOverride);
    if (!isGitRepo(repo)) {
      throw new Error(`--repo ${input.repoOverride} is not a git repository`);
    }
    return { repo, source: "explicit --repo" };
  }
  if (!project) {
    throw new Error("issue has no Linear project; resolve the repo manually and rerun with --repo <path>");
  }
  const lowerProject = project.toLowerCase();

  // Prefer the repo you're already in when it declares the same project —
  // avoids surprising switches on stale maps.
  if (input.currentRoot) {
    const declared = declaredProjectForRepo(input.currentRoot);
    if (declared && declared.toLowerCase() === lowerProject) {
      return { repo: input.currentRoot, source: "current repo declares project" };
    }
  }

  for (const mapFile of input.mapFiles) {
    const mapped = staticLookup(loadMapEntries(mapFile), lowerProject);
    if (mapped) {
      const repo = expandTilde(mapped);
      if (isGitRepo(repo)) {
        return { repo, source: `static map (${mapFile})` };
      }
      // Stale entry: keep looking in lower-priority maps / scan.
    }
  }

  const declared = scanDeclared(input.roots);
  const matches = declared.filter((d) => d.name.toLowerCase() === lowerProject).map((d) => d.repoDir);
  if (matches.length === 1) {
    return { repo: matches[0]!, source: `dynamic scan (${input.roots.join(":")})` };
  }
  if (matches.length === 0) {
    const hint = declared.length
      ? `Discovered projects: ${declared.map((d) => `${d.name} (${d.repoDir})`).join(", ")}. `
      : "";
    throw new Error(
      `no repo declares Linear project '${project}' under ${input.roots.join(" ")}. ${hint}Add it to ${input.mapFiles[0] ?? DEFAULT_WORKIT_MAP} or pass --repo <path>`,
    );
  }
  throw new Error(
    `multiple repos declare Linear project '${project}': ${matches.join(", ")}. Disambiguate with --repo <path>`,
  );
}

/** Map files in priority order: $WORKIT_MAP > workit map > $REVIEW_LINEAR_MAP > review-linear map. */
export function defaultMapFiles(explicit?: string): string[] {
  if (explicit) return [explicit];
  const files: string[] = [];
  if (process.env.WORKIT_MAP) files.push(process.env.WORKIT_MAP);
  files.push(DEFAULT_WORKIT_MAP);
  if (process.env.REVIEW_LINEAR_MAP) files.push(process.env.REVIEW_LINEAR_MAP);
  files.push(DEFAULT_REVIEW_MAP);
  return [...new Set(files)];
}

/** Scan roots: --roots > $WORKIT_ROOTS > $REVIEW_LINEAR_ROOTS > ~/dev. */
export function defaultRoots(explicit?: string): string[] {
  const raw =
    explicit ?? process.env.WORKIT_ROOTS ?? process.env.REVIEW_LINEAR_ROOTS ?? DEFAULT_ROOTS;
  return raw.split(":").filter(Boolean);
}

/**
 * A value passed via --repo is a local path override when it looks like one:
 * absolute / ~/ / ./ / ../ prefixed, or an existing directory. Otherwise it
 * is a GitHub `owner/name` override (existing behavior).
 */
export function isLocalRepoValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith("~/") ||
    trimmed === "~" ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    return true;
  }
  try {
    const expanded = expandTilde(trimmed);
    if (existsSync(expanded) && isDirectory(expanded)) return true;
  } catch {
    // fall through to GitHub handling
  }
  return false;
}

/** Split a smart --repo value into a local path vs a GitHub owner/name. */
export function splitSmartRepo(value: string | undefined): { repoPath?: string; githubRepo?: string } {
  if (!value) return {};
  if (isLocalRepoValue(value)) return { repoPath: value };
  return { githubRepo: value };
}

/** Scan roots and (re)generate the static map, preserving manual entries. */
export function syncMapFile(mapFile: string, roots: string[]): { path: string; entries: MapEntry[] } {
  const existing = loadMapEntries(mapFile);
  const scanned = scanDeclared(roots);
  const seen = new Set<string>();
  const merged: MapEntry[] = [];
  for (const entry of existing) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    merged.push(entry);
  }
  for (const entry of scanned) {
    const name = entry.name.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push({ name, path: entry.repoDir });
  }
  if (merged.length === 0) {
    throw new Error(`no .agents/context.md Linear project declarations found under: ${roots.join(" ")}`);
  }
  const target = expandTilde(mapFile);
  mkdirSync(dirname(target), { recursive: true });
  const body = merged.map((e) => `${e.name}: ${e.path}`).join("\n");
  writeFileSync(
    target,
    "# workit project map: Linear project -> local repo (case-insensitive)\n" +
      "# Regenerate with: workit sync-map (manual entries are preserved)\n" +
      "# Format-compatible with review-linear's map.yml; the files may be symlinked.\n" +
      body +
      "\n",
    "utf8",
  );
  return { path: target, entries: merged };
}
