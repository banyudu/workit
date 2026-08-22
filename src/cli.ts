import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chooseAgent } from "./agents.js";
import { resolveConfig, resolveHomePath } from "./config.js";
import { branchForIssue, createOrResumeWorktree, originRemote, prepareDependencies, repositoryRoot } from "./git.js";
import { fetchIssue, inferBackend, normalizeIdentifier, transitionLinearIssue } from "./issue.js";
import { launch } from "./launch.js";
import type { CliOptions, DependencyMode, LaunchTarget, ProviderMode } from "./types.js";

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {}
  return "0.0.0";
})();

function help(): string {
  return `workit ${VERSION} — unified Linear and GitHub issue worktree launcher

Usage:
  workit [options] <issue> [issue ...]

Issue routing:
  workit 23             GitHub issue #23
  workit #23            GitHub issue #23
  workit ENG-123        Linear issue ENG-123

Options:
  --linear, --github, --provider <name>  Override automatic routing
  --repo <owner/name>                   GitHub repository override
  --agent <name>                        Explicit agent (otherwise weighted)
                                        Shorthands: --codex, --claude, --opencode (ox-alpha),
                                          --muse (--muse-spark), --mimo, --hy (--hy3),
                                          --dpsk-pro (--dpsk-v4-pro), --dpsk-flash (--dpsk-v4-flash),
                                          --qwen, --glm, --gly, --deepseek, --ox (--0x/ox-alpha)
  --here                               Launch in the current terminal
  --banyan                             Launch a Banyan session (default)
  --iterm                              Launch an iTerm2 tab
  --no-prompt                          Launch agent without an issue prompt
  --no-agent                           Create/prepare worktree only
  --review / --no-review               Include/skip design guidance
  --symlink / --build / --install      Dependency preparation mode
  --dry-run                            Resolve and print without launching
  --config <path>                      Add/override the user config file
  -h, --help                          Show this help

Config precedence (later wins):
  ~/.agents/worktree-agents.yml (legacy agent defaults)
  ~/.config/workit/config.yml (user defaults)
  user-config.projects[repo-or-root] (project override)
  <git-root>/.workit.yml (project override)
`;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    prompt: true,
    agentLaunch: true,
    review: true,
    dryRun: false,
    verbose: false,
    identifiers: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        console.log(help());
        process.exit(0);
      case "--version":
        console.log(VERSION);
        process.exit(0);
      case "--linear":
        options.provider = "linear";
        break;
      case "--github":
      case "--gh":
        options.provider = "github";
        break;
      case "--provider":
        options.provider = next() as ProviderMode;
        if (!["auto", "linear", "github"].includes(options.provider)) {
          throw new Error(`Unsupported provider '${options.provider}'`);
        }
        break;
      case "--repo":
        options.repo = next();
        break;
      case "--agent":
        options.agent = next();
        break;
      case "--codex":
        options.agent = "codex";
        break;
      case "--claude":
        options.agent = "claude";
        break;
      case "--glm":
        options.agent = "glm";
        break;
      case "--gly":
        options.agent = "gly";
        break;
      case "--opencode":
        options.agent = "opencode";
        break;
      case "--ox":
      case "--0x":
      case "--ox-alpha":
      case "--0x-alpha":
      case "--ox-alpha-free":
        options.agent = "ox";
        break;
      case "--deepseek":
        options.agent = "deepseek";
        break;
      case "--muse":
      case "--muse-spark":
        options.agent = "muse";
        break;
      case "--mimo":
        options.agent = "mimo";
        break;
      case "--hy":
      case "--hy3":
        options.agent = "hy";
        break;
      case "--dpsk-flash":
      case "--dpsk-v4-flash":
        options.agent = "dpsk-flash";
        break;
      case "--dpsk-pro":
      case "--dpsk-v4-pro":
        options.agent = "dpsk-pro";
        break;
      case "--qwen":
        options.agent = "qwen";
        break;
      case "--here":
        options.target = "here";
        break;
      case "--banyan":
        options.target = "banyan";
        break;
      case "--iterm":
        options.target = "iterm";
        break;
      case "--no-prompt":
        options.prompt = false;
        break;
      case "--no-agent":
      case "--no-claude":
        options.agentLaunch = false;
        break;
      case "--review":
        options.review = true;
        break;
      case "--no-review":
        options.review = false;
        break;
      case "--symlink":
        options.dependencies = "symlink";
        break;
      case "--build":
        options.dependencies = "clone";
        break;
      case "--install":
        options.dependencies = "install";
        break;
      case "--none":
        options.dependencies = "none";
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--config":
        options.configPath = next();
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option '${arg}'`);
        for (const identifier of arg.split(",")) {
          const normalized = normalizeIdentifier(identifier);
          if (normalized) options.identifiers.push(normalized);
        }
    }
  }
  if (options.identifiers.length === 0) throw new Error("At least one issue identifier is required");
  return options;
}

function configProvider(options: CliOptions, configured: ProviderMode | undefined): ProviderMode {
  return options.provider ?? configured ?? "auto";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = repositoryRoot();
  const remote = originRemote(root);
  const resolved = resolveConfig(root, {
    explicitPath: options.configPath ? resolveHomePath(options.configPath, root) : undefined,
    remote,
  });
  const provider = configProvider(options, resolved.config.provider);
  const config = options.repo
    ? { ...resolved.config, repo: options.repo, github: { ...resolved.config.github, repo: options.repo } }
    : resolved.config;
  const dependencyMode = options.dependencies ?? config.launch?.dependencies ?? "symlink";

  if (options.target === "here" && options.identifiers.length > 1) {
    throw new Error("--here can only be used with one issue identifier");
  }

  if (options.verbose && resolved.configFiles.length) {
    console.log(`Config: ${resolved.configFiles.join(", ")}`);
  }

  for (const identifier of options.identifiers) {
    const backend = inferBackend(identifier, provider);
    const issue = options.dryRun
      ? {
          backend,
          identifier,
          title: backend === "github" ? `GitHub issue #${identifier}` : identifier,
          body: "",
          labels: [],
          url: backend === "github" ? "" : `${config.linear?.baseUrl ?? "https://linear.app/2en/issue"}/${identifier}`,
        }
      : await fetchIssue(backend, identifier, config, root);
    if (!options.dryRun) await transitionLinearIssue(issue, config);

    const branch = branchForIssue(issue.backend, issue.identifier, issue.title, config);
    const worktree = options.dryRun
      ? {
          path: resolve(root, config.worktree?.directory ?? ".worktrees", branch.replace(/\//g, "-")),
          branch,
          sourceBranch: branch,
          resumed: false,
        }
      : createOrResumeWorktree({ ...resolved, config }, branch);
    if (!options.dryRun) prepareDependencies(root, worktree.path, dependencyMode);
    const selected = options.agentLaunch
      ? chooseAgent(config, options.agent)
      : { name: "none", definition: { command: "" } };
    launch({ ...resolved, config }, issue, worktree, selected.name, selected.definition, options);
  }
}

main().catch((error: unknown) => {
  console.error(`workit: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
