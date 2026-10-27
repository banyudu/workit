import { investigation, verificationSource } from "./verification-source.js";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDefinition, CliOptions, IssueDetails, ResolvedConfig, WorktreeResult } from "./types.js";
import type { Job, VerifierPlan, VerifierRun } from "./lifecycle.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function findBanyanctl(): string {
  if (process.env.WORKIT_BANYANCTL) return process.env.WORKIT_BANYANCTL;
  try {
    return execFileSync("sh", ["-lc", "command -v banyanctl"], { encoding: "utf8" }).trim();
  } catch {
    const fallback = join(homedir(), "dev/yudu/banyan/dist/bin/banyanctl");
    return fallback;
  }
}

export function promptFor(
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
  const instructions = options.instructions?.length
    ? `\n${options.instructions.map((line) => line.trim()).filter(Boolean).join("\n")}`
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
    instructions,
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
  mkdirSync(promptDirectory, { recursive: true, mode: 0o700 });
  const promptFile = join(
    promptDirectory,
    `${issue.backend}-${issue.identifier.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}.txt`,
  );
  writeFileSync(promptFile, promptFor(issue, worktree, options), { mode: 0o600 });
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
  sessionID?: string,
  parentFallback = true,
  control?: { executable: string; quiet: boolean; parent?: string },
): void {
  const banyanctl = control?.executable ?? findBanyanctl();
  const args = [
    "session", "new",
    "--id", sessionID ?? issue.identifier,
    "--title", `${issue.identifier} ${issue.title}`,
    "--title-url", issue.url,
    "--cwd", worktree.path,
  ];
  if (command) args.push("--command", `cd ${shellQuote(worktree.path)} && ${command}`);
  // A launch inside Banyan inherits its calling session unless an explicit
  // override is set. Resolve it before clearing the child CLI's identity.
  const parent = control?.parent ?? (process.env.BANYAN_PARENT_SESSION_ID?.trim() || process.env.BANYAN_SESSION_ID?.trim());
  const environment = { ...process.env };
  delete environment.BANYAN_SESSION_ID;
  delete environment.BANYAN_PARENT_SESSION_ID;
  const invoke = (parentArgs: string[]) => spawnSync(banyanctl, [...args, ...parentArgs], {
    env: environment, encoding: "utf8", stdio: [control?.quiet ? "ignore" : "inherit", "pipe", "pipe"], timeout: 30_000,
  });
  let result = invoke(parent ? ["--parent", parent] : ["--no-parent"]);
  // A 400 missing-parent rejection happens before session creation. Retry only
  // this confirmed failure, once, keeping the same session id and command.
  if (parent && parentFallback && result.status === 64 &&
      /^banyanctl: server returned HTTP 400\r?$/m.test(result.stderr ?? "")) {
    let response;
    try { response = JSON.parse(result.stdout); } catch { /* Preserve the original error. */ }
    if (response?.ok === false && response.error?.code === "bad_request" &&
        response.error.message === `No active parent session found for id '${parent}'`) {
      console.warn(`workit: Banyan parent '${parent}' is inactive; launching a top-level session`);
      result = invoke(["--no-parent"]);
    }
  }
  if (!control?.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!control?.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new Error(`Unable to launch Banyan: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`banyanctl exited with status ${result.status ?? "unknown"}`);
}

/** A separate bounded review run using the existing registry and Banyan launcher. */
export function launchIndependentVerifier(job: Job, run: VerifierRun, plan: VerifierPlan, banyanctl = findBanyanctl()): void {
  if (!plan.command) throw new Error("No verifier command available");
  const prompt = [
    `Independently verify managed job ${job.id}. Reviewer run ID: ${run.id}.`,
    `Issue: ${job.issue.url}. ${investigation(job) ? "Observed source" : "Merged source"}: ${verificationSource(job)}. Current AC hash: ${job.acHash}.`,
    `Acceptance profile: ${job.config.verification}. AC labels: ${job.acLabels.join(", ")}.`,
    job.deployment ? `Expected serving binding: ${JSON.stringify(job.deployment)}.` : "No serving deployment is required. Local does not mean all evidence must be local; explicitly required CI runs need actual CI evidence (kind: ci), not local tests or estimates.",
    `Read the current issue and repository instructions. Write the complete JSON VerificationReport to ${run.reportPath}.`,
    `Use reviewer: {runID: "${run.id}", independent: true}, jobID, issueURL, acHash, ${investigation(job) ? "sourceSha" : "mergeSha"}, checkedAt and one criterion with actual evidence per current AC.`,
    "Each criterion needs label, status and evidence entries with kind, reference and observed. Deployed journeys also need the actual environment, target, sourceSha and version on the report and evidence.",
    "Report fail/blocked for anything unproven. Do not fabricate journeys, deployment provenance or human acceptance.",
    "This is a bounded verification run. Do not implement changes, replay the implementation task, create native goals, schedule work, launch other agents, merge, deploy, send external messages, edit issue ACs/checklists or mark the issue Done.",
    "Do not start paid/provider journeys or perform human acceptance. Only use already authorized local fixtures and read-only probes. Report blocked when further authority or external provenance is required.",
  ].join("\n");
  // Node supplies a portable process timeout; no new scheduler or live config writes.
  const runner = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const [command,outcome,seconds]=process.argv.slice(1);
let timedOut=false;
const child=spawn('/bin/sh',['-lc',command],{stdio:'inherit',detached:true});
const stop=()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL')}catch{}};
const timer=setTimeout(stop,Number(seconds)*1000);
const finish=status=>{clearTimeout(timer);fs.writeFileSync(outcome+'.tmp',JSON.stringify({status}),{mode:0o600});fs.renameSync(outcome+'.tmp',outcome)};
child.on('error',()=>finish('failed'));
child.on('exit',(code)=>finish(!timedOut&&code===0?'complete':'failed'));
process.on('SIGTERM',stop);process.on('SIGINT',stop);`;
  const command = [process.execPath, "-e", runner, "--", headlessPromptCommand(plan.command, prompt), run.outcomePath, String(run.timeoutSeconds)].map(shellQuote).join(" ");
  runBanyan(command, { ...job.issue, identifier: run.id, title: "Independent managed verification" },
    { path: job.worktree, branch: "", sourceBranch: "", resumed: false }, run.sessionID, !job.queue?.coordinatorSessionID, { executable: banyanctl, quiet: true, parent: job.queue?.coordinatorSessionID });
  if (job.queue?.coordinatorSessionID) {
    const result = spawnSync(banyanctl, ["coordination", "helper", "--id", run.sessionID, "--parent", job.queue.coordinatorSessionID,
      "--group-id", job.queue.id, "--worker", job.sessionID, "--run-id", run.id, "--job-id", job.id],
      { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.status !== 0) throw new Error("Verifier launched but group ownership was not confirmed; inspect the original run");
  }
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
    runBanyan(command, issue, worktree, options.sessionID,
      options.parentFallback ?? resolved.config.launch?.parentFallback ?? true);
  }
}
