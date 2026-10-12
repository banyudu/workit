import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const label = "io.workit.heartbeat";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function heartbeatPlist(input: { node: string; cli: string; path: string; logs: string; state: string; interval: number }): string {
  if (!Number.isSafeInteger(input.interval) || input.interval < 15) throw new Error("Heartbeat interval must be at least 15 seconds");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(input.node)}</string><string>${xml(input.cli)}</string><string>tick</string></array>
<key>StartInterval</key><integer>${input.interval}</integer>
<key>RunAtLoad</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(input.path)}</string><key>WORKIT_STATE_DIR</key><string>${xml(input.state)}</string></dict>
<key>StandardOutPath</key><string>${xml(join(input.logs, "heartbeat.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(input.logs, "heartbeat-error.log"))}</string>
</dict></plist>
`;
}

export function heartbeatCLI(args: string[]): void {
  if (process.platform !== "darwin") throw new Error("Automatic heartbeat installation requires macOS launchd; run workit tick from your host scheduler elsewhere");
  const action = args[0];
  if (!["install", "uninstall", "status"].includes(action)) throw new Error("Usage: workit heartbeat install [--interval 60] | uninstall | status");
  if (args.slice(1).length && !(action === "install" && args.length === 3 && args[1] === "--interval")) throw new Error("Unknown heartbeat options");
  const path = join(homedir(), "Library", "LaunchAgents", label + ".plist");
  const service = `gui/${process.getuid!()}/${label}`;
  if (action === "status") { execFileSync("launchctl", ["print", service], { stdio: "inherit" }); return; }
  if (action === "uninstall") {
    try { execFileSync("launchctl", ["bootout", service], { stdio: "pipe" }); } catch { /* may already be stopped */ }
    rmSync(path, { force: true });
    console.log("Workit heartbeat removed; issue checkpoints were retained.");
    return;
  }
  const cli = resolve(process.argv[1]);
  if (!cli.endsWith(".js")) throw new Error("Build workit and install its compiled CLI before registering launchd");
  const state = resolve(process.env.WORKIT_STATE_DIR ?? join(homedir(), ".local", "state", "workit"));
  const logs = join(state, "logs");
  const content = heartbeatPlist({ node: process.execPath, cli, path: process.env.PATH ?? "/usr/bin:/bin",
    logs, state, interval: Number(args[2] ?? 60) });
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  try { execFileSync("launchctl", ["bootout", service], { stdio: "pipe" }); } catch { /* first install */ }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path], { stdio: "inherit" });
  console.log(`Workit heartbeat installed: ${path}`);
}
