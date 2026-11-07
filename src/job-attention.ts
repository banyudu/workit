import type { Job, JobStore, LifecycleAdapter } from "./lifecycle.js";
import { DEFAULT_INTERVAL_SECONDS } from "./lifecycle.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function notifyDesktopAttention(job: Job): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Desktop attention notifications require macOS");
  // Pass data as argv, never as AppleScript source. Keep private issue prose and
  // raw tool errors off the desktop/lock screen.
  await promisify(execFile)("/usr/bin/osascript", ["-e", `on run argv
display notification (item 2 of argv) with title (item 1 of argv)
end run`, "--", "Workit needs attention",
    `${job.issue.identifier}: automatic continuation stopped. Inspect workit job status ${job.id}.`],
  { cwd: job.repoRoot, timeout: 30_000 });
}

/** A held worker cannot deliver its own failure notification. Keep the local
 * desktop delivery independent of Banyan and retry it from the same heartbeat. */
export async function deliverJobAttention(store: JobStore, adapter: Pick<LifecycleAdapter, "notifyAttention">, expected: Job, now: Date): Promise<void> {
  const notice = expected.attentionNotice;
  if (expected.stage !== "needs-you" || !notice || notice.deliveredAt || !adapter.notifyAttention) return;
  if (notice.lastAttemptAt && now.getTime() - Date.parse(notice.lastAttemptAt) <
      (expected.config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000) return;
  let job: Job;
  try {
    job = store.update(expected.id, current => {
      if (current.revision !== expected.revision || current.stage !== "needs-you" ||
          current.attentionNotice?.id !== notice.id) throw new Error("Attention delivery changed");
      current.attentionNotice.lastAttemptAt = now.toISOString();
    }, now, { recordProgress: false });
  } catch { return; }
  try {
    await adapter.notifyAttention(job);
    try {
      store.update(job.id, current => {
        if (current.attentionNotice?.id !== notice.id) return;
        current.attentionNotice.deliveredAt = now.toISOString();
        delete current.attentionNotice.error;
      }, now, { recordProgress: false });
    } catch { /* A concurrent checkpoint retains delivery for later inspection. */ }
  } catch {
    try {
      store.update(job.id, current => {
        if (current.attentionNotice?.id === notice.id)
          current.attentionNotice.error = "Desktop notification unavailable; heartbeat will retry. Inspect workit job attention.";
      }, now, { recordProgress: false });
    } catch { /* A concurrent checkpoint must not fail the heartbeat. */ }
  }
}
