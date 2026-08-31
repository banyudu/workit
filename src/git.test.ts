import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDependencies } from "./git.js";

test("symlink dependency mode links installed workspace node_modules behind an existing root link", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-root-"));
  const target = mkdtempSync(join(tmpdir(), "workit-target-"));
  const workspace = join("infra", "d1-backup");
  const rootNodeModules = join(root, "node_modules");
  const rootWorkspaceNodeModules = join(root, workspace, "node_modules");

  mkdirSync(rootNodeModules, { recursive: true });
  mkdirSync(rootWorkspaceNodeModules, { recursive: true });
  mkdirSync(join(target, workspace), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["infra/*"] }));
  writeFileSync(join(target, "package.json"), JSON.stringify({ workspaces: ["infra/*"] }));
  writeFileSync(join(target, workspace, "package.json"), JSON.stringify({ name: "d1-backup" }));

  // This is the layout produced by the old implementation. The early return
  // must no longer prevent workspace-local links from being completed.
  symlinkSync(rootNodeModules, join(target, "node_modules"), "dir");

  prepareDependencies(root, target, "symlink");

  assert.equal(realpathSync(join(target, "node_modules")), realpathSync(rootNodeModules));
  assert.equal(
    realpathSync(join(target, workspace, "node_modules")),
    realpathSync(rootWorkspaceNodeModules),
  );
});
