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

/** A versioned display contract. Never expose commands, paths, issue bodies or auth. */
export function overview(jobs: Job[], limit = 500, now = new Date()) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("overview limit must be 1–1000");
  const priority: Record<WorkGroup, number> = { "needs-you": 0, working: 1, waiting: 2, paused: 3, verified: 4, cancelled: 5 };
  const ordered = [...jobs].sort((a, b) => priority[workGroup(a)] - priority[workGroup(b)] || (b.lastProgressAt ?? b.createdAt).localeCompare(a.lastProgressAt ?? a.createdAt) || a.id.localeCompare(b.id));
  return {
    version: 1 as const, generatedAt: now.toISOString(), total: jobs.length, truncated: jobs.length > limit,
    jobs: ordered.slice(0, limit).map(job => {
      const blockers = jobBlockers(job);
      const evidence = [...new Set(job.verification?.criteria.flatMap(item => item.evidence.map(entry => webLink(entry.reference))).filter((value): value is string => !!value))].slice(0, 5);
      return {
        id: job.id, revision: job.revision, title: sanitizedDetail(job.issue.title).slice(0, 300),
        issueURL: webLink(job.issue.url), sessionID: job.sessionID,
        stage: job.stage, group: workGroup(job), detail: sanitizedDetail(job.detail),
        lastProgressAt: job.lastProgressAt, createdAt: job.createdAt, nextWakeAt: job.nextWakeAt,
        progress: { passed: job.verification?.criteria.filter(item => item.status === "pass").length ?? 0, total: job.acLabels.length },
        nextAction: sanitizedDetail(blockers[0]?.nextAction ?? (job.stage === "verified" ? "Acceptance verified" : job.stage === "cancelled" ? "Cancelled" : "Continue from the saved checkpoint")),
        prURL: webLink(job.pr), evidence,
      };
    }),
  };
}
