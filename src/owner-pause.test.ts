import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, createJob, tick } from "./lifecycle.js";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";

test("owner-pause-contract: exact argv guards revision/session, returns projection status and retains uncertain wake audit", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-pause-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ctl = join(directory, "banyanctl");
  const projectionPath = join(directory, "projection.json");
  writeFileSync(ctl, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PAUSE_PROJECTION_FILE, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ok:true}));\n', { mode: 0o700 });
  const store = new JobStore(directory);
  const job = createJob({ issue: { backend: "github", identifier: "23", title: "Pause contract", labels: [],
    url: "https://github.com/example/project/issues/23",
    body: "## Acceptance Criteria\n- [ ] `[test:pause]` Pause persists.\n- [ ] `[code:contract]` Contract exists." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
    config: { verification: "local" } });
  job.wake = { id: "uncertain-wake", reason: "unfinished work", revision: 0, counted: false };
  job.claim = { token: "heartbeat-claim", process: "fixture-process" };
  job.lastRecovery = { wakeID: "previous-wake", outcome: "delivered", detail: "Inspected", at: job.createdAt };
  store.insert(job);
  const invoke = (args: string[]) => JSON.parse(execFileSync(process.execPath,
    ["--import", "tsx", "src/cli.ts", "job", ...args],
    { encoding: "utf8", env: { ...process.env, WORKIT_STATE_DIR: directory,
      WORKIT_BANYANCTL: ctl, PAUSE_PROJECTION_FILE: projectionPath }, stdio: ["ignore", "pipe", "pipe"] }));
  const pause = (revision: string, sessionID: string) => invoke(["pause", job.id, "--detail", "Operator requested a hold",
    "--expected-revision", revision, "--expected-session-id", sessionID]);
  for (const [revision, sessionID] of [["1", job.sessionID], ["0", "different-session"], ["NaN", job.sessionID],
    ["-1", job.sessionID], ["9007199254740992", job.sessionID], ["0", ""]]) {
    assert.throws(() => pause(revision, sessionID));
    assert.deepEqual(store.get(job.id), job);
  }
  const paused = pause("0", job.sessionID);
  assert.equal(paused.id, job.id);
  assert.equal(paused.sessionID, job.sessionID);
  assert.equal(paused.revision, 1);
  assert.equal(paused.stage, "paused");
  assert.equal(paused.nextWakeAt, undefined);
  assert.equal(paused.claim, undefined);
  assert.deepEqual(paused.wake, job.wake);
  assert.deepEqual(paused.issue, job.issue);
  assert.equal(paused.acHash, job.acHash);
  assert.deepEqual(paused.projection, { status: "confirmed", sessionID: job.sessionID, revision: 1 });
  assert.deepEqual(paused.lastRecovery, job.lastRecovery);
  assert.equal(new JobStore(directory).get(job.id).projectedRevision, 1);
  const projected = JSON.parse(readFileSync(projectionPath, "utf8")) as string[];
  const value = (flag: string) => projected[projected.indexOf(flag) + 1];
  assert.equal(value("--id"), job.sessionID);
  assert.equal(value("--job-id"), job.id);
  assert.equal(value("--revision"), "1");
  assert.equal(value("--state"), "paused");
  assert.throws(() => pause("0", job.sessionID));

  // A control outage retains the durable hold for Banyan's projection retry.
  writeFileSync(ctl, '#!/usr/bin/env node\nprocess.exit(69);\n', { mode: 0o700 });
  const pending = pause("1", job.sessionID);
  assert.equal(pending.stage, "paused");
  assert.deepEqual(pending.projection, { status: "pending", sessionID: job.sessionID, revision: 2 });
  assert.equal(store.get(job.id).projectedRevision, 1);
  assert.equal(store.get(job.id).revision, 2);
  await tick(store, new BanyanLifecycleAdapter(ctl));
  assert.equal(store.get(job.id).nextWakeAt, undefined);
  assert.deepEqual(store.get(job.id).wake, job.wake);

  // Existing CLI callers can still pause without optional binding guards.
  assert.equal(invoke(["pause", job.id, "--detail", "Keep held"]).stage, "paused");
  assert.throws(() => invoke(["resume", job.id]));
  assert.deepEqual(store.get(job.id).wake, job.wake);
  writeFileSync(ctl, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "workflow" && args[1] === "set") {
  fs.writeFileSync(process.env.PAUSE_PROJECTION_FILE, JSON.stringify(args));
}
const projected = JSON.parse(fs.readFileSync(process.env.PAUSE_PROJECTION_FILE, "utf8"));
const value = flag => projected[projected.indexOf(flag) + 1];
console.log(JSON.stringify(args[0] === "session" ? {workflowProtocol:1,sessions:[{
  id:${JSON.stringify(job.sessionID)},cwd:${JSON.stringify(directory)},workflow:{owner:"workit",
  jobID:${JSON.stringify(job.id)},revision:Number(value("--revision")),state:value("--state"),
  wake:{id:${JSON.stringify(job.wake.id)},status:"uncertain"}}
}]} : {ok:true}));
`, { mode: 0o700 });
  const reconciled = invoke(["reconcile", job.id, "--delivery", "not-delivered", "--detail", "Inspected original conversation; no delivery"]);
  assert.equal(reconciled.stage, "paused");
  assert.equal(reconciled.nextWakeAt, undefined);
  assert.equal(reconciled.wake, undefined);
  assert.equal(reconciled.lastRecovery.wakeID, job.wake.id);
  const resumed = invoke(["resume", job.id]);
  assert.equal(resumed.sessionID, job.sessionID);
  assert.equal(resumed.stage, "implementing");
  assert.ok(resumed.nextWakeAt);
});
