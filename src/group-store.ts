import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Job, JobStore } from "./lifecycle.js";

export interface GroupMessage {
  id: string; kind: "progress" | "result" | "intervention"; at: string;
  jobID: string; sessionID: string; jobRevision: number; fingerprint: string;
  snapshot: Pick<Job, "stage" | "detail" | "pr" | "mergeSha" | "observedSourceSha" | "acHash" | "verification"> & { issueURL: string; observationError?: string };
  interventionID: string; intervention?: { id: string; at: string; text: string };
  delivery: "pending" | "dispatching" | "delivered" | "uncertain";
  sequence?: number; accepted?: { at: string; reason: string; ownerSessionID: string }; retiredAt?: string;
  recovery?: { at: string; reason: string }; error?: string;
}
export interface GroupState {
  id: string; revision: number; nextSequence: number;
  claim?: { token: string; process: string };
  messages: GroupMessage[];
  last: Record<string, string>;
  finished?: boolean;
}

// Sharing the queue/job database makes observation, acceptance and dispatch
// reservations atomic with queue controls and worker checkpoints.
const SQL = String.raw`
import json, sqlite3, sys
db, op=sys.argv[1:3]
r=json.load(sys.stdin)
with sqlite3.connect(db,timeout=10) as c:
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    c.execute("BEGIN IMMEDIATE")
    row=c.execute("SELECT data FROM queues WHERE id=?",(r["id"],)).fetchone()
    q=json.loads(row[0]) if row else None
    if not q or not q.get("coordinator"): raise ValueError("Unknown coordinated group")
    row=c.execute("SELECT data FROM groups WHERE id=?",(r["id"],)).fetchone()
    g=json.loads(row[0]) if row else dict(id=r["id"],revision=0,nextSequence=1,messages=[],last={})
    def save():
        g["revision"]+=1
        c.execute("INSERT OR REPLACE INTO groups VALUES (?,?)",(g["id"],json.dumps(g)))
    def job(id):
        row=c.execute("SELECT data FROM jobs WHERE id=?",(id,)).fetchone()
        return json.loads(row[0]) if row else None
    def current(m):
        j=job(m["jobID"])
        return j and j.get("queue",{}).get("id")==q["id"] and j["sessionID"]==m["sessionID"] and j["revision"]==m["jobRevision"]
    result=None
    if op=="get": result=g
    elif op=="claim":
        if g.get("claim",{}).get("token")==r.get("previous"):
            g["claim"]={"token":r["token"],"process":r["process"]}; save(); result=g
    elif op=="release":
        if g.get("claim",{}).get("token")==r["token"]:
            g.pop("claim",None); save()
    elif op=="observe":
        m=r["message"]
        if current(m) and not g.get("finished"):
            if m["kind"]=="intervention":
                duplicate=any(x.get("intervention",{}).get("id")==m["intervention"]["id"] for x in g["messages"])
            else: duplicate=g["last"].get(m["jobID"])==m["fingerprint"]
            if not duplicate:
                g["messages"].append(m)
                if m["kind"]!="intervention": g["last"][m["jobID"]]=m["fingerprint"]
                save()
        result=g
    elif op=="dispatch":
        if g.get("claim",{}).get("token")!=r["token"]: raise ValueError("Group tick ownership changed")
        pending=next((m for m in g["messages"] if m["delivery"] in ["dispatching","uncertain"]),None)
        if not pending and not g.get("finished") and q["state"]=="active" and r["now"]<q["deadline"]:
            m=next((m for m in g["messages"] if m["delivery"]=="pending"),None)
            if m:
                prior=any(x["token"]==m["id"] and x["jobID"]=="coordinator" for x in q["continuations"])
                if prior or len(q["continuations"])<q["maxContinuations"]:
                    if not prior: q["continuations"].append(dict(jobID="coordinator",token=m["id"],at=r["now"]))
                    if not m.get("sequence"):
                        m["sequence"]=g["nextSequence"]; g["nextSequence"]+=1
                    m["delivery"]="dispatching"; save()
                    q["revision"]+=1
                    c.execute("UPDATE queues SET data=? WHERE id=?",(json.dumps(q),q["id"]))
                    result=m
    elif op in ["delivery","accept","retired","retirement-error"]:
        m=next((m for m in g["messages"] if m["id"]==r["messageID"]),None)
        if not m: raise ValueError("Unknown group message")
        if op=="retirement-error":
            if current(m): m["error"]=r["reason"]
        elif op=="delivery":
            if m["delivery"]!=r["expected"]: raise ValueError("Message delivery changed; inspect it again")
            m["delivery"]=r["delivery"]
            if r.get("reason"): m["recovery"]={"reason":r["reason"],"at":r["now"]}
        else:
            j=job(m["jobID"])
            if not current(m) or m["kind"]!="result" or j["stage"]!="verified" or not j.get("verification") or j.get("wake") or j.get("claim") or j.get("verifier",{}).get("state") in ["reserved","running","uncertain","invalidated"]:
                raise ValueError("Only the current verified result without active work can be accepted or retired")
            if op=="accept":
                if r["ownerSessionID"]!=q["coordinator"]["sessionID"]: raise ValueError("Only the main coordinator can accept a child result")
                # New direct input invalidates old completion even before a job checkpoint changes.
                inputs=[x for x in g["messages"] if x["jobID"]==m["jobID"] and x["kind"]=="intervention"]
                if inputs and inputs[-1]["interventionID"]!=m["interventionID"]:
                    raise ValueError("New child input requires inspection and a fresh result")
                m["accepted"]={"at":r["now"],"reason":r["reason"],"ownerSessionID":r["ownerSessionID"]}
            else:
                if not m.get("accepted"): raise ValueError("Coordinator has not accepted this result")
                m["retiredAt"]=r["now"]
                m.pop("error",None)
        save(); result=g
    elif op=="finish":
        if any(m["delivery"] in ["dispatching","uncertain"] for m in g["messages"]): raise ValueError("Inspect pending delivery before finishing")
        if not all(any(m["jobID"]==i["jobID"] and m.get("retiredAt") and current(m) for m in g["messages"]) for i in q["items"]):
            raise ValueError("Every group issue must have a current accepted and retired result")
        g["finished"]=True; save(); result=g
    print(json.dumps(result))
`;

export class GroupStore {
  constructor(readonly jobs: JobStore) {}
  private call<T>(op: string, input: object): T {
    try {
      return JSON.parse(execFileSync("python3", ["-c", SQL, this.jobs.path, op], {
        input: JSON.stringify(input), encoding: "utf8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      })) as T;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw new Error(stderr.match(/ValueError: (.*)/)?.[1] ?? "Group journal unavailable; inspect before continuing");
    }
  }
  get(id: string): GroupState { return this.call("get", { id }); }
  claim(id: string, process: string, previous?: string): GroupState | undefined {
    return this.call<GroupState | null>("claim", { id, process, previous, token: randomUUID() }) ?? undefined;
  }
  release(id: string, token: string): void { this.call("release", { id, token }); }
  observe(id: string, message: GroupMessage): GroupState { return this.call("observe", { id, message }); }
  dispatch(id: string, token: string, now = new Date()): GroupMessage | undefined {
    return this.call<GroupMessage | null>("dispatch", { id, token, now: now.toISOString() }) ?? undefined;
  }
  delivery(id: string, messageID: string, expected: GroupMessage["delivery"], delivery: GroupMessage["delivery"], reason?: string, now = new Date()): GroupState {
    return this.call("delivery", { id, messageID, expected, delivery, reason, now: now.toISOString() });
  }
  accept(id: string, messageID: string, reason: string, ownerSessionID: string, now = new Date()): GroupState {
    if (!reason.trim() || reason.length > 4000) throw new Error("Acceptance requires a bounded inspection reason");
    return this.call("accept", { id, messageID, reason, ownerSessionID, now: now.toISOString() });
  }
  retired(id: string, messageID: string, now = new Date()): GroupState { return this.call("retired", { id, messageID, now: now.toISOString() }); }
  retirementError(id: string, messageID: string, reason: string): void { this.call("retirement-error", { id, messageID, reason }); }
  finish(id: string): GroupState { return this.call("finish", { id }); }
}
