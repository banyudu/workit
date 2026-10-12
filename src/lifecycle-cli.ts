import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { JobStore, checkpoint, controlCommand, issueFinished, stages, tick, validateReport, type Job, type Stage } from "./lifecycle.js";
import { heartbeatCLI } from "./heartbeat.js";

function options(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined) throw new Error("Options require --name value pairs");
    if (values[args[i]] !== undefined) throw new Error("Duplicate option " + args[i]);
    values[args[i]] = args[i + 1];
  }
  return values;
}
function only(values: Record<string, string>, allowed: string[]): void {
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error("Unknown option " + key);
}
async function project(store: JobStore, adapter: BanyanLifecycleAdapter, job: Job): Promise<void> {
  try { await adapter.project(job); store.acknowledgeProjection(job); }
  catch { console.error("workit: checkpoint saved; Banyan projection will be retried by the heartbeat"); }
}
export async function lifecycleCLI(args: string[]): Promise<void> {
  if (args[0] === "heartbeat") { heartbeatCLI(args.slice(1)); return; }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`workit tick [--job ID]
workit job list
workit job status ID
workit job checkpoint ID --stage STAGE --detail TEXT [--pr URL] [--merge-sha SHA] [--after SECONDS]
workit job pause|cancel ID --detail TEXT
workit job resume ID [--detail TEXT]
workit job reconcile ID --delivery delivered|not-delivered --detail TEXT
workit job verify ID --report PATH
workit heartbeat install [--interval 60] | uninstall | status
Stages: ${stages.join(", ")}
Managed launches: workit --managed ISSUE (Banyan only)
State: $WORKIT_STATE_DIR/lifecycle.sqlite; python3 + sqlite3 required.
The heartbeat never grants merge/deployment authority.`);
    console.log(`Verification report contract (see docs/managed-delivery.md):
{jobID, issueURL, acHash, mergeSha, checkedAt, reviewer: {runID, independent: true},
 deployment?: {environment, target, sourceSha, version},
 criteria: [{label, status: "pass", evidence: [{kind, reference, observed, deployment?}]}]}
Use exact labels/hash from job status, one entry per AC, and an independent verifier's observations.
Deployed acceptance requires journey evidence bound to the observed serving version.`);
    return;
  }
  const store = new JobStore();
  const adapter = new BanyanLifecycleAdapter();
  if (args[0] === "tick") {
    const values = options(args.slice(1)); only(values, ["--job"]);
    console.log(JSON.stringify(await tick(store, adapter, { jobID: values["--job"] })));
    return;
  }
  const [action, id, ...rest] = args.slice(1);
  if (action === "list" && !id) { console.log(JSON.stringify(store.list(), null, 2)); return; }
  if (!id) throw new Error("workit job requires an action and job ID; see workit job --help");
  const values = options(rest);
  let job: Job;
  switch (action) {
    case "status":
      only(values, []); job = store.get(id); break;
    case "checkpoint":
      only(values, ["--stage", "--detail", "--pr", "--merge-sha", "--after"]);
      if (!values["--stage"] || !values["--detail"]?.trim()) throw new Error("checkpoint requires --stage and --detail");
      job = checkpoint(store, id, { stage: values["--stage"] as Stage, detail: values["--detail"],
        pr: values["--pr"], mergeSha: values["--merge-sha"],
        after: values["--after"] === undefined ? undefined : Number(values["--after"]) });
      await project(store, adapter, job); break;
    case "pause":
    case "cancel":
      only(values, ["--detail"]);
      if (!values["--detail"]?.trim()) throw new Error("--detail is required for pause/cancel");
      job = checkpoint(store, id, { stage: action === "pause" ? "paused" : "cancelled", detail: values["--detail"] });
      await project(store, adapter, job); break;
    case "resume":
      only(values, ["--detail"]);
      job = store.update(id, current => {
        if (!["paused", "needs-you"].includes(current.stage)) throw new Error("Only paused/human-blocked jobs can be resumed");
        current.stage = current.deployment || (current.mergeSha && current.config.verification === "local") ? "verifying"
          : current.mergeSha ? "waiting-deploy" : current.pr ? "waiting-ci" : "implementing";
        current.detail = values["--detail"] ?? "Explicitly resumed";
        current.nextWakeAt = new Date().toISOString(); current.errors = 0; current.wakeups = 0;
        delete current.claim;
      });
      await project(store, adapter, job); break;
    case "reconcile": {
      only(values, ["--delivery", "--detail"]);
      const expected = store.get(id);
      const outcome = values["--delivery"];
      if (expected.stage !== "needs-you" || !expected.wake ||
          !["delivered", "not-delivered"].includes(outcome) || !values["--detail"]?.trim()) {
        throw new Error("Inspect the original conversation first; reconcile requires a human-blocked pending wake, --delivery and --detail");
      }
      await adapter.project(expected);
      await adapter.reconcile(expected, outcome, values["--detail"]);
      job = store.update(id, current => {
        if (current.revision !== expected.revision) throw new Error("Job changed during reconciliation; reread before resuming");
        current.lastRecovery = { wakeID: expected.wake!.id, outcome, detail: values["--detail"], at: new Date().toISOString() };
        delete current.wake; current.errors = 0;
        current.detail = "Wake reconciled; explicit job resume is still required";
      });
      await project(store, adapter, job); break;
    }
    case "verify": {
      only(values, ["--report"]);
      if (!values["--report"]) throw new Error("verify requires --report PATH");
      const expected = store.get(id);
      if (expected.stage !== "verifying") throw new Error("Job must be in verifying before completion");
      const pr = await adapter.pr(expected);
      if (!pr.merged || pr.mergeSha !== expected.mergeSha) throw new Error("GitHub does not establish the expected merged source");
      if (expected.config.verification !== "local") {
        const deployment = await adapter.deployment(expected);
        if (!deployment || JSON.stringify(deployment) !== JSON.stringify(expected.deployment) ||
            !await adapter.containsMerge(expected, deployment.sourceSha)) throw new Error("Serving deployment changed; rerun applicable verification");
      }
      const issue = await adapter.currentIssue(expected);
      const report = validateReport(expected, JSON.parse(readFileSync(resolve(values["--report"]), "utf8")), issue.body);
      if (!issueFinished(issue)) throw new Error("Acceptance evidence is valid; reconcile the issue's evidence/checklist and close it under repository policy, then retry");
      job = store.update(id, current => {
        if (current.stage !== expected.stage || current.acHash !== expected.acHash ||
            current.pr !== expected.pr || current.mergeSha !== expected.mergeSha ||
            JSON.stringify(current.deployment) !== JSON.stringify(expected.deployment)) {
          throw new Error("Job changed during verification; reread and retry");
        }
        current.verification = report; current.stage = "verified"; current.detail = "Every current AC has independent passing evidence";
        delete current.nextWakeAt; delete current.claim; delete current.wake;
      });
      await project(store, adapter, job); break;
    }
    default: throw new Error("Unknown job action; see workit job --help");
  }
  console.log(JSON.stringify(job, null, 2));
}

export function managedInstructions(job: Job): string[] {
  return [
    `CLI for all checkpoint/status/verify commands in this job: ${controlCommand(job)}.`,
    `You own managed workit job ${job.id} through verified issue completion, not just a PR. Banyan session: ${job.sessionID}.`,
    "Read repository instructions and the current ACs. Establish acceptance probes before implementation, preverify locally, repair review/CI, merge only when authorized, await the scheduled deployment, then independently verify the applicable deployed journeys.",
    "Do not create a native goal or scheduled task for this managed issue: workit owns continuation and its heartbeat. Preserve human holds and deployment authorization; this launch does not authorize a deployment.",
    `Use workit job status ${job.id} to read durable state. Before ending a turn, use workit job checkpoint ${job.id} --stage STAGE --detail TEXT, with --pr URL and --merge-sha FULL_SHA when known.`,
    "Use waiting-ci or waiting-deploy for external waits; use needs-you for missing authority, auth, tools, ambiguous recovery or irreducible human acceptance. Do not leave an active goal repeatedly polling an external wait.",
    `Completion requires an independent verification report accepted by workit job verify ${job.id} --report PATH. Source, merge, deployment, journey and issue closeout are separate claims. After acceptance is proven, reconcile the issue's evidence/checklist and completed state under repository policy before submitting the report.`,
    "Use workit job --help for the verification report contract. If the serving version changes during verification, checkpoint waiting-deploy to refresh it and rerun the affected acceptance probes before submitting new evidence.",
    "The job is not complete when your process exits. Fix failed acceptance in a follow-up PR and refresh the merge/deployment checkpoint before verifying again.",
  ];
}
