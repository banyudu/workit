import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchIssue } from "./issue.js";
import { resolveConfig } from "./config.js";
import { originRemote } from "./git.js";
import { digest, sha, workflowState, type Deployment, type Job, type LifecycleAdapter, type PRSnapshot, type Session } from "./lifecycle.js";

const exec = promisify(execFile);
export async function commandJSON(command: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, NO_COLOR: "1", CLICOLOR: "0" };
  delete env.CLICOLOR_FORCE; delete env.FORCE_COLOR; delete env.GH_FORCE_TTY;
  let stdout: string;
  try {
    ({ stdout } = await exec(command[0], command.slice(1), { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch { throw new Error(`${command[0]} failed or timed out; inspect its authentication and local logs`); }
  try { return JSON.parse(stdout); } catch { throw new Error(`${command[0]} did not return JSON`); }
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
    await commandJSON([this.banyanctl, "workflow", "set", "--id", job.sessionID, "--owner", "workit",
      "--job-id", job.id, "--revision", String(job.revision), "--state", workflowState(job.stage),
      "--detail", job.detail || job.stage], job.repoRoot);
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
  async currentIssue(job: Job) {
    const resolved = resolveConfig(job.repoRoot, { remote: originRemote(job.repoRoot) });
    return fetchIssue(job.issue.backend, job.issue.identifier, {
      ...resolved.config, repo: job.githubRepo, github: { ...resolved.config.github, repo: job.githubRepo },
    }, job.repoRoot);
  }
}
