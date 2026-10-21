import { assertVerificationSource, assertVerificationDeployment } from "./verification-source.js";
import { assertTracker } from "./tracker-policy.js";
import { randomUUID } from "node:crypto";
import type { TrackerIssue } from "./issue.js";
import { JobStore, checklistChanges, issueFinished, processIdentity, processIsAlive, provenChecklist, reportComplete,
  synchronizeChecklist, validateProgressReport, validateReport,
  type Job, type LifecycleAdapter } from "./lifecycle.js";

export interface CloseoutAdapter extends LifecycleAdapter {
  currentIssue(job: Job): Promise<TrackerIssue>;
  updateIssue(job: Job, id: string, input: { description?: string; stateId?: string }): Promise<void>;
}

/** Local claims serialize workit only. Linear issueUpdate has no server-side CAS. */
export async function closeoutJob(store: JobStore, adapter: CloseoutAdapter, id: string,
  input: { report?: unknown; reconcile?: boolean } = {}): Promise<Job> {
  const expected = store.get(id);
  if (expected.stage !== "verifying" && !(input.reconcile && expected.stage === "verified")) {
    throw new Error("Job must be in verifying before completion (closeout can also reconcile a previously verified job)");
  }
  if (expected.wake) throw new Error("Pending wake must be reconciled before tracker closeout");
  const value = input.report ?? (input.reconcile ? expected.verification : undefined);
  const validate = expected.issue.backend === "linear" ? validateProgressReport : validateReport;
  const token = randomUUID();
  let job = store.update(id, current => {
    if (current.revision !== expected.revision || (current.claim && processIsAlive(current.claim.process))) {
      throw new Error("Job is changed or claimed; reread status and retry closeout");
    }
    current.claim = { token, process: processIdentity() };
    // Old verified jobs must not retain a completion claim if reconciliation fails.
    current.stage = "verifying";
  });
  const assertOwned = () => {
    const current = store.get(id);
    if (current.revision !== job.revision || current.claim?.token !== token || current.stage !== "verifying") {
      throw new Error("Job changed during closeout; preserve its hold/checkpoint and reread before retrying");
    }
  };
  const save = (change: (current: Job) => void) => {
    job = store.update(id, current => {
      if (current.revision !== job.revision || current.claim?.token !== token || current.stage !== "verifying") {
        throw new Error("Job changed during closeout; reread before retrying");
      }
      change(current);
    });
  };
  const source = async () => {
    assertOwned();
    await assertVerificationSource(adapter, job);
    await assertVerificationDeployment(adapter, job);
    assertOwned();
  };
  const read = async () => {
    assertOwned();
    const issue = await adapter.currentIssue(job);
    assertTracker(job, issue);
    const report = validate(job, value, issue.body);
    if (issue.backend === "linear" && reportComplete(job, report) && !issue.linear?.completedStateID) {
      throw new Error("The issue's team has no active completed workflow state");
    }
    const intent = job.closeout?.checklist;
    if (intent && (issue.linear?.id !== intent.issueID || issue.linear.teamID !== intent.teamID)) {
      throw new Error("Linear issue/team changed during closeout; inspect the pending effect before retrying");
    }
    assertOwned();
    return issue;
  };
  const unchanged = async (previous: TrackerIssue) => {
    const fresh = await read();
    if (fresh.body !== previous.body || JSON.stringify(fresh.linear) !== JSON.stringify(previous.linear) ||
        JSON.stringify(fresh.labels) !== JSON.stringify(previous.labels)) {
      throw new Error("Observable Linear conflict before mutation; no stale snapshot was written. Reread and retry");
    }
    return fresh;
  };
  try {
    if (!value) throw new Error("No stored independent report; use job verify --report PATH");
    await source();
    let issue = await read();
    const report = validate(job, value, issue.body);
    const changes = checklistChanges(report);
    const complete = reportComplete(job, report);
    save(current => {
      current.verification = report; current.closeout ??= {};
      if (!complete) current.closeout.stateConfirmed = false;
    });
    if (issue.backend === "linear") {
      // Every retry reads the actual effect first, including lost mutation responses.
      const pending = job.closeout?.checklist;
      const pendingChanges = pending?.changes ?? job.acLabels.map(label => ({ label, checked: true }));
      let after = synchronizeChecklist(issue.body, changes);
      if (pending && !job.closeout?.checklistConfirmed && issue.body !== pending.before &&
          synchronizeChecklist(issue.body, pendingChanges) !== issue.body) {
        throw new Error("Pending checklist conflicts with current description; inspect/merge the checkbox-only change before job closeout retry");
      }
      if (after !== issue.body) {
        issue = await unchanged(issue);
        after = synchronizeChecklist(issue.body, changes);
        save(current => {
          current.closeout!.checklist = { before: issue.body, after, issueID: issue.linear!.id, teamID: issue.linear!.teamID, changes };
          current.closeout!.checklistConfirmed = false;
        });
        assertOwned();
        let failure: unknown;
        try { await adapter.updateIssue(job, issue.linear!.id, { description: after }); } catch (error) { failure = error; }
        // Even success:true is insufficient, and errors may have applied remotely.
        issue = await read();
        if (issue.body !== after) throw new Error(failure
          ? "Checklist write failed or is unconfirmed; job closeout will reconcile by readback before retrying"
          : "Observable checklist conflict after mutation; inspect the current description before job closeout retry");
      }
      save(current => { current.closeout!.checklistConfirmed = true; });
      await source();
      issue = await read();
      if (!complete) {
        if (synchronizeChecklist(issue.body, changes) !== issue.body) throw new Error("Checklist progress changed; retry job closeout");
        save(current => {
          current.detail = `AC progress synchronized (${changes.filter(item => item.checked).length} pass, ${changes.filter(item => !item.checked).length} fail); complete independent passing evidence is still required`;
          current.nextWakeAt = new Date(Date.now() + (current.config.intervalSeconds ?? 60) * 1000).toISOString();
          delete current.claim;
        });
        return job;
      }
      if (provenChecklist(issue.body, job.acLabels) !== issue.body) throw new Error("Checklist changed before completion; retry job closeout");
      if (!issueFinished(issue)) {
        if (job.config.trackerCompletion === "human") throw new Error("Tracker completion requires the authorized human to close the issue");
        issue = await unchanged(issue);
        const stateId = issue.linear!.completedStateID!;
        save(current => { current.closeout!.stateID = stateId; current.closeout!.stateConfirmed = false; });
        assertOwned();
        let failure: unknown;
        try { await adapter.updateIssue(job, issue.linear!.id, { stateId }); } catch (error) { failure = error; }
        issue = await read();
        if (!issueFinished(issue)) throw new Error(failure
          ? "Completed-state write failed or is unconfirmed; retry job closeout to reconcile first"
          : "Completed state was not confirmed by readback; retry job closeout");
      }
      save(current => { current.closeout!.stateConfirmed = true; });
    } else if (!issueFinished(issue)) {
      throw new Error("Acceptance evidence is valid; close it under repository policy, then retry");
    }
    await source();
    issue = await read();
    if (!issueFinished(issue) || (issue.backend === "linear" && provenChecklist(issue.body, job.acLabels) !== issue.body)) {
      throw new Error("Final tracker checklist/state readback is incomplete; retry job closeout");
    }
    save(current => {
      if (current.issue.backend === "linear") current.trackerDone = true;
      if (current.verifier?.id === report.reviewer.runID) current.verifier.state = "accepted";
      current.stage = "verified"; current.detail = "Every current AC has independent passing evidence; tracker completion confirmed";
      delete current.nextWakeAt; delete current.claim;
    });
    return job;
  } catch (error) {
    try {
      save(current => {
        current.detail = `${error instanceof Error ? error.message : "Closeout failed"}. Retry: job closeout ${id} (or job verify --report PATH for fresh evidence)`;
        current.nextWakeAt = new Date(Date.now() + (current.config.intervalSeconds ?? 60) * 1000).toISOString();
        delete current.claim;
      });
    } catch { /* A concurrent pause/checkpoint remains authoritative. */ }
    throw error;
  }
}
