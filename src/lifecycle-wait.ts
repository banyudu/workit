import { JobStore, prDecision, processIdentity, processIsAlive, tick, type Job, type LifecycleAdapter } from "./lifecycle.js";

/** Stages where the next step depends on something outside the agent. */
export const waitableStages = ["waiting-ci", "waiting-deploy"] as const;
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 25 * 60;
export const DEFAULT_WAIT_INTERVAL_SECONDS = 60;
/** Exit status for "nothing to do yet; run job wait again". */
export const WAIT_STILL_WAITING_EXIT = 2;

export interface WaitResult {
  outcome: "action" | "changed" | "timeout";
  text: string;
  job: Job;
}

export interface WaitOptions {
  timeoutSeconds?: number;
  intervalSeconds?: number;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  process?: string;
  alive?: (identity: string) => boolean;
  signal?: AbortSignal;
}

const sleepFor = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

function stillWaiting(job: Job): string {
  const pr = job.facts?.pr;
  const reason = job.stage === "waiting-deploy" ? "the deployment containing the merge is not ready yet"
    : pr ? prDecision(pr, job.config.reviewScoreRequired).reason : "no PR facts observed yet";
  return `Workit: ${job.issue.identifier} is still ${job.stage}: ${reason}. Run \`workit job wait ${job.id}\` again to keep waiting.`;
}

function changed(job: Job): string {
  const detail = job.holdDetail ?? job.detail;
  return `Workit update for ${job.issue.identifier}: the job is now ${job.stage}${detail ? `. ${detail}` : ""}. Read job status before acting.`;
}

/**
 * Blocks the calling agent until Workit has a concrete action for it, the job
 * leaves its external wait, or the timeout passes. The agent stays the owner of
 * its own conversation; nothing is typed into a terminal.
 */
export async function waitForJob(store: JobStore, adapter: LifecycleAdapter, id: string, options: WaitOptions = {}): Promise<WaitResult> {
  const now = options.now ?? (() => new Date());
  const alive = options.alive ?? processIsAlive;
  const me = options.process ?? processIdentity();
  const timeoutMs = (options.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000;
  const intervalMs = (options.intervalSeconds ?? DEFAULT_WAIT_INTERVAL_SECONDS) * 1000;
  if (!(timeoutMs > 0) || !(intervalMs > 0)) throw new Error("--timeout and --interval must be positive seconds");
  const signal = options.signal ?? new AbortController().signal;
  const sleep = options.sleep ?? sleepFor;
  const deadline = now().getTime() + timeoutMs;

  store.update(id, job => {
    if (!(waitableStages as readonly string[]).includes(job.stage)) {
      throw new Error(`job wait applies to ${waitableStages.join("/")}; ${id} is ${job.stage}. Checkpoint the external wait first.`);
    }
    if (job.waiter && job.waiter.process !== me && Date.parse(job.waiter.until) > now().getTime() && alive(job.waiter.process)) {
      throw new Error(`Another job wait already owns ${id} until ${job.waiter.until}`);
    }
    // A short grace keeps the heartbeat away while this process exits.
    job.waiter = { process: me, until: new Date(deadline + 60_000).toISOString() };
  }, now());

  let text: string | undefined;
  try {
    for (;;) {
      const job = store.get(id);
      if (job.waiter?.process !== me || !(waitableStages as readonly string[]).includes(job.stage)) {
        return { outcome: "changed", text: changed(job), job };
      }
      await tick(store, adapter, { jobID: id, now: now(), process: me, alive,
        selfWait: { deliver: async (_job, _wakeID, update) => { text = update; } } });
      const latest = store.get(id);
      if (text !== undefined) return { outcome: "action", text, job: latest };
      if (!(waitableStages as readonly string[]).includes(latest.stage)) return { outcome: "changed", text: changed(latest), job: latest };
      const remaining = deadline - now().getTime();
      if (remaining <= 0 || signal.aborted) return { outcome: "timeout", text: stillWaiting(latest), job: latest };
      await sleep(Math.min(intervalMs, remaining), signal);
    }
  } finally {
    try {
      store.update(id, job => {
        if (job.waiter?.process !== me) throw new Error("waiter changed");
        delete job.waiter;
      }, now());
    } catch { /* another waiter, checkpoint or expiry already took over */ }
  }
}
