import { jobBlockers } from "./closeout.js";
import { sanitizedDetail, type Job } from "./lifecycle.js";

export type WorkGroup = "working" | "waiting" | "needs-you" | "paused" | "verified" | "cancelled";
export function workGroup(job: Job): WorkGroup {
  if (["needs-you", "paused", "verified", "cancelled"].includes(job.stage)) return job.stage as WorkGroup;
  if (jobBlockers(job).some(item => item.owner === "owner")) return "needs-you";
  if (job.stage.startsWith("waiting-") || job.verifier?.state === "running" || (job.verifier?.state === "report-ready" && !job.verifier.handoff && job.stage === "verifying")) return "waiting";
  return "working";
}
function webLink(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = ""; url.hash = "";
    return url.href.length <= 2048 ? url.href : undefined;
  } catch { return undefined; }
}

/** Presentation only: never infer permission to release a hold or replay a wake. */
export function displayStatus(job: Job) {
  const blockers = jobBlockers(job);
  const status = (kind: string, label: string, nextAction?: string) => ({ kind, label,
    nextAction: sanitizedDetail(nextAction ?? blockers[0]?.nextAction ?? "Continue from the saved checkpoint") });
  if (job.stage === "verified") return status("verified", "Verified", "Acceptance verified");
  if (job.stage === "cancelled") return status("cancelled", "Cancelled", "Cancelled");
  if (job.stage === "paused") return status("paused", "Paused", "Review why this work was paused before explicitly resuming it");
  const held = job.stage === "needs-you";
  // Explicit structured decisions take priority over historical runner errors.
  if (job.blocker?.owner === "owner" && job.blocker.reason === "acceptance-decision")
    return status("decision", "Decision needed", job.blocker.nextAction);
  if (job.blocker?.reason === "source-provenance") return status("blocked", "Source unavailable", job.blocker.nextAction);
  if (job.blocker?.reason === "queue-bound") return status("blocked", "Queue held", job.blocker.nextAction);
  const legacyToolFailure = !job.blocker && job.errors > 0 && /failed or timed out|^Heartbeat failed/.test(job.holdDetail ?? job.detail);
  if (held && (job.blocker?.reason === "runner-error" || legacyToolFailure))
    return status("blocked", "Tool error", "Inspect the saved tool failure and the original conversation. Repair the tool and reconcile any uncertain continuation before resuming");
  if (blockers.some(item => item.reason === "uncertain-delivery"))
    return status("blocked", "Check continuation", "Inspect whether the previous continuation was delivered; reconcile its receipt before resuming");
  if (job.blocker?.owner === "owner") return status("decision", "Decision needed", job.blocker.nextAction);
  if (held) return status("blocked", "Held", "Inspect the original stop reason in the conversation before deciding whether to resume");
  if (blockers.some(item => item.reason === "acceptance-decision")) return status("decision", "Review merge");
  if (workGroup(job) === "waiting") return status("waiting", job.stage === "waiting-ci" ? "Waiting for CI"
    : job.stage === "waiting-deploy" ? "Waiting for deployment" : "Waiting for verification");
  const labels: Record<string, string> = { implementing: "Implementing", investigating: "Investigating", preverifying: "Checking", reviewing: "Reviewing", verifying: "Verifying", fixing: "Fixing" };
  return status("working", labels[job.stage] ?? "Working");
}

/** A versioned display contract. Never expose commands, paths, issue bodies or auth. */
export function overview(jobs: Job[], limit = 500, now = new Date()) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("overview limit must be 1–1000");
  const priority: Record<WorkGroup, number> = { "needs-you": 0, working: 1, waiting: 2, paused: 3, verified: 4, cancelled: 5 };
  const ordered = [...jobs].sort((a, b) => priority[workGroup(a)] - priority[workGroup(b)] || (b.lastProgressAt ?? b.createdAt).localeCompare(a.lastProgressAt ?? a.createdAt) || a.id.localeCompare(b.id));
  return {
    version: 1 as const, generatedAt: now.toISOString(), total: jobs.length, truncated: jobs.length > limit,
    jobs: ordered.slice(0, limit).map(job => {
      const display = displayStatus(job);
      const evidence = [...new Set(job.verification?.criteria.flatMap(item => item.evidence.map(entry => webLink(entry.reference))).filter((value): value is string => !!value))].slice(0, 5);
      return {
        id: job.id, revision: job.revision, title: sanitizedDetail(job.issue.title).slice(0, 300),
        issueURL: webLink(job.issue.url), sessionID: job.sessionID,
        stage: job.stage, group: workGroup(job), detail: sanitizedDetail(job.detail),
        display: { kind: display.kind, label: display.label },
        stopReason: ["paused", "needs-you"].includes(job.stage) ? sanitizedDetail(job.holdDetail ?? job.detail) : undefined,
        lastProgressAt: job.lastProgressAt, createdAt: job.createdAt, nextWakeAt: job.nextWakeAt,
        progress: { passed: job.verification?.criteria.filter(item => item.status === "pass").length ?? 0, total: job.acLabels.length },
        nextAction: display.nextAction,
        prURL: webLink(job.pr), evidence,
      };
    }),
  };
}
