import { runnableStage, type Job } from "./lifecycle.js";

const HELD_REFRESH_LIMIT = 10;
const HELD_REFRESH_BUDGET_MS = 30_000;

/** Due delivery work runs before history maintenance, independent of job IDs. */
export function scheduleTick(jobs: Job[], now: Date): Job[] {
  const dueAt = (job: Job) => Date.parse(job.nextWakeAt ?? job.createdAt);
  const due = (job: Job) => runnableStage(job.stage) && dueAt(job) <= now.getTime();
  return [...jobs].sort((a, b) => Number(due(b)) - Number(due(a)) ||
    (due(a) ? dueAt(a) - dueAt(b)
      : Date.parse(a.facts?.observedAt ?? a.createdAt) - Date.parse(b.facts?.observedAt ?? b.createdAt)) ||
    a.id.localeCompare(b.id));
}

/** Oldest observations rotate first; maintenance cannot occupy an entire heartbeat. */
export function heldRefreshBudget(clock = () => performance.now()): (job: Job, now: Date) => boolean {
  let started: number | undefined;
  let count = 0;
  return (job, now) => {
    if (!job.pr || (job.facts && Date.parse(job.facts.nextCheckAt) > now.getTime())) return false;
    started ??= clock();
    if (count >= HELD_REFRESH_LIMIT || clock() - started >= HELD_REFRESH_BUDGET_MS) return false;
    count++;
    return true;
  };
}
