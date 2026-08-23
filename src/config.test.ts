import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepMerge, resolveConfig } from "./config.js";

test("deepMerge preserves nested defaults and lets project values win", () => {
  const merged = deepMerge(
    { launch: { target: "banyan", review: true }, agents: { codex: { weight: 2 } } },
    { launch: { target: "here" }, agents: { claude: { weight: 3 } } },
  );
  assert.deepEqual(merged, {
    launch: { target: "here", review: true },
    agents: { codex: { weight: 2 }, claude: { weight: 3 } },
  });
});

test("project config overrides user defaults and repository mappings", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-config-"));
  const user = join(root, "user.yml");
  writeFileSync(user, [
    "provider: auto",
    "projects:",
    "  banyudu/example:",
    "    provider: github",
    "launch:",
    "  target: here",
  ].join("\n"));
  writeFileSync(join(root, ".workit.yml"), "provider: linear\n");

  const resolved = resolveConfig(root, {
    explicitPath: user,
    remote: "git@github.com:banyudu/example.git",
  });
  assert.equal(resolved.config.provider, "linear");
  assert.equal(resolved.config.launch?.target, "here");
  assert.equal(resolved.configFiles.at(-1), join(root, ".workit.yml"));
  assert.equal(resolved.configFiles.includes(user), true);
});

function writeHomeRegistry(home: string, file: string, body: string): void {
  mkdirSync(join(home, ".agents"), { recursive: true });
  writeFileSync(join(home, ".agents", file), body);
}

test("registry resolution prefers agents.yml over the legacy coding-agents.yml", () => {
  const home = mkdtempSync(join(tmpdir(), "workit-reg-"));
  const root = mkdtempSync(join(tmpdir(), "workit-root-"));
  writeHomeRegistry(home, "coding-agents.yml", 'default: from-legacy\n');
  writeHomeRegistry(home, "agents.yml", 'default: from-canonical\n');

  const resolved = resolveConfig(root, { homeDirectory: home });
  assert.equal(resolved.registryFile, join(home, ".agents", "agents.yml"));
  assert.equal(resolved.config.default, "from-canonical");
});

test("registry falls back to legacy coding-agents.yml when agents.yml is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "workit-legacy-"));
  const root = mkdtempSync(join(tmpdir(), "workit-root-"));
  writeHomeRegistry(home, "coding-agents.yml", 'default: from-legacy\n');

  const resolved = resolveConfig(root, { homeDirectory: home });
  assert.equal(resolved.registryFile, join(home, ".agents", "coding-agents.yml"));
  assert.equal(resolved.config.default, "from-legacy");
});

test("only registry entries tagged coding join workit's agent pool", () => {
  const home = mkdtempSync(join(tmpdir(), "workit-tags-"));
  const root = mkdtempSync(join(tmpdir(), "workit-root-"));
  writeHomeRegistry(
    home,
    "agents.yml",
    [
      "default: codex",
      "agents:",
      "  tagged:",
      "    command: tagged-cmd",
      "    weight: 5",
      "    tags: [banyan, coding]",
      "  untagged:",
      "    command: untagged-cmd",
      "    tags: [banyan]",
      "  notag:",
      "    command: notag-cmd",
    ].join("\n"),
  );

  const resolved = resolveConfig(root, { homeDirectory: home });
  const agents = resolved.config.agents ?? {};
  assert.equal(agents.tagged?.command, "tagged-cmd");
  assert.equal(agents.untagged, undefined);
  assert.equal(agents.notag, undefined);
});
