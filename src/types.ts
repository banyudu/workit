export type Backend = "linear" | "github";
export type ProviderMode = Backend | "auto";
export type LaunchTarget = "banyan" | "here" | "iterm";
export type DependencyMode = "symlink" | "clone" | "install" | "none";

export interface AgentDefinition {
  command: string;
  provider?: string;
  weight?: number;
}

export interface WorkitConfig {
  provider?: ProviderMode;
  repo?: string;
  default?: string;
  agents?: Record<string, AgentDefinition>;
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
  projectKey?: string;
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
