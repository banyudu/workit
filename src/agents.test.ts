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



test("agentDefinitionsByTag projects tagged registry entries", async () => {
  const { agentDefinitionsByTag } = await import("./config.js");
  const config = {
    codingAgents: {
      agents: {
        muse: { command: "opencode --agent muse-spark", weight: 10, tags: ["daily", "banyan"] },
        claude: { command: "claude", weight: 5, tags: ["coding"] },
        hy3: { command: "opencode --agent hy3", weight: 0, tags: ["daily"] },
        broken: { command: "  ", tags: ["daily"] },
      },
    },
  } as never;
  const daily = agentDefinitionsByTag(config, "daily");
  assert.deepEqual(Object.keys(daily), ["muse", "hy3"]);
  assert.equal(daily.muse.command, "opencode --agent muse-spark");
  assert.equal(daily.hy3.weight, 0);
});

test("headlessPromptCommand converts registry commands for non-interactive runs", async () => {
  const { headlessPromptCommand } = await import("./launch.js");
  assert.equal(
    headlessPromptCommand("opencode --agent muse-spark", "hello world"),
    "opencode run --agent muse-spark 'hello world'",
  );
  assert.equal(
    headlessPromptCommand("opencode run --agent hy3", "hi"),
    "opencode run --agent hy3 'hi'",
  );
  assert.equal(
    headlessPromptCommand("claude --dangerously-skip-permissions --model opus", "do it"),
    "claude -p --dangerously-skip-permissions --model opus 'do it'",
  );
  assert.equal(headlessPromptCommand("claude -p", "q"), "claude -p 'q'");
  assert.equal(
    headlessPromptCommand("codex -p terra --dangerously-bypass-approvals-and-sandbox", "go"),
    "codex exec -p terra --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check 'go'",
  );
  assert.equal(
    headlessPromptCommand("codex exec --skip-git-repo-check", "q"),
    "codex exec --skip-git-repo-check 'q'",
  );
  assert.equal(headlessPromptCommand("someagent --flag", "x"), "someagent --flag 'x'");
});
