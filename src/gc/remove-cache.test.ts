import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeCache } from "./engine.js";

test("removeCache unlinks a dangling symlink that rmSync would silently skip", t => {
  const dir = mkdtempSync(join(tmpdir(), "workit-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, "python3.12");
  symlinkSync("python3", link);
  removeCache(link);
  assert.throws(() => lstatSync(link), /ENOENT/);
});
