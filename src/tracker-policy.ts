import type { Job } from "./lifecycle.js";
import type { TrackerIssue } from "./issue.js";

export class TrackerHoldError extends Error {}

export function assertTracker(job: Job, issue: TrackerIssue): void {
  if (issue.backend !== job.issue.backend || issue.identifier !== job.issue.identifier || issue.url !== job.issue.url) {
    throw new Error("Tracker identity changed; reread the issue before closeout");
  }
  if (/^(on hold|hold|paused|blocked)$/i.test(issue.state ?? "") ||
      issue.labels.some(label => /^(owner[- ]hold|on[- ]hold|hold|paused|blocked)$/i.test(label))) {
    throw new TrackerHoldError("Current tracker issue has an owner hold; release it explicitly before continuing");
  }
  if (issue.backend !== "linear") return;
  if (!issue.linear) throw new Error("Missing Linear workflow/revision metadata");
  if (issue.linear.archivedAt || issue.linear.snoozedUntilAt ||
      /^(on hold|hold|paused|blocked)$/i.test(issue.state ?? "") ||
      issue.labels.some(label => /^(owner[- ]hold|on[- ]hold|hold|paused|blocked)$/i.test(label))) {
    throw new TrackerHoldError("Linear issue has an owner hold; release it explicitly before closeout");
  }
  if (!["triage", "backlog", "unstarted", "started", "completed"].includes(issue.stateType ?? "")) {
    throw new Error("Linear issue is canceled, duplicate or has an unknown workflow type; cannot complete it");
  }
}
