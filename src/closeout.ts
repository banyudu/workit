import { QueueStore } from "./queue-store.js";
import { assertVerificationSource, assertVerificationDeployment, investigation, verificationSource, VerificationReadError, observe } from "./verification-source.js";
import { selectDeploymentTarget } from "./deployment-target.js";
import { assertTracker, TrackerHoldError } from "./tracker-policy.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SourceProvenanceError, acceptance, acceptanceCriteria, assertLocalAcceptance, dependencyIdentity, digest, issueFinished, provenChecklist, requiresHuman, runnableStage, sha, terminalStage, validateProgressReport, reportComplete, validateReport,
  type Blocker, type DeliveryKind, type LifecycleConfig, type Job, type JobStore, type LifecycleAdapter, type VerifierRun, type VerificationReport } from "./lifecycle.js";
import type { IssueDetails } from "./types.js";

export function correctAcceptance(store: JobStore, id: string, input: {
  profile: "local" | "deployed"; reason: string; expectedRevision: number; expectedAcHash: string;
  delivery?: DeliveryKind; target?: string; observedSourceSha?: string;
}, issue: IssueDetails, now = new Date(), trustedConfig?: LifecycleConfig): Job {
  if (!["local", "deployed"].includes(input.profile) || !input.reason?.trim() ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Acceptance correction requires a profile, reason and expected revision");
  const binding = acceptance(issue.body);
  if (binding.acHash !== input.expectedAcHash) throw new Error("Current AC binding is stale; reread the issue before correcting acceptance");
  if (input.profile === "local") assertLocalAcceptance(issue.body);
  return store.update(id, current => {
    if (current.revision !== input.expectedRevision) throw new Error("Job revision mismatch; reread before correcting acceptance");
    if (terminalStage(current.stage) || current.issue.url !== issue.url) throw new Error("Acceptance correction needs the current unfinished issue");
    const fromDelivery = current.config.delivery ?? "implementation";
    const delivery = input.delivery ?? fromDelivery;
    if (!["implementation", "investigation"].includes(delivery)) throw new Error("Unknown delivery kind");
    if (delivery === "investigation" && !sha(input.observedSourceSha)) throw new Error("Investigation correction needs a freshly observed source SHA");
    const target = input.target ? selectDeploymentTarget(trustedConfig ?? {}, input.target) : undefined;
    const nextConfig = { ...current.config, ...(target ? { deploymentTarget: target.deploymentTarget,
      deploymentProbe: target.deploymentProbe, deploymentBinding: target.deploymentBinding,
      deploymentDependency: target.deploymentDependency } : {}), delivery, verification: input.profile };
    if (input.profile === "deployed" && !nextConfig.deploymentProbe?.length) throw new Error("Deployed acceptance requires a trusted deployment probe");
    (current.acceptanceHistory ??= []).push({ from: current.config.verification ?? "deployed", to: input.profile,
      reason: input.reason.trim(), at: now.toISOString(), revision: current.revision + 1,
      oldAcHash: current.acHash, acHash: binding.acHash, fromDelivery, toDelivery: delivery,
      fromTarget: current.config.deploymentTarget, toTarget: nextConfig.deploymentTarget,
      priorPR: current.pr, priorSourceSha: verificationSource(current) });
    current.config = nextConfig;
    if (delivery === "investigation") {
      current.observedSourceSha = input.observedSourceSha;
      // This delivery contract records observations, not an implementation PR.
      delete current.pr; delete current.mergeSha; delete current.inReview;
    } else delete current.observedSourceSha;
    current.issue = issue; Object.assign(current, binding); current.acceptanceChangedAt = now.toISOString();
    delete current.deployment; delete current.verification; delete current.closeout; delete current.trackerDone; delete current.fingerprint; delete current.blocker;
    // Retain active/uncertain delivery audit and capacity until explicitly inspected.
    if (current.verifier) {
      if (["reserved", "running", "uncertain", "invalidated"].includes(current.verifier.state)) current.verifier.state = "invalidated";
      else { (current.verifierHistory ??= []).push(current.verifier); delete current.verifier; }
    }
    delete current.claim;
    if (current.wake || current.verifier?.state === "invalidated") {
      if (runnableStage(current.stage)) current.stage = "needs-you";
      current.detail = "Acceptance corrected; inspect pending delivery before explicitly resuming";
    }
    if (runnableStage(current.stage)) {
      const ready = !investigation(current) ? !!current.mergeSha
        : fromDelivery === "investigation" && ["verifying", "waiting-deploy"].includes(current.stage);
      current.stage = ready ? (input.profile === "local" ? "verifying" : "waiting-deploy")
        : investigation(current) ? "investigating" : "implementing";
      current.nextWakeAt = now.toISOString();
      current.detail = "Acceptance plan corrected; fresh independent evidence is required";
    } else delete current.nextWakeAt;
  }, now);
}

/** Read GitHub facts without touching session control, holds or wake receipts. */
export async function refreshHeldFacts(store: JobStore, adapter: LifecycleAdapter, expected: Job, now: Date): Promise<Job> {
  if (!expected.pr || (expected.facts && Date.parse(expected.facts.nextCheckAt) > now.getTime())) return expected;
  let facts: NonNullable<Job["facts"]> = { observedAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + (expected.config.intervalSeconds ?? 60) * 1000).toISOString() };
  try {
    facts.pr = await adapter.pr(expected);
    if (facts.pr.merged && !sha(facts.pr.mergeSha)) throw new Error("Missing merge source");
  } catch {
    delete facts.pr;
    facts.error = "GitHub facts unavailable; repair CLI authentication or connectivity and recheck";
  }
  try {
    return store.update(expected.id, current => {
      if (current.revision !== expected.revision) throw new Error("Job changed during fact refresh");
      current.facts = facts;
      if (facts.pr?.merged) {
        if (current.mergeSha !== facts.pr.mergeSha) { delete current.deployment; delete current.verification; delete current.closeout; delete current.trackerDone; }
        current.mergeSha = facts.pr.mergeSha;
        current.holdDetail ??= current.detail;
        current.detail = "Hold retained; GitHub confirms the PR is merged. Explicit resume is required";
      } else if (facts.pr && !facts.pr.ready) {
        current.holdDetail ??= current.detail;
        current.detail = "Hold retained; the PR is not currently ready. Inspect its latest head and checks";
      }
    }, now, { recordProgress: false });
  } catch { return store.get(expected.id); }
}

function blocker(job: Job, reason: Blocker["reason"], owner: Blocker["owner"], nextAction: string, recheckTrigger: string, dependency?: string): Blocker {
  return { reason, owner, nextAction, recheckTrigger, dependency, observedAt: job.facts?.observedAt ?? job.updatedAt };
}
export function jobBlockers(job: Job): Blocker[] {
  if (terminalStage(job.stage)) return job.verifier && ["reserved", "running", "uncertain", "invalidated"].includes(job.verifier.state)
    ? [blocker(job, "uncertain-delivery", "owner", "Inspect the in-flight verifier and reconcile its completed or not-delivered outcome to release capacity", "inspected-verifier-reconciliation")] : [];
  const result: Blocker[] = [];
  if (job.stage === "paused" || (job.stage === "needs-you" && (job.holdDetail || !job.blocker))) result.push(blocker(job, "owner-hold", "owner", "Inspect the saved hold and explicitly resume when released", "explicit-resume"));
  if ((job.wake && job.wake.delivery !== "not-delivered") || ["reserved", "uncertain", "invalidated"].includes(job.verifier?.state ?? "")) {
    result.push(blocker(job, "uncertain-delivery", "owner", "Inspect the original conversation or verifier receipt and reconcile delivery before resuming", "inspected-delivery-reconciliation"));
  }
  if (job.facts?.error) result.push(blocker(job, "runner-error", "system", job.facts.error, "next-fact-refresh"));
  if (job.blocker) result.push(["paused", "needs-you"].includes(job.stage)
    ? { ...job.blocker, nextAction: job.blocker.nextAction + "; explicitly resume only after inspecting and releasing the hold" } : job.blocker);
  else if (job.verifier?.state === "report-ready" && job.verifier.handoff && job.verification) {
    result.push(blocker(job, job.verifier.handoff === "repair" ? "acceptance-repair" : "tracker-closeout", "worker",
      job.verifier.handoff === "repair" ? "Read the retained independent report; repair proven failures or supply missing evidence within this issue's scope"
        : "Use the retained passing evidence to finish tracker closeout under current repository policy",
      "original-worker-checkpoint"));
  } else if (job.mergeSha || (investigation(job) && ["waiting-deploy", "verifying"].includes(job.stage))) {
    if (job.config.verification !== "local" && !job.deployment) result.push(blocker(job, "external-wait", "external",
      "Wait for the authorized deployment and its serving source/version probe", "deployment-probe-change",
      dependencyIdentity(job, "deployment")));
    else result.push(blocker(job, "missing-verifier", "verifier", "Submit an independent complete report with job verify, or opt in to trusted verifier dispatch", "independent-report"));
  } else if (job.facts?.pr && !job.facts.pr.merged) {
    result.push(blocker(job, job.facts.pr.ready ? "acceptance-decision" : "external-wait", job.facts.pr.ready ? "owner" : "external",
      job.facts.pr.ready ? "Assess repository policy and merge only with existing authority" : "Inspect the latest PR head, conflicts and checks", "github-fact-change"));
  } else if (job.errors) result.push(blocker(job, "runner-error", "system", "Repair the runner or tool and inspect delivery receipts before retrying", "tool-repaired"));
  return result;
}
export function attention(jobs: Job[]): {
  items: Array<Blocker & { key: string; jobIDs: string[] }>;
  jobs: Array<{ id: string; stage: Job["stage"]; facts?: Job["facts"]; nextWakeAt?: string }>;
} {
  const groups = new Map<string, Blocker & { key: string; jobIDs: string[] }>();
  for (const job of jobs) for (const item of jobBlockers(job)) {
    const key = `${item.reason}:${item.owner}:${item.dependency ?? job.id}`;
    const found = groups.get(key);
    if (found) { if (!found.jobIDs.includes(job.id)) found.jobIDs.push(job.id); }
    else groups.set(key, { ...item, key, jobIDs: [job.id] });
  }
  return { items: [...groups.values()], jobs: jobs.filter(job => !terminalStage(job.stage) || jobBlockers(job).length).map(job => ({
    id: job.id, stage: job.stage, facts: job.facts, nextWakeAt: job.nextWakeAt,
  })) };
}
export function readableAttention(view: ReturnType<typeof attention>): string {
  const facts = view.jobs.map(job => {
    const pr = job.facts?.pr;
    const state = pr ? pr.merged ? " PR merged" : ` PR ${pr.ready ? "ready for policy assessment" : "not ready"} (${pr.mergeState ?? "checks/review pending"})` : "";
    return `${job.id} [${job.stage}]${state}`;
  });
  const items = view.items.map(item => `${item.owner}: ${item.reason} (${item.jobIDs.length} job${item.jobIDs.length === 1 ? "" : "s"})\n  ${item.jobIDs.join(", ")}\n  Next: ${item.nextAction}\n  Recheck: ${item.recheckTrigger}`);
  return [...facts, ...items].join("\n") || "No unfinished closeout dependencies.";
}

export async function checkVerification(adapter: LifecycleAdapter, expected: Job, value: unknown, now = new Date(), progress = false): Promise<{ report: VerificationReport; finished: boolean; complete: boolean; humanPending: boolean }> {
  if (expected.stage !== "verifying") throw new Error("Job must be in verifying before completion");
  if (expected.verifier && ["reserved", "running", "uncertain", "invalidated", "report-ready"].includes(expected.verifier.state) &&
      (expected.verifier.state === "invalidated" || (value as VerificationReport)?.reviewer?.runID !== expected.verifier.id)) throw new Error("Reconcile the existing verifier before replacing its report or identity");
  if (!adapter.currentIssue) throw new Error("Current issue reader unavailable");
  await assertVerificationSource(adapter, expected);
  await assertVerificationDeployment(adapter, expected);
  const issue = await observe(() => adapter.currentIssue!(expected));
  assertTracker(expected, issue);
  const report = (progress ? validateProgressReport : validateReport)(expected, value, issue.body, now);
  const complete = reportComplete(expected, report);
  const humanPending = acceptanceCriteria(issue.body).some((criterion, index) => requiresHuman(criterion) &&
    report.criteria.find(item => item.label === expected.acLabels[index])?.status !== "pass");
  return { report, complete, humanPending, finished: complete && issueFinished(issue) && (issue.backend !== "linear" || provenChecklist(issue.body, expected.acLabels) === issue.body) };
}
export function completeVerification(store: JobStore, expected: Job, report: VerificationReport, now = new Date()): Job {
  return store.update(expected.id, current => {
    if (current.revision !== expected.revision || current.stage !== "verifying") throw new Error("Job changed during verification; reread and retry");
    current.verification = report; current.stage = "verified"; current.detail = "Every current AC has independent passing evidence";
    if (current.verifier?.id === report.reviewer.runID) current.verifier.state = "accepted";
    delete current.nextWakeAt; delete current.claim; delete current.wake; delete current.blocker;
  }, now);
}

export function verifierBinding(job: Job): string {
  return digest(JSON.stringify([job.acHash, verificationSource(job), job.config.delivery, job.config.deploymentTarget, job.config.verification, job.acceptanceChangedAt, job.deployment]));
}
function readArtifact(path: string): unknown {
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error("Verifier artifact exceeds the bounded report size");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Called only under the ordinary per-job heartbeat claim. No implementer replay. */
export async function coordinateVerification(store: JobStore, adapter: LifecycleAdapter, expected: Job, now: Date, dispatchNow: () => Date = () => new Date(), readExistingOnly = false): Promise<string | undefined> {
  let job = expected;
  const save = (change: (current: Job) => void) => {
    job = store.update(job.id, current => {
      if (current.revision !== job.revision || current.claim?.token !== job.claim?.token || current.stage !== "verifying") throw new Error("Job changed during verifier coordination");
      change(current);
    }, now);
  };
  const wait = (reason: Blocker["reason"], owner: Blocker["owner"], nextAction: string, trigger: string, result: string) => {
    save(current => {
      current.blocker = { reason, owner, nextAction, recheckTrigger: trigger, observedAt: now.toISOString(),
        dependency: reason === "source-provenance" ? dependencyIdentity(current, "provenance") : undefined };
      current.nextWakeAt = new Date(now.getTime() + (current.config.intervalSeconds ?? 60) * 1000).toISOString();
    });
    return result;
  };
  const ownerHold = (completedOutcome = false) => {
    save(current => {
      if (completedOutcome && current.verifier) current.verifier.state = "report-ready";
      current.stage = "needs-you"; current.holdDetail = "Current tracker issue has an explicit owner hold";
      current.detail = "Retained verifier outcome; release the tracker hold and explicitly resume before continuing";
      current.blocker = { reason: "owner-hold", owner: "owner", observedAt: now.toISOString(), recheckTrigger: "owner-hold-released", nextAction: "Release the actual issue hold and explicitly resume; do not rerun verification to bypass it" };
      delete current.nextWakeAt;
    });
    return "owner-hold";
  };
  const uncertain = () => {
    save(current => {
      if (current.verifier && current.verifier.state !== "invalidated") current.verifier.state = "uncertain";
      current.stage = "needs-you"; current.detail = "Verifier delivery is uncertain; inspect its original session and reconcile before resuming";
      current.blocker = { reason: "uncertain-delivery", owner: "owner", observedAt: now.toISOString(), recheckTrigger: "inspected-verifier-reconciliation", nextAction: "Inspect the persisted verifier identity, report and outcome; use job verifier-reconcile" };
      delete current.nextWakeAt;
    });
    return "verifier-uncertain";
  };
  if (job.verifier?.state === "report-ready" && job.verifier.binding !== verifierBinding(job)) {
    save(current => {
      (current.verifierHistory ??= []).push(current.verifier!); delete current.verifier;
      delete current.verification; delete current.closeout; delete current.trackerDone;
    });
    if (readExistingOnly) return "verifier-binding-refreshed";
  }
  const run = job.verifier;
  if (run && ["reserved", "uncertain", "invalidated"].includes(run.state)) return uncertain();
  if (run && ["running", "report-ready"].includes(run.state)) {
    if (run.binding !== verifierBinding(job)) return uncertain();
    if (existsSync(run.outcomePath)) {
      let outcome: { status?: string };
      try { outcome = readArtifact(run.outcomePath) as { status?: string }; }
      catch { return uncertain(); }
      if (outcome?.status === "failed") {
        save(current => { current.verifier!.state = "failed"; });
        return wait("runner-error", "system", "Inspect verifier logs and repair the tool; retries remain bounded", "retry-budget-and-backoff", "verifier-failed");
      }
      if (outcome?.status !== "complete") return uncertain();
      if (!existsSync(run.reportPath)) {
        save(current => { current.verifier!.state = "failed"; });
        return wait("runner-error", "verifier", "Verifier finished without a report; repair the report handoff", "retry-budget-and-backoff", "verifier-report-missing");
      }
      try {
        const value = readArtifact(run.reportPath) as VerificationReport;
        if (value?.reviewer?.runID !== run.id) throw new Error("Verifier identity mismatch");
        const checked = await checkVerification(adapter, job, value, now, true);
        if (checked.finished) { job = completeVerification(store, job, checked.report, now); return "verified"; }
        save(current => {
          current.verifier!.state = "report-ready"; current.verification = checked.report;
          if (checked.complete && current.issue.backend === "linear") current.closeout ??= {};
          if (!checked.complete) {
            if (!checked.humanPending) current.verifier!.handoff = "repair";
            current.detail = "Independent report retained; inspect failed, blocked or missing evidence and continue this issue under its existing scope";
            current.stage = checked.humanPending ? "needs-you" : investigation(current) ? "investigating" : "fixing";
            if (checked.humanPending) {
              current.holdDetail = "Current acceptance requires actual human confirmation";
              current.blocker = { reason: "acceptance-decision", owner: "owner", observedAt: now.toISOString(), recheckTrigger: "human-acceptance-evidence", nextAction: "Obtain the required actual human confirmation before explicitly resuming" };
              delete current.nextWakeAt;
            } else delete current.blocker;
          }
        });
        if (!checked.complete) return checked.humanPending ? "owner-acceptance-required" : undefined;
        if (job.issue.backend === "linear" || job.config.trackerCompletion === "human")
          return wait("tracker-closeout", "owner", "Independent evidence passed; reconcile the issue checklist and completed state under repository policy", "tracker-state-change", "awaiting-tracker-closeout");
        // The ordinary worker owns policy-sensitive tracker closeout. Return to
        // its normal wake path, which still checks liveness and queue authority.
        save(current => { current.verifier!.handoff = "tracker"; current.detail = "Independent acceptance passed; close the GitHub issue only under repository policy, then reconcile this report"; });
        return undefined;
      } catch (error) {
        if (error instanceof TrackerHoldError) return ownerHold(true);
        if (error instanceof SourceProvenanceError) return wait("source-provenance", "external", "Repair the actual serving source/version binding before accepting evidence", "serving-provenance-repaired", "serving-binding-stale");
        if (error instanceof VerificationReadError) {
          return wait("runner-error", "system", "Current issue, PR or deployment facts are unavailable; retain this verifier report and retry the read", "fact-reader-recovered", "verifier-facts-unavailable");
        }
        // Never treat stale AC/source/serving evidence as success or disclose tool output.
        save(current => { current.verifier!.state = "failed"; delete current.verification; });
        return wait("runner-error", "verifier", "Report rejected by current AC, source, version or identity checks; inspect and rerun applicable verification", "fresh-valid-report", "verifier-report-rejected");
      }
    }
    if (now.getTime() > Date.parse(run.reservedAt) + (run.timeoutSeconds + 60) * 1000) return uncertain();
    return wait("external-wait", "verifier", "Wait for the existing bounded verifier report and outcome", "verifier-outcome", "verifier-running");
  }
  if (readExistingOnly) return "verifier-awaiting-original-session";
  const plan = await adapter.verifierPlan!(job);
  if (!plan.enabled) {
    wait("missing-verifier", "verifier", "Dispatch is disabled; submit an independent report with job verify or explicitly opt in in trusted configuration", "independent-report-or-config-change", "verifier-disabled");
    // Preserve the existing post-merge/deployment handoff when dispatch is off.
    return undefined;
  }
  if (!plan.command || !plan.agent || !adapter.launchVerifier) return wait("missing-verifier", "system", "Configure an available review-tagged agent in the trusted registry, or submit an independent report manually", "registry-repaired", "verifier-unavailable");
  if ((job.verifierAttempts ?? 0) >= plan.maxAttempts) return wait("runner-error", "owner", "Verifier retry budget exhausted; inspect prior attempts and supply independent evidence manually", "owner-recovery", "verifier-budget-exhausted");
  // Check fresh issue, merged source and deployed binding before spending a turn.
  if (!adapter.currentIssue) return wait("runner-error", "system", "Repair the current issue reader before dispatching verification", "tool-repaired", "verifier-unavailable");
  const issue = await adapter.currentIssue(job);
  if (issue.url !== job.issue.url || acceptance(issue.body).acHash !== job.acHash) return wait("acceptance-decision", "owner", "Current ACs changed; review and correct the acceptance plan against the current binding", "audited-acceptance-correction", "acceptance-stale");
  try { assertTracker(job, issue); } catch (error) { if (error instanceof TrackerHoldError) return ownerHold(); throw error; }
  if (job.config.verification === "local") assertLocalAcceptance(issue.body);
  if (acceptanceCriteria(issue.body).some(requiresHuman)) return wait("acceptance-decision", "owner", "Obtain the explicit human acceptance required by the current ACs, then submit independent complete evidence", "human-acceptance-evidence", "owner-acceptance-required");
  try { await assertVerificationSource(adapter, job); }
  catch (error) {
    if (error instanceof VerificationReadError) throw error;
    return wait("runner-error", "system", "Refresh the expected source before dispatching verification", "source-fact-change", "source-unestablished");
  }
  try { await assertVerificationDeployment(adapter, job); }
  catch (error) {
    if (error instanceof VerificationReadError) throw error;
    return wait("source-provenance", "external", "Repair the actual serving source/version binding and refresh waiting-deploy before verifying", "serving-provenance-repaired", "serving-binding-stale");
  }
  const id = "workit-verifier-" + randomUUID();
  const artifacts = join(dirname(store.path), "verifiers", id);
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const reserved: VerifierRun = { id, sessionID: id, agent: plan.agent, binding: verifierBinding(job), state: "reserved",
    reportPath: join(artifacts, "report.json"), outcomePath: join(artifacts, "outcome.json"), reservedAt: now.toISOString(), timeoutSeconds: plan.timeoutSeconds };
  const claimed = store.reserveVerifier(job, reserved, plan.concurrency, plan.maxAttempts, now);
  if (!claimed) return wait("external-wait", "system", "Wait for a verifier capacity slot; concurrent claims cannot launch duplicates", "verifier-capacity", "verifier-capacity");
  job = claimed;
  if (!new QueueStore(store).continuation(job, reserved.id, dispatchNow())) {
    save(current => { delete current.verifier; current.verifierAttempts = Math.max(0, (current.verifierAttempts ?? 1) - 1); });
    return wait("queue-bound", "owner", "Inspect queue status: pause, deadline, budget or concurrency prevents verifier dispatch", "queue-state-budget-or-capacity-change", "queue-bound");
  }
  try { await adapter.launchVerifier(job, reserved, plan); }
  catch { return uncertain(); }
  save(current => { current.verifier!.state = "running"; current.verifier!.delivery = "delivered"; current.verifier!.startedAt = now.toISOString(); });
  return wait("external-wait", "verifier", "Wait for the existing bounded verifier report and outcome", "verifier-outcome", "verifier-launched");
}

export function reconcileVerifier(store: JobStore, id: string, input: { runID: string; expectedRevision: number; outcome: string; reason: string }, now = new Date()): Job {
  if (!input.reason?.trim() || !["delivered", "not-delivered", "completed"].includes(input.outcome)) throw new Error("Inspect the verifier first; reconciliation requires an outcome and reason");
  return store.update(id, current => {
    if (current.revision !== input.expectedRevision || current.verifier?.id !== input.runID) throw new Error("Verifier revision or identity mismatch");
    const run = current.verifier;
    run.recovery = { reason: input.reason, at: now.toISOString() };
    if (input.outcome === "completed") { (current.verifierHistory ??= []).push(run); delete current.verifier; }
    else if (input.outcome === "not-delivered") { run.state = "failed"; run.delivery = "not-delivered"; }
    else { if (run.binding !== verifierBinding(current)) throw new Error("Invalidated verifier must finish before releasing its capacity"); run.state = "running"; run.delivery = "delivered"; }
    delete current.blocker;
    // Deliberately does not resume a hold or reset attempts.
  }, now);
}
