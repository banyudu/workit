import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResolvedConfig, WorkitConfig } from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function deepMerge<T>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };

  for (const [key, value] of Object.entries(override)) {
    if (isRecord(result[key]) && isRecord(value)) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value,
      );
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

function parseConfigFile(file: string): WorkitConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to parse config ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    throw new Error(`Config ${file} must contain a YAML/JSON object`);
  }

  return parsed as WorkitConfig;
}

function uniqueExisting(files: string[]): string[] {
  return [...new Set(files)].filter((file) => existsSync(file));
}

function userConfigCandidates(explicit?: string): string[] {
  const home = homedir();
  return [
    join(home, ".agents", "worktree-agents.yml"),
    join(home, ".config", "workit", "config.yml"),
    join(home, ".config", "workit", "config.yaml"),
    join(home, ".config", "workit", "config.json"),
    join(home, ".workit.yml"),
    join(home, ".workit.yaml"),
    process.env.WORKIT_CONFIG,
    explicit,
  ].filter((file): file is string => Boolean(file));
}

function validateConfig(config: WorkitConfig): void {
  if (config.provider && !["auto", "linear", "github"].includes(config.provider)) {
    throw new Error(`Unsupported provider '${config.provider}' in workit config`);
  }
  const target = config.launch?.target;
  if (target && !["banyan", "here", "iterm"].includes(target)) {
    throw new Error(`Unsupported launch target '${target}' in workit config`);
  }
  const dependencies = config.launch?.dependencies;
  if (dependencies && !["symlink", "clone", "install", "none"].includes(dependencies)) {
    throw new Error(`Unsupported dependency mode '${dependencies}' in workit config`);
  }
  for (const [name, value] of [
    ["portBase", config.worktree?.portBase],
    ["portStep", config.worktree?.portStep],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`worktree.${name} must be a positive integer`);
    }
  }
}

function projectConfigCandidates(root: string): string[] {
  return [
    join(root, ".workit.yml"),
    join(root, ".workit.yaml"),
    join(root, ".workit.json"),
    join(root, ".workit", "config.yml"),
    join(root, ".workit", "config.yaml"),
    join(root, ".workit", "config.json"),
  ];
}

function normalizeRemote(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/, "");
  const match = value.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return match?.[1];
}

function projectOverrides(config: WorkitConfig, keys: string[]): WorkitConfig {
  let result: WorkitConfig = {};
  for (const key of keys) {
    const override = config.projects?.[key];
    if (override) result = deepMerge(result, override as Record<string, unknown>);
  }
  return result;
}

function defaultConfig(): WorkitConfig {
  return {
    provider: "auto",
    worktree: {
      directory: ".worktrees",
      branchPrefix: "yudu",
      baseBranch: "auto",
      portBase: 3001,
      portStep: 10,
      copyEnv: true,
      envPaths: ["."],
    },
    launch: {
      target: "banyan",
      review: true,
      handoff: true,
      dependencies: "symlink",
      logFile: "~/.agents/logs/workit-launches.log",
    },
  };
}

export function resolveHomePath(value: string, base = homedir()): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(base, value);
}

export function resolveConfig(
  root: string,
  options: { explicitPath?: string; remote?: string } = {},
): ResolvedConfig {
  const userFiles = uniqueExisting(userConfigCandidates(options.explicitPath));
  const projectFiles = uniqueExisting(projectConfigCandidates(root));
  const configFiles = [...userFiles, ...projectFiles];

  let config = defaultConfig();
  for (const file of userFiles) {
    config = deepMerge(config, parseConfigFile(file) as Record<string, unknown>);
  }

  const remoteKey = options.remote ? normalizeRemote(options.remote) : undefined;
  const keys = [root, ...(remoteKey ? [remoteKey] : [])];
  const userProject = projectOverrides(config, keys);
  config = deepMerge(config, userProject as Record<string, unknown>);

  for (const file of projectFiles) {
    config = deepMerge(config, parseConfigFile(file) as Record<string, unknown>);
  }

  validateConfig(config);

  return { config, root, configFiles, projectKey: remoteKey };
}

export function configBaseDirectory(file: string): string {
  return dirname(file);
}
