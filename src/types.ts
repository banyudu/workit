export type Backend = "linear" | "github";
export type ProviderMode = Backend | "auto";
export type LaunchTarget = "banyan" | "here" | "iterm";
export type DependencyMode = "symlink" | "clone" | "install" | "none";

/**
 * A window in which an agent's weight differs from its static one, e.g. a
 * vendor's peak-pricing hours. Windows are read in `tz` wall-clock time, so
 * the weekday boundary follows the vendor's calendar, not UTC's.
 */
export interface TimeWeightRule {
  /** IANA zone the ranges and weekdays are read in. Defaults to "UTC". */
  tz?: string;
  /** Weekday whitelist (mon..sun, any capitalisation). Absent means every day. */
  weekdays?: string[];
  /** "HH:MM-HH:MM" windows; end <= start wraps past midnight. Absent means all day. */
  ranges?: string[];
  /** Weight used while the rule is in force. */
  weight: number;
  /** Extra lookahead beyond `horizon` for this rule, e.g. "15m". Defaults to 0. */
  bufferBefore?: string | number;
}

/** The weight fields shared by launchable agents and raw registry entries. */
export interface WeightedDefinition {
  /** Static weight, also the fallback when no time rule is in force. */
  weight?: number;
  /** Expected session length, e.g. "60m". Defaults to DEFAULT_HORIZON when time rules exist. */
  horizon?: string | number;
  /** Time-dependent weight overrides; the first matching rule wins. */
  timeWeights?: TimeWeightRule[];
}

export interface AgentDefinition extends WeightedDefinition {
  command: string;
  provider?: string;
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
export interface CodingAgentEntry extends WeightedDefinition {
  /** Display label for the banyan picker (defaults to the registry key). */
  label?: string;
  /** Provider key used for banyan icon mapping and workit metadata. */
  provider?: string;
  /** workit weight; positive integers enter weighted selection. Defaults to 0. */
  weight?: number;
  /** Expected session length used when evaluating `timeWeights`, e.g. "60m". */
  horizon?: string | number;
  /**
   * Weight overrides for vendor peak/off-peak windows. A session that would
   * bleed into a window within `horizon` is already treated as inside it.
   */
  timeWeights?: TimeWeightRule[];
  /** Launch command shared by workit and the banyan picker. */
  command?: string;
  /** Override command used only for the banyan picker entry (defaults to command). */
  banyanCommand?: string;
  /** Route the Banyan picker entry to a puckd session instead of its CLI command. */
  puckProvider?: string;
  /** Model ID for the puckd route; required for Anthropic and Gemini. */
  puckModel?: string;
  /** Puck-owned account label; required for Anthropic and Gemini. */
  puckAccount?: string;
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
   * Custom tags are allowed and selectable via `--tag` (e.g. "daily").
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
  resolve?: {
    /** Static project->repo map file (default ~/.config/workit/map.yml). */
    map?: string;
    /** Roots scanned for .agents/context.md declarations (default ~/dev). */
    roots?: string;
    /** Set false to disable Linear project->repo auto-resolution. */
    auto?: boolean;
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
    /**
     * Guidance appended to every issue prompt. Replaces the built-in
     * DEFAULT_LAUNCH_INSTRUCTIONS list, so `[]` disables it.
     */
    instructions?: string[];
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
  /** Explicit local repo path override (--repo-path, or path-like --repo). */
  repoPath?: string;
  /** Static project->repo map file override (--map). */
  mapFile?: string;
  /** Colon-separated roots scanned for .agents/context.md (--roots). */
  roots?: string;
  /** Disable Linear project->repo auto-resolution (--no-resolve). */
  noResolve?: boolean;
  agent?: string;
  /** Unknown --agent falls back to weighted selection instead of failing. */
  allowFallback?: boolean;
  /** Registry tag used to scope the weighted selection pool (e.g. "coding", "daily"). */
  tag?: string;
  target?: LaunchTarget;
  prompt: boolean;
  agentLaunch: boolean;
  review: boolean;
  /** Extra guidance from --instructions, appended to the configured list. */
  instructions?: string[];
  /** --no-instructions: drop the configured guidance entirely. */
  noInstructions?: boolean;
  dependencies?: DependencyMode;
  dryRun: boolean;
  verbose: boolean;
  configPath?: string;
  /** Evaluate time-dependent weights at this instant instead of now (--at). */
  at?: Date;
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
  /** Linear project name (e.g. "Rene"); absent for GitHub issues. */
  project?: string;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  sourceBranch: string;
  port?: number;
  resumed: boolean;
}
