import { test } from "node:test";
import assert from "node:assert/strict";
import { promptFor } from "./launch.js";
import type { CliOptions, IssueDetails, WorktreeResult } from "./types.js";

const issue: IssueDetails = {
  backend: "linear",
  identifier: "ENG-123",
  title: "Fix the widget",
  body: "Widgets explode when poked.",
  labels: ["bug"],
  url: "https://linear.app/2en/issue/ENG-123",
};

const worktree: WorktreeResult = {
  path: "/tmp/worktrees/fix-the-widget",
  branch: "yudu/eng-123-fix-the-widget",
  sourceBranch: "main",
  resumed: false,
};

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    prompt: true,
    agentLaunch: true,
    review: false,
    dryRun: false,
    verbose: false,
    identifiers: ["ENG-123"],
    ...overrides,
  };
}

test("instructions are appended verbatim to the issue prompt", () => {
  const prompt = promptFor(issue, worktree, options({
    instructions: ["Open a pull request when done.", "Then fix its review comments."],
  }));
  assert.match(prompt, /Open a pull request when done\./);
  assert.match(prompt, /Then fix its review comments\./);
  // The block sits between the issue body and the provenance footer.
  assert.ok(prompt.indexOf("Open a pull request when done.") < prompt.indexOf("Launcher provenance"));
});

test("blank instruction lines are dropped", () => {
  const prompt = promptFor(issue, worktree, options({ instructions: ["  ", "Real guidance."] }));
  const matches = prompt.split("Real guidance.").length - 1;
  assert.equal(matches, 1);
});

test("an empty or absent instruction list adds no guidance", () => {
  const withEmpty = promptFor(issue, worktree, options({ instructions: [] }));
  const withAbsent = promptFor(issue, worktree, options());
  assert.equal(withEmpty, withAbsent);
  assert.doesNotMatch(withAbsent, /pull request/i);
});

test("resumed worktrees point the agent at existing history", () => {
  const prompt = promptFor(issue, { ...worktree, resumed: true }, options());
  assert.match(prompt, /This worktree already exists\./);
});
