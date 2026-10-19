import { spawnSync } from "node:child_process";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Role = "implementation" | "review" | "pool" | "unclassified";
export interface WorktreeRecord {
  id: string;
  path: string;
  repo: string;
  gitDir: string;
  birth: number;
  head: string;
  branch?: string;
  role: Role;
  phase: "idle" | "preparing" | "running" | "finished" | "interrupted" | "retired";
  createdAt: number;
  lastActivity: number;
  finishedAt?: number;
  keep: boolean;
  jobFile?: string;
  issue?: string;
  owner?: { pid: number; identity: string };
  archive?: string;
  recoveryRef?: string;
  /** Only unique local files, never committed source or dependencies. */
  retainedStateDirectory?: string;
  orphan?: boolean;
  /** An unregistered residual directory whose original Git revision is unknown. */
  remnant?: boolean;
}

// Python's standard-library SQLite keeps Node 20 support without native npm
// addons. Payloads travel over stdin; no SQL or paths are interpolated by a shell.
export const SQLITE = String.raw`
import json,sqlite3,sys,os,urllib.parse,subprocess
x=json.load(sys.stdin)
p=x['path']
if x['op']=='activity':
 c=sqlite3.connect('file:'+urllib.parse.quote(os.path.abspath(p))+'?mode=ro',uri=True,timeout=5)
 print(json.dumps(c.execute('SELECT cwd,MAX(updated_at) FROM threads GROUP BY cwd').fetchall()))
 sys.exit(0)
if x['op']=='read' and not os.path.exists(p):
 print('[]');sys.exit(0)
if x['op']=='inspections':
 if not os.path.exists(p):print('{}');sys.exit(0)
 c=sqlite3.connect('file:'+urllib.parse.quote(os.path.abspath(p))+'?mode=ro',uri=True,timeout=5)
 table=c.execute("SELECT name FROM sqlite_master WHERE name='inspections'").fetchone()
 print(json.dumps(dict(c.execute('SELECT id,at FROM inspections')) if table else {}))
 c.close();sys.exit(0)
if x['op']=='read':
 c=sqlite3.connect('file:'+urllib.parse.quote(os.path.abspath(p))+'?mode=ro',uri=True,timeout=5)
 print(json.dumps([json.loads(r[0]) for r in c.execute('SELECT data FROM worktrees')]))
 c.close();sys.exit(0)
c=sqlite3.connect(p,timeout=30)
c.execute('PRAGMA busy_timeout=30000')
c.execute('CREATE TABLE IF NOT EXISTS worktrees (path TEXT PRIMARY KEY, data TEXT NOT NULL)')
c.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER, data TEXT NOT NULL)')
c.execute('CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, token TEXT, owner TEXT)')
c.execute('CREATE TABLE IF NOT EXISTS inspections (id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
if x['op']=='read': print(json.dumps([json.loads(r[0]) for r in c.execute('SELECT data FROM worktrees')]))
elif x['op'] in ('write','import'):
 with c:
  for r in x['records']: c.execute(('INSERT OR IGNORE' if x['op']=='import' else 'INSERT OR REPLACE')+' INTO worktrees VALUES (?,?)',(r['path'],json.dumps(r)))
 print('{}')
elif x['op']=='event':
 with c: c.execute('INSERT INTO events(at,data) VALUES (?,?)',(x['event']['at'],json.dumps(x['event'])))
 print('{}')
elif x['op']=='inspected':
 with c:c.execute('INSERT OR REPLACE INTO inspections VALUES (?,?)',(x['id'],x['at']))
 print('{}')
elif x['op']=='lock':
 with c:
  c.execute('BEGIN IMMEDIATE')
  row=c.execute('SELECT owner FROM locks WHERE key=?',(x['key'],)).fetchone()
  alive=False
  if row:
   owner=json.loads(row[0])
   try:
    p=subprocess.run(['ps','-p',str(owner['pid']),'-o','lstart='],capture_output=True,text=True,timeout=5)
    alive=bool(owner['identity']) and p.stdout.strip()==owner['identity']
   except Exception:alive=True
  if not alive:c.execute('INSERT OR REPLACE INTO locks VALUES (?,?,?)',(x['key'],x['token'],json.dumps(x['owner'])))
 print(json.dumps(not alive))
elif x['op']=='unlock':
 with c:c.execute('DELETE FROM locks WHERE key=? AND token=?',(x['key'],x['token']))
 print('{}')
c.close()
`;

export function python<T>(script: string, input: unknown, timeout = 45_000): T {
  const result = spawnSync(process.env.WORKIT_PYTHON || "python3", ["-c", script], {
    input: JSON.stringify(input), encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`workit GC helper failed: ${result.error?.message || result.stderr.slice(-1200)}`);
  return JSON.parse(result.stdout || "null") as T;
}

export function statePath(): string {
  return process.env.WORKIT_GC_STATE || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "workit", "state.sqlite");
}

export class Registry {
  constructor(readonly path = statePath()) {}
  read(): WorktreeRecord[] { return python(SQLITE, { op: "read", path: this.path }); }
  inspections(): Record<string, number> { return python(SQLITE, { op: "inspections", path: this.path }); }
  inspected(id: string): void { python(SQLITE, { op: "inspected", path: this.path, id, at: Date.now() }); }
  write(records: WorktreeRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    python(SQLITE, { op: "write", path: this.path, records });
    chmodSync(this.path, 0o600);
  }
  import(records: WorktreeRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    python(SQLITE, { op: "import", path: this.path, records });
    chmodSync(this.path, 0o600);
  }
  event(event: Record<string, unknown>): void {
    if (!existsSync(this.path)) this.write([]);
    python(SQLITE, { op: "event", path: this.path, event: { at: Date.now(), ...event } });
  }
  lock(key: string, token: string, owner: NonNullable<WorktreeRecord["owner"]>): boolean {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const acquired = python<boolean>(SQLITE, { op: "lock", path: this.path, key, token, owner });
    chmodSync(this.path, 0o600);
    return acquired;
  }
  unlock(key: string, token: string): void { python(SQLITE, { op: "unlock", path: this.path, key, token }); }
}
