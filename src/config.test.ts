import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
