import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPriority, setPriority } from "node:os";
import { expand, registerWorktree, restoreRetiredWorktree, runGC, setLifecycle } from "./engine.js";
import { Registry, type Role } from "./store.js";

const HELP = `workit gc — lifecycle-aware worktree recycling (dry-run by default)

  workit gc [--dry-run | --apply] [--repo PATH] [--worktree PATH]
            [--json] [--output PATH] [--max-actions N]
  workit gc register --worktree PATH --role implementation|review|pool|unclassified
                     [--job-file PATH] [--issue ID] [--pid PID] [--keep]
  workit gc keep --worktree PATH [--off]
  workit gc lease --worktree PATH --pid PID
  workit gc release --worktree PATH --pid PID
  workit gc finish --worktree PATH --pid PID [--interrupted] [--apply]
  workit gc restore --state DIRECTORY [--worktree NEW_PATH]

gc policies live in the existing workit config under gc:. Runtime state lives
in ~/.local/state/workit/state.sqlite (override WORKIT_GC_STATE for testing).
--repo may repeat; configured and already registered repositories are included.
--only-repo PATH may repeat to restrict a sweep to selected repositories.
--remnants-only inspects residual folders without touching linked checkouts.
Review registration requires its owner's job.json. Unclassified worktrees are
reported only unless explicitly opted in. Clean checkouts are deleted directly;
branches and commit refs are kept. With preserveLocalState enabled, unique
local files are verified and retained internally before retirement. No full
checkout backups. Generated-cache cleanup is independent of local-file retention.
`;

export function gcCLI(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  let command = "sweep";
  if (argv[0] && !argv[0].startsWith("-")) command = argv.shift()!;
  const supported = ["sweep", "register", "keep", "lease", "release", "finish", "restore"];
  if (!supported.includes(command)) throw new Error(`Unknown GC command: ${command}`);
  let worktree: string | undefined, role: Role | undefined, jobFile: string | undefined, pid: number | undefined, issue: string | undefined, output: string | undefined, maxActions: number | undefined;
  let stateDirectory: string | undefined;
  let apply = false, json = false, keep = false, off = false, interrupted = false, dryRun = false, remnantsOnly = false;
  const repos: string[] = [];
  const onlyRepositories: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--apply") { apply = true; continue; }
    if (flag === "--dry-run") { dryRun = true; continue; }
    if (flag === "--json") { json = true; continue; }
    if (flag === "--keep") { keep = true; continue; }
    if (flag === "--off") { off = true; continue; }
    if (flag === "--interrupted") { interrupted = true; continue; }
    if (flag === "--remnants-only") { remnantsOnly = true; continue; }
    if (!["--worktree", "--role", "--job-file", "--pid", "--issue", "--repo", "--only-repo", "--output", "--max-actions", "--state"].includes(flag)) throw new Error(`Unknown GC option: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--worktree") worktree = expand(value);
    if (flag === "--job-file") jobFile = expand(value);
    if (flag === "--repo") repos.push(expand(value));
    if (flag === "--only-repo") onlyRepositories.push(expand(value));
    if (flag === "--issue") issue = value;
    if (flag === "--output") output = expand(value);
    if (flag === "--state") stateDirectory = expand(value);
    if (flag === "--role") {
      if (!["implementation", "review", "pool", "unclassified"].includes(value)) throw new Error(`Unknown role: ${value}`);
      role = value as Role;
    }
    if (flag === "--pid" || flag === "--max-actions") {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} requires a positive integer`);
      if (flag === "--pid") pid = n; else maxActions = n;
    }
  }
  if (apply && dryRun) throw new Error("--apply and --dry-run are mutually exclusive");
  if (dryRun && command !== "sweep") throw new Error("Lifecycle mutations do not accept --dry-run");
  const registry = new Registry();
  if (command === "restore") {
    if (!stateDirectory) throw new Error("restore requires --state");
    console.log(JSON.stringify(restoreRetiredWorktree(stateDirectory, worktree, registry))); return;
  }
  if (command !== "sweep" && !worktree) throw new Error(`${command} requires --worktree`);
  if (command === "register") {
    const record = registerWorktree(worktree!, { role, jobFile, issue, keep: keep ? true : undefined, pid, phase: pid ? "preparing" : "idle" }, registry);
    console.log(JSON.stringify(record)); return;
  }
  if (command === "keep") { console.log(JSON.stringify(setLifecycle(worktree!, { keep: !off }, registry))); return; }
  if (command === "lease") {
    if (!pid) throw new Error("lease requires --pid");
    console.log(JSON.stringify(registerWorktree(worktree!, { pid, phase: "running" }, registry))); return;
  }
  if (command === "release" || command === "finish") {
    if (!pid) throw new Error(`${command} requires --pid`);
    setLifecycle(worktree!, { pid, release: true, phase: command === "finish" ? interrupted ? "interrupted" : "finished" : "idle" }, registry);
    if (command === "release" || !apply) { console.log("Lifecycle recorded"); return; }
  }
  const execute = () => runGC({ apply, worktree, repositories: repos, onlyRepositories: onlyRepositories.length ? onlyRepositories : undefined, remnantsOnly, maxActions, registry, includeLegacy: true, completionOwner: command === "finish" ? pid : undefined });
  if (apply) { try { setPriority(Math.max(10, getPriority())); } catch { /* Best effort on restricted hosts. */ } }
  const report = execute();
  const rendered = JSON.stringify({ dryRun: !apply, at: new Date().toISOString(), ...report }, null, 2);
  if (output) writeFileSync(output, rendered + "\n", { mode: 0o600 });
  if (json) console.log(rendered);
  else {
    for (const row of report.decisions) console.log(`${row.action.padEnd(8)} ${row.path}\n         ${row.reason}${row.result ? `; ${row.result}` : ""}`);
    console.log(`${apply ? "Completed" : "Dry run"}: ${report.decisions.length} checkouts, ${report.actions} actions, ${report.errors.length} errors`);
  }
  if (report.errors.length) process.exitCode = 1;
}
