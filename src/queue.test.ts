import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { JobStore, checkpoint, createJob, tick, type Job, type LifecycleAdapter } from "./lifecycle.js";
import { QueueStore, type QueueItem, type WorkQueue } from "./queue-store.js";
import { assertQueueIssue, advanceQueues, prepareQueue, queueStatus, type QueueManifest } from "./queue.js";

const now = new Date("2026-10-01T00:00:00Z");
const body = "## Acceptance Criteria\n- [ ] `[test:behavior]` The isolated fixture passes.\n- [ ] `[code:docs]` Usage is documented.";
function issue(id: string) { return { identifier: id, backend: "github" as const, title: "Fixture " + id, body, labels: [], state: "OPEN", url: `https://github.com/example/project/issues/${id}` }; }
async function fixture(t: { after: (fn: () => void) => void }, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), "workit-queue-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const jobs = new JobStore(directory), queues = new QueueStore(jobs);
  const manifest: QueueManifest = { title: "Repair fixture workflow", outcome: "Three independently accepted issues", deadline: "2026-10-02T00:00:00Z",
    maxConcurrent: 1, maxStarts: 3, maxContinuations: 2,
    items: [{ key: "first", repo: directory, issue: "1" }, { key: "second", repo: directory, issue: "2" }, { key: "last", repo: directory, issue: "3", dependsOn: ["first", "second"] }], ...extra };
  const resolve = async (item: QueueManifest["items"][number]) => ({ repo: item.repo, issue: issue(item.issue), delivery: "implementation" as const, verification: "local" as const });
  const queue = queues.create(await prepareQueue(manifest, resolve, [process.execPath, "/tmp/fixture-cli.js"], now));
  const launches: string[] = [], wakes: string[] = [], verifiers: string[] = [];
  let busy = false;
  const adapter: LifecycleAdapter = {
    session: async job => ({ id: job.sessionID, status: busy ? "busy" : "idle" }),
    project: async () => {}, wake: async (job, token) => { wakes.push(job.id + ":" + token); },
    pr: async () => ({ merged: true, mergeSha: "a".repeat(40), ready: true, fingerprint: "merged" }),
    deployment: async () => undefined, containsMerge: async () => true, markInReview: async () => {}, markDone: async () => true,
    currentIssue: async job => job.issue,
    verifierPlan: async () => ({ enabled: true, agent: "reviewer", command: "fixture", concurrency: 1, maxAttempts: 1, timeoutSeconds: 60 }),
    launchVerifier: async (_job, run) => { verifiers.push(run.id); },
  };
  const attach = (q: WorkQueue, item: QueueItem) => queues.attach(q.id, item.launchID!, createJob({ issue: issue(item.issue), repoRoot: item.repo, worktree: item.repo,
    githubRepo: "example/project", agent: "fixture", config: { verification: "local", delivery: "implementation" }, now }), now);
  const launcher = { launch: async (q: WorkQueue, item: QueueItem) => { attach(q, item); launches.push(item.key); queues.confirm(q.id, item.jobID, item.launchID!); } };
  const control = (state: WorkQueue["state"]) => queues.control(queue.id, state, queues.get(queue.id).revision, now);
  const advance = () => advanceQueues(jobs, adapter, launcher, now);
  return { directory, jobs, queues, queue, manifest, resolve, launches, wakes, verifiers, adapter, attach, launcher, control, advance, busy: (value: boolean) => { busy = value; } };
}

test("queue creation is paused, explicit, finite and refuses cycles/duplicate ownership", async t => {
  const f = await fixture(t);
  await f.advance(); assert.equal(f.launches.length, 0);
  for (const patch of [{ maxStarts: Infinity }, { maxContinuations: 0 }, { deadline: now.toISOString() },
    { items: [{ ...f.manifest.items[0], dependsOn: ["first"] }] },
    { items: [f.manifest.items[0], { ...f.manifest.items[0], key: "duplicate" }] }]) {
    await assert.rejects(prepareQueue({ ...f.manifest, ...patch }, f.resolve, [process.execPath, "/tmp/cli"], now));
  }
  const another = await prepareQueue(f.manifest, f.resolve, [process.execPath, "/tmp/cli"], now);
  assert.throws(() => f.queues.create(another), /already has a job or queue owner/);
  assert.throws(() => f.queues.control(f.queue.id, "active", 999, now), /revision changed/);
});

test("independent heartbeat processes atomically reserve one start and crashes never replay", async t => {
  const f = await fixture(t); f.control("active");
  const script = `import { JobStore } from ${JSON.stringify(new URL("./lifecycle.ts", import.meta.url).href)};
import { QueueStore } from ${JSON.stringify(new URL("./queue-store.ts", import.meta.url).href)};
const q=new QueueStore(new JobStore(process.env.QUEUE_TEST_DIRECTORY));console.log(JSON.stringify(q.reserve(process.env.QUEUE_TEST_ID,new Date(process.env.QUEUE_TEST_NOW))??null));`;
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
    env: { ...process.env, QUEUE_TEST_DIRECTORY: f.directory, QUEUE_TEST_ID: f.queue.id, QUEUE_TEST_NOW: now.toISOString() },
  })));
  assert.equal(results.map(r => JSON.parse(r.stdout)).filter(Boolean).length, 1);
  const restarted = new QueueStore(new JobStore(f.directory));
  assert.equal(restarted.get(f.queue.id).starts, 1);
  await f.advance(); assert.equal(f.launches.length, 0);
  assert.equal(queueStatus(restarted.get(f.queue.id), f.jobs, now).summary.uncertain, 1);
});

test("lost launch response retains job identity and requires inspected reconciliation", async t => {
  const f = await fixture(t); f.control("active");
  let calls = 0;
  await advanceQueues(f.jobs, f.adapter, { launch: async (q, item) => { f.attach(q, item); calls++; throw new Error("lost output"); } }, now);
  await f.advance(); assert.equal(calls, 1); assert.equal(f.launches.length, 0);
  let q = f.queues.get(f.queue.id), item = q.items[0];
  assert.equal(item.state, "uncertain"); assert.equal(f.jobs.list().length, 1);
  await tick(f.jobs, f.adapter, { now: new Date(now.getTime() + 60_000), process: "fixture", alive: () => false });
  assert.equal(f.wakes.length, 0);
  assert.throws(() => f.queues.reconcile(q.id, item, "delivered", "", q.revision, now), /Inspect/);
  q = f.queues.get(q.id); item = q.items[0];
  f.queues.reconcile(q.id, item, "delivered", "Observed original session and matching launch", q.revision, now);
  await tick(f.jobs, f.adapter, { now: new Date(now.getTime() + 120_000), process: "fixture", alive: () => false });
  assert.equal(f.wakes.length, 1); assert.equal(f.jobs.list().length, 1);
});

test("idle human-blocked work releases capacity; dependencies and busy/uncertain work do not", async t => {
  const f = await fixture(t); f.control("active"); await f.advance();
  assert.deepEqual(f.launches, ["first"]);
  const first = f.queue.items[0].jobID;
  checkpoint(f.jobs, first, { stage: "needs-you", detail: "Actual owner decision" }, now);
  f.busy(true); await f.advance(); assert.deepEqual(f.launches, ["first"]);
  f.busy(false); await f.advance(); assert.deepEqual(f.launches, ["first", "second"]);
  const second = f.queue.items[1].jobID;
  f.jobs.update(second, job => { job.stage = "verified"; }, now);
  await f.advance(); assert.equal(f.launches.length, 2);
  const view = queueStatus(f.queues.get(f.queue.id), f.jobs, now);
  assert.equal(view.summary.verified, 1); assert.equal(view.summary.blocked, 1); assert.equal(view.summary["dependency-blocked"], 1);
  assert.equal(f.jobs.get(first).holdDetail, "Actual owner decision");
  f.jobs.update(first, job => { job.stage = "verified"; }, now);
  await f.advance(); assert.deepEqual(f.launches, ["first", "second", "last"]);
});

test("pause, deadline and finite starts block future work without rewriting job holds", async t => {
  const f = await fixture(t, { maxStarts: 1 }); f.control("active"); await f.advance();
  const id = f.queue.items[0].jobID;
  f.control("paused");
  const run = (offset: number) => tick(f.jobs, f.adapter, { now: new Date(now.getTime() + offset), process: "fixture", alive: () => false });
  await run(60_000); assert.equal(f.wakes.length, 0); assert.equal(f.queues.get(f.queue.id).continuations.length, 0);
  f.control("active"); await run(120_000); assert.equal(f.wakes.length, 1);
  await run(86400_000); assert.equal(f.wakes.length, 1);
  assert.throws(() => f.queues.control(f.queue.id, "active", f.queues.get(f.queue.id).revision, new Date("2026-10-03")), /deadline expired/);
  checkpoint(f.jobs, id, { stage: "needs-you", detail: "Keep owner hold" }, now);
  await f.advance(); assert.equal(f.launches.length, 1); assert.equal(f.jobs.get(id).stage, "needs-you");
});

test("continuation receipts bound wakes and verifier starts, deduplicate retries and reacquire slots", async t => {
  const f = await fixture(t, { maxContinuations: 1 }); f.control("active"); await f.advance();
  const id = f.queue.items[0].jobID, job = f.jobs.get(id);
  assert.equal(f.queues.continuation(job, "same-receipt", now), true);
  assert.equal(f.queues.continuation(job, "same-receipt", now), true);
  assert.equal(f.queues.continuation(job, "different", now), false);
  assert.equal(f.queues.get(f.queue.id).continuations.length, 1);
  checkpoint(f.jobs, id, { stage: "verifying", detail: "Ready", pr: "https://github.com/example/project/pull/1", mergeSha: "a".repeat(40) }, now);
  await tick(f.jobs, f.adapter, { now: new Date(now.getTime() + 60_000), process: "fixture", alive: () => false });
  assert.equal(f.verifiers.length, 0); assert.equal(f.jobs.get(id).verifier, undefined); assert.equal(f.jobs.get(id).verifierAttempts, 0);
  f.control("paused"); assert.equal(f.queues.continuation(job, "same-receipt", now), false);
});

test("launch attachment rejects drift, paused queues and replay before any agent starts", async t => {
  const f = await fixture(t); f.control("active");
  const item = f.queues.reserve(f.queue.id, now)!;
  f.control("paused"); assert.throws(() => f.attach(f.queue, item), /held\/expired/);
  f.control("active");
  const job = createJob({ issue: { ...issue("1"), body: body.replace("passes", "rejects invalid input") }, repoRoot: item.repo, worktree: item.repo, githubRepo: "example/project", agent: "fixture", config: { verification: "local" }, now });
  assert.throws(() => f.queues.attach(f.queue.id, item.launchID!, job, now), /plan changed/);
  f.attach(f.queue, item); assert.throws(() => f.attach(f.queue, item), /reservation unavailable/);
});


test("pause while projecting cannot dispatch a wake and preserves the unused delivery intent safely", async t => {
  const f = await fixture(t); f.control("active"); await f.advance();
  let paused = false;
  f.adapter.project = async () => { if (!paused) { paused = true; f.control("paused"); } };
  await tick(f.jobs, f.adapter, { now: new Date(now.getTime() + 60_000), process: "fixture", alive: () => false });
  assert.equal(f.wakes.length, 0);
  assert.equal(f.jobs.get(f.queue.items[0].jobID).wake, undefined);
  assert.equal(f.queues.get(f.queue.id).continuations.length, 1);
});

test("queue issue preflight refuses fresh tracker holds and completed or archived work", () => {
  for (const current of [{ ...issue("1"), labels: ["owner-hold"] }, { ...issue("1"), state: "CLOSED" },
    { ...issue("1"), backend: "linear" as const, state: "On Hold", stateType: "started" },
    { ...issue("1"), backend: "linear" as const, state: "In Progress", stateType: "started", linear: { id: "one", teamID: "team", stateID: "started", updatedAt: now.toISOString(), archivedAt: now.toISOString() } }]) {
    assert.throws(() => assertQueueIssue(current));
  }
});


test("progress reports owner blockers and closed sessions require inspected capacity release", async t => {
  const f = await fixture(t); f.control("active"); await f.advance();
  const id = f.queue.items[0].jobID;
  f.jobs.update(id, job => { job.stage = "verifying"; job.blocker = { reason: "tracker-closeout", owner: "owner", observedAt: now.toISOString(), nextAction: "Close under policy", recheckTrigger: "tracker-state" }; }, now);
  assert.equal(queueStatus(f.queues.get(f.queue.id), f.jobs, now).summary.blocked, 1);
  assert.throws(() => f.queues.settle(f.queue.id, id, "Inspected", f.queues.get(f.queue.id).revision, now), /settled held/);
  f.jobs.update(id, job => { job.stage = "verified"; }, now);
  f.adapter.session = async job => ({ id: job.sessionID, status: "closed" });
  await f.advance(); assert.deepEqual(f.launches, ["first"]);
  f.queues.settle(f.queue.id, id, "Confirmed original process and verifier are stopped", f.queues.get(f.queue.id).revision, now);
  await f.advance(); assert.deepEqual(f.launches, ["first", "second"]);
});


test("verification failure handoffs consume the same queue budget and obey queue pause", async t => {
  for (const mode of ["budget", "paused", "allowed"] as const) {
    const f = await fixture(t, { maxContinuations: mode === "budget" ? 1 : 2 });
    f.control("active"); await f.advance(); const id = f.queue.items[0].jobID;
    checkpoint(f.jobs, id, { stage: "verifying", detail: "Ready for acceptance", pr: "https://github.com/example/project/pull/1", mergeSha: "a".repeat(40) }, now);
    await tick(f.jobs, f.adapter, { now: new Date(now.getTime() + 60_000), process: "fixture", alive: () => false });
    const job = f.jobs.get(id), verifier = job.verifier!; assert.equal(f.verifiers.length, 1);
    writeFileSync(verifier.reportPath, JSON.stringify({ jobID: id, issueURL: job.issue.url, acHash: job.acHash, mergeSha: job.mergeSha,
      checkedAt: new Date(now.getTime() + 61_000).toISOString(), reviewer: { runID: verifier.id, independent: true },
      criteria: job.acLabels.map(label => ({ label, status: "fail", evidence: [{ kind: "test", reference: "artifact://failure", observed: "Fixture reproduced the incorrect result" }] })) }));
    writeFileSync(verifier.outcomePath, JSON.stringify({ status: "complete" }));
    if (mode === "paused") f.control("paused");
    await tick(f.jobs, f.adapter, { now: new Date(now.getTime() + 120_000), process: "fixture", alive: () => false });
    assert.equal(f.jobs.get(id).stage, "fixing"); assert.equal(f.verifiers.length, 1);
    assert.equal(f.jobs.get(id).verification?.criteria[0].status, "fail");
    assert.equal(f.wakes.length, mode === "allowed" ? 1 : 0);
    assert.equal(f.queues.get(f.queue.id).continuations.length, mode === "allowed" ? 2 : 1);
  }
});
