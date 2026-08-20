import { test } from "node:test";
import assert from "node:assert/strict";
import { inferBackend, normalizeIdentifier, slugify } from "./issue.js";

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
