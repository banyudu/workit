import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { lifecycleCLI } from "./lifecycle-cli.js";
import { createJob, JobStore, syncVerifiedIssue, type Stage } from "./lifecycle.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "workit-deployment-refresh-"));
  const previous = process.env.WORKIT_STATE_DIR;
  process.env.WORKIT_STATE_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKIT_STATE_DIR;
    else process.env.WORKIT_STATE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(console, "log", () => {});
  const job = createJob({
    issue: { backend: "github", identifier: "7", title: "Deployment evidence", labels: [],
      url: "https://github.com/example/project/issues/7",
      body: "## Acceptance Criteria\n- [ ] `[deploy:journey]` Actual journey passes.\n- [ ] `[code:contract]` Contract exists." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture",
    config: { verification: "deployed", deploymentProbe: ["fixture-read-only-probe"] },
  });
  job.pr = "https://github.com/example/project/pull/8";
  job.mergeSha = "a".repeat(40);
  job.stage = "waiting-deploy";
  const store = new JobStore();
  store.insert(job);
  const deployment = { environment: "lab", target: "fixture", sourceSha: "b".repeat(40), version: "version-2" };
  t.mock.method(BanyanLifecycleAdapter.prototype, "pr", async () => ({ merged: true, mergeSha: job.mergeSha, fingerprint: "fixture", ready: true, closed: false }));
  t.mock.method(BanyanLifecycleAdapter.prototype, "deployment", async () => deployment);
  t.mock.method(BanyanLifecycleAdapter.prototype, "containsMerge", async () => true);
  t.mock.method(BanyanLifecycleAdapter.prototype, "project", async () => {});
  return { job, store, deployment };
}

test("explicit deployment refresh records the trusted observation without wake or acceptance", async t => {
  const f = fixture(t);
  f.store.update(f.job.id, job => {
    job.closeout = { checklistConfirmed: true, stateConfirmed: true };
    job.trackerDone = true;
  });
  t.mock.method(BanyanLifecycleAdapter.prototype, "session", async () => { throw new Error("must not wake or require an idle session"); });
  t.mock.method(BanyanLifecycleAdapter.prototype, "wake", async () => { throw new Error("must not wake"); });
  await lifecycleCLI(["job", "refresh-deployment", f.job.id]);
  const current = f.store.get(f.job.id);
  assert.equal(current.stage, "verifying");
  assert.deepEqual(current.deployment, f.deployment);
  assert.equal(current.verification, undefined);
  assert.equal(current.closeout, undefined);
  assert.equal(current.trackerDone, undefined);
  assert.equal(current.wake, undefined);
});

test("deployment refresh preserves pauses, pending wakes and active claims", async t => {
  const f = fixture(t);
  for (const stage of ["paused", "needs-you", "verified", "cancelled"] as Stage[]) {
    f.store.update(f.job.id, job => { job.stage = stage; });
    await assert.rejects(lifecycleCLI(["job", "refresh-deployment", f.job.id]), /unheld post-merge/);
    assert.equal(f.store.get(f.job.id).stage, stage);
  }
  f.store.update(f.job.id, job => {
    job.stage = "verifying";
    job.wake = { id: "uncertain-wake", reason: "pending", revision: job.revision };
  });
  await assert.rejects(lifecycleCLI(["job", "refresh-deployment", f.job.id]), /pending wake/);
  assert.equal(f.store.get(f.job.id).wake?.id, "uncertain-wake");
  f.store.update(f.job.id, job => { delete job.wake; job.claim = { token: "active", process: "fixture" }; });
  await assert.rejects(lifecycleCLI(["job", "refresh-deployment", f.job.id]), /claim/);
});

test("deployment refresh refuses unavailable source, wrong merge and changed job", async t => {
  const f = fixture(t);
  t.mock.method(BanyanLifecycleAdapter.prototype, "containsMerge", async () => false);
  await assert.rejects(lifecycleCLI(["job", "refresh-deployment", f.job.id]), /Serving deployment/);
  assert.equal(f.store.get(f.job.id).deployment, undefined);
  t.mock.method(BanyanLifecycleAdapter.prototype, "containsMerge", async () => true);
  t.mock.method(BanyanLifecycleAdapter.prototype, "pr", async () => ({ merged: true, mergeSha: "c".repeat(40), fingerprint: "fixture", ready: true, closed: false }));
  await assert.rejects(lifecycleCLI(["job", "refresh-deployment", f.job.id]), /GitHub/);
  t.mock.method(BanyanLifecycleAdapter.prototype, "pr", async () => ({ merged: true, mergeSha: f.job.mergeSha, fingerprint: "fixture", ready: true, closed: false }));
  t.mock.method(BanyanLifecycleAdapter.prototype, "deployment", async () => {
    f.store.update(f.job.id, job => { job.stage = "paused"; });
    return f.deployment;
  });
  await assert.rejects(lifecycleCLI(["job", "refresh-deployment", f.job.id]), /Job changed/);
  assert.equal(f.store.get(f.job.id).stage, "paused");
  assert.equal(f.store.get(f.job.id).deployment, undefined);
});

test("explicit human tracker completion survives verification and prevents automatic Done", async t => {
  const f = fixture(t);
  await lifecycleCLI(["job", "checkpoint", f.job.id, "--stage", "waiting-deploy", "--detail", "Human owns closure", "--tracker-completion", "human"]);
  assert.equal(f.store.get(f.job.id).config.trackerCompletion, "human");
  const current = f.store.update(f.job.id, job => {
    job.stage = "verified";
    job.issue.backend = "linear";
  });
  const adapter = new BanyanLifecycleAdapter();
  const markDone = t.mock.method(adapter, "markDone", async () => { throw new Error("Human-only issue must not transition"); });
  await syncVerifiedIssue(f.store, adapter, current);
  assert.equal(markDone.mock.callCount(), 0);
  assert.equal(f.store.get(f.job.id).stage, "verified");
  assert.equal(f.store.get(f.job.id).trackerDone, undefined);
});
