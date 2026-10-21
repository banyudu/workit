import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BanyanLifecycleAdapter } from "./lifecycle-adapter.js";
import { JobStore, acceptance, assertLocalAcceptance, checkpoint, controlCommand, parseVerificationMode, setVerificationMode, verificationInstructions, stages, tick, type Job, type Stage } from "./lifecycle.js";
import { attention, checkVerification, completeVerification, correctAcceptance, readableAttention, reconcileVerifier } from "./closeout.js";
import { closeoutJob } from "./lifecycle-closeout.js";
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
async function project(store: JobStore, adapter: BanyanLifecycleAdapter, job: Job): Promise<"confirmed" | "pending"> {
  try {
    await adapter.project(job);
    if (store.acknowledgeProjection(job)) { job.projectedRevision = job.revision; return "confirmed"; }
  } catch { /* durable change retained */ }
  console.error("workit: checkpoint saved; Banyan projection will be retried by the heartbeat"); return "pending";
}
export async function lifecycleCLI(args: string[]): Promise<void> {
  if (args[0] === "heartbeat") { heartbeatCLI(args.slice(1)); return; }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`workit tick [--job ID]
workit job list
workit job status ID
workit job attention [--format json|text]
workit job acceptance ID
workit job acceptance ID --profile local|deployed --reason TEXT --expected-revision N --expected-ac-hash HASH
workit job verifier-reconcile ID --run-id ID --outcome delivered|not-delivered|completed --reason TEXT --expected-revision N
workit job checkpoint ID --stage STAGE --detail TEXT [--pr URL] [--merge-sha SHA] [--after SECONDS] [--verification local|deployed] [--tracker-completion human|automatic]
workit job pause ID --detail TEXT [--expected-revision N] [--expected-session-id SESSION_ID]
workit job cancel ID --detail TEXT
workit job resume ID [--detail TEXT] [--verification local|deployed]
workit job reconcile ID --delivery delivered|not-delivered --detail TEXT
workit job refresh-deployment ID
workit job verify ID --report PATH
workit job closeout ID
workit heartbeat install [--interval 60] | uninstall | status
Stages: ${stages.join(", ")}
Managed launches: workit --managed [--verification local|deployed] ISSUE (Banyan only)
State: $WORKIT_STATE_DIR/lifecycle.sqlite; python3 + sqlite3 required.
The heartbeat never grants merge/deployment authority.`);
    console.log(`Verification report contract (see docs/managed-delivery.md):
{jobID, issueURL, acHash, mergeSha, checkedAt, reviewer: {runID, independent: true},
 deployment?: {environment, target, sourceSha, version},
 criteria: [{label, status: "pass"|"fail"|"blocked", evidence: [{kind, reference, observed, deployment?, confirmedBy?}]}]}
Use exact labels/hash from job status, unique AC entries, and an independent verifier's observations.
Linear accepts partial reports: evidenced passes check ACs, evidenced failures uncheck them, and omitted/blocked results leave boxes unchanged.
Partial reports leave the issue state unchanged and job verifying; completion still requires a complete passing report.
Deployed acceptance requires journey evidence bound to the observed serving version.
Human ACs require human evidence with confirmedBy and a reference to actual confirmation.
Validated Linear closeout automatically checks proven ACs and completes the actual team workflow.
Retry/reconcile one job with job closeout ID; stored evidence is revalidated against current AC/source/version.
Local acceptance skips deployment checks and still requires complete independent AC evidence.
--verification overrides this job only; include local acceptance coverage in --detail when correcting a job.`);
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
  if (action === "attention") {
    const values = options(args.slice(2)); only(values, ["--format"]);
    if (values["--format"] && !["json", "text"].includes(values["--format"])) throw new Error("attention --format requires json or text");
    const view = attention(store.list());
    console.log(values["--format"] === "text" ? readableAttention(view) : JSON.stringify(view, null, 2)); return;
  }
  if (!id) throw new Error("workit job requires an action and job ID; see workit job --help");
  const values = options(rest);
  let job: Job;
  let projection: "confirmed" | "pending" | undefined;
  switch (action) {
    case "status":
      only(values, []); job = store.get(id); break;
    case "acceptance": {
      only(values, ["--profile", "--reason", "--expected-revision", "--expected-ac-hash"]);
      if (!Object.keys(values).length) {
        const current = store.get(id);
        const issue = await adapter.currentIssue(current);
        let localEligible = true;
        try { assertLocalAcceptance(issue.body); } catch { localEligible = false; }
        console.log(JSON.stringify({ jobID: id, revision: current.revision, profile: current.config.verification,
          boundAcHash: current.acHash, current: acceptance(issue.body), localEligible }, null, 2)); return;
      }
      if (!/^\d+$/.test(values["--expected-revision"] ?? "")) throw new Error("acceptance requires --expected-revision N");
      const expected = store.get(id);
      if (expected.revision !== Number(values["--expected-revision"])) throw new Error("Job revision mismatch; reread before correcting acceptance");
      const issue = await adapter.currentIssue(expected);
      job = correctAcceptance(store, id, { profile: values["--profile"] as "local" | "deployed", reason: values["--reason"],
        expectedRevision: Number(values["--expected-revision"]), expectedAcHash: values["--expected-ac-hash"] }, issue);
      await project(store, adapter, job); break;
    }
    case "verifier-reconcile":
      only(values, ["--run-id", "--outcome", "--reason", "--expected-revision"]);
      if (!/^\d+$/.test(values["--expected-revision"] ?? "")) throw new Error("verifier-reconcile requires --expected-revision N");
      job = reconcileVerifier(store, id, { runID: values["--run-id"], outcome: values["--outcome"], reason: values["--reason"], expectedRevision: Number(values["--expected-revision"]) });
      await project(store, adapter, job); break;
    case "checkpoint":
      only(values, ["--stage", "--detail", "--pr", "--merge-sha", "--after", "--verification", "--tracker-completion"]);
      if (!values["--stage"] || !values["--detail"]?.trim()) throw new Error("checkpoint requires --stage and --detail");
      job = checkpoint(store, id, { stage: values["--stage"] as Stage, detail: values["--detail"],
        pr: values["--pr"], mergeSha: values["--merge-sha"],
        verification: values["--verification"] === undefined ? undefined : parseVerificationMode(values["--verification"]),
        trackerCompletion: values["--tracker-completion"] as "human" | "automatic" | undefined,
        after: values["--after"] === undefined ? undefined : Number(values["--after"]) });
      await project(store, adapter, job); break;
    case "pause":
    case "cancel":
      only(values, action === "pause" ? ["--detail", "--expected-revision", "--expected-session-id"] : ["--detail"]);
      if (!values["--detail"]?.trim()) throw new Error("--detail is required for pause/cancel");
      if (values["--expected-revision"] !== undefined && !/^\d+$/.test(values["--expected-revision"])) throw new Error("--expected-revision must be a non-negative integer");
      job = checkpoint(store, id, { stage: action === "pause" ? "paused" : "cancelled", detail: values["--detail"],
        expectedRevision: values["--expected-revision"] === undefined ? undefined : Number(values["--expected-revision"]),
        expectedSessionID: values["--expected-session-id"] });
      projection = await project(store, adapter, job); break;
    case "resume":
      only(values, ["--detail", "--verification"]);
      if (values["--verification"] !== undefined && !values["--detail"]?.trim()) throw new Error("--detail must explain the verification-mode correction");
      job = store.update(id, current => {
        if (!["paused", "needs-you"].includes(current.stage)) throw new Error("Only paused/human-blocked jobs can be resumed");
        if (current.wake) throw new Error("Pending wake requires inspected job reconcile before resume");
        if (current.verifier && ["reserved", "uncertain", "invalidated"].includes(current.verifier.state)) throw new Error("Pending verifier requires inspected job verifier-reconcile before resume");
        if (values["--verification"] !== undefined) setVerificationMode(current, values["--verification"]);
        current.stage = current.deployment || (current.mergeSha && current.config.verification === "local") ? "verifying"
          : current.mergeSha ? "waiting-deploy" : current.pr ? "waiting-ci" : "implementing";
        current.detail = values["--detail"] ?? "Explicitly resumed";
        current.nextWakeAt = new Date().toISOString(); current.errors = 0; current.wakeups = 0;
        delete current.claim; delete current.holdDetail; delete current.blocker;
      });
      await project(store, adapter, job); break;
    case "reconcile": {
      only(values, ["--delivery", "--detail"]);
      const expected = store.get(id);
      const outcome = values["--delivery"];
      if (!["paused", "needs-you"].includes(expected.stage) || !expected.wake ||
          !["delivered", "not-delivered"].includes(outcome) || !values["--detail"]?.trim()) {
        throw new Error("Inspect the original conversation first; reconcile requires a paused/human-blocked pending wake, --delivery and --detail");
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
    case "refresh-deployment": {
      only(values, []);
      const expected = store.get(id);
      if (!["waiting-deploy", "verifying"].includes(expected.stage) || expected.wake || expected.claim)
        throw new Error("Deployment refresh requires an unheld post-merge job without a pending wake or claim");
      if (expected.config.verification === "local") throw new Error("Local verification has no serving deployment");
      const pr = await adapter.pr(expected);
      if (!pr.merged || pr.mergeSha !== expected.mergeSha)
        throw new Error("GitHub does not establish the expected merged source");
      const deployment = await adapter.deployment(expected);
      if (!deployment || !await adapter.containsMerge(expected, deployment.sourceSha))
        throw new Error("Serving deployment does not establish the merged source");
      job = store.update(id, current => {
        if (current.revision !== expected.revision || current.stage !== expected.stage ||
            current.pr !== expected.pr || current.mergeSha !== expected.mergeSha || current.wake || current.claim)
          throw new Error("Job changed during deployment refresh; reread and retry");
        current.deployment = deployment;
        current.stage = "verifying";
        delete current.verification;
        delete current.closeout;
        delete current.trackerDone;
        current.detail = "Trusted serving deployment refreshed; independent acceptance evidence is still required";
      });
      await project(store, adapter, job); break;
    }
    case "verify":
    case "closeout": {
      only(values, action === "verify" ? ["--report"] : []);
      if (action === "verify" && !values["--report"]) throw new Error("verify requires --report PATH");
      try {
        job = await closeoutJob(store, adapter, id, action === "verify"
          ? { report: JSON.parse(readFileSync(resolve(values["--report"]), "utf8")) } : { reconcile: true });
      } catch (error) {
        // In particular, remove an older verified badge when reconciliation fails.
        await project(store, adapter, store.get(id));
        throw error;
      }
      await project(store, adapter, job); break;
    }
    default: throw new Error("Unknown job action; see workit job --help");
  }
  console.log(JSON.stringify(projection ? { ...job, projection: { status: projection, sessionID: job.sessionID, revision: job.revision } } : job, null, 2));
}

export function managedInstructions(job: Job): string[] {
  return [
    `CLI for all checkpoint/status/verify commands in this job: ${controlCommand(job)}.`,
    `You own managed workit job ${job.id} through verified issue completion, not just a PR. Banyan session: ${job.sessionID}.`,
    "Read repository instructions and the current ACs. Establish acceptance probes before implementation, preverify locally, repair review/CI, merge only when authorized, then independently verify the applicable acceptance criteria.",
    ...verificationInstructions(job),
    "Do not create a native goal or scheduled task for this managed issue: workit owns continuation and its heartbeat. Preserve human holds and deployment authorization; this launch does not authorize a deployment.",
    `Use workit job status ${job.id} to read durable state. Before ending a turn, use workit job checkpoint ${job.id} --stage STAGE --detail TEXT, with --pr URL and --merge-sha FULL_SHA when known.`,
    "Use waiting-ci or waiting-deploy for external waits; use needs-you for missing authority, auth, tools, ambiguous recovery or irreducible human acceptance. Do not leave an active goal repeatedly polling an external wait.",
    `Completion requires an independent verification report accepted by workit job verify ${job.id} --report PATH. Source, merge, deployment, journey and issue closeout are separate claims. After validated acceptance, workit automatically synchronizes proven Linear AC checkboxes, resolves the actual team completed state, and confirms both by readback before marking verified. No extra approval is needed for this managed closeout; owner holds and real human acceptance remain authoritative. GitHub closeout still follows repository policy.`,
    `Submit independent partial progress with workit job verify ${job.id} --report PATH even while other ACs are omitted, failed or blocked. Only evidenced pass/fail checkbox states synchronize; the job stays verifying and the issue state is unchanged until a complete passing report meets every completion gate. Existing checked boxes never substitute for missing report evidence.`,
    `Retry interrupted tracker effects with workit job closeout ${job.id}; it revalidates the stored independent report and can reconcile an older verified-but-open job. Fresh reads detect observable conflicts; Linear has no conditional description update, so concurrent edits in the final read/write window remain a race. Inspect conflicts before retrying.`,
    "Use workit job --help for the verification report contract. If the serving version changes during verification, checkpoint waiting-deploy to refresh it and rerun the affected acceptance probes before submitting new evidence.",
    "The job is not complete when your process exits. Fix failed acceptance in a follow-up PR and refresh the merge/deployment checkpoint before verifying again.",
  ];
}
