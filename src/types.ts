export type Backend = "linear" | "github";
export type ProviderMode = Backend | "auto";
export type LaunchTarget = "banyan" | "here" | "iterm";
export type DependencyMode = "symlink" | "clone" | "install" | "none";

export interface AgentDefinition {
  command: string;
  provider?: string;
  weight?: number;
  /** Extra names that resolve to this agent via --agent (workit only). */
  aliases?: string[];
}

/**
 * One entry in the shared coding-agent registry (~/.agents/agents.yml; legacy
 * fallback: ~/.agents/coding-agents.yml).
 * A single entry can drive up to three surfaces:
 *   - workit weighted pool: needs a non-empty `command` (and workit !== false)
 *   - banyan model picker: needs a `command` defined ("" ok, e.g. zsh) and picker !== false
 *   - opencode.jsonc agent map: present iff an `opencode` block is defined
 */
export interface CodingAgentEntry {
  /** Display label for the banyan picker (defaults to the registry key). */
  label?: string;
  /** Provider key used for banyan icon mapping and workit metadata. */
  provider?: string;
  /** workit weight; positive integers enter weighted selection. Defaults to 0. */
  weight?: number;
  /** Launch command shared by workit and the banyan picker. */
  command?: string;
  /** Override command used only for the banyan picker entry (defaults to command). */
  banyanCommand?: string;
  /** Extra names usable with --agent / shorthand flags in workit. */
  aliases?: string[];
  /** Optional banyan icon override: file path or SF Symbol name. */
  icon?: string;
  /** Set false to keep this agent out of the banyan picker. Defaults true. */
  picker?: boolean;
  /** Set false to keep this command out of the workit pool. Defaults true. */
  workit?: boolean;
  /**
   * Scenario whitelist; consumers only see entries carrying their tag.
   * Known tags: "banyan" (picker), "coding" (workit pool), "review".
   * Absent or empty tags mean the entry surfaces nowhere (default disallowed).
   */
  tags?: string[];
  /** Key used inside opencode.jsonc's agent map when it differs from the registry key. */
  opencodeName?: string;
  /** Raw block merged into the generated opencode.jsonc agent entry. Presence opts in. */
  opencode?: Record<string, unknown>;
}

/** Non-agent passthrough settings written into ~/.config/opencode/opencode.jsonc. */
export interface OpencodeSettings {
  default_agent?: string;
  [key: string]: unknown;
}

export interface CodingAgentsConfig {
  default?: string;
  agents?: Record<string, CodingAgentEntry>;
  opencode?: OpencodeSettings;
}

export interface WorkitConfig {
  provider?: ProviderMode;
  repo?: string;
  default?: string;
  agents?: Record<string, AgentDefinition>;
  /** Canonical coding-agent registry loaded from ~/.agents/agents.yml. */
  codingAgents?: CodingAgentsConfig;
  github?: {
    repo?: string;
    api?: string;
  };
  linear?: {
    org?: string;
    baseUrl?: string;
    apiUrl?: string;
  };
  worktree?: {
    directory?: string;
    branchPrefix?: string;
    baseBranch?: string;
    portBase?: number;
    portStep?: number;
    copyEnv?: boolean;
    envPaths?: string[];
  };
  launch?: {
    target?: LaunchTarget;
    review?: boolean;
    dependencies?: DependencyMode;
    logFile?: string;
  };
  projects?: Record<string, Partial<WorkitConfig>>;
}

export interface ResolvedConfig {
  config: WorkitConfig;
  root: string;
  configFiles: string[];
  /** Registry file actually loaded (~/.agents/agents.yml or the legacy path). */
  registryFile?: string;
  /** Normalized remote (owner/repo) when launched inside a git repo. */
  projectKey?: string;
  /** alias name -> canonical agent name, expanded from agents[*].aliases. */
  aliasIndex: Record<string, string>;
}

export interface CliOptions {
  provider?: ProviderMode;
  repo?: string;
  agent?: string;
  target?: LaunchTarget;
  prompt: boolean;
  agentLaunch: boolean;
  review: boolean;
  dependencies?: DependencyMode;
  dryRun: boolean;
  verbose: boolean;
  configPath?: string;
  identifiers: string[];
}

export interface IssueDetails {
  backend: Backend;
  identifier: string;
  title: string;
  body: string;
  labels: string[];
  url: string;
  number?: number;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  sourceBranch: string;
  port?: number;
  resumed: boolean;
}
