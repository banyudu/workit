import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IssueDetails } from "./types.js";
import { coordinateVerification, refreshHeldFacts } from "./closeout.js";

export const stages = ["implementing", "preverifying", "reviewing", "waiting-ci", "waiting-deploy",
  "verifying", "fixing", "needs-you", "paused", "cancelled", "verified"] as const;
export type Stage = typeof stages[number];
export interface Deployment {
  environment: string; target: string; sourceSha: string; version: string;
}
export interface LifecycleConfig {
  enabled?: boolean;
  intervalSeconds?: number;
  maxWakeups?: number;
  maxErrors?: number;
  verification?: "deployed" | "local";
  /** Trusted, read-only argv; stdout: {ready, environment, target, sourceSha, version}. */
  deploymentProbe?: string[];
  /** Trusted grouping key. Attention views expose only its digest. */
  deploymentDependency?: string;
  verifier?: { enabled?: boolean; agent?: string; concurrency?: number; maxAttempts?: number; timeoutSeconds?: number };
}
export interface Blocker {
  reason: "owner-hold" | "acceptance-decision" | "external-wait" | "source-provenance" | "missing-verifier" | "runner-error" | "uncertain-delivery" | "tracker-closeout";
  owner: "owner" | "external" | "system" | "verifier";
  dependency?: string; observedAt: string; recheckTrigger: string; nextAction: string;
}
export interface VerifierRun {
  id: string; sessionID: string; agent: string; binding: string; reportPath: string; outcomePath: string;
  state: "reserved" | "running" | "uncertain" | "failed" | "report-ready" | "accepted" | "invalidated";
  reservedAt: string; startedAt?: string; timeoutSeconds: number;
  delivery?: "delivered" | "not-delivered"; recovery?: { reason: string; at: string };
}
export interface VerifierPlan { enabled: boolean; agent?: string; command?: string; concurrency: number; maxAttempts: number; timeoutSeconds: number }
export interface Job {
  schema: 1; id: string; revision: number; projectedRevision?: number;
  issue: IssueDetails; acHash: string; acLabels: string[];
  repoRoot: string; worktree: string; sessionID: string; githubRepo: string;
  agent: string; stage: Stage; detail: string; config: LifecycleConfig;
  controlCommand?: string[]; stateDirectory?: string;
  createdAt: string; updatedAt: string; nextWakeAt?: string;
  pr?: string; mergeSha?: string; deployment?: Deployment;
  fingerprint?: string; errors: number; wakeups: number;
  claim?: { token: string; process: string };
  // Older pending wakes already charged wakeups when they were reserved.
  wake?: { id: string; reason: string; revision: number; counted?: boolean; delivery?: "not-delivered" };
  verification?: VerificationReport;
  lastRecovery?: { wakeID: string; outcome: string; detail: string; at: string };
  acceptanceChangedAt?: string;
  acceptanceHistory?: Array<{ from: string; to: string; reason: string; at: string; revision: number; oldAcHash: string; acHash: string }>;
  holdDetail?: string;
  blocker?: Blocker;
  facts?: { pr?: PRSnapshot; observedAt: string; nextCheckAt: string; error?: string };
  verifier?: VerifierRun; verifierHistory?: VerifierRun[]; verifierAttempts?: number;
}
export interface VerificationReport {
  jobID: string; issueURL: string; acHash: string; mergeSha: string; checkedAt: string;
  reviewer: { runID: string; independent: boolean };
  deployment?: Deployment;
  criteria: Array<{ label: string; status: "pass" | "fail" | "blocked";
    evidence: Array<{ kind: string; reference: string; observed: string; deployment?: Deployment }> }>;
}

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const terminalStage = (stage: Stage): boolean => ["verified", "cancelled"].includes(stage);
export const runnableStage = (stage: Stage): boolean => !terminalStage(stage) && !["paused", "needs-you"].includes(stage);
export const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
export function dependencyIdentity(job: Job, kind: "deployment" | "provenance"): string | undefined {
  const key = job.config.deploymentDependency;
  return typeof key === "string" && key.trim() ? digest(kind + "\n" + key).slice(0, 20) : undefined;
}
export function sanitizedDetail(value: string): string {
  return value.replace(/https?:\/\/[^\s]+/gi, "[URL]")
    .replace(/(?:bearer\s+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "[credential]")
    .replace(/(?:\/[\w.@~%-]+){2,}/g, "[path]")
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600);
}

export function acceptanceCriteria(body: string): string[] {
  const section = body.split(/^##\s+Acceptance Criteria\s*$/im)[1]?.split(/^##\s+/m)[0] ?? "";
  const criteria: string[] = [];
  let current: string[] | undefined;
  let indentation = 0;
  const finish = () => {
    if (current) criteria.push(current.join("\n").trim());
    current = undefined;
  };
  for (const line of section.split(/\r?\n/)) {
    const checkbox = line.match(/^([ \t]*)-\s+\[[ xX]\]\s+(.+)$/);
    if (checkbox) {
      finish(); current = [checkbox[2]]; indentation = checkbox[1].length;
    } else if (current) {
      // Markdown list items may contain multiple paragraphs. Keep all indented
      // requirements in both the scope check and AC binding across blank lines.
      if (!line.trim()) current.push("");
      else if (line.match(/^[ \t]*/)![0].length > indentation) current.push(line);
      else finish();
    }
  }
  finish();
  return criteria;
}
export function acceptance(body: string): { acHash: string; acLabels: string[] } {
  const lines = acceptanceCriteria(body);
  if (lines.length < 2) throw new Error("Managed issues need at least two Acceptance Criteria checkboxes");
  const acLabels = lines.map(line => line.match(/\[(?:test|code|ci|query|deploy|mobile|human):([a-z0-9-]+)\]/)?.[1] ?? "ac-" + digest(line).slice(0, 12));
  if (new Set(acLabels).size !== acLabels.length) throw new Error("Acceptance Criteria labels must be unique");
  return { acHash: digest(lines.join("\n")), acLabels };
}

function localContractDescription(criterion: string): boolean {
  const description = criterion.replace(/`?\[(?:test|code):[a-z0-9-]+\]`?/g, "").trim();
  return /^(?:tests? (?:cover|reject|reconcile|group|establish|enforce|preserve)|a fixture\b|documentation (?:describes|documents|explains|lists)|document\b|describe\b)/i.test(description);
}
export function requiresDeployed(criterion: string): boolean {
  if (/\[deploy(?::|\])/i.test(criterion)) return true;
  // A fixture/documentation contract can describe deployed behavior without
  // requiring runtime execution. Direct runtime instructions still take priority.
  const directRuntime = /\b(?:run|runs|execute|executed|exercise|verify|verified|probe)\b[^.\n]{0,80}\b(?:deployed|production|staging|live runtime)\b/i.test(criterion);
  const runtimeObligation = /\b(?:deployed|production|staging|serving[ -](?:version|bound|source|runtime))\b[^.\n]{0,100}\b(?:must|shall|required|passes?|succeeds?|completes?)\b|\b(?:must|shall|required)\b[^.\n]{0,100}\b(?:deployed|production|staging|serving)\b/i.test(criterion);
  if (localContractDescription(criterion) && !directRuntime && !runtimeObligation) return false;
  return /\[deploy(?::|\])|\bdeployed\b|\bserving[ -](?:version|source|bound|runtime)\b|\b(?:production|staging|live runtime)\b|\b(?:dev|development|remote|live) (?:environment|runtime|service|deployment)\b|\bjourney\b[^.\n]*\b(?:environment|deployment|runtime)\b/i.test(criterion);
}
export function requiresHuman(criterion: string): boolean {
  if (/\[human(?::|\])/i.test(criterion)) return true;
  if (localContractDescription(criterion) && !/\b(?:obtain|requires?|required|record|recorded|must|shall)\b[^.\n]{0,80}\b(?:human|owner|user) (?:acceptance|approval)\b|\b(?:human|owner|user) (?:acceptance|approval)\b[^.\n]{0,80}\b(?:must|shall|required)\b|\b(?:owner|human|operator|user) (?:approves|accepts|signs off)\b/i.test(criterion)) return false;
  return /\[human(?::|\])|\b(?:human|manual|user) acceptance\b|\b(?:owner|human|operator|user) (?:approval|acceptance|approves|accepts|sign.off)\b/i.test(criterion);
}
export function assertLocalAcceptance(body: string): void {
  acceptance(body);
  if (acceptanceCriteria(body).some(line => requiresDeployed(line) || requiresHuman(line))) {
    throw new Error("Local acceptance cannot bypass a current deployed or human AC; preserve its scope");
  }
}

export function workflowState(stage: Stage): string {
  if (stage.startsWith("waiting-")) return "waiting";
  if (["needs-you", "paused", "cancelled", "verified"].includes(stage)) return stage;
  return "working";
}

export function createJob(input: {
  issue: IssueDetails; repoRoot: string; worktree: string; githubRepo: string; agent: string;
  config?: LifecycleConfig; now?: Date;
  acceptance?: "local" | "deployed";
}): Job {
  const now = (input.now ?? new Date()).toISOString();
  const id = digest(input.repoRoot + "\n" + input.issue.url).slice(0, 24);
  const config = { verification: "deployed" as const, intervalSeconds: 60, maxWakeups: 40, maxErrors: 5, ...input.config,
    ...(input.acceptance ? { verification: input.acceptance } : {}) };
  for (const key of ["intervalSeconds", "maxWakeups", "maxErrors"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key]! < 1) throw new Error(`lifecycle.${key} must be a positive integer`);
  }
  if (!["deployed", "local"].includes(config.verification)) throw new Error("Invalid lifecycle.verification");
  if (config.verification === "local") assertLocalAcceptance(input.issue.body);
  if (config.deploymentProbe && (!Array.isArray(config.deploymentProbe) || !config.deploymentProbe.length ||
      config.deploymentProbe.some(arg => typeof arg !== "string" || !arg || arg.includes("\0")))) {
    throw new Error("lifecycle.deploymentProbe must be non-empty argv");
  }
  if (config.verification === "deployed" && !config.deploymentProbe) {
    throw new Error("Managed deployed verification requires a read-only lifecycle.deploymentProbe before launch");
  }
  return { schema: 1, id, revision: 0, issue: input.issue, ...acceptance(input.issue.body),
    repoRoot: input.repoRoot, worktree: input.worktree, githubRepo: input.githubRepo,
    sessionID: "workit-" + id, agent: input.agent, stage: "implementing", detail: "",
    config, createdAt: now, updatedAt: now,
    nextWakeAt: new Date(Date.parse(now) + config.intervalSeconds * 1000).toISOString(), errors: 0, wakeups: 0 };
}

// Python's standard-library SQLite keeps Node 20 support, avoids a native npm
// addon, and gives atomic compare-and-swap plus OS-managed crash recovery.
const SQLITE = String.raw`
import json, sqlite3, sys
db, op = sys.argv[1:3]
request = json.load(sys.stdin)
with sqlite3.connect(db, timeout=10) as connection:
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)")
    if op == "list":
        print(json.dumps([json.loads(row[0]) for row in connection.execute("SELECT data FROM jobs ORDER BY id")]))
    elif op == "get":
        row = connection.execute("SELECT data FROM jobs WHERE id=?", (request["id"],)).fetchone()
        print(row[0] if row else "null")
    elif op == "insert":
        job = request["job"]
        connection.execute("INSERT INTO jobs VALUES (?, ?, ?)", (job["id"], job["revision"], json.dumps(job)))
        print("true")
    elif op == "cas":
        job = request["job"]
        cursor = connection.execute("UPDATE jobs SET revision=?,data=? WHERE id=? AND revision=?",
            (job["revision"], json.dumps(job), job["id"], request["expected"]))
        print("true" if cursor.rowcount == 1 else "false")
    elif op == "reserve-verifier":
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT data FROM jobs WHERE id=?", (request["job"]["id"],)).fetchone()
        current = json.loads(row[0]) if row else None
        active = sum(1 for row in connection.execute("SELECT data FROM jobs")
            if json.loads(row[0]).get("verifier", {}).get("state") in ["reserved", "running", "uncertain", "invalidated"])
        job = request["job"]
        if current and current["revision"] == request["expected"] and active < request["limit"]:
            connection.execute("UPDATE jobs SET revision=?,data=? WHERE id=? AND revision=?",
                (job["revision"], json.dumps(job), job["id"], request["expected"]))
            print("true")
        else:
            print("false")
`;

export class JobStore {
  private static python?: string;
  readonly path: string;
  constructor(directory = process.env.WORKIT_STATE_DIR ?? join(homedir(), ".local", "state", "workit")) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, "lifecycle.sqlite");
    closeSync(openSync(this.path, "a", 0o600));
  }
  private call<T>(operation: string, input: unknown): T {
    let output: string;
    try {
      JobStore.python ??= execFileSync("python3", ["-c", "import sys; print(sys.executable)"],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      output = execFileSync(JobStore.python, ["-c", SQLITE, this.path, operation],
      { input: JSON.stringify(input), encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { throw new Error("Workit lifecycle storage failed; python3 with sqlite3 and a writable state directory are required"); }
    chmodSync(this.path, 0o600);
    return JSON.parse(output) as T;
  }
  list(): Job[] { return this.call("list", {}); }
  get(id: string): Job { const job = this.call<Job | null>("get", { id }); if (!job) throw new Error(`Unknown job '${id}'`); return job; }
  insert(job: Job): void { this.call("insert", { job }); }
  reserveVerifier(expected: Job, run: VerifierRun, concurrency: number, maxAttempts: number, now: Date): Job | undefined {
    if (!runnableStage(expected.stage) || expected.stage !== "verifying" || expected.wake ||
        (expected.verifier && expected.verifier.state !== "failed") || (expected.verifierAttempts ?? 0) >= maxAttempts) return undefined;
    const job = structuredClone(expected);
    if (job.verifier) (job.verifierHistory ??= []).push(job.verifier);
    job.verifier = run; job.verifierAttempts = (job.verifierAttempts ?? 0) + 1;
    job.revision++; job.updatedAt = now.toISOString();
    return this.call<boolean>("reserve-verifier", { job, expected: expected.revision, limit: concurrency }) ? job : undefined;
  }
  acknowledgeProjection(job: Job): boolean {
    return this.call("cas", { expected: job.revision, job: { ...job, projectedRevision: job.revision } });
  }
  update(id: string, change: (job: Job) => void, now = new Date()): Job {
    for (let attempt = 0; attempt < 10; attempt++) {
      const job = this.get(id);
      const expected = job.revision;
      change(job);
      job.revision++;
      job.updatedAt = now.toISOString();
      if (this.call<boolean>("cas", { expected, job })) return job;
    }
    throw new Error("Concurrent lifecycle updates; retry");
  }
}

export function processIdentity(pid = process.pid): string {
  const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000 }).trim();
  if (!started) throw new Error("Cannot determine heartbeat process identity");
  return pid + ":" + started;
}
export function processIsAlive(identity: string): boolean {
  const pid = Number(identity.split(":")[0]);
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  try { return processIdentity(pid) === identity; } catch { return true; }
}

export function checkpoint(store: JobStore, id: string, patch: {
  stage: Stage; detail: string; after?: number; pr?: string; mergeSha?: string;
  expectedRevision?: number; expectedSessionID?: string;
}, now = new Date()): Job {
  if (!stages.includes(patch.stage)) throw new Error("Unknown lifecycle stage");
  if (patch.stage === "verified") throw new Error("Use job verify with a verification report");
  if (patch.after !== undefined && (!Number.isSafeInteger(patch.after) || patch.after < 1)) throw new Error("--after must be positive seconds");
  if (patch.mergeSha !== undefined && !sha(patch.mergeSha)) throw new Error("--merge-sha must be a full commit SHA");
  if (patch.expectedRevision !== undefined && (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0)) throw new Error("--expected-revision must be a non-negative integer");
  if (patch.expectedSessionID !== undefined && !patch.expectedSessionID.trim()) throw new Error("--expected-session-id must be non-empty");
  return store.update(id, job => {
    if (patch.expectedRevision !== undefined && job.revision !== patch.expectedRevision) throw new Error("Job revision mismatch; reread before pausing");
    if (patch.expectedSessionID !== undefined && job.sessionID !== patch.expectedSessionID) throw new Error("Job session binding mismatch; reread before pausing");
    if (terminalStage(job.stage)) throw new Error("Finished jobs cannot be restarted or rewritten");
    if (["paused", "needs-you"].includes(job.stage) && !["paused", "needs-you", "cancelled"].includes(patch.stage)) {
      throw new Error("Use job resume to release a pause or human gate");
    }
    if (patch.pr !== undefined) {
      const match = patch.pr.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/);
      if (!match || match[1].toLowerCase() !== job.githubRepo.toLowerCase()) throw new Error("PR must belong to this job's repository");
      if (job.pr && patch.pr !== job.pr) {
        delete job.mergeSha; delete job.deployment; delete job.verification; delete job.facts;
      }
      job.pr = patch.pr;
    }
    if (patch.mergeSha !== undefined) {
      if (patch.mergeSha !== job.mergeSha) { delete job.deployment; delete job.verification; }
      job.mergeSha = patch.mergeSha;
    }
    if (patch.stage === "waiting-ci" && !job.pr) throw new Error("waiting-ci requires a PR");
    if (["waiting-deploy", "verifying"].includes(patch.stage) && (!job.pr || !job.mergeSha)) throw new Error("Post-merge stages require PR and merge SHA");
    if (patch.stage === "waiting-deploy" && !job.config.deploymentProbe) throw new Error("Configure lifecycle.deploymentProbe before waiting for deployment");
    if (patch.stage === "verifying" && job.config.verification !== "local" && !job.deployment) throw new Error("Establish the deployed version through waiting-deploy before verifying");
    job.stage = patch.stage; job.detail = patch.detail; job.errors = 0;
    delete job.blocker;
    if (["paused", "needs-you"].includes(job.stage)) job.holdDetail = patch.detail;
    delete job.fingerprint; delete job.claim;
    // A hold must retain pending delivery evidence for inspected recovery.
    if (runnableStage(job.stage)) delete job.wake;
    if (runnableStage(job.stage)) job.nextWakeAt = new Date(now.getTime() + (patch.after ?? job.config.intervalSeconds ?? 60) * 1000).toISOString();
    else delete job.nextWakeAt;
  }, now);
}

export function validateReport(job: Job, value: unknown, currentBody: string, now = new Date()): VerificationReport {
  const report = value as VerificationReport;
  if (!report || report.jobID !== job.id || report.issueURL !== job.issue.url ||
      report.acHash !== job.acHash || acceptance(currentBody).acHash !== job.acHash) throw new Error("Verification issue/AC binding is stale or mismatched");
  if (!sha(job.mergeSha) || report.mergeSha !== job.mergeSha || report.reviewer?.independent !== true || !report.reviewer.runID?.trim() ||
      [job.id, job.sessionID].includes(report.reviewer.runID)) {
    throw new Error("Verification needs the merged source and an independent reviewer run");
  }
  const checked = Date.parse(report.checkedAt);
  if (!Number.isFinite(checked) || checked < Date.parse(job.acceptanceChangedAt ?? job.createdAt) || checked > now.getTime() + 60_000) throw new Error("Invalid verification time");
  if (!Array.isArray(report.criteria) || report.criteria.length !== job.acLabels.length ||
      new Set(report.criteria.map(item => item.label)).size !== job.acLabels.length) throw new Error("Verification must cover every AC exactly once");
  for (const label of job.acLabels) {
    const item = report.criteria.find(item => item.label === label);
    if (!item || item.status !== "pass" || !Array.isArray(item.evidence) || !item.evidence.length ||
        item.evidence.some(entry => !entry.kind?.trim() || !entry.reference?.trim() || !entry.observed?.trim())) {
      throw new Error(`AC '${label}' lacks passing evidence`);
    }
  }
  if (job.config.verification === "local") assertLocalAcceptance(currentBody);
  if (job.config.verification !== "local") {
    const matches = (value?: Deployment) => value && job.deployment &&
      ["environment", "target", "sourceSha", "version"].every(key => value[key as keyof Deployment] === job.deployment![key as keyof Deployment]);
    if (!matches(report.deployment) || !report.criteria.some(item => item.evidence.some(entry => entry.kind === "journey" && matches(entry.deployment)))) {
      throw new Error("Verification needs journey evidence for the observed deployment");
    }
    acceptanceCriteria(currentBody).forEach((criterion, index) => {
      if (requiresDeployed(criterion) && !report.criteria.find(item => item.label === job.acLabels[index])?.evidence.some(entry => entry.kind === "journey" && matches(entry.deployment))) {
        throw new Error("Every deployed AC needs its own serving-bound journey evidence");
      }
    });
  }
  acceptanceCriteria(currentBody).forEach((criterion, index) => {
    if (requiresHuman(criterion) && !report.criteria.find(item => item.label === job.acLabels[index])?.evidence.some(entry => entry.kind === "human")) throw new Error("Human AC requires explicit human acceptance evidence");
  });
  return report;
}

export function issueFinished(issue: IssueDetails): boolean {
  return issue.backend === "github" ? issue.state === "CLOSED"
    : issue.stateType === "completed" || ["done", "completed"].includes(issue.state?.toLowerCase() ?? "");
}

export interface Session {
  id: string; cwd?: string; status: string; isSuspended?: boolean; isFrozen?: boolean; isDeepSuspended?: boolean;
  isDeepResuming?: boolean; agentLaunchCancelled?: boolean; workflowRecoveryError?: string;
  needsRecovery?: boolean;
  workflow?: { owner: string; jobID: string; revision: number; state: string; wake?: { id: string; status: string } };
}
export interface PRSnapshot { fingerprint: string; merged: boolean; mergeSha?: string; ready: boolean; closed?: boolean; headSha?: string; mergeState?: string; checks?: "pending" | "pass" | "fail" }
export class WorkflowRefusedError extends Error {
  readonly code = "workflow_refused";
  override name = "WorkflowRefusedError";
}
export class SourceProvenanceError extends Error {}
export interface LifecycleAdapter {
  session(job: Job): Promise<Session | undefined>;
  project(job: Job): Promise<void>;
  wake(job: Job, wakeID: string, text: string): Promise<void>;
  pr(job: Job): Promise<PRSnapshot>;
  deployment(job: Job): Promise<Deployment | undefined>;
  containsMerge(job: Job, sourceSha: string): Promise<boolean>;
  currentIssue?(job: Job): Promise<IssueDetails>;
  verifierPlan?(job: Job): Promise<VerifierPlan>;
  launchVerifier?(job: Job, run: VerifierRun, plan: VerifierPlan): Promise<void>;
}

function available(session: Session): boolean {
  return !session.isSuspended && !session.isFrozen && !session.isDeepSuspended && !session.isDeepResuming &&
    !session.agentLaunchCancelled && !session.workflowRecoveryError &&
    (["idle", "review", "completed", "failed"].includes(session.status) ||
      (session.needsRecovery && !["asking", "need-input"].includes(session.status)) ||
      (["need-input", "closed"].includes(session.status) && ["working", "waiting"].includes(session.workflow?.state ?? "")));
}
export function controlCommand(job: Job): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const prefix = job.stateDirectory ? "env WORKIT_STATE_DIR=" + quote(job.stateDirectory) + " " : "";
  return prefix + (job.controlCommand ?? ["workit"]).map(quote).join(" ");
}
function prompt(job: Job, reason: string): string {
  return [
    `Continue managed workit job ${job.id} for ${job.issue.url}. Reason: ${reason}.`,
    `Stage: ${job.stage}. Checkpoint: ${job.detail || "(none)"}.`,
    job.pr ? `PR: ${job.pr}. Expected merge SHA: ${job.mergeSha ?? "not yet established"}.` : "",
    job.deployment ? `Observed deployment: ${JSON.stringify(job.deployment)}.` : "",
    "Re-read the issue, repository instructions, PR and durable job state before acting. Reconcile completed external effects before retrying.",
    `Acceptance profile: ${job.config.verification}. Apply its current AC scope; local acceptance does not require deployed journeys.`,
    "Own implementation, preverification, review repair, merge when authorized, deployed acceptance and any follow-up fix. Do not stop at merge.",
    "Deployment authorization and human holds remain in force. Never deploy merely because this heartbeat resumed you.",
    `CLI for this job: ${controlCommand(job)}. Persist your next stage with this CLI's job checkpoint ${job.id}; use needs-you for a human gate and waiting-ci/waiting-deploy for external waits.`,
    job.config.verification === "local"
      ? "Verification requires independent complete local AC evidence and merged source. Use workit job verify --report; process exit is not completion."
      : "Verification requires independent AC evidence, the actual serving version, and applicable journeys. Use workit job verify --report; process exit is not completion.",
  ].filter(Boolean).join("\n");
}

/** A heartbeat inspects due jobs; only actionable changes spend an agent turn. */
export async function tick(store: JobStore, adapter: LifecycleAdapter, options: {
  now?: Date; process?: string; alive?: (identity: string) => boolean; jobID?: string;
} = {}): Promise<Array<{ id: string; result: string; detail?: string }>> {
  const now = options.now ?? new Date();
  const owner = options.process ?? processIdentity();
  const alive = options.alive ?? processIsAlive;
  const results: Array<{ id: string; result: string; detail?: string }> = [];
  for (const candidate of store.list()) {
    if (options.jobID && candidate.id !== options.jobID) continue;
    // Project pause/cancel/completion too; it must survive an app outage.
    if (terminalStage(candidate.stage) || candidate.stage === "paused" || candidate.stage === "needs-you") {
      const held = terminalStage(candidate.stage) ? candidate : await refreshHeldFacts(store, adapter, candidate, now);
      if (held.projectedRevision !== held.revision) {
        try { await adapter.project(held); store.acknowledgeProjection(held); } catch { /* durable job remains authoritative */ }
      }
      continue;
    }
    if (candidate.nextWakeAt && Date.parse(candidate.nextWakeAt) > now.getTime()) continue;
    if (candidate.claim && alive(candidate.claim.process)) continue;
    const token = randomUUID();
    let job: Job;
    try {
      job = store.update(candidate.id, current => {
        if (current.revision !== candidate.revision || !runnableStage(current.stage) ||
            (current.claim && alive(current.claim.process))) throw new Error("already claimed");
        current.claim = { token, process: owner };
      }, now);
    } catch { continue; }
    const save = (change: (current: Job) => void) => {
      job = store.update(job.id, current => {
        if (current.claim?.token !== token) throw new Error("job changed while checking");
        change(current);
      }, now);
    };
    try {
      const session = await adapter.session(job);
      if (!session) throw new Error("Banyan session is missing; recover it before continuing");
      if (session.workflow && (session.workflow.jobID !== job.id || session.workflow.owner !== "workit")) throw new Error("Banyan workflow has a different owner");
      if (session.workflow && ["paused", "cancelled", "needs-you"].includes(session.workflow.state)) {
        save(current => { current.stage = session.workflow!.state as Stage; delete current.nextWakeAt; });
        results.push({ id: job.id, result: job.stage }); continue;
      }
      if (!available(session)) {
        save(current => { current.nextWakeAt = new Date(now.getTime() + (job.config.intervalSeconds ?? 60) * 1000).toISOString(); });
        results.push({ id: job.id, result: "busy-or-held" }); continue;
      }
      let reason = "agent is idle with unfinished issue work";
      let actionable = true;
      if (job.wake) {
        const receipt = session.workflow?.wake;
        if (receipt?.id === job.wake.id && receipt.status === "delivered") {
          save(current => {
            if (current.wake?.counted === false) current.wakeups++;
            delete current.wake; delete current.blocker; current.errors = 0;
          });
          results.push({ id: job.id, result: "wake-reconciled" }); continue;
        }
        if (receipt?.id === job.wake.id && receipt.status !== "not-delivered") {
          throw new Error("Previous wake delivery is uncertain; inspect the conversation");
        }
        // Retry exactly the persisted wake ID. Banyan deduplicates delivery.
        reason = job.wake.reason;
      } else if (job.stage === "waiting-ci") {
        const pr = await adapter.pr(job);
        save(current => { current.facts = { pr, observedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + (job.config.intervalSeconds ?? 60) * 1000).toISOString() }; });
        if (pr.closed && !pr.merged) throw new Error("PR was closed without merging");
        if (pr.merged) {
          if (!sha(pr.mergeSha)) throw new Error("Merged PR has no exact merge SHA");
          save(current => { current.mergeSha = pr.mergeSha; current.stage = current.config.verification === "local" ? "verifying" : "waiting-deploy"; });
          reason = "PR merged; continue post-merge verification";
        } else {
          actionable = pr.ready || (job.fingerprint !== undefined && job.fingerprint !== pr.fingerprint);
          save(current => { current.fingerprint = pr.fingerprint; });
          reason = "PR checks or reviews changed";
        }
      } else if (job.stage === "waiting-deploy") {
        const pr = await adapter.pr(job);
        if (!pr.merged || pr.mergeSha !== job.mergeSha) throw new Error("Expected merge is not established by GitHub");
        const deployment = await adapter.deployment(job);
        actionable = deployment !== undefined;
        if (deployment) {
          if (!sha(deployment.sourceSha) || !await adapter.containsMerge(job, deployment.sourceSha)) throw new Error("Deployment source does not contain the merged change");
          save(current => { current.deployment = deployment; current.stage = "verifying"; });
          reason = "deployment containing the merged change is ready; run applicable journeys";
        }
      }
      if (job.stage === "verifying" && !job.wake && adapter.verifierPlan) {
        const coordinated = await coordinateVerification(store, adapter, job, now, candidate.stage !== "verifying");
        job = store.get(job.id);
        if (coordinated) { results.push({ id: job.id, result: coordinated }); continue; }
      }
      if (!actionable) {
        save(current => { current.errors = 0; delete current.blocker; current.nextWakeAt = new Date(now.getTime() + (job.config.intervalSeconds ?? 60) * 1000).toISOString(); });
        results.push({ id: job.id, result: "unchanged" }); continue;
      }
      if (!job.wake && job.wakeups >= (job.config.maxWakeups ?? 40)) throw new Error("Automatic wakeup budget exhausted; inspect before resuming");
      if (!job.wake) save(current => { current.wake = { id: randomUUID(), reason, revision: current.revision + 1, counted: false }; });
      await adapter.project(job);
      await adapter.wake(job, job.wake!.id, prompt(job, reason));
      save(current => {
        if (current.wake?.counted === false) current.wakeups++;
        delete current.wake; delete current.blocker; current.errors = 0;
        current.nextWakeAt = new Date(now.getTime() + (job.config.intervalSeconds ?? 60) * 1000).toISOString();
      });
      results.push({ id: job.id, result: "woken" });
    } catch (error) {
      try {
        save(current => {
          current.detail = sanitizedDetail(error instanceof Error ? error.message : "Heartbeat failed");
          current.blocker = { reason: error instanceof SourceProvenanceError ? "source-provenance" : /uncertain/.test(current.detail) ? "uncertain-delivery" : "runner-error",
            owner: error instanceof SourceProvenanceError ? "external" : /uncertain/.test(current.detail) ? "owner" : "system",
            dependency: error instanceof SourceProvenanceError ? dependencyIdentity(current, "provenance") : undefined,
            observedAt: now.toISOString(), recheckTrigger: error instanceof SourceProvenanceError ? "serving-provenance-repaired" : "tool-repaired-or-inspected-recovery",
            nextAction: error instanceof SourceProvenanceError ? "Repair the runtime's actual serving source/version probe; health alone cannot establish acceptance" : "Inspect tool authentication, local logs and delivery receipts before retrying" };
          if (error instanceof WorkflowRefusedError) {
            if (current.wake) current.wake.delivery = "not-delivered";
            current.nextWakeAt = new Date(now.getTime() + (current.config.intervalSeconds ?? 60) * 1000).toISOString();
            return;
          }
          current.errors++;
          if (current.errors >= (current.config.maxErrors ?? 5) || /uncertain|budget exhausted/.test(current.detail)) {
            current.stage = "needs-you"; delete current.nextWakeAt;
          } else current.nextWakeAt = new Date(now.getTime() + Math.min(900, 60 * 2 ** (current.errors - 1)) * 1000).toISOString();
        });
        results.push(error instanceof WorkflowRefusedError
          ? { id: job.id, result: "workflow-refused", detail: job.detail }
          : { id: job.id, result: job.stage === "needs-you" ? "needs-you" : "retry" });
      } catch { results.push({ id: candidate.id, result: "checkpoint-changed" }); }
    } finally {
      try {
        const latest = store.get(job.id);
        if (latest.claim?.token === token) save(current => { delete current.claim; });
        else job = latest;
        await adapter.project(job); store.acknowledgeProjection(job);
      } catch { /* next tick reconciles projection */ }
    }
  }
  return results;
}
