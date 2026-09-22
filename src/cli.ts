import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chooseAgent, describeEffectiveWeights } from "./agents.js";
import { allLaunchableRegistryAgents, agentDefinitionsByTag, resolveConfig, resolveHomePath } from "./config.js";
import { branchForIssue, createOrResumeWorktree, originRemote, prepareDependencies, repositoryRoot } from "./git.js";
import { fetchIssue, inferBackend, normalizeIdentifier, transitionLinearIssue } from "./issue.js";
import { headlessPromptCommand, launch, runHere } from "./launch.js";
import {
  DEFAULT_WORKIT_MAP,
  defaultMapFiles,
  defaultRoots,
  resolveRepoForProject,
  splitSmartRepo,
  syncMapFile,
} from "./project.js";
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
  workit sync-map [--map <path>] [--roots <dirs>]
  workit agents [--tag <tag>] [--format json|table] [--at <iso>]

Issue routing:
  workit 23             GitHub issue #23
  workit #23            GitHub issue #23
  workit ENG-123        Linear issue ENG-123 (auto-resolves repo from project)

Linear project resolution (per issue):
  workit finds the local repo from the issue's Linear project, so it works
  from anywhere: explicit --repo path > current repo (when it declares the
  same project) > static map > dynamic scan of .agents/context.md under
  the roots (default ~/dev). Falls back to the current git repo when the
  project is unknown. Use --no-resolve to disable switching.

  Maps share the neutral "project: repo-path" format; workit's map and
  review-linear's map are symlink-compatible. Lookup order:
  $WORKIT_MAP > ~/.config/workit/map.yml > $REVIEW_LINEAR_MAP >
  ~/.config/review-linear/map.yml. Roots: --roots > $WORKIT_ROOTS >
  $REVIEW_LINEAR_ROOTS > ~/dev.

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
  emits {name, label, command, aliases, weight, effectiveWeight} objects.

Time-sensitive weights:
  An entry may carry timeWeights rules that override "weight" inside vendor
  windows (e.g. peak pricing), plus a "horizon" for the expected session
  length. A rule applies when [now, now + horizon + bufferBefore] overlaps one
  of its ranges in its own tz, so a session started at 13:59 that would bleed
  into a 14:00 peak is already priced as peak. Use --at <iso> to evaluate the
  weights at another instant and --verbose to see the reasoning.

Sync options:
  --check               Exit non-zero if derived configs are stale; write nothing

Options:
  --linear, --github, --provider <name>  Override automatic routing
  --repo <owner/name|path>              GitHub repo (owner/name) or local repo path
                                        (path-like values switch the worktree root)
  --repo-path <path>                    Explicit local repo path (alias for path-like --repo)
  --map <path>                          Static project->repo map file
  --roots <dirs>                        Colon-separated scan roots (default ~/dev)
  --no-resolve                          Disable Linear project->repo auto-resolution
  --agent <name>                        Explicit agent (otherwise weighted)
                                        Shorthands: --codex, --claude, --opencode,
                                          --muse (--muse-spark), --mimo, --hy (--hy3),
                                          --dpsk-pro (--dpsk-v4-pro), --dpsk-flash (--dpsk-v4-flash),
                                          --qwen, --glm, --gly, --deepseek
  --allow-fallback                       Unknown --agent falls back to weighted selection
  --tag <tag>                           Scope weighted selection to agents carrying this tag
  --here                               Launch in the current terminal
  --banyan                             Launch a Banyan session (default)
  --iterm                              Launch an iTerm2 tab
  --no-prompt                          Launch agent without an issue prompt
  --no-agent                           Create/prepare worktree only
  --review / --no-review               Include/skip design guidance
  --instructions <text>                Append guidance to the issue prompt (repeatable)
  --no-instructions                    Drop the prompt guidance (auto-PR + review block)
  --symlink / --build / --install      Dependency preparation mode
  --at <iso>                            Evaluate time-dependent weights at this instant
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

/** Parse an --at value into the instant time-dependent weights are read at. */
function parseAt(value: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`--at requires an ISO timestamp, got '${value}'`);
  }
  return at;
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
      case "--repo": {
        const value = next();
        const split = splitSmartRepo(value);
        if (split.repoPath) options.repoPath = split.repoPath;
        else options.repo = split.githubRepo;
        break;
      }
      case "--repo-path":
        options.repoPath = next();
        break;
      case "--map":
        options.mapFile = next();
        break;
      case "--roots":
        options.roots = next();
        break;
      case "--no-resolve":
        options.noResolve = true;
        break;
      case "--agent":
        options.agent = next();
        break;
      case "--allow-fallback":
        options.allowFallback = true;
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
      case "--instructions":
        options.instructions = [...(options.instructions ?? []), next()];
        break;
      case "--no-instructions":
        options.noInstructions = true;
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
      case "--at":
        options.at = parseAt(next());
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
  mode: "launch" | "sync" | "sync-map" | "agents" | "run";
  check: boolean;
  tag?: string;
  format?: "json" | "table";
  options?: CliOptions;
  agent?: string;
  allowFallback?: boolean;
  workdir?: string;
  dryRun?: boolean;
  at?: Date;
  mapFile?: string;
  roots?: string;
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
      case "--allow-fallback":
        invocation.allowFallback = true;
        break;
      case "--workdir":
        invocation.workdir = next();
        break;
      case "--at":
        invocation.at = parseAt(next());
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
  if (argv[0] === "sync-map" || argv[0] === "sync_map") {
    const invocation: Invocation = { mode: "sync-map", check: false, promptArgs: [] };
    const args = argv.slice(1);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const next = () => {
        const value = args[++index];
        if (!value) throw new Error(`${arg} requires a value`);
        return value;
      };
      switch (arg) {
        case "--map":
          invocation.mapFile = next();
          break;
        case "--roots":
          invocation.roots = next();
          break;
        case "-h":
        case "--help":
          console.log(help());
          process.exit(0);
          break;
        default:
          throw new Error(`Unknown sync-map option '${arg}'`);
      }
    }
    return invocation;
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
        case "--at":
          invocation.at = parseAt(next());
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
    const now = invocation.at ?? new Date();
    const selected = chooseAgent(
      { ...resolved.config, agents: pickPool },
      invocation.agent,
      randomInt,
      resolved.aliasIndex,
      now,
      invocation.allowFallback,
    );
    const prompt = invocation.promptArgs.join(" ");
    const command = headlessPromptCommand(selected.definition.command, prompt);
    const workdir = invocation.workdir ? resolveHomePath(invocation.workdir) : process.cwd();
    if (invocation.dryRun) {
      console.log(`agent=${selected.name}`);
      console.log(`weights at ${now.toISOString()}:`);
      for (const line of describeEffectiveWeights(pickPool, now)) console.log(line);
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
    const now = invocation.at ?? new Date();
    const entries = listAgents(resolved, invocation.tag, now);
    if (invocation.format === "json") {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    // Show `base→effective` only where a time rule actually moved the weight.
    const weightOf = (entry: (typeof entries)[number]): string =>
      entry.effectiveWeight === entry.weight
        ? String(entry.weight)
        : `${entry.weight}→${entry.effectiveWeight}`;
    const nameWidth = Math.max("name".length, ...entries.map((entry) => entry.name.length));
    const labelWidth = Math.max(
      "label".length,
      ...entries.map((entry) => entry.label.length),
    );
    const weightWidth = Math.max("weight".length, ...entries.map((entry) => weightOf(entry).length));
    console.log(
      `${"name".padEnd(nameWidth)}  ${"label".padEnd(labelWidth)}  ${"weight".padEnd(weightWidth)}  aliases  command`,
    );
    for (const entry of entries) {
      const aliases = entry.aliases.join(",");
      console.log(
        `${entry.name.padEnd(nameWidth)}  ${entry.label.padEnd(labelWidth)}  ${weightOf(entry).padEnd(weightWidth)}  ${aliases.padEnd("aliases".length)}  ${entry.command}`,
      );
    }
    return;
  }
  if (!options) {
    if (invocation.mode === "sync-map") {
      try {
        const mapFile = invocation.mapFile ?? process.env.WORKIT_MAP ?? DEFAULT_WORKIT_MAP;
        const roots = defaultRoots(invocation.roots);
        const { path, entries } = syncMapFile(mapFile, roots);
        console.log(`✦ workit sync-map`);
        console.log(`  Map:      ${path}`);
        console.log(`  Scanned:  ${roots.join(" ")}`);
        console.log(`  Entries:`);
        for (const entry of entries) console.log(`    ${entry.name}: ${entry.path}`);
      } catch (error) {
        console.error(`workit: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      return;
    }
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

  if (options.target === "here" && options.identifiers.length > 1) {
    throw new Error("--here can only be used with one issue identifier");
  }

  // The starting repo (when invoked inside one). Linear issues may switch
  // away from it via project resolution; GitHub issues always stay here.
  let initialRoot: string | undefined;
  try {
    initialRoot = repositoryRoot();
  } catch {
    initialRoot = undefined;
  }

  const provisionalRoot = initialRoot ?? resolveHomePath("~");
  const provisionalResolved = resolveConfig(provisionalRoot, {
    explicitPath: options.configPath ? resolveHomePath(options.configPath, provisionalRoot) : undefined,
    remote: initialRoot ? originRemote(initialRoot) : undefined,
  });
  const autoEnabled = !options.noResolve && (provisionalResolved.config.resolve?.auto ?? true);
  const mapFiles = defaultMapFiles(options.mapFile ?? provisionalResolved.config.resolve?.map);
  const scanRoots = defaultRoots(options.roots ?? provisionalResolved.config.resolve?.roots);
  const provisionalProvider = configProvider(options, provisionalResolved.config.provider);

  // Explicit local repo override wins for every issue (--repo-path or path-like --repo).
  let explicitLocalRoot: string | undefined;
  if (options.repoPath) {
    const expanded = resolveHomePath(options.repoPath);
    if (!existsSync(`${expanded}/.git`)) {
      throw new Error(`--repo ${options.repoPath} is not a git repository`);
    }
    explicitLocalRoot = expanded;
  }

  const syncedRoots = new Set<string>();
  async function ensureSynced(
    resolved: Parameters<typeof syncDerivedConfigs>[0],
    verbose: boolean,
  ): Promise<void> {
    if (syncedRoots.has(resolved.root) || options!.dryRun) return;
    syncedRoots.add(resolved.root);
    try {
      const syncResult = await syncDerivedConfigs(resolved);
      if (verbose && syncResult.changed) console.log(describeSync(syncResult));
    } catch (error) {
      console.warn(
        `workit: registry sync skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  for (const identifier of options.identifiers) {
    const initialBackend = inferBackend(identifier, provisionalProvider);
    const wantsResolve = initialBackend === "linear" && autoEnabled && !explicitLocalRoot;

    // Provisional fetch (best-effort in dry-run) to learn the Linear
    // project before committing to a repo root.
    let prefetched: import("./types.js").IssueDetails | undefined;
    let resolveSource = "";
    let root: string | undefined = explicitLocalRoot ?? initialRoot;
    if (wantsResolve) {
      if (options.dryRun) {
        try {
          prefetched = await fetchIssue(
            "linear",
            identifier,
            provisionalResolved.config,
            provisionalRoot,
          );
        } catch {
          prefetched = undefined;
        }
      } else {
        prefetched = await fetchIssue(
          "linear",
          identifier,
          provisionalResolved.config,
          provisionalRoot,
        );
      }
      const project = prefetched?.project ?? "";
      if (project) {
        try {
          const settled = resolveRepoForProject(project, {
            currentRoot: initialRoot,
            mapFiles,
            roots: scanRoots,
          });
          root = settled.repo;
          resolveSource = settled.source;
        } catch (error) {
          if (!options.dryRun) throw error;
          // dry-run stays on the current repo when resolution fails.
          if (options.verbose) {
            console.warn(
              `workit: project resolution skipped (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }
      }
      if (!root) {
        throw new Error(
          `workit must resolve a repo for ${identifier}: no project mapping found and not inside a git repository. Add it to ${mapFiles[0]} or pass --repo <path>`,
        );
      }
    } else if (!root) {
      throw new Error("workit must be run inside a Git repository");
    }

    const remote = originRemote(root);
    const resolved = resolveConfig(root, {
      explicitPath: options.configPath ? resolveHomePath(options.configPath, root) : undefined,
      remote,
    });
    const provider = configProvider(options, resolved.config.provider);
    const backend = inferBackend(identifier, provider);
    const config = options.repo
      ? { ...resolved.config, repo: options.repo, github: { ...resolved.config.github, repo: options.repo } }
      : resolved.config;
    const dependencyMode = options.dependencies ?? config.launch?.dependencies ?? "symlink";
    const instructions = options.noInstructions
      ? []
      : [...(config.launch?.instructions ?? []), ...(options.instructions ?? [])];

    if (options.verbose && resolved.configFiles.length) {
      console.log(`Config: ${resolved.configFiles.join(", ")}`);
    }
    if (resolveSource && (options.verbose || root !== initialRoot)) {
      console.log(`Repo: ${root} (${resolveSource})`);
    }
    await ensureSynced(resolved, options.verbose);

    const issue = options.dryRun
      ? {
          backend,
          identifier,
          title: backend === "github" ? `GitHub issue #${identifier}` : (prefetched?.title ?? identifier),
          body: prefetched?.body ?? "",
          labels: prefetched?.labels ?? [],
          url:
            prefetched?.url ??
            (backend === "github"
              ? ""
              : `${config.linear?.baseUrl ?? "https://linear.app/2en/issue"}/${identifier}`),
          ...(prefetched?.project ? { project: prefetched.project } : {}),
        }
      : (prefetched && backend === "linear"
          ? prefetched
          : await fetchIssue(backend, identifier, config, root));
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
    const now = options.at ?? new Date();
    if (options.verbose && options.agentLaunch && !options.agent) {
      console.log(`Weights at ${now.toISOString()}:`);
      for (const line of describeEffectiveWeights(pickPool, now)) console.log(line);
    }
    const selected = options.agentLaunch
      ? chooseAgent(
          { ...config, agents: pickPool },
          options.agent,
          randomInt,
          resolved.aliasIndex,
          now,
          options.allowFallback,
        )
      : { name: "none", definition: { command: "" } };
    launch({ ...resolved, config }, issue, worktree, selected.name, selected.definition, {
      ...options,
      instructions,
    });
  }
}

main().catch((error: unknown) => {
  console.error(`workit: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
