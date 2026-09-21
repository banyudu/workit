import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaredProjectForRepo,
  defaultMapFiles,
  defaultRoots,
  isLocalRepoValue,
  parseContextLinear,
  parseMapEntries,
  resolveRepoForProject,
  scanDeclared,
  splitSmartRepo,
  staticLookup,
  syncMapFile,
} from "./project.js";

test("parses inline and block linear project declarations", () => {
  assert.equal(
    parseContextLinear("linear: { team: ENG, project: Rene, project_id: abc }").project,
    "Rene",
  );
  const block = [
    "linear:",
    "  team: ENG",
    "  project: OPS — Internal Tools & Automation",
    "  project_id: abc",
  ].join("\n");
  assert.equal(parseContextLinear(block).project, "OPS — Internal Tools & Automation");
});

test("static map lookup is case-insensitive", () => {
  const entries = parseMapEntries("rene: ~/dev/2enai/clawly\n# comment\nops: /tmp/x\n");
  assert.equal(staticLookup(entries, "rene"), "~/dev/2enai/clawly");
  assert.equal(staticLookup(entries, "RENE"), "~/dev/2enai/clawly");
  assert.equal(staticLookup(entries, "missing"), "");
});

test("smart --repo splits local paths from owner/name", () => {
  assert.deepEqual(splitSmartRepo("~/dev/2enai/clawly"), { repoPath: "~/dev/2enai/clawly" });
  assert.deepEqual(splitSmartRepo("/tmp/repo"), { repoPath: "/tmp/repo" });
  assert.deepEqual(splitSmartRepo("./relative"), { repoPath: "./relative" });
  assert.deepEqual(splitSmartRepo("banyudu/example"), { githubRepo: "banyudu/example" });
  assert.deepEqual(splitSmartRepo(undefined), {});
  assert.equal(isLocalRepoValue("~/dev/x"), true);
  assert.equal(isLocalRepoValue("owner/repo"), false);
});

test("existing directories count as local repo values", () => {
  const dir = mkdtempSync(join(tmpdir(), "workit-islocal-"));
  assert.equal(isLocalRepoValue(dir), true);
});

test("scan finds repos declaring a project and resolution prefers current repo", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-scan-"));
  const repoA = join(root, "org", "repo-a");
  const repoB = join(root, "repo-b");
  for (const repo of [repoA, repoB]) {
    mkdirSync(join(repo, ".agents"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
  }
  writeFileSync(join(repoA, ".agents", "context.md"), "linear:\n  project: Rene\n");
  writeFileSync(join(repoB, ".agents", "context.md"), "linear:\n  project: Other\n");

  const declared = scanDeclared([root]);
  assert.equal(declared.find((d) => d.repoDir === repoA)?.name, "Rene");
  assert.equal(declaredProjectForRepo(repoA), "Rene");

  const mapFile = join(root, "map.yml");
  writeFileSync(mapFile, `rene: ${repoB}\n`);
  // Current repo declares the same project → wins over a stale map.
  const hit = resolveRepoForProject("rene", {
    currentRoot: repoA,
    mapFiles: [mapFile],
    roots: [root],
  });
  assert.equal(hit.repo, repoA);

  // Without the current-repo hint, the static map wins.
  const mapped = resolveRepoForProject("rene", { mapFiles: [mapFile], roots: [root] });
  assert.equal(mapped.repo, repoB);
});

test("dynamic scan resolves when the map misses, and errors helpfully otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-dyn-"));
  const repo = join(root, "grp", "myrepo");
  mkdirSync(join(repo, ".agents"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".agents", "context.md"), "linear: { project: MyProj }\n");

  const resolved = resolveRepoForProject("myproj", {
    mapFiles: [join(root, "missing.yml")],
    roots: [root],
  });
  assert.equal(resolved.repo, repo);

  assert.throws(
    () => resolveRepoForProject("nope", { mapFiles: [join(root, "missing.yml")], roots: [root] }),
    /no repo declares Linear project/,
  );
});

test("sync-map merges scan results while preserving manual entries", () => {
  const root = mkdtempSync(join(tmpdir(), "workit-syncmap-"));
  const repo = join(root, "myrepo");
  mkdirSync(join(repo, ".agents"), { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".agents", "context.md"), "linear: { project: Fresh }\n");
  const mapFile = join(root, "map.yml");
  writeFileSync(mapFile, "manual: /tmp/elsewhere\n");

  const { entries } = syncMapFile(mapFile, [root]);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("manual"));
  assert.ok(names.includes("fresh"));
});

test("default map files fall back to the review-linear map, roots default to ~/dev", () => {
  const files = defaultMapFiles();
  assert.ok(files[0]?.endsWith(".config/workit/map.yml"));
  assert.ok(files.some((f) => f.endsWith(".config/review-linear/map.yml")));
  assert.ok(defaultRoots()[0]?.endsWith("/dev"));
  assert.deepEqual(defaultRoots("/a:/b"), ["/a", "/b"]);
});
