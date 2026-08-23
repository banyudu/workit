import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AgentDefinition,
  CodingAgentEntry,
  CodingAgentsConfig,
  ResolvedConfig,
  WorkitConfig,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Canonical agent registry: ~/.agents/agents.yml. */
export const AGENTS_FILE = join(homedir(), ".agents", "agents.yml");

/** Legacy registry path kept as a fallback for older setups. */
export const CODING_AGENTS_FILE = join(
  homedir(),
  ".agents",
  "coding-agents.yml",
);

/** True when `file` is one of the canonical/legacy registry paths in `home`. */
export function isRegistryFile(file: string, home = homedir()): boolean {
  return (
    file === join(home, ".agents", "agents.yml") ||
    file === join(home, ".agents", "coding-agents.yml")
  );
}

/**
 * Pick the registry file to load: prefer ~/.agents/agents.yml, fall back to
 * the legacy ~/.agents/coding-agents.yml. Only one path is ever returned so
 * the same registry is never merged twice.
 */
export function resolveRegistryFile(home = homedir()): string | undefined {
  const canonical = join(home, ".agents", "agents.yml");
  if (existsSync(canonical)) return canonical;
  const legacy = join(home, ".agents", "coding-agents.yml");
  if (existsSync(legacy)) return legacy;
  return undefined;
}

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

function parseConfigFile(file: string, home = homedir()): WorkitConfig {
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

  // The canonical coding-agent registry has its own schema; nest it so the
  // generic deep-merge keeps registry entries separate from workit's agents.
  if (isRegistryFile(file, home)) {
    const { default: defaultAgent, opencode, agents } = parsed as Record<string, unknown>;
    const codingAgents: CodingAgentsConfig = {};
    if (agents !== undefined) codingAgents.agents = agents as CodingAgentsConfig["agents"];
    if (isRecord(opencode)) {
      codingAgents.opencode = opencode as CodingAgentsConfig["opencode"];
    }
    return {
      ...(defaultAgent !== undefined ? { default: defaultAgent as WorkitConfig["default"] } : {}),
      ...(Object.keys(codingAgents).length ? { codingAgents } : {}),
    } as WorkitConfig;
  }

  return parsed as WorkitConfig;
}

/** Expand agents[*].aliases into a lookup index (alias -> canonical name). */
function buildAliasIndex(config: WorkitConfig): Record<string, string> {
  const index: Record<string, string> = {};
  // Alias sources in precedence order: the launchable agent map first, then
  // every registry entry so --agent resolves names outside the "coding" pool.
  const agentMap = config.agents ?? {};
  const registry = config.codingAgents?.agents ?? {};
  for (const [name, definition] of [...Object.entries(agentMap), ...Object.entries(registry)]) {
    for (const alias of definition?.aliases ?? []) {
      if (!alias || alias === name) continue;
      if (index[alias]) continue;
      index[alias] = name;
    }
  }
  return index;
}

/** Agent keys shipped as built-in defaults; a loaded registry supersedes them. */
const DEFAULT_AGENT_KEYS = Object.keys(defaultConfig().agents ?? {});

/**
 * Project launchable registry entries into workit's agent map. When a
 * registry file was loaded it is authoritative: built-in default agents are
 * dropped unless the registry (or a later user config) redefines them.
 * Entries tagged "coding" with a non-empty command and workit !== false
 * become AgentDefinitions.
 */
function projectRegistryIntoAgents(config: WorkitConfig): void {
  const registryAgents = config.codingAgents?.agents;
  if (!registryAgents) return;
  const agents: Record<string, AgentDefinition> = { ...config.agents };
  for (const key of DEFAULT_AGENT_KEYS) delete agents[key];
  for (const [name, entry] of Object.entries(registryAgents)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.workit === false) continue;
    if (!entry.tags?.includes("coding")) continue;
    if (!entry.command?.trim()) continue;
    agents[name] = {
      command: entry.command,
      provider: entry.provider,
      weight: entry.weight,
      aliases: entry.aliases,
    };
  }
  config.agents = agents;
}

/**
 * Project registry entries tagged `tag` into launchable AgentDefinitions,
 * bypassing the default "coding"-only projection so consumers can weight
 * over any scenario pool (e.g. "review", "daily").
 */
export function agentDefinitionsByTag(
  config: WorkitConfig,
  tag: string,
): Record<string, AgentDefinition> {
  return projectRegistry(config, (entry) => entry.tags?.includes(tag) === true);
}

/** Every launchable registry entry as an AgentDefinition map (tag-agnostic). */
export function allLaunchableRegistryAgents(config: WorkitConfig): Record<string, AgentDefinition> {
  return projectRegistry(config, () => true);
}

function projectRegistry(
  config: WorkitConfig,
  matches: (entry: CodingAgentEntry) => boolean,
): Record<string, AgentDefinition> {
  const registryAgents = config.codingAgents?.agents ?? {};
  const agents: Record<string, AgentDefinition> = {};
  for (const [name, entry] of Object.entries(registryAgents)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.workit === false) continue;
    if (!entry.command?.trim()) continue;
    if (!matches(entry)) continue;
    agents[name] = {
      command: entry.command,
      provider: entry.provider,
      weight: entry.weight ?? 0,
      aliases: entry.aliases,
    };
  }
  return agents;
}

function uniqueExisting(files: string[]): string[] {
  return [...new Set(files)].filter((file) => existsSync(file));
}

function userConfigCandidates(explicit?: string, home = homedir()): string[] {
  return [
    join(home, ".agents", "worktree-agents.yml"),
    join(home, ".config", "workit", "config.yml"),
    join(home, ".config", "workit", "config.yaml"),
    join(home, ".config", "workit", "config.json"),
    resolveRegistryFile(home),
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
    default: "codex",
    agents: {
      claude: {
        provider: "claude",
        weight: 3,
        command: "claude --dangerously-skip-permissions --model 'opus' --effort xhigh",
      },
      codex: {
        provider: "codex",
        weight: 2,
        command: "codex -p terra --dangerously-bypass-approvals-and-sandbox",
      },
      opencode: {
        provider: "opencode",
        weight: 0,
        command: "opencode",
      },
      muse: {
        provider: "opencode",
        weight: 0,
        command: "opencode --agent muse-spark",
        aliases: ["muse-spark"],
      },
      mimo: {
        provider: "opencode",
        weight: 0,
        command: "opencode --agent mimo",
      },
      hy: {
        provider: "opencode",
        weight: 0,
        command: "opencode --agent hy3",
        aliases: ["hy3"],
      },
      "dpsk-flash": {
        provider: "opencode",
        weight: 0,
        command: "opencode --agent dpsk-v4-flash",
        aliases: ["dpsk-v4-flash"],
      },
      "dpsk-pro": {
        provider: "opencode",
        weight: 0,
        command: "opencode --agent dpsk-v4-pro",
        aliases: ["dpsk-v4-pro"],
      },
      qwen: {
        provider: "opencode",
        weight: 0,
        command: "opencode --agent qwen",
      },
      glm: {
        provider: "claude",
        weight: 0,
        command: "CCP=glm claude --dangerously-skip-permissions --model 'glm-5.2[1m]'",
      },
      gly: {
        provider: "claude",
        weight: 0,
        command: "CCP=glm CLAUDE_CODE_AUTO_COMPACT_WINDOW=256000 claude --dangerously-skip-permissions --model 'glm-5.2'",
      },
      deepseek: {
        provider: "claude",
        weight: 0,
        command: "CCP=deepseek claude --dangerously-skip-permissions --model 'deepseek-v4-pro[1m]'",
      },
    },
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
  options: { explicitPath?: string; remote?: string; homeDirectory?: string } = {},
): ResolvedConfig {
  const home = options.homeDirectory ?? homedir();
  const userFiles = uniqueExisting(userConfigCandidates(options.explicitPath, home));
  const projectFiles = uniqueExisting(projectConfigCandidates(root));
  const configFiles = [...userFiles, ...projectFiles];
  const registryFile = resolveRegistryFile(home);

  let config = defaultConfig();
  for (const file of userFiles) {
    config = deepMerge(config, parseConfigFile(file, home) as Record<string, unknown>);
  }

  const remoteKey = options.remote ? normalizeRemote(options.remote) : undefined;
  const keys = [root, ...(remoteKey ? [remoteKey] : [])];
  const userProject = projectOverrides(config, keys);
  config = deepMerge(config, userProject as Record<string, unknown>);

  for (const file of projectFiles) {
    config = deepMerge(config, parseConfigFile(file, home) as Record<string, unknown>);
  }

  projectRegistryIntoAgents(config);
  validateConfig(config);

  return {
    config,
    root,
    configFiles,
    registryFile,
    projectKey: remoteKey,
    aliasIndex: buildAliasIndex(config),
  };
}

export function configBaseDirectory(file: string): string {
  return dirname(file);
}
