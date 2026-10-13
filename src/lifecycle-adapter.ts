import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { fetchIssue } from "./issue.js";
import { agentDefinitionsByTag, resolveConfig } from "./config.js";
import { chooseAgent } from "./agents.js";
import { launchIndependentVerifier } from "./launch.js";
import { originRemote } from "./git.js";
import { WorkflowRefusedError, SourceProvenanceError, digest, sanitizedDetail, sha, workflowState, type Deployment, type Job, type LifecycleAdapter, type PRSnapshot, type Session, type VerifierPlan, type VerifierRun } from "./lifecycle.js";

const exec = promisify(execFile);
function workflowRefusal(value: unknown): WorkflowRefusedError | undefined {
  const response = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (response?.ok === false && response.error?.code === "workflow_refused" &&
      typeof response.error.message === "string" && response.error.message.trim()) {
    return new WorkflowRefusedError(sanitizedDetail(response.error.message));
  }
}
export async function commandJSON(command: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, NO_COLOR: "1", CLICOLOR: "0" };
  delete env.CLICOLOR_FORCE; delete env.FORCE_COLOR; delete env.GH_FORCE_TTY;
  let stdout: string;
  try {
    ({ stdout } = await exec(command[0], command.slice(1), { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    const failure = error as { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    // A timeout/signal or HTTP 5xx remains a failure even if stdout contains a refusal.
    if (command[1] === "workflow" && typeof failure.code === "number" && !failure.killed && !failure.signal &&
        !/\bHTTP 5\d\d\b/i.test(failure.stderr ?? "")) {
      let value: unknown;
      try { value = JSON.parse(failure.stdout ?? ""); } catch { /* genuine command failure */ }
      const refusal = workflowRefusal(value);
      if (refusal) throw refusal;
    }
    throw new Error(`${basename(command[0])} failed or timed out; inspect its authentication and local logs`);
  }
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`${basename(command[0])} did not return JSON`); }
  const refusal = command[1] === "workflow" ? workflowRefusal(value) : undefined;
  if (refusal) throw refusal;
  return value;
}

export function githubRepository(remote?: string): string {
  const value = remote?.match(/(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  if (!value) throw new Error("Managed jobs require a GitHub origin remote");
  return value;
}

export class BanyanLifecycleAdapter implements LifecycleAdapter {
  constructor(readonly banyanctl = process.env.WORKIT_BANYANCTL ?? "banyanctl") {}

  async requireWorkflowSupport(cwd: string): Promise<void> {
    const value = await commandJSON([this.banyanctl, "session", "list"], cwd) as { workflowProtocol?: number };
    if (value.workflowProtocol !== 1) throw new Error("Update/restart Banyan with workflow protocol v1 before launching managed jobs");
  }

  async session(job: Job): Promise<Session | undefined> {
    const value = await commandJSON([this.banyanctl, "session", "list"], job.repoRoot) as { sessions?: Session[] };
    const session = value.sessions?.find(item => item.id === job.sessionID);
    if (session?.cwd && session.cwd !== job.worktree) throw new Error("Banyan session worktree does not match its job");
    return session;
  }
  async project(job: Job): Promise<void> {
    const value = await commandJSON([this.banyanctl, "workflow", "set", "--id", job.sessionID, "--owner", "workit",
      "--job-id", job.id, "--revision", String(job.revision), "--state", workflowState(job.stage),
      "--detail", job.detail || job.stage], job.repoRoot) as { ok?: boolean };
    if (value?.ok !== true) throw new Error("Banyan did not confirm the workflow projection; inspect it before closing the session");
  }
  async wake(job: Job, wakeID: string, text: string): Promise<void> {
    await commandJSON([this.banyanctl, "workflow", "wake", "--id", job.sessionID,
      "--job-id", job.id, "--revision", String(job.revision), "--wake-id", wakeID, "--text", text], job.repoRoot);
  }
  async reconcile(job: Job, outcome: string, detail: string): Promise<void> {
    await commandJSON([this.banyanctl, "workflow", "resolve", "--id", job.sessionID,
      "--job-id", job.id, "--revision", String(job.revision), "--wake-id", job.wake!.id,
      "--outcome", outcome, "--detail", detail], job.repoRoot);
  }
  async pr(job: Job): Promise<PRSnapshot> {
    if (!job.pr) throw new Error("No PR checkpoint exists");
    const value = await commandJSON(["gh", "pr", "view", job.pr, "--repo", job.githubRepo,
      "--json", "state,headRefOid,mergeCommit,updatedAt,reviewDecision,mergeStateStatus,statusCheckRollup"], job.repoRoot) as {
      state: string; headRefOid: string; mergeCommit?: { oid: string }; updatedAt: string;
      reviewDecision: string; mergeStateStatus: string;
      statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }>;
    };
    const checks = value.statusCheckRollup ?? [];
    const pending = checks.some(check => (check.status && check.status !== "COMPLETED") ||
      ["PENDING", "EXPECTED"].includes(check.state ?? ""));
    const failed = checks.some(check => (check.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion)) || ["FAILURE", "ERROR"].includes(check.state ?? ""));
    // Readiness wakes the agent to assess policy; it never authorizes merging.
    return { fingerprint: digest(JSON.stringify(value)), merged: value.state === "MERGED",
      mergeSha: value.mergeCommit?.oid, closed: value.state === "CLOSED",
      headSha: sha(value.headRefOid) ? value.headRefOid : undefined,
      mergeState: ["CLEAN", "DIRTY", "BLOCKED", "BEHIND", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"].includes(value.mergeStateStatus) ? value.mergeStateStatus : "UNKNOWN",
      checks: pending ? "pending" : failed ? "fail" : "pass",
      ready: value.state === "OPEN" && !pending && !failed && value.mergeStateStatus === "CLEAN" && value.reviewDecision !== "CHANGES_REQUESTED" };
  }
  async deployment(job: Job): Promise<Deployment | undefined> {
    const command = job.config.deploymentProbe;
    if (!command?.length) throw new Error("Configure a read-only lifecycle.deploymentProbe");
    const value = await commandJSON(command, job.repoRoot, {
      WORKIT_JOB_ID: job.id, WORKIT_ISSUE_URL: job.issue.url, WORKIT_MERGE_SHA: job.mergeSha ?? "",
    }) as Partial<Deployment> & { ready?: boolean };
    if (value?.ready === false) return undefined;
    if (!value || value.ready !== true || !sha(value.sourceSha) ||
        typeof value.environment !== "string" || !value.environment.trim() || typeof value.target !== "string" || !value.target.trim() || typeof value.version !== "string" || !value.version.trim()) {
      throw new SourceProvenanceError("Deployment probe needs ready, environment, target, full sourceSha and version");
    }
    return { environment: value.environment, target: value.target, sourceSha: value.sourceSha, version: value.version };
  }
  async containsMerge(job: Job, sourceSha: string): Promise<boolean> {
    if (!sha(job.mergeSha) || !sha(sourceSha)) return false;
    const value = await commandJSON(["gh", "api", `repos/${job.githubRepo}/compare/${job.mergeSha}...${sourceSha}`], job.repoRoot) as { status?: string };
    return value.status === "identical" || value.status === "ahead";
  }
  async currentIssue(job: Job) {
    try {
      const resolved = resolveConfig(job.repoRoot, { remote: originRemote(job.repoRoot) });
      return await fetchIssue(job.issue.backend, job.issue.identifier, {
        ...resolved.config, repo: job.githubRepo, github: { ...resolved.config.github, repo: job.githubRepo },
      }, job.repoRoot);
    } catch { throw new Error("Current issue unavailable; repair tracker authentication or connectivity and retry"); }
  }
  async verifierPlan(job: Job): Promise<VerifierPlan> {
    try {
      const resolved = resolveConfig(job.repoRoot, { remote: originRemote(job.repoRoot) });
      const config = resolved.config.lifecycle?.verifier;
      const plan: VerifierPlan = { enabled: config?.enabled === true, concurrency: config?.concurrency ?? 1,
        maxAttempts: config?.maxAttempts ?? 2, timeoutSeconds: config?.timeoutSeconds ?? 300 };
      for (const [key, max] of [["concurrency", 16], ["maxAttempts", 10], ["timeoutSeconds", 3600]] as const) {
        if (!Number.isSafeInteger(plan[key]) || plan[key] < 1 || plan[key] > max) throw new Error("Invalid verifier bounds");
      }
      if (!plan.enabled) return plan;
      const agents = agentDefinitionsByTag(resolved.config, "review");
      if (!Object.keys(agents).length || (config?.agent && !agents[config.agent])) return plan;
      const selected = chooseAgent({ ...resolved.config, agents,
        default: resolved.config.default && agents[resolved.config.default] ? resolved.config.default : Object.keys(agents)[0] }, config?.agent);
      return { ...plan, agent: selected.name, command: selected.definition.command };
    } catch { throw new Error("Verifier configuration unavailable or invalid; repair trusted registry/configuration or submit an independent report manually"); }
  }
  async launchVerifier(job: Job, run: VerifierRun, plan: VerifierPlan): Promise<void> {
    launchIndependentVerifier(job, run, plan, this.banyanctl);
  }
}
