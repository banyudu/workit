import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const DAY = 86_400_000;
/** A save that never wrote its manifest failed, but give a running one time. */
const INCOMPLETE_GRACE_MS = 6 * 3_600_000;

export interface RetentionPolicy { retainedStateDays?: number; maxRetainedStateMB?: number }
export interface RetentionReport { deleted: number; freedBytes: number; errors: string[] }

interface Snapshot { directory: string; created: number; bytes: number; key: string }

/**
 * Bound retained-state growth. Each snapshot is an independent copy of one
 * retired checkout's local files, so pruning drops, in order: byte-identical
 * repeats of the same checkout (keeping the newest), saves that never wrote a
 * manifest, snapshots older than `retainedStateDays`, and then the oldest
 * snapshots until the rest fit in `maxRetainedStateMB`. Zero disables a limit.
 */
export function pruneRetainedState(parent: string, policy: RetentionPolicy, now = Date.now()): RetentionReport {
  const report: RetentionReport = { deleted: 0, freedBytes: 0, errors: [] };
  if (!existsSync(parent)) return report;
  const remove = (directory: string, bytes: number) => {
    try {
      removeSnapshot(directory);
      report.deleted++;
      report.freedBytes += bytes;
    } catch (error) {
      report.errors.push(`${directory}: ${(error as Error).message}`);
    }
  };
  const snapshots: Snapshot[] = [];
  for (const name of readdirSync(parent)) {
    const directory = join(parent, name);
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const created = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      const manifestPath = join(directory, "manifest.json");
      if (!existsSync(manifestPath)) {
        if (now - created > INCOMPLETE_GRACE_MS) remove(directory, 0);
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { roots: string[]; entries: Record<string, unknown>; bytes: number };
      const record = JSON.parse(readFileSync(join(directory, "record.json"), "utf8")) as { id: string };
      // Python writes entries in hash-seeded order; compare them sorted.
      const entries = Object.keys(manifest.entries).sort().map(key => [key, manifest.entries[key]]);
      const key = createHash("sha256").update(JSON.stringify([record.id, [...manifest.roots].sort(), entries])).digest("hex");
      snapshots.push({ directory, created, bytes: Number(manifest.bytes) || 0, key });
    } catch (error) {
      report.errors.push(`${directory}: ${(error as Error).message}`);
    }
  }
  snapshots.sort((a, b) => b.created - a.created);
  const seen = new Set<string>();
  const maxAge = (policy.retainedStateDays ?? 0) * DAY;
  const maxBytes = (policy.maxRetainedStateMB ?? 0) * 1024 ** 2;
  let total = 0;
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.key)) { remove(snapshot.directory, snapshot.bytes); continue; }
    seen.add(snapshot.key);
    if (maxAge > 0 && now - snapshot.created > maxAge) { remove(snapshot.directory, snapshot.bytes); continue; }
    if (maxBytes > 0 && total + snapshot.bytes > maxBytes) { remove(snapshot.directory, snapshot.bytes); continue; }
    total += snapshot.bytes;
  }
  return report;
}

// Snapshots copy read-only directories verbatim. Make only owned directories
// writable and never follow a symlink out of the snapshot.
function removeSnapshot(directory: string): void {
  const writable = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Snapshot is owned by another user");
    if ((stat.mode & 0o700) !== 0o700) chmodSync(path, stat.mode | 0o700);
    for (const item of readdirSync(path, { withFileTypes: true })) if (item.isDirectory() && !item.isSymbolicLink()) writable(join(path, item.name));
  };
  writable(directory);
  rmSync(directory, { recursive: true, force: true });
}
