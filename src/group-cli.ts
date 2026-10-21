import { JobStore, processIdentity, processIsAlive } from "./lifecycle.js";
import { GroupStore } from "./group-store.js";
import { BanyanGroupAdapter, tellGroupChild } from "./group.js";
import { QueueStore } from "./queue-store.js";
import { queueCLI } from "./queue-cli.js";
import { queueStatus } from "./queue.js";

export async function groupCLI(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help")) {
    console.log(`workit group create MANIFEST.json
workit group list
workit group status|inbox ID
workit group start|pause|cancel ID --expected-revision N
workit group tell ID --item KEY --text TEXT
workit group accept ID --message MESSAGE_ID --reason TEXT
workit group reconcile ID --message MESSAGE_ID --outcome delivered|not-delivered --reason TEXT
workit group finish ID
The queue manifest must include coordinator: {sessionID: "existing-main-session"}.
Owner notifications share maxContinuations with worker dispatches.
Only accepted, current verified results may retire their child into history.
finish requires every issue accepted and retired; it releases the main session for another group.
Existing jobs are never silently adopted. Use queue recovery commands for uncertain launches.`);
    return;
  }
  if (["create", "start", "pause", "cancel"].includes(args[0])) { await queueCLI(args, true); return; }
  const jobs = new JobStore(), queues = new QueueStore(jobs), groups = new GroupStore(jobs);
  const [action, id, ...rest] = args;
  if (action === "list" && !id) {
    console.log(JSON.stringify(queues.list().filter(queue => queue.coordinator).map(queue => ({ ...queueStatus(queue, jobs), group: groups.get(queue.id) })), null, 2)); return;
  }
  if (!id) throw new Error("Group ID required");
  const queue = queues.get(id), group = groups.get(id);
  if (["status", "inbox"].includes(action) && !rest.length) {
    console.log(JSON.stringify(action === "inbox" ? group.messages : { ...queueStatus(queue, jobs), group }, null, 2)); return;
  }
  const values: Record<string, string> = {};
  const allowed = action === "tell" ? ["--item", "--text"] : action === "accept" ? ["--message", "--reason"] : action === "reconcile" ? ["--message", "--reason", "--outcome"] : [];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || rest[i + 1] === undefined || values[rest[i]] !== undefined) throw new Error("Invalid group option");
    values[rest[i]] = rest[i + 1];
  }
  const adapter = new BanyanGroupAdapter();
  const ownerSessionID = await adapter.requireOwner(queue);
  if (action === "tell" && values["--item"] && values["--text"] && Object.keys(values).length === 2) {
    console.log(JSON.stringify(tellGroupChild(jobs, queue, values["--item"], values["--text"]), null, 2)); return;
  }
  if (action === "accept" && values["--message"] && values["--reason"] && !values["--outcome"]) {
    console.log(JSON.stringify(groups.accept(id, values["--message"], values["--reason"], ownerSessionID), null, 2)); return;
  }
  if (action === "reconcile") {
    const message = group.messages.find(message => message.id === values["--message"]);
    if (!message?.sequence || !["uncertain", "dispatching"].includes(message.delivery) || !values["--reason"]?.trim() ||
        !["delivered", "not-delivered"].includes(values["--outcome"])) throw new Error("Inspect the original pending delivery and supply its message, outcome and reason");
    if (group.claim && processIsAlive(group.claim.process)) throw new Error("A group tick owns reconciliation; wait for it to finish");
    const claimed = groups.claim(id, processIdentity(), group.claim?.token);
    if (!claimed?.claim) throw new Error("Group ownership changed; inspect again");
    try {
    const receipt = await adapter.receipt(queue);
    if (receipt.wake?.id === message.id) {
      await adapter.control(queue, "resolve", ["--revision", String(message.sequence), "--wake-id", message.id,
        "--outcome", values["--outcome"], "--detail", values["--reason"]]);
    } else if (values["--outcome"] !== "not-delivered") throw new Error("No matching native receipt; cannot claim delivery");
    console.log(JSON.stringify(groups.delivery(id, message.id, message.delivery,
      values["--outcome"] === "delivered" ? "delivered" : "pending", values["--reason"]), null, 2)); return;
    } finally { groups.release(id, claimed.claim.token); }
  }
  if (action === "finish" && !rest.length) {
    // Save completion first. If release fails, a repeated finish retries it.
    const result = groups.finish(id);
    await adapter.control(queue, "release");
    console.log(JSON.stringify(result, null, 2)); return;
  }
  throw new Error("Unknown group action; see workit group --help");
}
