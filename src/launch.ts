import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDefinition, CliOptions, IssueDetails, ResolvedConfig, WorktreeResult } from "./types.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function findBanyanctl(): string {
  try {
    return execFileSync("sh", ["-lc", "command -v banyanctl"], { encoding: "utf8" }).trim();
  } catch {
    const fallback = join(homedir(), "dev/yudu/banyan/dist/bin/banyanctl");
    return fallback;
  }
}

function promptFor(
  issue: IssueDetails,
  worktree: WorktreeResult,
  options: CliOptions,
): string {
  const resume = worktree.resumed
    ? `\nThis worktree already exists. Inspect git log and git diff before continuing.`
    : "";
  const review = options.review
    ? `\nFor non-trivial changes, do a short root-cause-first design pass before coding. Separate symptom from cause, consider alternatives, and commit to a recommendation.`
    : "";
  return [
    `Working on ${issue.backend === "github" ? "GitHub" : "Linear"} issue ${issue.identifier}. Branch: ${worktree.branch}.`,
    `Issue: ${issue.url}`,
    `Title: ${issue.title}`,
    issue.labels.length ? `Labels: ${issue.labels.join(", ")}` : "",
    "",
    issue.body,
    resume,
    review,
    "",
    `Launcher provenance: workit backend=${issue.backend} issue=${issue.identifier} worktree=${worktree.path}`,
  ].filter(Boolean).join("\n");
}

function logLaunch(
  resolved: ResolvedConfig,
  issue: IssueDetails,
  worktree: WorktreeResult,
  agent: string,
  target: string,
): void {
  const configured = resolved.config.launch?.logFile ?? "~/.agents/logs/workit-launches.log";
  const logFile = configured.startsWith("~/")
    ? join(homedir(), configured.slice(2))
    : configured;
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, [
    `timestamp_utc=${new Date().toISOString()}`,
    `backend=${issue.backend}`,
    `issue=${issue.identifier}`,
    `branch=${worktree.branch}`,
    `worktree=${worktree.path}`,
    `agent=${agent}`,
    `target=${target}`,
    `resuming=${worktree.resumed}`,
    "---",
    "",
  ].join("\n"));
}

function commandWithPrompt(
  agent: AgentDefinition,
  issue: IssueDetails,
  worktree: WorktreeResult,
  options: CliOptions,
): string {
  if (!options.prompt) return agent.command;
  const promptDirectory = join(tmpdir(), "workit");
  mkdirSync(promptDirectory, { recursive: true });
  const promptFile = join(
    promptDirectory,
    `${issue.backend}-${issue.identifier.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`,
  );
  writeFileSync(promptFile, promptFor(issue, worktree, options));
  const quotedPrompt = `"$(cat ${shellQuote(promptFile)})"`;
  // OpenCode TUI expects --prompt for initial message; `opencode run` uses positional message.
  // Detect opencode commands and inject --prompt correctly.
  const trimmed = agent.command.trimStart();
  if (trimmed.startsWith("opencode")) {
    const isRun = /\bopencode\s+run\b/.test(agent.command);
    if (isRun) return `${agent.command} ${quotedPrompt}`;
    const hasPromptFlag = /(?:^|\s)--prompt(?:\s|=|$)/.test(` ${agent.command} `);
    if (hasPromptFlag) return `${agent.command} ${quotedPrompt}`;
    return `${agent.command} --prompt ${quotedPrompt}`;
  }
  return `${agent.command} ${quotedPrompt}`;
}

/**
 * Build a non-interactive command that runs the agent with the given prompt:
 *   opencode --agent X  -> opencode run --agent X '<prompt>'
 *   claude [flags]      -> claude -p [flags] '<prompt>'
 *   codex [flags]       -> codex exec [flags] '<prompt>'
 * Anything else gets the prompt appended as the final argument.
 */
export function headlessPromptCommand(agentCommand: string, prompt: string): string {
  const quotedPrompt = shellQuote(prompt);
  const trimmed = agentCommand.trimStart();
  if (trimmed.startsWith("opencode")) {
    if (/^opencode\s+run\b/.test(trimmed)) return `${agentCommand} ${quotedPrompt}`;
    return `${agentCommand.replace(/^opencode\b/, "opencode run")} ${quotedPrompt}`;
  }
  if (trimmed.startsWith("codex")) {
    let base = /\bexec\b/.test(trimmed) ? agentCommand : agentCommand.replace(/^codex\b/, "codex exec");
    // codex exec refuses to run outside git repos unless the check is skipped.
    if (!/--skip-git-repo-check\b/.test(base)) base += " --skip-git-repo-check";
    return `${base} ${quotedPrompt}`;
  }
  if (trimmed.startsWith("claude")) {
    if (/(?:^|\s)-p(?:\s|=|$)/.test(` ${agentCommand}`)) return `${agentCommand} ${quotedPrompt}`;
    return `${agentCommand.replace(/^claude\b/, "claude -p")} ${quotedPrompt}`;
  }
  return `${agentCommand} ${quotedPrompt}`;
}

export function runHere(command: string, cwd: string): void {
  const shell = process.env.SHELL || "/bin/sh";
  const args = shell.endsWith("zsh") ? ["-ilc", command] : ["-lc", command];
  const result = spawnSync(shell, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Agent exited with status ${result.status ?? "unknown"}`);
}

function runBanyan(
  command: string | undefined,
  issue: IssueDetails,
  worktree: WorktreeResult,
): void {
  const banyanctl = findBanyanctl();
  const args = [
    "session", "new",
    "--id", issue.identifier,
    "--title", `${issue.identifier} ${issue.title}`,
    "--title-url", issue.url,
    "--cwd", worktree.path,
  ];
  if (process.env.BANYAN_PARENT_SESSION_ID || process.env.BANYAN_SESSION_ID) {
    args.push("--parent", process.env.BANYAN_PARENT_SESSION_ID ?? process.env.BANYAN_SESSION_ID!);
  }
  if (command) args.push("--command", `cd ${shellQuote(worktree.path)} && ${command}`);
  const result = spawnSync(banyanctl, args, { stdio: "inherit" });
  if (result.error) throw new Error(`Unable to launch Banyan: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`banyanctl exited with status ${result.status ?? "unknown"}`);
}

function runIterm(
  command: string | undefined,
  worktree: WorktreeResult,
): void {
  const body = command
    ? `cd ${shellQuote(worktree.path)} && ${command}; exec zsh -i`
    : `cd ${shellQuote(worktree.path)}; exec zsh -i`;
  const script = [
    'tell application "iTerm"',
    "activate",
    "if (count of windows) = 0 then",
    "create window with default profile",
    "end if",
    "tell current window",
    "create tab with default profile",
    `tell current session to write text ${JSON.stringify(body)}`,
    "end tell",
    "end tell",
  ].join("\n");
  const result = spawnSync("osascript", ["-e", script], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Unable to launch iTerm2");
}

export function launch(
  resolved: ResolvedConfig,
  issue: IssueDetails,
  worktree: WorktreeResult,
  agentName: string,
  agent: AgentDefinition,
  options: CliOptions,
): void {
  const target = options.target ?? resolved.config.launch?.target ?? "banyan";
  const command = options.agentLaunch
    ? commandWithPrompt(agent, issue, worktree, options)
    : undefined;

  console.log("");
  console.log(`${worktree.resumed ? "♻  Resuming" : "✦  New worktree"}  ${issue.identifier}`);
  console.log(`  Backend:  ${issue.backend}`);
  console.log(`  Worktree: ${worktree.path}`);
  console.log(`  Branch:   ${worktree.branch}`);
  console.log(`  Agent:    ${options.agentLaunch ? agentName : "none"}`);
  if (worktree.port !== undefined) console.log(`  Port:     ${worktree.port}`);

  if (options.dryRun) return;
  logLaunch(resolved, issue, worktree, agentName, target);
  if (target === "here") {
    if (command) runHere(command, worktree.path);
  } else if (target === "iterm") {
    runIterm(command, worktree);
  } else {
    runBanyan(command, issue, worktree);
  }
}
