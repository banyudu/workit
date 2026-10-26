import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verificationSource } from "./verification-source.js";
import { selectDeploymentTarget } from "./deployment-target.js";
import { basename } from "node:path";
import { fetchIssue, fetchLinearCloseoutIssue, updateLinearCloseoutIssue, markLinearIssueDone, markLinearIssueInReview } from "./issue.js";
import { agentDefinitionsByTag, resolveConfig } from "./config.js";
import { chooseAgent } from "./agents.js";
import { launchIndependentVerifier } from "./launch.js";
import { originRemote } from "./git.js";
import { WorkflowRefusedError, SourceProvenanceError, digest, validateReport, sanitizedDetail, sha, workflowState, type Deployment, type Job, type LifecycleAdapter, type PRSnapshot, type Session, type VerifierPlan, type VerifierRun } from "./lifecycle.js";

const exec = promisify(execFile);
// Session inventories include retained history and can exceed 4 MiB even when
// Banyan is healthy. Keep a bounded allowance for large JSON responses.
const COMMAND_JSON_MAX_BUFFER = 32 * 1024 * 1024;
function workflowRefusal(value: unknown): WorkflowRefusedError | undefined {
  const response = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  const error = response?.error;
  if (response?.ok === false && (error?.code === "workflow_refused" || error?.code === "workflow_wake_refused") &&
      typeof error.message === "string" && error.message.trim()) {
    return new WorkflowRefusedError(error.message, error.code);
  }
}
export async function commandJSON(command: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, NO_COLOR: "1", CLICOLOR: "0" };
  delete env.CLICOLOR_FORCE; delete env.FORCE_COLOR; delete env.GH_FORCE_TTY;
  let stdout: string;
  try {
    ({ stdout } = await exec(command[0], command.slice(1), { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: COMMAND_JSON_MAX_BUFFER }));
  } catch (error) {
    const failure = error as { code?: string | number; killed?: boolean; signal?: string; stdout?: string; stderr?: string };
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(`${command[0]} JSON output exceeded the ${COMMAND_JSON_MAX_BUFFER / 1024 / 1024} MiB buffer limit`);
    }
    // Timeouts, signals, auth failures and HTTP 5xx override any refusal on stdout.
    if (["workflow", "coordination"].includes(command[1]) && typeof failure.code === "number" && !failure.killed && !failure.signal &&
        !/\bHTTP (?:401|403|5\d\d)\b/i.test(failure.stderr ?? "")) {
      let value: unknown;
      try { value = JSON.parse(failure.stdout ?? ""); } catch { /* genuine command failure */ }
      const refusal = workflowRefusal(value);
      if (refusal) throw refusal;
    }
    throw new Error(`${basename(command[0])} failed or timed out; inspect its authentication and local logs`);
  }
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`${basename(command[0])} did not return JSON`); }
  const refusal = ["workflow", "coordination"].includes(command[1]) ? workflowRefusal(value) : undefined;
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
    const value = await commandJSON([this.banyanctl, "session", "list", "--id", job.sessionID], job.repoRoot) as { sessions?: Session[] };
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
    try {
      await commandJSON([this.banyanctl, "workflow", "wake", "--id", job.sessionID,
        "--job-id", job.id, "--revision", String(job.revision), "--wake-id", wakeID, "--text", text], job.repoRoot);
    } catch (error) {
      if (!(error instanceof WorkflowRefusedError)) throw error;
      // A wake refusal can follow admission or a lost delivery acknowledgement.
      // Only a fresh, readable receipt from this exact workflow can settle intent.
      let delivery: "delivered" | "not-delivered" | "uncertain" = "uncertain";
      try {
        const value = await commandJSON([this.banyanctl, "session", "list", "--id", job.sessionID], job.repoRoot) as {
          workflowProtocol?: number; sessions?: Session[];
        };
        const matches = value.sessions?.filter(session => session.id === job.sessionID) ?? [];
        const session = matches.length === 1 ? matches[0] : undefined;
        const workflow = session?.workflow;
        if (value.workflowProtocol === 1 && session?.cwd === job.worktree && session.workflowRecoveryError == null &&
            workflow?.owner === "workit" && workflow.jobID === job.id && workflow.revision === job.revision &&
            workflow.state === workflowState(job.stage)) {
          const receipt = workflow.wake;
          if (receipt?.id === wakeID) {
            if (["delivered", "not-delivered"].includes(receipt.status)) delivery = receipt.status as typeof delivery;
          } else if (!receipt || (typeof receipt.id === "string" && receipt.id.trim() &&
              ["delivered", "not-delivered"].includes(receipt.status))) delivery = "not-delivered";
        }
      } catch { /* Unreadable evidence retains the intent and holds delivery. */ }
      throw new WorkflowRefusedError(error.reason, error.code, delivery);
    }
  }
  async reconcile(job: Job, outcome: string, detail: string): Promise<void> {
    if (!["paused", "needs-you"].includes(job.stage) || !job.wake ||
        !["delivered", "not-delivered"].includes(outcome) || !detail.trim()) {
      throw new WorkflowRefusedError("Recovery requires a held job, pending wake and inspected delivery outcome");
    }
    const value = await commandJSON([this.banyanctl, "session", "list", "--id", job.sessionID], job.repoRoot) as {
      workflowProtocol?: number; sessions?: Session[];
    };
    const matches = value.sessions?.filter(session => session.id === job.sessionID) ?? [];
    const session = matches.length === 1 ? matches[0] : undefined;
    const workflow = session?.workflow;
    if (value.workflowProtocol !== 1 || !session || session.cwd !== job.worktree ||
        session.workflowRecoveryError != null || workflow?.owner !== "workit" || workflow.jobID !== job.id ||
        workflow.revision !== job.revision || workflow.state !== workflowState(job.stage)) {
      throw new WorkflowRefusedError("Recovery requires the original session's readable, current held workflow");
    }
    if (workflow.wake?.id !== job.wake.id) {
      // Workit persists intent before calling Banyan. An inspected refusal before
      // admission has no native receipt to resolve. Preserve any older settled
      // receipt; the caller clears only Workit's intent with its revision guard.
      if (outcome === "not-delivered" && (!workflow.wake ||
          (typeof workflow.wake.id === "string" && workflow.wake.id.trim() &&
           ["delivered", "not-delivered"].includes(workflow.wake.status)))) return;
      throw new WorkflowRefusedError("A different unresolved native wake requires inspection; delivery cannot be inferred");
    }
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
  async observedSource(job: Pick<Job, "worktree">): Promise<string> {
    await exec("git", ["diff", "--quiet", "HEAD", "--"], { cwd: job.worktree, timeout: 10_000 });
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: job.worktree, timeout: 10_000 });
    if (!sha(stdout.trim())) throw new Error("Observed source must be a full commit SHA");
    return stdout.trim();
  }
  trustedTarget(job: Job, name: string) {
    return selectDeploymentTarget(resolveConfig(job.repoRoot, { remote: originRemote(job.repoRoot) }).config.lifecycle ?? {}, name);
  }
  async deployment(job: Job): Promise<Deployment | undefined> {
    const command = job.config.deploymentProbe;
    if (!command?.length) throw new Error("Configure a read-only lifecycle.deploymentProbe");
    const value = await commandJSON(command, job.repoRoot, {
      WORKIT_JOB_ID: job.id, WORKIT_ISSUE_URL: job.issue.url, WORKIT_MERGE_SHA: job.mergeSha ?? "", WORKIT_SOURCE_SHA: verificationSource(job) ?? "", WORKIT_DEPLOYMENT_TARGET: job.config.deploymentTarget ?? "",
    }) as Partial<Deployment> & { ready?: boolean };
    if (value?.ready === false) return undefined;
    if (!value || value.ready !== true || !sha(value.sourceSha) ||
        typeof value.environment !== "string" || !value.environment.trim() || typeof value.target !== "string" || !value.target.trim() || typeof value.version !== "string" || !value.version.trim()) {
      throw new SourceProvenanceError("Deployment probe needs ready, environment, target, full sourceSha and version");
    }
    if (job.config.deploymentBinding && (value.environment !== job.config.deploymentBinding.environment || value.target !== job.config.deploymentBinding.target)) throw new SourceProvenanceError("Deployment probe returned a different named target or environment");
    return { environment: value.environment, target: value.target, sourceSha: value.sourceSha, version: value.version };
  }
  async containsMerge(job: Job, sourceSha: string): Promise<boolean> {
    const source = verificationSource(job);
    if (!sha(source) || !sha(sourceSha)) return false;
    const value = await commandJSON(["gh", "api", `repos/${job.githubRepo}/compare/${source}...${sourceSha}`], job.repoRoot) as { status?: string };
    return value.status === "identical" || value.status === "ahead";
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
  async markInReview(job: Job): Promise<void> {
    if (job.issue.backend !== "linear") return;
    const resolved = resolveConfig(job.repoRoot, { remote: originRemote(job.repoRoot) });
    await markLinearIssueInReview(job.issue, resolved.config, job.repoRoot);
  }
  async markDone(job: Job): Promise<boolean> {
    if (job.issue.backend !== "linear") return true;
    if (job.stage !== "verified" || !job.verification) throw new Error("Tracker completion requires accepted verification");
    const issue = await this.currentIssue(job);
    if (issue.state?.toLowerCase() === "done") return true;
    // A later hold, cancellation or reopening is a human decision, not a retry.
    if (issue.state?.toLowerCase() !== "in review") return false;
    validateReport(job, job.verification, issue.body);
    const resolved = resolveConfig(job.repoRoot, { remote: originRemote(job.repoRoot) });
    await markLinearIssueDone(issue, resolved.config, job.repoRoot);
    const readback = await this.currentIssue(job);
    if (readback.state?.toLowerCase() !== "done") throw new Error("Linear did not confirm the Done transition");
    return true;
  }
  private issueConfig(job: Job) {
    const resolved = resolveConfig(job.repoRoot, { remote: originRemote(job.repoRoot) });
    return {
      ...resolved.config, repo: job.githubRepo, github: { ...resolved.config.github, repo: job.githubRepo },
    };
  }
  async currentIssue(job: Job) {
    const config = this.issueConfig(job);
    return job.issue.backend === "linear" ? fetchLinearCloseoutIssue(job.issue.identifier, config)
      : fetchIssue(job.issue.backend, job.issue.identifier, config, job.repoRoot);
  }
  async updateIssue(job: Job, id: string, input: { description?: string; stateId?: string }): Promise<void> {
    if (job.issue.backend !== "linear") throw new Error("Automatic tracker mutations apply only to Linear");
    await updateLinearCloseoutIssue(this.issueConfig(job), id, input);
  }
}
