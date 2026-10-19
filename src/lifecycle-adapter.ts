import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchIssue, fetchLinearCloseoutIssue, updateLinearCloseoutIssue, markLinearIssueDone, markLinearIssueInReview } from "./issue.js";
import { resolveConfig } from "./config.js";
import { originRemote } from "./git.js";
import { WorkflowRefusedError, digest, sha, validateReport, workflowState, type Deployment, type Job, type LifecycleAdapter, type PRSnapshot, type Session } from "./lifecycle.js";

const exec = promisify(execFile);
// Session inventories include retained history and can exceed 4 MiB even when
// Banyan is healthy. Keep a bounded allowance for large JSON responses.
const COMMAND_JSON_MAX_BUFFER = 32 * 1024 * 1024;
function workflowRefusal(value: unknown): WorkflowRefusedError | undefined {
  const response = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  if (response?.ok === false && response.error?.code === "workflow_refused" &&
      typeof response.error.message === "string" && response.error.message.trim()) {
    return new WorkflowRefusedError(response.error.message);
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
    // A timeout/signal or HTTP 5xx remains a failure even if stdout contains a refusal.
    if (command[1] === "workflow" && typeof failure.code === "number" && !failure.killed && !failure.signal &&
        !/\bHTTP 5\d\d\b/i.test(failure.stderr ?? "")) {
      let value: unknown;
      try { value = JSON.parse(failure.stdout ?? ""); } catch { /* genuine command failure */ }
      const refusal = workflowRefusal(value);
      if (refusal) throw refusal;
    }
    throw new Error(`${command[0]} failed or timed out; inspect its authentication and local logs`);
  }
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`${command[0]} did not return JSON`); }
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
    const value = await commandJSON([this.banyanctl, "session", "list", "--id", job.sessionID], job.repoRoot) as { sessions?: Session[] };
    const session = value.sessions?.find(item => item.id === job.sessionID);
    if (session?.cwd && session.cwd !== job.worktree) throw new Error("Banyan session worktree does not match its job");
    return session;
  }
  async project(job: Job): Promise<void> {
    await commandJSON([this.banyanctl, "workflow", "set", "--id", job.sessionID, "--owner", "workit",
      "--job-id", job.id, "--revision", String(job.revision), "--state", workflowState(job.stage),
      "--detail", job.detail || job.stage], job.repoRoot);
  }
  async wake(job: Job, wakeID: string, text: string): Promise<void> {
    await commandJSON([this.banyanctl, "workflow", "wake", "--id", job.sessionID,
      "--job-id", job.id, "--revision", String(job.revision), "--wake-id", wakeID, "--text", text], job.repoRoot);
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
    // Readiness wakes the agent to assess policy; it never authorizes merging.
    return { fingerprint: digest(JSON.stringify(value)), merged: value.state === "MERGED",
      mergeSha: value.mergeCommit?.oid, closed: value.state === "CLOSED",
      ready: !pending && value.mergeStateStatus === "CLEAN" && value.reviewDecision !== "CHANGES_REQUESTED" };
  }
  async deployment(job: Job): Promise<Deployment | undefined> {
    const command = job.config.deploymentProbe;
    if (!command?.length) throw new Error("Configure a read-only lifecycle.deploymentProbe");
    const value = await commandJSON(command, job.repoRoot, {
      WORKIT_JOB_ID: job.id, WORKIT_ISSUE_URL: job.issue.url, WORKIT_MERGE_SHA: job.mergeSha ?? "",
    }) as Partial<Deployment> & { ready?: boolean };
    if (value.ready === false) return undefined;
    if (value.ready !== true || !sha(value.sourceSha) ||
        !value.environment?.trim() || !value.target?.trim() || !value.version?.trim()) {
      throw new Error("Deployment probe needs ready, environment, target, full sourceSha and version");
    }
    return { environment: value.environment, target: value.target, sourceSha: value.sourceSha, version: value.version };
  }
  async containsMerge(job: Job, sourceSha: string): Promise<boolean> {
    if (!sha(job.mergeSha) || !sha(sourceSha)) return false;
    const value = await commandJSON(["gh", "api", `repos/${job.githubRepo}/compare/${job.mergeSha}...${sourceSha}`], job.repoRoot) as { status?: string };
    return value.status === "identical" || value.status === "ahead";
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
