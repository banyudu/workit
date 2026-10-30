import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity, runGC, type Activity } from "./engine.js";
import { Registry } from "./store.js";

const quiet: Activity = { uncertain: [], sessions: [], processes: [], history: [] };

test("a busy sweep lock stays silent by default and is reported after a requested wait", t => {
  const dir = mkdtempSync(join(tmpdir(), "workit-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = new Registry(join(dir, "state.sqlite"));
  assert.equal(registry.lock("sweep", "other", { pid: process.pid, identity: processIdentity(process.pid) }), true);

  const nonblocking = runGC({ apply: true, registry, activity: quiet, policy: { enabled: true } });
  assert.equal(nonblocking.actions, 0);
  assert.deepEqual(nonblocking.errors, []);

  const blocked = runGC({ apply: true, registry, activity: quiet, lockWaitMs: 300, policy: { enabled: true } });
  assert.equal(blocked.actions, 0);
  assert.match(blocked.errors.join("\n"), /cleanup worker busy after [\d.]+s/);

  registry.unlock("sweep", "other");
  const released = runGC({ apply: true, registry, activity: quiet, lockWaitMs: 300, policy: { enabled: true } });
  assert.deepEqual(released.errors, []);
});
