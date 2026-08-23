import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chooseAgent } from "./agents.js";
import { allLaunchableRegistryAgents, agentDefinitionsByTag, resolveConfig, resolveHomePath } from "./config.js";
import { branchForIssue, createOrResumeWorktree, originRemote, prepareDependencies, repositoryRoot } from "./git.js";
import { fetchIssue, inferBackend, normalizeIdentifier, transitionLinearIssue } from "./issue.js";
import { headlessPromptCommand, launch, runHere } from "./launch.js";
import { listAgents, syncDerivedConfigs, type SyncResult } from "./sync.js";
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
  workit run [--tag <tag>] [--agent <name>] [--workdir <dir>] [--here] <prompt words...>
  workit sync [--check]
  workit agents [--tag <tag>] [--format json|table]

Issue routing:
  workit 23             GitHub issue #23
  workit #23            GitHub issue #23
  workit ENG-123        Linear issue ENG-123

Prompt-only runs (no issue, no worktree):
  workit run --here --tag daily "summarize my day"
  Picks an agent weighted from the registry pool carrying the given tag and
  runs it non-interactively with the prompt in the current terminal.
  --agent overrides weighted selection; --workdir sets the working directory.

Agent registry:
  Agents are defined once in ~/.agents/agents.yml. Entries need a "coding"
  tag to enter workit's pool and a "banyan" tag to appear in banyan's picker.
  Tags scope weighted selection: pass --tag <tag> to pick from that pool.
  Every workit run regenerates ~/.banyan/config.yml and the agent section of
  ~/.config/opencode/opencode.jsonc when they are stale.

  workit agents [--tag review] lists launchable registry agents; --format json
  emits {name, label, command, aliases} objects for scripts.

Sync options:
  --check               Exit non-zero if derived configs are stale; write nothing

Options:
  --linear, --github, --provider <name>  Override automatic routing
  --repo <owner/name>                   GitHub repository override
  --agent <name>                        Explicit agent (otherwise weighted)
                                        Shorthands: --codex, --claude, --opencode,
                                          --muse (--muse-spark), --mimo, --hy (--hy3),
                                          --dpsk-pro (--dpsk-v4-pro), --dpsk-flash (--dpsk-v4-flash),
                                          --qwen, --glm, --gly, --deepseek
  --tag <tag>                           Scope weighted selection to agents carrying this tag
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
  ~/.agents/agents.yml (canonical agent registry; legacy: coding-agents.yml)
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
      case "--tag":
        options.tag = next();
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

interface Invocation {
  mode: "launch" | "sync" | "agents" | "run";
  check: boolean;
  tag?: string;
  format?: "json" | "table";
  options?: CliOptions;
  agent?: string;
  workdir?: string;
  dryRun?: boolean;
  promptArgs: string[];
}

function parseRunInvocation(argv: string[]): Invocation {
  const invocation: Invocation = {
    mode: "run",
    check: false,
    promptArgs: [],
    dryRun: false,
  };
  const args = argv.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--tag":
        invocation.tag = next();
        break;
      case "--agent":
        invocation.agent = next();
        break;
      case "--workdir":
        invocation.workdir = next();
        break;
      case "--here":
      case "--banyan":
      case "--iterm":
        // run mode always executes in the current terminal; kept for ergonomics.
        break;
      case "--dry-run":
        invocation.dryRun = true;
        break;
      case "-h":
      case "--help":
        console.log(help());
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown run option '${arg}'`);
        invocation.promptArgs.push(arg);
    }
  }
  if (invocation.promptArgs.length === 0) {
    throw new Error("At least one prompt word is required");
  }
  return invocation;
}

function parseInvocation(argv: string[]): Invocation {
  if (argv[0] === "run") {
    return parseRunInvocation(argv);
  }
  if (argv[0] === "sync") {
    let check = false;
    for (const arg of argv.slice(1)) {
      switch (arg) {
        case "--check":
          check = true;
          break;
        case "-h":
        case "--help":
          console.log(help());
          process.exit(0);
          break;
        default:
          throw new Error(`Unknown sync option '${arg}'`);
      }
    }
    return { mode: "sync", check, promptArgs: [] };
  }
  if (argv[0] === "agents") {
    const invocation: Invocation = { mode: "agents", check: false, format: "table", promptArgs: [] };
    const args = argv.slice(1);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const next = () => {
        const value = args[++index];
        if (!value) throw new Error(`${arg} requires a value`);
        return value;
      };
      switch (arg) {
        case "--tag":
          invocation.tag = next();
          break;
        case "--format":
          invocation.format = next() as "json" | "table";
          if (!["json", "table"].includes(invocation.format)) {
            throw new Error(`Unsupported format '${invocation.format}' (expected json|table)`);
          }
          break;
        case "-h":
        case "--help":
          console.log(help());
          process.exit(0);
          break;
        default:
          throw new Error(`Unknown agents option '${arg}'`);
      }
    }
    return invocation;
  }
  return { mode: "launch", check: false, options: parseArgs(argv), promptArgs: [] };
}

function describeSync(result: SyncResult): string {
  const lines: string[] = [];
  for (const target of result.targets) {
    lines.push(
      `${target.changed ? "updated" : "up to date"}  ${target.path}` +
        (target.backupPath && target.changed ? ` (backup: ${target.backupPath})` : ""),
    );
  }
  return lines.join("\n");
}

function configProvider(options: CliOptions, configured: ProviderMode | undefined): ProviderMode {
  return options.provider ?? configured ?? "auto";
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  const options = invocation.options;
  if (invocation.mode === "run") {
    const resolved = resolveConfig(resolveHomePath("~"));
    const runPool = invocation.tag
      ? agentDefinitionsByTag(resolved.config, invocation.tag)
      : resolved.config.agents ?? {};
    if (invocation.tag && Object.keys(runPool).length === 0) {
      throw new Error(`No agents carry the tag '${invocation.tag}'`);
    }
    // Explicit --agent may name any launchable registry entry, even one
    // outside the tag pool; merge those in so selection can reach it.
    const explicitName = invocation.agent
      ? resolved.aliasIndex[invocation.agent] ?? invocation.agent
      : undefined;
    const pickPool =
      explicitName && !runPool[explicitName]
        ? { ...runPool, ...allLaunchableRegistryAgents(resolved.config) }
        : runPool;
    const selected = chooseAgent(
      { ...resolved.config, agents: pickPool },
      invocation.agent,
      randomInt,
      resolved.aliasIndex,
    );
    const prompt = invocation.promptArgs.join(" ");
    const command = headlessPromptCommand(selected.definition.command, prompt);
    const workdir = invocation.workdir ? resolveHomePath(invocation.workdir) : process.cwd();
    if (invocation.dryRun) {
      console.log(`agent=${selected.name}`);
      console.log(command);
      return;
    }
    console.log(
      `✦  workit run  agent=${selected.name}${invocation.tag ? ` tag=${invocation.tag}` : ""} cwd=${workdir}`,
    );
    runHere(command, workdir);
    return;
  }
  if (invocation.mode === "agents") {
    const resolved = resolveConfig(resolveHomePath("~"));
    const entries = listAgents(resolved, invocation.tag);
    if (invocation.format === "json") {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    const nameWidth = Math.max("name".length, ...entries.map((entry) => entry.name.length));
    const labelWidth = Math.max(
      "label".length,
      ...entries.map((entry) => entry.label.length),
    );
    console.log(
      `${"name".padEnd(nameWidth)}  ${"label".padEnd(labelWidth)}  aliases  command`,
    );
    for (const entry of entries) {
      const aliases = entry.aliases.join(",");
      console.log(
        `${entry.name.padEnd(nameWidth)}  ${entry.label.padEnd(labelWidth)}  ${aliases.padEnd("aliases".length)}  ${entry.command}`,
      );
    }
    return;
  }
  if (!options) {
    // sync mode does not require an issue identifier or a git repository.
    try {
      const resolved = resolveConfig(resolveHomePath("~"));
      const result = await syncDerivedConfigs(resolved, { check: invocation.check });
      console.log(describeSync(result));
      if (invocation.check && result.changed) process.exitCode = 1;
    } catch (error) {
      console.error(`workit: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }
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

  if (!options.dryRun) {
    try {
      const syncResult = await syncDerivedConfigs(resolved);
      if (options.verbose && syncResult.changed) console.log(describeSync(syncResult));
    } catch (error) {
      console.warn(
        `workit: registry sync skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    }
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
    const pickPool = options.tag
      ? agentDefinitionsByTag(config, options.tag)
      : config.agents ?? {};
    if (options.tag && Object.keys(pickPool).length === 0) {
      throw new Error(`No agents carry the tag '${options.tag}'`);
    }
    const selected = options.agentLaunch
      ? chooseAgent({ ...config, agents: pickPool }, options.agent, randomInt, resolved.aliasIndex)
      : { name: "none", definition: { command: "" } };
    launch({ ...resolved, config }, issue, worktree, selected.name, selected.definition, options);
  }
}

main().catch((error: unknown) => {
  console.error(`workit: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
