import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob } from "./lifecycle.js";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";

const body = "## Acceptance Criteria\n- [ ] `[test:behavior]` The behavior passes.\n- [ ] `[code:contract]` The contract is documented.";
const issue = { backend: "github" as const, identifier: "9", number: 9, title: "Review preflight", body,
  labels: [], url: "https://github.com/example/project/issues/9" };
const head = "a".repeat(40);

const fake = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.WORKIT_REVIEW_FIXTURE;
const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
const name = path.basename(process.argv[1]);
if (name === "review-probe") fixture.probeCalls++;
else if (name !== "gh") process.exit(2);
fs.writeFileSync(file, JSON.stringify(fixture));
process.stdout.write(JSON.stringify(name === "gh" ? fixture.pr : fixture.review));
`;

test("review preflight fingerprints decision facts, not comment or update timestamps", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-review-preflight-"));
  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv); rmSync(directory, { recursive: true, force: true });
  });
  for (const name of ["gh", "review-probe"]) {
    writeFileSync(join(directory, name), fake, { mode: 0o700 });
    chmodSync(join(directory, name), 0o700);
  }
  const file = join(directory, "fixture.json");
  process.env.PATH = directory + ":" + process.env.PATH;
  process.env.WORKIT_REVIEW_FIXTURE = file;
  const job = createJob({ issue, repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "codex",
    config: { verification: "local", reviewProbe: [join(directory, "review-probe")], reviewScoreRequired: true },
    now: new Date("2026-01-02T00:00:00Z") });
  job.pr = "https://github.com/example/project/pull/42";
  const fixture = {
    probeCalls: 0,
    pr: { state: "OPEN", headRefOid: head, updatedAt: "2026-01-02T00:00:00Z", reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN", statusCheckRollup: [] },
    review: { head: { sha: head }, reviewDecision: "APPROVED",
      checks: { pending: [], failing: [] }, threads: { unresolved: 1, items: [
        { id: "thread-1", resolved: false, path: "src/widget.ts", line: 7, firstBody: "Keep the empty state.", lastUpdatedAt: "2026-01-02T00:00:00Z" },
      ] },
      superdog: { summaries: [{ head, score: "4/5", stale: false, url: "https://example.invalid/review",
        updatedAt: "2026-01-02T00:00:00Z" }] } },
  };
  writeFileSync(file, JSON.stringify(fixture));
  const replaceFixture = (value: unknown) => writeFileSync(file, JSON.stringify({
    ...(value as Record<string, unknown>), probeCalls: JSON.parse(readFileSync(file, "utf8")).probeCalls,
  }));
  const adapter = new BanyanLifecycleAdapter();
  const first = await adapter.pr(job);
  assert.equal(first.reviewScore?.score, 4);
  assert.equal(first.unresolvedReviews?.[0].path, "src/widget.ts");
  assert.equal(first.ready, false);

  const metadataOnly = { ...fixture, pr: { ...fixture.pr, updatedAt: "2026-01-02T01:00:00Z" },
    review: { ...fixture.review, threads: { unresolved: 1, items: [{ ...fixture.review.threads.items[0],
      lastUpdatedAt: "2026-01-02T01:00:00Z" }] }, superdog: { summaries: [{ ...fixture.review.superdog.summaries[0],
      updatedAt: "2026-01-02T01:00:00Z" }] } } };
  replaceFixture(metadataOnly);
  const second = await adapter.pr(job);
  assert.equal(second.fingerprint, first.fingerprint);

  const changed = { ...metadataOnly, review: { ...metadataOnly.review, threads: { unresolved: 0, items: [] },
    superdog: { summaries: [{ ...metadataOnly.review.superdog.summaries[0], score: "5/5" }] } } };
  replaceFixture(changed);
  const ready = await adapter.pr(job);
  assert.notEqual(ready.fingerprint, first.fingerprint);
  assert.equal(ready.ready, true);

  const staleAttempt = { ...changed, pr: { ...changed.pr, statusCheckRollup: [
    { name: "Lint checks", status: "COMPLETED", conclusion: "CANCELLED" },
  ] } };
  replaceFixture(staleAttempt);
  const deduped = await adapter.pr(job);
  assert.equal(deduped.checks, "pass");
  assert.deepEqual(deduped.failingChecks, []);

  const pending = { ...changed, pr: { ...changed.pr, mergeStateStatus: "BLOCKED",
    statusCheckRollup: [{ name: "Lint checks", status: "IN_PROGRESS" }] } };
  replaceFixture(pending);
  const waiting = await adapter.pr(job);
  assert.equal(waiting.checks, "pending");
  assert.equal(waiting.ready, false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).probeCalls, 4);
});
