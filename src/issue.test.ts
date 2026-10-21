import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completedLinearState, inferBackend, markLinearIssueDone, markLinearIssueInReview, normalizeIdentifier, slugify, transitionLinearIssue } from "./issue.js";
import type { IssueDetails } from "./types.js";

const linearIssue: IssueDetails = {
  backend: "linear",
  identifier: "ENG-1",
  title: "Hand off in review",
  body: "## Acceptance Criteria\n- [ ] `[code:contract]` One.\n- [ ] `[test:journey]` Two.",
  labels: [],
  url: "https://linear.app/2en/issue/ENG-1",
};

function linearResponse(state: string): Response {
  return {
    ok: true,
    json: async () => ({
      data: { issue: { id: "issue-uuid", state: { name: state }, team: { states: { nodes: [
        { id: "state-in-progress", name: "In Progress" },
        { id: "state-in-review", name: "In Review" },
        { id: "state-done", name: "Done" },
      ] } } } },
    }),
  } as Response;
}

test("routes common identifiers automatically", () => {
  assert.equal(inferBackend("23"), "github");
  assert.equal(inferBackend("#23"), "github");
  assert.equal(inferBackend("ENG-123"), "linear");
  assert.equal(inferBackend("PROJ-abc"), "linear");
  assert.equal(normalizeIdentifier(" #23 "), "23");
});

test("explicit provider overrides inference", () => {
  assert.equal(inferBackend("23", "linear"), "linear");
  assert.equal(inferBackend("ENG-123", "github"), "github");
});

test("slugifies issue titles for branches", () => {
  assert.equal(slugify("Fix: flaky login / retry"), "fix-flaky-login-retry");
});

test("completed workflow resolution is team-specific, deterministic and excludes canceled/duplicate/archived states", () => {
  const current = { id: "review", name: "In Review", type: "started", position: 1 };
  for (const team of ["alpha", "beta"]) {
    const states = [
      { id: "canceled", name: "Done", type: "canceled", position: 0 },
      { id: "duplicate", name: "Done", type: "duplicate", position: 0 },
      { id: "old", name: "Old Done", type: "completed", position: 0, archivedAt: "2026-01-01" },
      { id: team + "-later", name: "Released", type: "completed", position: 9 },
      { id: team + "-done", name: "Accepted", type: "completed", position: 2 },
    ];
    assert.equal(completedLinearState(states, current), team + "-done");
    assert.equal(completedLinearState(states, states[3]), team + "-later", "retain the actual already completed state");
  }
  assert.equal(completedLinearState([], current), undefined);
});

test("Linear launch and merge handoffs guard on the current state and never target Done", async t => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const savedFetch = globalThis.fetch; const savedKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "test-key";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return body.query.includes("IssueState")
      ? linearResponse("In Progress")
      : ({ ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }) } as Response);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = savedKey;
  });

  await markLinearIssueInReview(linearIssue, {});
  assert.equal(calls.length, 2);
  assert.match(calls[0].query, /IssueState/);
  assert.match(calls[1].query, /issueUpdate/);
  assert.deepEqual(calls[1].variables, { id: "issue-uuid", stateId: "state-in-review" });

  calls.length = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return linearResponse("Done");
  }) as typeof fetch;
  await markLinearIssueInReview(linearIssue, {});
  await markLinearIssueInReview({ ...linearIssue, backend: "github", identifier: "7" }, {});
  assert.equal(calls.length, 1, "a completed issue and a GitHub issue are both left alone");
});

test("verified Linear completion targets Done through the API and preserves holds and reopenings", async t => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const savedFetch = globalThis.fetch; const savedKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "test-key";
  let state = "In Review";
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return body.query.includes("IssueState") ? linearResponse(state)
      : ({ ok: true, json: async () => ({ data: { issueUpdate: { success: true } } }) } as Response);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = savedKey;
  });
  await markLinearIssueDone(linearIssue, {});
  assert.deepEqual(calls[1].variables, { id: "issue-uuid", stateId: "state-done" });
  for (state of ["Done", "On Hold", "Rework", "In Progress", "Canceled"]) {
    calls.length = 0;
    await markLinearIssueDone(linearIssue, {});
    assert.equal(calls.length, 1, `${state} is left unchanged`);
  }
  calls.length = 0;
  await markLinearIssueDone({ ...linearIssue, backend: "github" }, {});
  assert.equal(calls.length, 0);
});

test("without an API key the Linear handoff uses the authenticated CLI", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-linear-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls.log");
  const state = join(directory, "state.json");
  writeFileSync(state, JSON.stringify({ state: { name: "Backlog" } }));
  const cli = join(directory, "linear");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${calls}\nif [ "$2" = "view" ]; then cat ${state}; fi\n`);
  chmodSync(cli, 0o700);
  const savedPath = process.env.PATH; const savedKey = process.env.LINEAR_API_KEY;
  const savedLog = console.log;
  process.env.PATH = directory + ":" + (savedPath ?? "");
  delete process.env.LINEAR_API_KEY;
  console.log = () => {};
  t.after(() => {
    process.env.PATH = savedPath;
    console.log = savedLog;
    if (savedKey === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = savedKey;
  });

  await transitionLinearIssue(linearIssue, {}, directory);
  writeFileSync(state, JSON.stringify({ state: { name: "In Progress" } }));
  await markLinearIssueInReview(linearIssue, {}, directory);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    "issue view ENG-1 --json --no-download",
    "issue update ENG-1 --state In Progress",
    "issue view ENG-1 --json --no-download",
    "issue update ENG-1 --state In Review",
  ]);
});
