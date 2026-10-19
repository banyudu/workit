import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { createJob } from "./lifecycle.js";

test("managed session inspection requests only the original session, including closed rows", async t => {
  const directory = mkdtempSync(join(tmpdir(), "workit-session-query-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const job = createJob({ issue: { backend: "github", identifier: "1", title: "Fixture", labels: [],
    url: "https://github.com/example/project/issues/1",
    body: "## Acceptance Criteria\n- [ ] `[test:lookup]` Lookup passes.\n- [ ] `[code:recovery]` Recovery works." },
    repoRoot: directory, worktree: directory, githubRepo: "example/project", agent: "fixture", config: { verification: "local" } });
  const session = { id: job.sessionID, cwd: directory, status: "closed",
    workflow: { owner: "workit", jobID: job.id, revision: job.revision, state: "needs-you" } };
  const calls = join(directory, "calls.jsonl");
  const cli = join(directory, "banyanctl");
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(${JSON.stringify(JSON.stringify({ workflowProtocol: 1, sessions: [session] }))});
`, { mode: 0o700 });
  const adapter = new BanyanLifecycleAdapter(cli);
  assert.equal((await adapter.session(job))?.status, "closed");
  const observed = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(observed, [
    ["session", "list", "--id", job.sessionID],
  ]);
});
