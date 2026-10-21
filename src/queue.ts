import { BanyanGroupAdapter } from "./group.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { acceptance, digest, issueFinished, type JobStore, type LifecycleAdapter } from "./lifecycle.js";
import { workGroup } from "./overview.js";
import { QueueStore, type QueueItem, type WorkQueue } from "./queue-store.js";
import type { TrackerIssue } from "./issue.js";
import type { IssueDetails } from "./types.js";

export interface QueueManifest {
  coordinator?: { sessionID: string };
  instructions?: string;
  title: string; outcome: string; deadline: string;
  maxConcurrent: number; maxStarts: number; maxContinuations: number;
  items: Array<{ key: string; repo: string; issue: string; provider?: "github" | "linear"; dependsOn?: string[];
    agent?: string; delivery?: "implementation" | "investigation"; verification?: "local" | "deployed"; deploymentTarget?: string }>;
}
type ResolvedItem = { repo: string; issue: IssueDetails; delivery: QueueItem["delivery"]; verification: QueueItem["verification"]; deploymentTarget?: string; agent?: string };
const text = (value: unknown, max = 2000): value is string => typeof value === "string" && !!value.trim() && value.length <= max && !value.includes("\0");

export function assertQueueIssue(issue: TrackerIssue): void {
  if (issueFinished(issue) || /^(on hold|hold|paused|blocked|canceled|cancelled|duplicate)$/i.test(issue.state ?? "") ||
      issue.labels.some(label => /^(owner[- ]hold|on[- ]hold|hold|paused|blocked)$/i.test(label))) throw new Error("Queue issue is completed or held; inspect it explicitly");
  if (issue.backend === "github" && issue.state !== "OPEN") throw new Error("Queue needs an observed open GitHub issue");
  if (issue.backend === "linear" && (!issue.linear || issue.linear.archivedAt || issue.linear.snoozedUntilAt ||
      !["triage", "backlog", "unstarted", "started"].includes(issue.stateType ?? ""))) throw new Error("Queue needs current unheld Linear workflow metadata");
}

/** Resolve only explicit entries. Creation reads issue/config facts, never launches. */
export async function prepareQueue(value: unknown, resolveItem: (item: QueueManifest["items"][number]) => Promise<ResolvedItem>, command: string[], now = new Date()): Promise<WorkQueue> {
  const m = value as QueueManifest;
  if (!m || !text(m.title, 200) || !text(m.outcome) || !text(m.deadline) || !Number.isFinite(Date.parse(m.deadline)) || Date.parse(m.deadline) <= now.getTime()) throw new Error("Queue needs a title, outcome and future deadline");
  if (m.instructions !== undefined && !text(m.instructions, 8000)) throw new Error("Group instructions must be bounded non-empty text");
  if (m.coordinator && (!text(m.coordinator.sessionID, 128) || !/^[A-Za-z0-9_.-]+$/.test(m.coordinator.sessionID))) throw new Error("Coordinator requires an explicit Banyan session ID");
  for (const [key, max] of [["maxConcurrent", 16], ["maxStarts", 1000], ["maxContinuations", 10000]] as const) {
    if (!Number.isSafeInteger(m[key]) || m[key] < 1 || m[key] > max) throw new Error(`${key} must be a finite integer from 1 to ${max}`);
  }
  if (!Array.isArray(command) || !command.length || !command.every(arg => text(arg, 8192)) || !isAbsolute(command[0])) throw new Error("Queue requires a trusted absolute CLI invocation");
  if (!Array.isArray(m.items) || !m.items.length || m.items.length > 200) throw new Error("Queue requires 1–200 explicit issues");
  const keys = new Set<string>();
  for (const item of m.items) {
    if (!item || !text(item.key, 80) || !/^[a-zA-Z0-9_-]+$/.test(item.key) || keys.has(item.key) || !text(item.repo, 4096) || !isAbsolute(item.repo) || !text(item.issue, 100)) throw new Error("Each queue issue needs a unique key, absolute repository path and issue identifier");
    keys.add(item.key);
    if (item.provider && !["github", "linear"].includes(item.provider)) throw new Error("Unknown queue issue provider");
    if (item.delivery && !["implementation", "investigation"].includes(item.delivery)) throw new Error("Unknown queue delivery kind");
    if (item.verification && !["local", "deployed"].includes(item.verification)) throw new Error("Unknown queue verification mode");
    for (const name of [item.agent, item.deploymentTarget]) if (name !== undefined && !text(name, 200)) throw new Error("Invalid queue agent or deployment target");
    if (item.dependsOn && (!Array.isArray(item.dependsOn) || item.dependsOn.some(key => !text(key, 80)) || new Set(item.dependsOn).size !== item.dependsOn.length)) throw new Error("Invalid queue dependencies");
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key) || !keys.has(key)) throw new Error("Queue dependencies must be known and acyclic");
    visiting.add(key);
    for (const dep of m.items.find(item => item.key === key)!.dependsOn ?? []) visit(dep);
    visiting.delete(key); visited.add(key);
  };
  for (const key of keys) visit(key);
  const items: QueueItem[] = [];
  for (const item of m.items) {
    const resolved = await resolveItem(item);
    assertQueueIssue(resolved.issue);
    const jobID = digest(resolved.repo + "\n" + resolved.issue.url).slice(0, 24);
    if (items.some(item => item.jobID === jobID)) throw new Error("The same issue appears more than once in the queue");
    items.push({ key: item.key, repo: resolved.repo, issue: resolved.issue.identifier, provider: resolved.issue.backend,
      issueURL: resolved.issue.url, acHash: acceptance(resolved.issue.body).acHash, jobID,
      dependsOn: item.dependsOn ?? [], agent: resolved.agent, delivery: resolved.delivery, verification: resolved.verification,
      deploymentTarget: resolved.deploymentTarget, state: "pending" });
  }
  return { schema: 1, id: "queue-" + randomUUID(), revision: 0, title: m.title.trim(), outcome: m.outcome.trim(),
    state: "paused", instructions: m.instructions, coordinator: m.coordinator ? { sessionID: m.coordinator.sessionID } : undefined, createdAt: now.toISOString(), deadline: new Date(m.deadline).toISOString(), maxConcurrent: m.maxConcurrent,
    maxStarts: m.maxStarts, maxContinuations: m.maxContinuations, starts: 0, continuations: [], command, items };
}

export interface QueueLauncher { preflight?(queue: WorkQueue): Promise<void>; launch(queue: WorkQueue, item: QueueItem): Promise<void> }
export class CommandQueueLauncher implements QueueLauncher {
  constructor(private readonly stateDirectory: string) {}
  async preflight(queue: WorkQueue): Promise<void> { if (queue.coordinator) await new BanyanGroupAdapter().bind(queue); }
  async launch(queue: WorkQueue, item: QueueItem): Promise<void> {
    const args = [...queue.command.slice(1), "--managed", "--banyan", "--no-resolve", "--provider", item.provider,
      "--repo-path", item.repo, "--delivery", item.delivery, "--verification", item.verification];
    if (queue.coordinator) args.push("--no-parent-fallback");
    if (item.agent) args.push("--agent", item.agent);
    if (item.deploymentTarget) args.push("--deployment-target", item.deploymentTarget);
    args.push(item.issue);
    try {
      await promisify(execFile)(queue.command[0], args, { cwd: item.repo, timeout: 120_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, WORKIT_STATE_DIR: this.stateDirectory, WORKIT_QUEUE_ID: queue.id, WORKIT_QUEUE_LAUNCH_ID: item.launchID,
          // The heartbeat is not a live parent conversation.
          BANYAN_SESSION_ID: "", BANYAN_PARENT_SESSION_ID: queue.coordinator?.sessionID ?? "", TMUX: "", TMUX_PANE: "" } });
    } catch { throw new Error("Queue launch outcome is uncertain; inspect its durable reservation and original session"); }
  }
}

/** Existing heartbeat invokes this; reservations never replay after lost output. */
export async function advanceQueues(jobs: JobStore, adapter: LifecycleAdapter, launcher: QueueLauncher, now?: Date): Promise<Array<{ queueID: string; key: string; result: string }>> {
  const queues = new QueueStore(jobs), results: Array<{ queueID: string; key: string; result: string }> = [];
  const time = () => now ?? new Date();
  for (const queue of queues.list()) {
    // Only an observed idle original session can release a held job's slot.
    for (const item of queue.items.filter(item => item.state === "launched" && item.slot)) {
      const job = jobs.get(item.jobID);
      if (!["paused", "needs-you", "verified", "cancelled"].includes(job.stage)) continue;
      try {
        const session = await adapter.session(job);
        if (session?.status === "idle" && (!session.workflow || session.workflow.jobID === job.id && session.workflow.owner === "workit")) queues.release(queue.id, job.id, job.revision);
      } catch { /* Unknown liveness retains capacity conservatively. */ }
    }
    if (queue.coordinator && queue.state === "active") {
      try { await launcher.preflight?.(queue); }
      catch { results.push({ queueID: queue.id, key: "coordinator", result: "Original coordinator unavailable; no child was launched" }); continue; }
    }
    for (let count = 0; count < queue.items.length; count++) {
      const item = queues.reserve(queue.id, time());
      if (!item) break;
      try {
        await launcher.launch(queues.get(queue.id), item);
        // Success requires the child's persisted launch receipt, not exit zero.
        if (queues.get(queue.id).items.find(current => current.key === item.key)?.state !== "launched") throw new Error("Missing launch receipt");
        results.push({ queueID: queue.id, key: item.key, result: "launched" });
      } catch {
        queues.uncertain(queue.id, item.jobID, item.launchID!);
        const state = queues.get(queue.id).items.find(current => current.key === item.key)!.state;
        results.push({ queueID: queue.id, key: item.key, result: state === "launched" ? "launch-confirmed" : "uncertain" });
      }
    }
  }
  return results;
}

export function queueStatus(queue: WorkQueue, jobs: JobStore, now = new Date()) {
  const saved = new Map(jobs.list().map(job => [job.id, job]));
  const items = queue.items.map(item => {
    const job = saved.get(item.jobID);
    const status = ["reserved", "launching", "uncertain"].includes(item.state) ? "uncertain"
      : item.state === "abandoned" ? "abandoned" : job?.stage === "verified" ? "verified"
      : job && ["needs-you", "paused", "cancelled"].includes(workGroup(job)) ? "blocked"
      : job ? workGroup(job) === "waiting" ? "waiting" : "working"
      : item.dependsOn.some(key => saved.get(queue.items.find(i => i.key === key)!.jobID)?.stage !== "verified") ? "dependency-blocked" : "remaining";
    return { ...item, status, stage: job?.stage, detail: job?.detail, nextWakeAt: job?.nextWakeAt, coordinatorNotes: job?.coordinatorNotes };
  });
  return { ...queue, expired: Date.parse(queue.deadline) <= now.getTime(),
    budget: { startsRemaining: queue.maxStarts - queue.starts, continuationsRemaining: queue.maxContinuations - queue.continuations.length,
      slotsUsed: queue.items.filter(item => item.slot).length },
    summary: Object.fromEntries(["verified", "working", "waiting", "blocked", "uncertain", "dependency-blocked", "remaining", "abandoned"].map(status => [status, items.filter(item => item.status === status).length])), items };
}
