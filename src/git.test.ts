import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function dependencyFixture(t: { after: (fn: () => void) => void }) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "workit-deps-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, "root");
  const target = join(fixture, "target with spaces");
  for (const directory of [root, target]) {
    mkdirSync(join(directory, "packages", "widget"), { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ workspaces: ["packages/*"], packageManager: "bun@1.4.0" }));
    writeFileSync(join(directory, "packages", "widget", "package.json"), JSON.stringify({ name: "widget" }));
    writeFileSync(join(directory, "bun.lock"), "same dependency graph\n");
  }
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  mkdirSync(join(root, "packages", "widget", "node_modules"));
  symlinkSync("../../../node_modules/dep", join(root, "packages", "widget", "node_modules", "dep"));
  symlinkSync(join(root, "packages", "widget"), join(root, "node_modules", "widget"));
  return { fixture, root, target };
}

function fakeBun(t: { after: (fn: () => void) => void }, fixture: string) {
  const bin = join(fixture, "bin");
  const log = join(fixture, "install.json");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, "install.cjs")}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "install.cjs"), `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2)}));
fs.mkdirSync('node_modules', {recursive:true});
fs.writeFileSync('node_modules/installed', 'yes');
`);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; });
  return log;
}

test("clone dependencies materializes root and workspace trees and rebases absolute workspace links", (t) => {
  const { root, target } = dependencyFixture(t);
  // Re-preparing a worktree created by old symlink mode must upgrade it.
  symlinkSync(join(root, "node_modules"), join(target, "node_modules"));
  symlinkSync(join(root, "packages", "widget", "node_modules"), join(target, "packages", "widget", "node_modules"));
  prepareDependencies(root, target, "clone");
  assert.equal(lstatSync(join(target, "node_modules")).isSymbolicLink(), false);
  assert.equal(lstatSync(join(target, "packages", "widget", "node_modules")).isSymbolicLink(), false);
  assert.equal(realpathSync(join(target, "node_modules", "widget")), join(target, "packages", "widget"));
  assert.equal(realpathSync(join(target, "packages", "widget", "node_modules", "dep")), join(target, "node_modules", "dep"));
  writeFileSync(join(target, "node_modules", "dep", "package.json"), "changed in clone");
  assert.equal(JSON.parse(readFileSync(join(root, "node_modules", "dep", "package.json"), "utf8")).version, "1.0.0");
});

test("different lockfiles force a frozen target install instead of cloning stale dependencies", (t) => {
  const { fixture, root, target } = dependencyFixture(t);
  const log = fakeBun(t, fixture);
  writeFileSync(join(target, "bun.lock"), "new dependency graph\n");
  symlinkSync(join(root, "node_modules"), join(target, "node_modules"));
  prepareDependencies(root, target, "clone");
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), { cwd: target, args: ["install", "--frozen-lockfile", "--ignore-scripts"] });
  assert.equal(lstatSync(join(target, "node_modules")).isSymbolicLink(), false);
  assert.equal(existsSync(join(root, "node_modules", "installed")), false);
});

test("external dependency redirects roll back the clone before installing locally", (t) => {
  const { fixture, root, target } = dependencyFixture(t);
  const log = fakeBun(t, fixture);
  const external = join(fixture, "external");
  mkdirSync(external);
  symlinkSync(external, join(root, "node_modules", "external"));
  prepareDependencies(root, target, "clone");
  assert.equal(existsSync(log), true);
  assert.equal(existsSync(join(target, "node_modules", "external")), false);
  assert.equal(existsSync(join(root, "node_modules", "external")), true);
});

test("explicit install still runs with an existing node_modules directory", (t) => {
  const { fixture, root, target } = dependencyFixture(t);
  const log = fakeBun(t, fixture);
  mkdirSync(join(target, "node_modules"));
  prepareDependencies(root, target, "install");
  assert.equal(existsSync(log), true);
});

test("dependency preparation refuses to change the main checkout", (t) => {
  const { root } = dependencyFixture(t);
  assert.throws(() => prepareDependencies(root, root, "install"), /separate worktree/);
});
