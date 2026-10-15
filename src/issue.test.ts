import { test } from "node:test";
import assert from "node:assert/strict";
import { completedLinearState, inferBackend, normalizeIdentifier, slugify } from "./issue.js";

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
