import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAgent } from "./agents.js";

const config = {
  default: "codex",
  agents: {
    claude: { command: "claude", weight: 3 },
    codex: { command: "codex", weight: 2 },
  },
};

test("zero weights fall back to the configured default", () => {
  const selected = chooseAgent({ default: "codex", agents: { codex: { command: "codex", weight: 0 } } });
  assert.equal(selected.name, "codex");
});

test("weighted selection is independent of the previous choice", () => {
  assert.equal(chooseAgent(config, undefined, () => 0).name, "claude");
  assert.equal(chooseAgent(config, undefined, () => 2).name, "claude");
  assert.equal(chooseAgent(config, undefined, () => 3).name, "codex");
  assert.equal(chooseAgent(config, undefined, () => 4).name, "codex");
});

test("explicit selection resolves aliases to the canonical agent", () => {
  const aliased = {
    default: "codex",
    agents: {
      hy3: { command: "opencode --agent hy3", weight: 0, aliases: ["hy", "hunyuan"] },
    },
  };
  const selected = chooseAgent(aliased, "hy", undefined as never, { hy: "hy3" });
  assert.equal(selected.name, "hy3");
  assert.equal(selected.definition.command, "opencode --agent hy3");
  assert.throws(() => chooseAgent(aliased, "unknown", undefined as never));
});
