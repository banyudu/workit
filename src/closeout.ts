import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { acceptance, acceptanceCriteria, assertLocalAcceptance, dependencyIdentity, digest, issueFinished, requiresHuman, runnableStage, sha, terminalStage, validateReport,
  type Blocker, type Job, type JobStore, type LifecycleAdapter, type VerifierRun, type VerificationReport } from "./lifecycle.js";
import type { IssueDetails } from "./types.js";

export function correctAcceptance(store: JobStore, id: string, input: {
  profile: "local" | "deployed"; reason: string; expectedRevision: number; expectedAcHash: string;
}, issue: IssueDetails, now = new Date()): Job {
  if (!["local", "deployed"].includes(input.profile) || !input.reason?.trim() ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Acceptance correction requires a profile, reason and expected revision");
  const binding = acceptance(issue.body);
  if (binding.acHash !== input.expectedAcHash) throw new Error("Current AC binding is stale; reread the issue before correcting acceptance");
  if (input.profile === "local") assertLocalAcceptance(issue.body);
  return store.update(id, current => {
    if (current.revision !== input.expectedRevision) throw new Error("Job revision mismatch; reread before correcting acceptance");
    if (terminalStage(current.stage) || current.issue.url !== issue.url) throw new Error("Acceptance correction needs the current unfinished issue");
    if (input.profile === "deployed" && !current.config.deploymentProbe?.length) throw new Error("Deployed acceptance requires a trusted deployment probe");
    (current.acceptanceHistory ??= []).push({ from: current.config.verification ?? "deployed", to: input.profile,
      reason: input.reason.trim(), at: now.toISOString(), revision: current.revision + 1,
      oldAcHash: current.acHash, acHash: binding.acHash });
    current.config.verification = input.profile;
    current.issue = issue; Object.assign(current, binding); current.acceptanceChangedAt = now.toISOString();
    delete current.deployment; delete current.verification; delete current.fingerprint; delete current.blocker;
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
      current.stage = current.mergeSha ? (input.profile === "local" ? "verifying" : "waiting-deploy") : current.stage;
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
        if (current.mergeSha !== facts.pr.mergeSha) { delete current.deployment; delete current.verification; }
        current.mergeSha = facts.pr.mergeSha;
        current.holdDetail ??= current.detail;
        current.detail = "Hold retained; GitHub confirms the PR is merged. Explicit resume is required";
      } else if (facts.pr && !facts.pr.ready) {
        current.holdDetail ??= current.detail;
        current.detail = "Hold retained; the PR is not currently ready. Inspect its latest head and checks";
      }
    }, now);
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
  else if (job.mergeSha) {
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

export async function checkVerification(adapter: LifecycleAdapter, expected: Job, value: unknown, now = new Date()): Promise<{ report: VerificationReport; finished: boolean }> {
  if (expected.stage !== "verifying") throw new Error("Job must be in verifying before completion");
  if (expected.verifier && ["reserved", "running", "uncertain", "invalidated", "report-ready"].includes(expected.verifier.state) &&
      (expected.verifier.state === "invalidated" || (value as VerificationReport)?.reviewer?.runID !== expected.verifier.id)) throw new Error("Reconcile the existing verifier before replacing its report or identity");
  if (!adapter.currentIssue) throw new Error("Current issue reader unavailable");
  const pr = await adapter.pr(expected);
  if (!pr.merged || pr.mergeSha !== expected.mergeSha) throw new Error("GitHub does not establish the expected merged source");
  if (expected.config.verification !== "local") {
    const deployment = await adapter.deployment(expected);
    if (!deployment || JSON.stringify(deployment) !== JSON.stringify(expected.deployment) ||
        !await adapter.containsMerge(expected, deployment.sourceSha)) throw new Error("Serving deployment changed; rerun applicable verification");
  }
  const issue = await adapter.currentIssue(expected);
  if (issue.url !== expected.issue.url) throw new Error("Current issue identity changed");
  return { report: validateReport(expected, value, issue.body, now), finished: issueFinished(issue) };
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
  return digest(JSON.stringify([job.acHash, job.mergeSha, job.config.verification, job.acceptanceChangedAt, job.deployment]));
}
function readArtifact(path: string): unknown {
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error("Verifier artifact exceeds the bounded report size");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Called only under the ordinary per-job heartbeat claim. No implementer replay. */
export async function coordinateVerification(store: JobStore, adapter: LifecycleAdapter, expected: Job, now: Date, transitionContinuation = false): Promise<string | undefined> {
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
  const uncertain = () => {
    save(current => {
      if (current.verifier && current.verifier.state !== "invalidated") current.verifier.state = "uncertain";
      current.stage = "needs-you"; current.detail = "Verifier delivery is uncertain; inspect its original session and reconcile before resuming";
      current.blocker = { reason: "uncertain-delivery", owner: "owner", observedAt: now.toISOString(), recheckTrigger: "inspected-verifier-reconciliation", nextAction: "Inspect the persisted verifier identity, report and outcome; use job verifier-reconcile" };
      delete current.nextWakeAt;
    });
    return "verifier-uncertain";
  };
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
        const checked = await checkVerification(adapter, job, value, now);
        if (checked.finished) { job = completeVerification(store, job, checked.report, now); return "verified"; }
        save(current => { current.verifier!.state = "report-ready"; current.verification = checked.report; });
        return wait("tracker-closeout", "owner", "Independent evidence passed; reconcile the issue checklist and completed state under repository policy", "tracker-state-change", "awaiting-tracker-closeout");
      } catch {
        // Never treat stale AC/source/serving evidence as success or disclose tool output.
        save(current => { current.verifier!.state = "failed"; delete current.verification; });
        return wait("runner-error", "verifier", "Report rejected by current AC, source, version or identity checks; inspect and rerun applicable verification", "fresh-valid-report", "verifier-report-rejected");
      }
    }
    if (now.getTime() > Date.parse(run.reservedAt) + (run.timeoutSeconds + 60) * 1000) return uncertain();
    return wait("external-wait", "verifier", "Wait for the existing bounded verifier report and outcome", "verifier-outcome", "verifier-running");
  }
  const plan = await adapter.verifierPlan!(job);
  if (!plan.enabled) {
    const result = wait("missing-verifier", "verifier", "Dispatch is disabled; submit an independent report with job verify or explicitly opt in in trusted configuration", "independent-report-or-config-change", "verifier-disabled");
    // Preserve the existing post-merge/deployment handoff when dispatch is off.
    return transitionContinuation ? undefined : result;
  }
  if (!plan.command || !plan.agent || !adapter.launchVerifier) return wait("missing-verifier", "system", "Configure an available review-tagged agent in the trusted registry, or submit an independent report manually", "registry-repaired", "verifier-unavailable");
  if ((job.verifierAttempts ?? 0) >= plan.maxAttempts) return wait("runner-error", "owner", "Verifier retry budget exhausted; inspect prior attempts and supply independent evidence manually", "owner-recovery", "verifier-budget-exhausted");
  // Check fresh issue, merged source and deployed binding before spending a turn.
  if (!adapter.currentIssue) return wait("runner-error", "system", "Repair the current issue reader before dispatching verification", "tool-repaired", "verifier-unavailable");
  const issue = await adapter.currentIssue(job);
  if (issue.url !== job.issue.url || acceptance(issue.body).acHash !== job.acHash) return wait("acceptance-decision", "owner", "Current ACs changed; review and correct the acceptance plan against the current binding", "audited-acceptance-correction", "acceptance-stale");
  if (job.config.verification === "local") assertLocalAcceptance(issue.body);
  if (acceptanceCriteria(issue.body).some(requiresHuman)) return wait("acceptance-decision", "owner", "Obtain the explicit human acceptance required by the current ACs, then submit independent complete evidence", "human-acceptance-evidence", "owner-acceptance-required");
  const pr = await adapter.pr(job);
  if (!pr.merged || pr.mergeSha !== job.mergeSha) return wait("runner-error", "system", "Refresh the merged PR source before dispatching verification", "github-fact-change", "source-unestablished");
  if (job.config.verification !== "local") {
    const deployment = await adapter.deployment(job);
    if (!deployment || JSON.stringify(deployment) !== JSON.stringify(job.deployment) || !await adapter.containsMerge(job, deployment.sourceSha)) return wait("source-provenance", "external", "Repair the actual serving source/version binding and refresh waiting-deploy before verifying", "serving-provenance-repaired", "serving-binding-stale");
  }
  const id = "workit-verifier-" + randomUUID();
  const artifacts = join(dirname(store.path), "verifiers", id);
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const reserved: VerifierRun = { id, sessionID: id, agent: plan.agent, binding: verifierBinding(job), state: "reserved",
    reportPath: join(artifacts, "report.json"), outcomePath: join(artifacts, "outcome.json"), reservedAt: now.toISOString(), timeoutSeconds: plan.timeoutSeconds };
  const claimed = store.reserveVerifier(job, reserved, plan.concurrency, plan.maxAttempts, now);
  if (!claimed) return wait("external-wait", "system", "Wait for a verifier capacity slot; concurrent claims cannot launch duplicates", "verifier-capacity", "verifier-capacity");
  job = claimed;
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
