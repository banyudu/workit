import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, JobStore, WorkflowRefusedError, checkpoint, tick, type LifecycleAdapter } from "./lifecycle.js";
import { prepareQueue, CommandQueueLauncher } from "./queue.js";
import { QueueStore } from "./queue-store.js";
import { GroupStore } from "./group-store.js";
import { advanceGroups, BanyanGroupAdapter, tellGroupChild, type GroupAdapter, type CoordinationReceipt } from "./group.js";
import { launchIndependentVerifier } from "./launch.js";

const now = new Date("2026-10-01T00:00:00Z");
async function fixture(t: { after: (fn: () => void) => void }, maxContinuations = 6, itemCount = 1) {
  const dir = mkdtempSync(join(tmpdir(), "workit-group-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issue = { identifier: "23", backend: "github" as const, title: "Fixture", labels: [], state: "OPEN",
    body: "## Acceptance Criteria\n- [ ] `[test:behavior]` Fixture behavior passes.\n- [ ] `[code:docs]` Usage is documented.",
    url: "https://github.com/example/project/issues/23" };
  const jobs = new JobStore(dir), queues = new QueueStore(jobs), groups = new GroupStore(jobs);
  const queue = queues.create(await prepareQueue({ title: "Fixture", outcome: "Verified fixture", deadline: "2026-10-02T00:00:00Z",
    maxConcurrent: itemCount, maxStarts: itemCount, maxContinuations, coordinator: { sessionID: "parent-original" },
    instructions: "Keep the current UI and do not merge the second issue.",
    items: Array.from({ length: itemCount }, (_, i) => ({ key: i ? "second" : "first", repo: dir, issue: String(23 + i), provider: "github" })) },
  async item => ({ repo: dir, issue: { ...issue, identifier: item.issue, url: `https://github.com/example/project/issues/${item.issue}` }, delivery: "implementation", verification: "local" }), [process.execPath, join(dir, "cli.mjs")], now));
  const control = (state: "active" | "paused" | "cancelled") => queues.control(queue.id, state, queues.get(queue.id).revision, now);
  control("active");
  const reservation = queues.reserve(queue.id, now)!;
  const job = queues.attach(queue.id, reservation.launchID!, createJob({ issue, repoRoot: dir, worktree: dir,
    githubRepo: "example/project", agent: "fixture", config: { verification: "local" }, now }), now);
  queues.confirm(queue.id, job.id, reservation.launchID!);
  let receipt: CoordinationReceipt = { coordinationProtocol: 1, groupID: queue.id, revision: 0, state: "working" };
  const deliveries: string[] = [], retirements: string[] = [];
  const interventions: Array<{ id: string; at: string; text: string }> = [];
  const adapter: GroupAdapter = {
    bind: async () => receipt, receipt: async () => receipt,
    session: async current => ({ id: current.sessionID, parent: "parent-original", status: "idle", coordinationInterventions: interventions }),
    deliver: async (_q, message) => { deliveries.push(message.id); receipt = { ...receipt, revision: message.sequence!, wake: { id: message.id, status: "delivered" } }; },
    retire: async (_q, current) => { retirements.push(current.sessionID); },
  };
  const run = () => advanceGroups(jobs, adapter, { now, process: "fixture", alive: () => false });
  const verify = (id = job.id) => jobs.update(id, current => {
    current.stage = "verified"; current.mergeSha = "a".repeat(40);
    current.verification = { jobID: current.id, issueURL: current.issue.url, acHash: current.acHash, mergeSha: current.mergeSha,
      checkedAt: now.toISOString(), reviewer: { runID: "independent-fixture", independent: true },
      criteria: current.acLabels.map(label => ({ label, status: "pass", evidence: [{ kind: "test", reference: "fixture", observed: "pass" }] })) };
  }, now);
  return { dir, jobs, queues, groups, queue, job, adapter, run, control, verify, deliveries, retirements, interventions,
    addSecond: () => {
      const item = queues.reserve(queue.id, now)!;
      const second = queues.attach(queue.id, item.launchID!, createJob({ issue: { ...issue, identifier: "24", url: "https://github.com/example/project/issues/24" }, repoRoot: dir,
        worktree: dir, githubRepo: "example/project", agent: "fixture", config: { verification: "local" }, now }), now);
      queues.confirm(queue.id, second.id, item.launchID!); return second;
    },
    receipt: (next: CoordinationReceipt) => { receipt = next; } };
}

test("background launcher preserves explicit owner and disables top-level fallback", async t => {
  const f = await fixture(t);
  const capture = join(f.dir, "capture.json");
  writeFileSync(join(f.dir, "cli.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv,parent:process.env.BANYAN_PARENT_SESSION_ID,self:process.env.BANYAN_SESSION_ID,tmux:process.env.TMUX}));`);
  await new CommandQueueLauncher(f.dir).launch(f.queue, f.queue.items[0]);
  const value = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(value.parent, "parent-original"); assert.equal(value.self, ""); assert.equal(value.tmux, "");
  assert(value.argv.includes("--no-parent-fallback"));
  assert.equal(f.jobs.get(f.job.id).queue?.coordinatorSessionID, "parent-original");
  assert.match(f.jobs.get(f.job.id).queue?.instructions ?? "", /do not merge the second/);
});

test("verified results survive restart and only explicit current acceptance retires", async t => {
  const f = await fixture(t); f.verify(); await f.run();
  assert.equal(f.retirements.length, 0);
  const restarted = new GroupStore(new JobStore(f.dir));
  const result = restarted.get(f.queue.id).messages.find(message => message.kind === "result")!;
  assert.throws(() => restarted.accept(f.queue.id, result.id, "Worker cannot accept itself", f.job.sessionID, now), /main coordinator/);
  assert.equal(result.snapshot.verification?.reviewer.runID, "independent-fixture");
  restarted.accept(f.queue.id, result.id, "Inspected independent AC evidence and source", "parent-original", now);
  await f.run(); await f.run();
  assert.deepEqual(f.retirements, [f.job.sessionID]); assert.equal(f.deliveries.length, 1);
  const retained = restarted.get(f.queue.id).messages[0];
  assert(retained.retiredAt); assert.equal(retained.snapshot.issueURL, f.job.issue.url);
  assert(restarted.finish(f.queue.id).finished);
});

test("stale results, new user input and active verifier work cannot be accepted", async t => {
  const f = await fixture(t); f.verify(); await f.run();
  const result = f.groups.get(f.queue.id).messages[0];
  f.interventions.push({ id: "human-1", at: now.toISOString(), text: "Change the behavior first" });
  await f.run();
  assert.throws(() => f.groups.accept(f.queue.id, result.id, "Old result", "parent-original", now), /New child input/);
  const latest = f.groups.get(f.queue.id).messages.filter(message => message.kind === "result").at(-1)!;
  f.jobs.update(f.job.id, job => { job.stage = "fixing"; }, now);
  assert.throws(() => f.groups.accept(f.queue.id, latest.id, "Stale", "parent-original", now), /current verified result/);
  await f.run(); assert.equal(f.retirements.length, 0);
});

test("direct input is deduplicated and preserved as data across restart", async t => {
  const f = await fixture(t);
  f.interventions.push({ id: "human-1", at: now.toISOString(), text: "Please prioritize the retry path." });
  f.interventions.push({ id: "human-2", at: now.toISOString(), text: "Keep the current UI." });
  f.verify(); await f.run(); await f.run();
  const state = new GroupStore(new JobStore(f.dir)).get(f.queue.id);
  assert.equal(state.messages.filter(message => message.kind === "intervention").length, 2);
  assert.equal(state.messages[0].intervention?.text, f.interventions[0].text);
  const result = state.messages.find(message => message.kind === "result")!;
  assert.doesNotThrow(() => f.groups.accept(f.queue.id, result.id, "Reviewed both interventions", "parent-original", now));
});

test("lost delivered response reconciles once; ambiguous delivery never replays", async t => {
  const f = await fixture(t);
  const original = f.adapter.deliver;
  f.adapter.deliver = async (queue, message) => { await original(queue, message); throw new Error("response lost"); };
  await f.run(); await f.run(); assert.equal(f.deliveries.length, 1);
  f.jobs.update(f.job.id, job => { job.stage = "reviewing"; }, now);
  let calls = 0;
  f.adapter.deliver = async () => { calls++; throw new Error("timeout before receipt known"); };
  await f.run(); await f.run(); await f.run();
  assert.equal(calls, 1);
  assert(f.groups.get(f.queue.id).messages.some(message => message.delivery === "uncertain"));
});

test("busy refusal retries the same receipt without consuming another dispatch", async t => {
  const f = await fixture(t, 1); let calls = 0;
  f.adapter.deliver = async () => { calls++; throw new WorkflowRefusedError("coordinator is busy"); };
  await f.run(); await f.run();
  assert.equal(calls, 2); assert.equal(f.queues.get(f.queue.id).continuations.length, 1);
  assert.equal(f.groups.get(f.queue.id).messages[0].sequence, 1);
});

test("pause, deadline and shared budget prevent parent dispatch and retirement", async t => {
  const f = await fixture(t, 1); f.verify(); f.control("paused"); await f.run();
  const result = f.groups.get(f.queue.id).messages[0];
  f.groups.accept(f.queue.id, result.id, "Inspected", "parent-original", now); await f.run();
  assert.equal(f.retirements.length, 0); assert.equal(f.deliveries.length, 0);
  f.control("active");
  await advanceGroups(f.jobs, f.adapter, { now: new Date("2026-10-03"), process: "fixture", alive: () => false });
  assert.equal(f.retirements.length, 0); assert.equal(f.deliveries.length, 0);
  await f.run(); assert.equal(f.deliveries.length, 1);
  f.interventions.push({ id: "later", at: now.toISOString(), text: "More detail" }); await f.run();
  assert.equal(f.deliveries.length, 1);
});

test("concurrent processes claim one group and a restarted tick retains pending delivery", async t => {
  const f = await fixture(t);
  const script = `import { JobStore } from ${JSON.stringify(new URL("./lifecycle.ts", import.meta.url).href)};
import { GroupStore } from ${JSON.stringify(new URL("./group-store.ts", import.meta.url).href)};
console.log(JSON.stringify(new GroupStore(new JobStore(process.env.FIXTURE_DIR)).claim(process.env.FIXTURE_GROUP,"worker")??null));`;
  const results = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath,
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
    { env: { ...process.env, FIXTURE_DIR: f.dir, FIXTURE_GROUP: f.queue.id } })));
  assert.equal(results.map(result => JSON.parse(result.stdout)).filter(Boolean).length, 1);
  await f.run(); assert.equal(f.deliveries.length, 1);
});


test("coordinator follow-ups use original worker receipts and preserve holds", async t => {
  const f = await fixture(t);
  f.jobs.update(f.job.id, job => { job.stage = "paused"; }, now);
  tellGroupChild(f.jobs, f.queues.get(f.queue.id), "first", "Inspect the retry race", now);
  assert.equal(f.jobs.get(f.job.id).stage, "paused");
  const prompts: string[] = [];
  const worker: LifecycleAdapter = {
    session: async job => ({ id: job.sessionID, status: "idle" }), project: async () => {},
    wake: async (_job, _id, prompt) => { prompts.push(prompt); },
    pr: async () => ({ merged: false, ready: false, fingerprint: "unchanged" }),
    deployment: async () => undefined, containsMerge: async () => true,
    markInReview: async () => {}, markDone: async () => true, currentIssue: async job => job.issue,
  };
  await tick(f.jobs, worker, { now, process: "worker", alive: () => false });
  assert.equal(prompts.length, 0);
  f.jobs.update(f.job.id, job => { job.stage = "implementing"; job.nextWakeAt = now.toISOString(); }, now);
  await tick(f.jobs, worker, { now, process: "worker", alive: () => false });
  assert.equal(prompts.length, 1); assert.match(prompts[0], /Inspect the retry race/);
  const note = f.jobs.get(f.job.id).coordinatorNotes![0]; assert(note.deliveredAt);
  assert.equal(f.queues.get(f.queue.id).continuations.length, 1);
  f.verify();
  assert.throws(() => tellGroupChild(f.jobs, f.queues.get(f.queue.id), "first", "Unrelated new work", now), /unfinished child/);
});

test("one unreadable child does not block another child's result", async t => {
  const f = await fixture(t, 8, 2), second = f.addSecond(); f.verify(second.id);
  const observe = f.adapter.session;
  f.adapter.session = async job => { if (job.id === f.job.id) throw new Error("Missing original child"); return observe(job); };
  await f.run();
  const inbox = f.groups.get(f.queue.id).messages;
  assert(inbox.some(message => message.jobID === second.id && message.kind === "result"));
  assert(inbox.some(message => message.snapshot.observationError?.includes("Missing original child")));
  assert.equal(f.deliveries.length, 1);
});

test("pause during retirement stops subsequent children and refusals remain visible", async t => {
  const f = await fixture(t, 8, 2), second = f.addSecond(); f.verify(); f.verify(second.id); await f.run();
  for (const message of f.groups.get(f.queue.id).messages) f.groups.accept(f.queue.id, message.id, "Inspected", "parent-original", now);
  f.adapter.retire = async (_q, job) => { f.retirements.push(job.sessionID); f.control("paused"); throw new Error("Child is selected"); };
  await f.run();
  assert.equal(f.retirements.length, 1);
  assert.match(f.groups.get(f.queue.id).messages[0].error!, /Child is selected/);
});

test("Banyan wire envelopes, explicit verifier ownership and cleanup order agree", async t => {
  const f = await fixture(t); f.verify(); await f.run();
  const executable = join(f.dir, "banyanctl"), log = join(f.dir, "calls.jsonl"), outcome = join(f.dir, "outcome.json");
  writeFileSync(executable, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const val=k=>args[args.indexOf(k)+1];
const data=args[1]==='observe'?{session:{id:val('--id'),parent:val('--parent'),status:'idle'}}:
args[1].startsWith('retire')?{ok:true,closed:val('--id')}:
{ok:true,coordinationProtocol:1,groupID:val('--group-id'),revision:0,state:'working'};
console.log(JSON.stringify(args[1]==='current'?{id:'parent-original'}:{ok:true,data}));
`, { mode: 0o700 });
  const adapter = new BanyanGroupAdapter(executable), job = f.jobs.get(f.job.id);
  assert.equal(await adapter.requireOwner(f.queue), "parent-original");
  assert.equal((await adapter.bind(f.queue)).groupID, f.queue.id);
  assert.equal((await adapter.session(job))?.id, job.sessionID);
  job.verifier = { id: "review-run", sessionID: "review-session", agent: "fixture", binding: "fixture", state: "accepted",
    reportPath: join(f.dir, "report.json"), outcomePath: outcome, timeoutSeconds: 60, reservedAt: now.toISOString() };
  launchIndependentVerifier(job, job.verifier, { enabled: true, command: "fixture", concurrency: 1, maxAttempts: 1, timeoutSeconds: 60 }, executable);
  writeFileSync(outcome, JSON.stringify({ status: "complete" }));
  await adapter.retire(f.queue, job, f.groups.get(f.queue.id).messages[0]);
  const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const launch = calls.find(args => args[0] === "session" && args[1] === "new")!;
  assert(launch); assert.equal(launch[launch.indexOf("--parent") + 1], "parent-original");
  assert(!launch.includes("--no-parent"));
  assert(calls.some(args => args[1] === "helper" && args.includes(job.sessionID)));
  assert.deepEqual(calls.filter(args => args[1].startsWith("retire")).map(args => args[1]), ["retire-helper", "retire"]);
});

test("a worker checkpoint cannot lose an in-flight coordinator note receipt", async t => {
  const f = await fixture(t);
  tellGroupChild(f.jobs, f.queues.get(f.queue.id), "first", "Inspect before repeating effects", now);
  let receipt: { id: string; status: "delivered" } | undefined, deliveries = 0;
  const adapter: LifecycleAdapter = {
    session: async job => ({ id: job.sessionID, status: "idle", workflow: { owner: "workit", jobID: job.id, revision: job.revision, state: "working", wake: receipt } }),
    project: async () => {}, wake: async (job, id) => {
      deliveries++; receipt = { id, status: "delivered" };
      checkpoint(f.jobs, job.id, { stage: "implementing", detail: "Started follow-up", after: 1 }, now);
    },
    pr: async () => ({ merged: false, ready: false, fingerprint: "same" }), deployment: async () => undefined,
    containsMerge: async () => true, markInReview: async () => {}, markDone: async () => true,
  };
  await tick(f.jobs, adapter, { now, process: "worker", alive: () => false });
  assert(f.jobs.get(f.job.id).wake?.coordinatorNoteIDs?.length);
  await tick(f.jobs, adapter, { now: new Date(now.getTime() + 1000), process: "worker", alive: () => false });
  assert.equal(deliveries, 1);
  assert(f.jobs.get(f.job.id).coordinatorNotes![0].deliveredAt);
  assert.equal(f.jobs.get(f.job.id).wake, undefined);
});
