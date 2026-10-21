import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { chooseAgent } from "./agents.js";
import { resolveConfig } from "./config.js";
import { originRemote, repositoryRoot } from "./git.js";
import { fetchLinearCloseoutIssue, fetchIssue, inferBackend, normalizeIdentifier } from "./issue.js";
import { acceptance, createJob, JobStore } from "./lifecycle.js";
import { BanyanLifecycleAdapter, githubRepository } from "./lifecycle-adapter.js";
import { assertQueueIssue, prepareQueue, queueStatus } from "./queue.js";
import { QueueStore } from "./queue-store.js";

export async function queueCLI(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help")) {
    console.log(`workit queue create MANIFEST.json
workit queue list
workit queue status ID
workit queue start|pause|cancel ID --expected-revision N
workit queue release ID --item KEY --reason TEXT --expected-revision N
workit queue reconcile ID --item KEY --outcome delivered|abandoned --reason TEXT --expected-revision N
Creation saves a paused explicit allowlist. Start uses the existing heartbeat.
Budgets limit agent starts and follow-up dispatch attempts, not tokens or money.
Pause/deadline stop future dispatches; already-running turns are not killed.
Inspect uncertain launches before reconciliation. They never replay automatically.`);
    return;
  }
  const jobs = new JobStore(), queues = new QueueStore(jobs);
  const [action, id, ...rest] = args;
  if (action === "create" && id && !rest.length) {
    const queue = await prepareQueue(JSON.parse(readFileSync(resolve(id), "utf8")), async item => {
      const repo = realpathSync(repositoryRoot(item.repo)), remote = originRemote(repo);
      const resolved = resolveConfig(repo, { remote });
      const provider = inferBackend(item.issue, item.provider ?? resolved.config.provider);
      const issue = provider === "linear" ? await fetchLinearCloseoutIssue(normalizeIdentifier(item.issue), resolved.config)
        : await fetchIssue(provider, normalizeIdentifier(item.issue), resolved.config, repo);
      const delivery = item.delivery ?? resolved.config.lifecycle?.delivery ?? "implementation";
      const verification = item.verification ?? resolved.config.lifecycle?.verification ?? "deployed";
      const deploymentTarget = item.deploymentTarget ?? resolved.config.lifecycle?.deploymentTarget;
      // Validate acceptance and trusted target configuration without creating a
      // worktree or claiming the issue. A real investigation pin is read at launch.
      createJob({ issue, repoRoot: repo, worktree: repo, githubRepo: githubRepository(remote), agent: "preview",
        observedSourceSha: delivery === "investigation" ? "0".repeat(40) : undefined,
        config: { ...resolved.config.lifecycle, delivery, verification, deploymentTarget } });
      const agent = item.agent ? chooseAgent(resolved.config, item.agent, undefined, resolved.aliasIndex).name : undefined;
      return { repo, issue, delivery, verification, deploymentTarget, agent };
    }, [process.execPath, ...process.execArgv, resolve(process.argv[1])]);
    console.log(JSON.stringify(queueStatus(queues.create(queue), jobs), null, 2)); return;
  }
  if (action === "list" && !id) { console.log(JSON.stringify(queues.list().map(queue => queueStatus(queue, jobs)), null, 2)); return; }
  if (!id) throw new Error("Queue ID required; see queue --help");
  if (action === "status" && !rest.length) { console.log(JSON.stringify(queueStatus(queues.get(id), jobs), null, 2)); return; }
  const values: Record<string, string> = {};
  const allowed = action === "release" ? ["--expected-revision", "--item", "--reason"] : action === "reconcile" ? ["--expected-revision", "--item", "--outcome", "--reason"] : ["--expected-revision"];
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || rest[i + 1] === undefined || values[rest[i]] !== undefined) throw new Error("Invalid queue option");
    values[rest[i]] = rest[i + 1];
  }
  if (!/^\d+$/.test(values["--expected-revision"] ?? "")) throw new Error("Reread queue status and supply --expected-revision N");
  const revision = Number(values["--expected-revision"]);
  if (["start", "pause", "cancel"].includes(action)) {
    const state = action === "start" ? "active" : action === "pause" ? "paused" : "cancelled";
    console.log(JSON.stringify(queueStatus(queues.control(id, state, revision), jobs), null, 2)); return;
  }
  if (action === "release") {
    const item = queues.get(id).items.find(item => item.key === values["--item"]);
    if (!item || !values["--reason"]) throw new Error("Inspect session/process liveness and supply item and reason");
    console.log(JSON.stringify(queueStatus(queues.settle(id, item.jobID, values["--reason"], revision), jobs), null, 2)); return;
  }
  if (action === "reconcile") {
    const item = queues.get(id).items.find(item => item.key === values["--item"]);
    if (!item || !values["--reason"] || !["delivered", "abandoned"].includes(values["--outcome"])) throw new Error("Inspect the reservation and supply item, outcome and reason");
    console.log(JSON.stringify(queueStatus(queues.reconcile(id, item, values["--outcome"] as "delivered" | "abandoned", values["--reason"], revision), jobs), null, 2)); return;
  }
  throw new Error("Unknown queue action; see queue --help");
}

export async function queueLaunchBinding(jobs: JobStore, job: ReturnType<typeof createJob>) {
  const id = process.env.WORKIT_QUEUE_ID, token = process.env.WORKIT_QUEUE_LAUNCH_ID;
  if (!id && !token) { jobs.insert(job); return job; }
  if (!id || !token) throw new Error("Incomplete queue launch reservation");
  const fresh = await new BanyanLifecycleAdapter().currentIssue(job);
  assertQueueIssue(fresh);
  job.issue = fresh; Object.assign(job, acceptance(fresh.body));
  return new QueueStore(jobs).attach(id, token, job);
}
