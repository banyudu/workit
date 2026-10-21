import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Job, JobStore } from "./lifecycle.js";
import type { Backend } from "./types.js";

export interface QueueItem {
  key: string; repo: string; issue: string; provider: Backend; issueURL: string; acHash: string; jobID: string;
  dependsOn: string[]; agent?: string; delivery: "implementation" | "investigation";
  verification: "local" | "deployed"; deploymentTarget?: string;
  state: "pending" | "reserved" | "launching" | "launched" | "uncertain" | "abandoned";
  launchID?: string; slot?: boolean; reservedAt?: string; recovery?: { reason: string; at: string };
}
export interface WorkQueue {
  coordinator?: { sessionID: string };
  instructions?: string;
  schema: 1; id: string; revision: number; title: string; outcome: string;
  state: "paused" | "active" | "cancelled"; createdAt: string; deadline: string;
  maxConcurrent: number; maxStarts: number; maxContinuations: number;
  starts: number; continuations: Array<{ jobID: string; token: string; at: string }>;
  command: string[]; items: QueueItem[];
}

// The queue and job tables share one SQLite transaction boundary. In particular,
// claiming an allowlisted launch and inserting its job cannot be split by a crash.
const SQL = String.raw`
import json, sqlite3, sys
db, op = sys.argv[1:3]
r = json.load(sys.stdin)
with sqlite3.connect(db, timeout=10) as c:
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)")
    c.execute("CREATE TABLE IF NOT EXISTS queues (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    c.execute("BEGIN IMMEDIATE")
    def queues(): return [json.loads(row[0]) for row in c.execute("SELECT data FROM queues ORDER BY id")]
    def job(id):
        row=c.execute("SELECT data FROM jobs WHERE id=?", (id,)).fetchone()
        return json.loads(row[0]) if row else None
    def save(q):
        q["revision"]+=1
        c.execute("UPDATE queues SET data=? WHERE id=?", (json.dumps(q),q["id"]))
    def enabled(q): return q["state"]=="active" and r["now"] < q["deadline"]
    def occupied(q): return sum(1 for i in q["items"] if i.get("slot",False))
    def free(j): return not j.get("wake") and j.get("verifier",{}).get("state") not in ["reserved","running","uncertain","invalidated"]
    result=None
    if op=="list": result=queues()
    elif op=="create":
        q=r["queue"]
        owned={i["jobID"] for other in queues() for i in other["items"] if i["state"]!="abandoned" and (other["state"]!="cancelled" or i["state"]!="pending")}
        if any(job(i["jobID"]) or i["jobID"] in owned for i in q["items"]): raise ValueError("An issue already has a job or queue owner; never adopt or resume it implicitly")
        c.execute("INSERT INTO queues VALUES (?,?)",(q["id"],json.dumps(q)))
        result=q
    else:
        row=c.execute("SELECT data FROM queues WHERE id=?",(r["id"],)).fetchone()
        if not row: raise ValueError("Unknown queue")
        q=json.loads(row[0])
        if op=="get": result=q
        elif op=="control":
            if q["revision"]!=r["revision"]: raise ValueError("Queue revision changed; reread its preview")
            if q["state"]=="cancelled": raise ValueError("Cancelled queues cannot restart")
            if r["state"]=="active" and r["now"]>=q["deadline"]: raise ValueError("Queue deadline expired; create a new explicit plan")
            q["state"]=r["state"]; save(q); result=q
        elif op=="reserve":
            if enabled(q) and q["starts"]<q["maxStarts"] and occupied(q)<q["maxConcurrent"]:
                for i in q["items"]:
                    if i["state"]!="pending" or job(i["jobID"]): continue
                    deps=[next(d for d in q["items"] if d["key"]==key) for key in i["dependsOn"]]
                    if not all(d["state"]=="launched" and (job(d["jobID"]) or {}).get("stage")=="verified" for d in deps): continue
                    i.update(state="reserved",launchID=r["token"],slot=True,reservedAt=r["now"])
                    q["starts"]+=1; save(q); result=i; break
        elif op=="attach":
            j=r["job"]
            i=next((i for i in q["items"] if i.get("launchID")==r["token"]),None)
            if not enabled(q) or not i or i["state"]!="reserved": raise ValueError("Launch reservation unavailable or queue held/expired")
            if j["id"]!=i["jobID"] or j["repoRoot"]!=i["repo"] or j["issue"]["url"]!=i["issueURL"] or j["acHash"]!=i["acHash"]: raise ValueError("Launch issue/source plan changed; inspect the reservation")
            cfg=j["config"]
            if cfg.get("delivery","implementation")!=i["delivery"] or cfg["verification"]!=i["verification"] or cfg.get("deploymentTarget")!=i.get("deploymentTarget"): raise ValueError("Launch acceptance differs from queue plan")
            if i.get("agent") and j["agent"]!=i["agent"]: raise ValueError("Launch agent differs from queue plan")
            j["queue"]={"id":q["id"],"key":i["key"],"launchID":r["token"],"outcome":q["outcome"],"deadline":q["deadline"]}
            if q.get("coordinator"): j["queue"]["coordinatorSessionID"]=q["coordinator"]["sessionID"]
            if q.get("instructions"): j["queue"]["instructions"]=q["instructions"]
            c.execute("INSERT INTO jobs VALUES (?,?,?)",(j["id"],j["revision"],json.dumps(j)))
            i["state"]="launching"; save(q); result=j
        elif op in ["confirm","uncertain","release","settle","reconcile","continuation"]:
            i=next((i for i in q["items"] if i["jobID"]==r["jobID"]),None)
            if not i: raise ValueError("Job is not allowlisted")
            j=job(i["jobID"])
            bound=j and j.get("queue",{}).get("id")==q["id"] and j["queue"].get("launchID")==i.get("launchID")
            if op=="confirm":
                if not bound or i.get("launchID")!=r["token"] or i["state"] not in ["launching","uncertain"]: raise ValueError("Launch receipt mismatch")
                i["state"]="launched"; save(q); result=True
            elif op=="uncertain":
                if i["state"] in ["reserved","launching"] and i.get("launchID")==r["token"]:
                    i["state"]="uncertain"; save(q)
                result=True
            elif op=="release":
                if bound and i["state"]=="launched" and j["revision"]==r["revision"] and j["stage"] in ["paused","needs-you","verified","cancelled"] and free(j):
                    i["slot"]=False; save(q); result=True
            elif op=="settle":
                if q["revision"]!=r["revision"] or not bound or i["state"]!="launched" or j["stage"] not in ["paused","needs-you","verified","cancelled"] or not free(j): raise ValueError("Only a settled held/finished job without pending delivery can release its slot")
                i["slot"]=False; i["recovery"]={"reason":r["reason"],"at":r["now"]}; save(q); result=q
            elif op=="reconcile":
                if q["revision"]!=r["revision"] or i.get("launchID")!=r["token"] or i["state"] not in ["reserved","launching","uncertain"]: raise ValueError("Reservation changed; inspect again")
                if r["outcome"]=="delivered" and not bound: raise ValueError("A matching durable job is required to confirm delivery")
                i["state"]="launched" if r["outcome"]=="delivered" else "abandoned"
                i["slot"]=r["outcome"]=="delivered"
                i["recovery"]={"reason":r["reason"],"at":r["now"]}; save(q); result=q
            elif op=="continuation":
                # Every attempt is charged before dispatch. Retries of a persisted
                # wake ID reuse its receipt, but still obey pause and deadline.
                if enabled(q) and bound and i["state"]=="launched" and j["stage"] not in ["paused","needs-you","verified","cancelled"]:
                    prior=any(x["jobID"]==j["id"] and x["token"]==r["token"] for x in q["continuations"])
                    capacity=i.get("slot",False) or occupied(q)<q["maxConcurrent"]
                    if capacity and (prior or len(q["continuations"])<q["maxContinuations"]):
                        i["slot"]=True
                        if not prior: q["continuations"].append({"jobID":j["id"],"token":r["token"],"at":r["now"]})
                        save(q); result=True
    print(json.dumps(result))
`;

export class QueueStore {
  constructor(readonly jobs: JobStore) {}
  private call<T>(op: string, input: object): T {
    try {
      return JSON.parse(execFileSync("python3", ["-c", SQL, this.jobs.path, op], {
        input: JSON.stringify(input), encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      })) as T;
    } catch (error) {
      // Python errors contain only our bounded contract messages, never issue text.
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      const detail = stderr.match(/ValueError: ([^\n]+)/)?.[1];
      throw new Error(detail ?? "Queue transaction failed; inspect local storage and the existing reservation before retrying");
    }
  }
  list(): WorkQueue[] { return this.call("list", {}); }
  get(id: string): WorkQueue { return this.call("get", { id }); }
  create(queue: WorkQueue): WorkQueue { return this.call("create", { queue }); }
  control(id: string, state: WorkQueue["state"], revision: number, now = new Date()): WorkQueue {
    return this.call("control", { id, state, revision, now: now.toISOString() });
  }
  reserve(id: string, now = new Date()): QueueItem | undefined {
    return this.call<QueueItem | null>("reserve", { id, token: randomUUID(), now: now.toISOString() }) ?? undefined;
  }
  attach(id: string, token: string, job: Job, now = new Date()): Job {
    return this.call("attach", { id, token, job, now: now.toISOString() });
  }
  confirm(id: string, jobID: string, token: string): void { this.call("confirm", { id, jobID, token }); }
  uncertain(id: string, jobID: string, token: string): void { this.call("uncertain", { id, jobID, token }); }
  release(id: string, jobID: string, revision: number): boolean { return !!this.call("release", { id, jobID, revision }); }
  reconcile(id: string, item: QueueItem, outcome: "delivered" | "abandoned", reason: string, revision: number, now = new Date()): WorkQueue {
    if (!reason.trim() || !["delivered", "abandoned"].includes(outcome)) throw new Error("Inspect the original session first; outcome and reason are required");
    return this.call("reconcile", { id, jobID: item.jobID, token: item.launchID, outcome, reason, revision, now: now.toISOString() });
  }
  settle(id: string, jobID: string, reason: string, revision: number, now = new Date()): WorkQueue {
    if (!reason.trim()) throw new Error("Inspect that no original agent or verifier is running, then record a reason");
    return this.call("settle", { id, jobID, reason, revision, now: now.toISOString() });
  }
  continuation(job: Job, token: string, now = new Date()): boolean {
    if (!job.queue) return true;
    return !!this.call("continuation", { id: job.queue.id, jobID: job.id, token, now: now.toISOString() });
  }
}
