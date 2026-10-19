# Managed issue delivery

Managed launches own one issue through implementation, local preverification,
review/CI repair, authorized merge, deployment waiting, independent acceptance,
tracker handoff and verified issue closeout. They are opt-in:

```bash
workit --managed 23
workit --managed TASK-123
workit job list
workit job status JOB_ID
```

Requirements: Banyan with workflow protocol v1
([companion implementation](https://github.com/banyudu/banyan/issues/137)),
`banyanctl`, authenticated GitHub CLI, and Python 3 with standard-library
`sqlite3`. `WORKIT_BANYANCTL` overrides the control executable.
Deployed acceptance requires a configured deployment probe before launch.
To manage ordinary issue calls, including calls from a batch launcher, add
repository configuration or a user-config project override:

```yaml
lifecycle:
  enabled: true
  verification: deployed
  intervalSeconds: 60
  maxWakeups: 40
  maxErrors: 5
  deploymentProbe: [direnv, exec, ., bun, run, scripts/deployment-probe.ts]
```

The probe is an example repository-owned command, not a bundled script.
It must be read-only, bounded, and emit one JSON object on stdout. It receives
`WORKIT_JOB_ID`, `WORKIT_ISSUE_URL`, and `WORKIT_MERGE_SHA`.
Return `{"ready":false}` until the relevant deployment is available, then:

```json
{
  "ready": true, "environment": "dev", "target": "example-worker",
  "sourceSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "version": "serving-version-id"
}
```

Report the actual serving source/version, not newest main or mere deploy-job
success. Workit checks GitHub ancestry against the merged PR. Trusted probe argv
is snapshotted from launch configuration; issue text and checkpoints cannot
supply new probe commands. Verification scope is per issue: the repository
setting is a default, and a local CLI, tooling or documentation issue should use
`local` when every AC has reliable local acceptance. Override the default at
launch without changing other jobs:

```bash
workit --managed --verification local TASK-123
```

Local verification proceeds directly from merge to `verifying`; it requires no
deployment probe, serving version or deployed journey. It still requires a merged
PR, independent evidence for every AC and tracker handoff. Keep `deployed` when
acceptance requires a serving environment. An explicit `[deploy]` or
`[deploy:label]` AC prevents selecting local verification. Both the initial
prompt and heartbeat continuations explain the selected mode and how to correct
an inherited default after reading the actual ACs.

`--unmanaged` overrides the project setting. Shell-only, unprompted, iTerm and
current-terminal launches remain unmanaged. Explicit `--managed` rejects
incompatible options.

## Heartbeat

Build/install the compiled CLI, then explicitly install its per-user LaunchAgent:

```bash
workit heartbeat install --interval 60
workit heartbeat status
workit tick
workit heartbeat uninstall
```

Installation pins Node/CLI paths, captures PATH and the state directory, and
writes logs under `~/.local/state/workit/logs/`. It does not serialize credentials.
Use normal CLI auth stores and a trusted environment loader such as `direnv exec`
where needed. Reinstall after moving the CLI/runtime. Ordinary issue launches
do not install a scheduler. On other hosts, schedule the compiled `workit tick`
command using the host scheduler.

The Mac must be awake and Banyan running for session control. Timers coalesce
after sleep; they cannot run while asleep. Checkpoints survive app/process
restarts. Use an always-on host for unattended operation.

Ticks cheaply inspect due jobs, skip busy/parked/frozen/human-blocked sessions,
and continue the same conversation only when actionable. Unchanged CI/deployment
waits consume no agent turn. Readiness wakes an agent to assess repository
policy; it does not authorize a merge/deployment. There is no global verification
lease or stability sleep. Isolated journeys can remain concurrent with their
relevant runtime/version evidence.

Use one scheduler per issue. Managed guidance suppresses the built-in Codex
goal instruction and asks agents not to add native goals or schedules. Handle an
already-active unrelated goal explicitly before onboarding that conversation.
Workit does not pick additional backlog issues.

## Tracker handoff

Workit owns the Linear state handoffs rather than delegating them to the agent.
Launch claims queued work (`Backlog`, `Todo`, `On Hold` → `In Progress`). The
heartbeat then hands a merged issue to review as soon as it observes the
merge, moving `In Progress`, `Rework` or `Merging` → `In Review`. After
`workit job verify` accepts independent passing evidence for every current AC,
workit automatically moves the Linear issue from `In Review` to `Done` and
confirms the state by reading it back. Merge alone never marks it Done.
Recording a follow-up PR re-arms the handoff, so the issue
is handed over again after that PR merges.

The handoff is best-effort and idempotent. A tracker failure is reported on
stderr and retried on later ticks instead of failing or delaying the job, and a
settled handoff is recorded as durable job state. Authentication follows the
rest of the CLI: `LINEAR_API_KEY` when it is set, otherwise the authenticated
`linear` CLI, so a CLI on the heartbeat's `PATH` is enough. Managed prompts drop
the tracker-handoff guidance that unmanaged launches receive, because the
heartbeat performs it. `workit job verify` accepts the Linear handoff state
(`In Review` or already `Done`) as its tracker precondition.

Acceptance is saved before attempting the Done transition, so a tracker outage
does not discard the independent report. The heartbeat retries completion for
verified jobs until `trackerDone: true` records a confirmed readback. This also
covers previously verified jobs. Before writing, it rechecks the current AC
binding and preserves human holds, cancellations and reopened issues; only an
issue still in `In Review` is moved. Already-Done issues are acknowledged without
another write. Completion sync needs no agent wake or idle session.

An issue launched under explicit human-only closure instructions can retain that
authorization with `job checkpoint ... --tracker-completion human`. The setting
is scoped to that job and suppresses automatic Done synchronization after
verification; other jobs keep their existing policy. Use `automatic` only when
the issue's authorization allows it.

## Checkpoints and recovery

The prompt includes the exact initiating CLI/state-directory invocation; use it
if the PATH wrapper is older. Before yielding, record a concrete next stage:

```bash
workit job checkpoint JOB_ID --stage waiting-ci --detail "Waiting for review" --pr https://github.com/example/project/pull/42
workit job checkpoint JOB_ID --stage waiting-deploy --detail "Awaiting scheduled dev batch" --merge-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
workit job pause JOB_ID --detail "Owner requested a hold"
workit job resume JOB_ID --detail "Hold released"
workit job cancel JOB_ID --detail "Scope cancelled"
```

During an active verification turn, `workit job refresh-deployment JOB_ID`
records the current serving version through the job's original read-only probe
and checks merged-source ancestry. It requires an unheld post-merge job with no
pending wake or active claim, and commits with a revision check. It neither
wakes the session nor accepts evidence. Revalidate affected acceptance probes
after a version change, then use `job verify --report` as usual. The targeted
guards are covered by `src/deployment-refresh.test.ts`.

To correct verification scope on an active job, include `--verification` in a
checkpoint and explain how every AC will be proven. For local post-merge
acceptance:

```bash
workit job checkpoint JOB_ID --stage verifying --verification local --detail "All ACs cover local CLI output and tests on the merged source"
```

A job already held in `needs-you` or `paused` can change mode while remaining
held by checkpointing the same stage. To explicitly release the hold and correct
the mode together:

```bash
workit job resume JOB_ID --verification local --detail "Every AC has local acceptance; deployment is outside this issue's scope"
```

Mode corrections affect only that job, clear stale deployment/report evidence,
and preserve merge, tracker and independent-review requirements. Ordinary
checkpoints cannot release a human hold. Pending wake delivery must be inspected
and reconciled before changing mode or resuming. Switching to `deployed`
requires the trusted deployment probe already saved in the job's configuration.

Stages: `implementing`, `preverifying`, `reviewing`, `waiting-ci`,
`waiting-deploy`, `verifying`, `fixing`, `needs-you`, `paused`, `cancelled`,
`verified`. A follow-up PR clears stale merge/deployment evidence. Ordinary
checkpoints cannot bypass pause/human gates. Pause/cancel stop future automatic
continuations; use Banyan's interrupt control to stop an active turn. They do not
roll back completed effects.

Banyan's **Pause and Close** uses `workit job pause JOB_ID --detail TEXT
--expected-revision N --expected-session-id SESSION_ID`. Both optional guards
are checked inside the atomic job update; stale revisions or session bindings
leave the job unchanged. The JSON acknowledgement identifies the paused job,
session and newer revision. Configure Banyan's trusted invocation and owning
state directory in `~/.banyan/workit.json`. A pause retains pending wake
evidence; inspect and reconcile that delivery before explicitly resuming.

Jobs live in private `~/.local/state/workit/lifecycle.sqlite`, independently of
worktree GC. `WORKIT_STATE_DIR` selects an alternative. SQLite transactions and
revisions prevent competing ticks from claiming a job. Claims include process
start identities, so dead workers can be reclaimed without confusing reused
PIDs. This is local coordination, not a distributed lock.

Wake intent is persisted before delivery; Banyan persists/deduplicates wake IDs.
Lost responses are reconciled from receipts. Uncertain delivery becomes a human
gate. A proven refusal before any prompt bytes were sent can retry the same wake
ID automatically. After inspecting the original conversation and any external effects:

```bash
workit job reconcile JOB_ID --delivery delivered --detail "Observed continuation in the original conversation"
workit job resume JOB_ID
```

Use `--delivery not-delivered` only when inspection establishes that no prompt
was delivered. Reconciliation leaves the job held until explicit resume.
Workit may have saved an intent that Banyan never admitted. For this inspected
`not-delivered` outcome, reconciliation can clear only Workit's intent when
protocol v1 confirms the original session's readable, current held workflow has
no matching receipt and no other unresolved wake. Any older settled native
receipt is preserved. Matching receipts still use Banyan's guarded resolution;
an absent receipt never establishes a `delivered` outcome.
Missing/ambiguous conversation identity, unreadable journals, removed worktrees
and uncertain launches never fall back to replaying the initial task in a new
conversation. Recover the named Banyan session first. Repeated auth/control
failures use bounded exponential backoff, then become `needs-you`.

## Verified completion

An independent verifier can submit AC progress as soon as individual results
are proven, using the same command as final completion:

```bash
workit job verify JOB_ID --report /absolute/path/verification.json
```

For Linear, partial reports synchronize evidenced results even while other ACs
are missing, failed or blocked. `pass` with valid evidence checks that AC; `fail`
with valid evidence unchecks it. Omitted or `blocked` ACs, and failures with no
evidence, retain their existing checkbox state. A claimed pass with missing or
invalid evidence rejects the report. Each included label must be current and
unique, and human results still require attributed human confirmation.
Report pending human acceptance as `blocked` so other proven ACs can synchronize.

For example, submit just the passing `documented-contract` entry from the report
below while the journey is still pending. Only that checkbox is synchronized;
the issue state is unchanged and the returned job remains `verifying`. This is
accepted progress, not verified completion. Retry a failed/interrupted sync with
`job closeout JOB_ID`, which revalidates the stored partial report first.

Progress synchronization retains the current issue/AC binding, merged-source,
independent-reviewer, owner-hold and applicable serving-version gates. A deployed
job still rechecks its observed serving version, but a partial report containing
only local/code evidence does not need a fabricated journey. Included journey
or version-bound evidence must match the actual observed deployment.

Final completion requires one complete passing report covering every current
AC, including applicable deployed journey evidence. Reports are not accumulated
to infer completion: existing checked boxes and passes from earlier submissions
cannot fill gaps in the latest report. Only then does workit resolve the
issue's actual team's active `completed` workflow state and confirm checklist
and state by readback before marking the job `verified`. No extra per-issue
approval is needed for this validated managed path. Existing completed states
are retained; canceled/duplicate states never count as successful completion.
If a team has several completed states, the first by workflow position (then ID)
is selected. GitHub behavior is unchanged: close the issue under repository
policy before submitting; workit does not mutate its body or state.

Linear closeout requires `LINEAR_API_KEY` and uses the supported public
[GraphQL issueUpdate API](https://linear.app/developers/graphql) with
`IssueUpdateInput.description` or `stateId`. It does not depend on CLI-specific
full-description helpers or an invented compare-and-swap parameter.

The job stores the latest accepted progress/completion report and each mutation
intent before sending it. A subsequent report can update more ACs without
repeating already-applied results.
After a failure or interruption, inspect status and retry only that job:

```bash
workit job status JOB_ID
workit job closeout JOB_ID
```

`closeout` revalidates stored independent evidence against current ACs, GitHub
merged source and, where applicable, the actual serving version. It reads the
tracker before retrying an uncertain mutation, skips effects already confirmed,
and never claims a newly verified job while either effect is unconfirmed.
It also reconciles a job marked `verified` by older workit versions; that job
returns to `verifying` until revalidation and readbacks succeed. No bulk job
migration runs automatically. Missing/stale reports require fresh independent
evidence and `job verify --report PATH`.

Checkbox synchronization matches unique stable labels in a fresh Acceptance
Criteria section and changes only the evidenced pass/fail checkbox character,
retaining all other description bytes, other checklists and current human edits.
A second read compares description, `updatedAt`, team, state and hold labels immediately before
each mutation. Changed AC content invalidates the report. Changed snapshots
abort before writing; post-write readback must match the intended description.
On an ambiguous pending checklist conflict, inspect Linear's current description
and activity history, merge/restore the checkbox-only change without removing
human edits, then retry `job closeout`. Workit does not blindly restore an old
full description. Lost responses are reconciled even when the API reported an
error; retries do not repeat an effect already present.

Linear does not expose a conditional description/state update. These reads
detect observable conflicts but cannot eliminate edits or holds arriving between
the last read and mutation, or an edit overwritten in that window. Local SQLite
claims serialize workit processes in one state directory, not other clients or
hosts. Human writers should avoid concurrent description edits during closeout;
inspect activity history if a race is suspected. Workit preserves concurrent
local pauses/checkpoints and never clears an explicit hold to finish closeout.
Readback also cannot rule out a timed-out request committing later; a retry sends
the same field value, but Linear may record another activity or notification.

Paused, human-blocked and canceled jobs cannot close out. Linear archived or
snoozed issues, states named `On Hold`, `Hold`, `Paused` or `Blocked`, and labels
`owner-hold`, `owner hold`, `on-hold`, `on hold`, `hold`, `paused` or `blocked`
also block mutations until explicitly released. Represent owner holds through
these controls rather than relying on prose in the description.

Example report (labels and hashes must match job status):

```json
{
  "jobID": "JOB_ID",
  "issueURL": "https://github.com/example/project/issues/23",
  "acHash": "AC_HASH_FROM_JOB_STATUS",
  "mergeSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "checkedAt": "2026-01-02T00:00:00Z",
  "reviewer": {"runID": "INDEPENDENT_VERIFIER_RUN", "independent": true},
  "deployment": {
    "environment": "dev", "target": "example-worker",
    "sourceSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "version": "serving-version-id"
  },
  "criteria": [
    {
      "label": "journey-contract", "status": "pass",
      "evidence": [{
        "kind": "journey", "reference": "/absolute/path/journey-result.json",
        "observed": "Expected behavior completed",
        "deployment": {
          "environment": "dev", "target": "example-worker",
          "sourceSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "version": "serving-version-id"
        }
      }]
    },
    {
      "label": "documented-contract", "status": "pass",
      "evidence": [{
        "kind": "code", "reference": "docs/contract.md:12",
        "observed": "The accepted behavior is documented"
      }]
    }
  ]
}
```

AC labels use `[test:journey-contract]`-style tags. Unlabeled checkboxes receive
stable content hashes shown in job status. Checked/unchecked changes preserve
the AC hash; contract edits invalidate it. For final completion, every AC must
occur exactly once with passing evidence. Deployed acceptance needs applicable
journey evidence bound to the observed target/version. Local reports omit deployment fields and use appropriate local test/code evidence against the merged source. Completion rechecks the
merged PR, current ACs, tracker completion and serving deployment. A changed serving version requires
fresh applicable evidence.

Every `[human:label]` (or `[human]`) AC additionally requires evidence with
`kind: "human"`, a nonempty `confirmedBy` naming the actual human, and a
`reference` to that person's explicit confirmation. An agent must not fabricate
this attestation; ordinary test evidence and existing checked boxes do not waive
human acceptance. The validator checks the attestation structure, while the
independent verifier owns its truth.

The validator checks completeness and provenance bindings, not the semantic
truth of observations. The independent verifier/repository tools still own
observations, human acceptance and deferred-scope tracking.

Process exit, merge, healthy deployment and agent claims do not mark jobs
verified. Verified/cancelled jobs stop scheduling after their final Banyan
projection is delivered. Banyan shows an independent workflow badge and offers
**Close verified sessions**. Repository merge/deployment authorization remains
in force throughout.
Automatic tracker completion grants no verifier-dispatch, merge, deployment,
runtime-configuration or external-messaging authority. It changes the former
human-only Linear Done policy only for this validated managed closeout path.

## Development verification

`bun run typecheck`, `bun run test`, and `bun run build` cover durable jobs and
fixture-based acceptance. For the optional wire check against the actual
companion CLI, build Banyan's `banyanctl` product and run:

```bash
WORKIT_TEST_BANYANCTL=/absolute/path/to/banyan/.build/debug/banyanctl bun run test
```

That test uses a disposable authenticated local HTTP fixture, isolated token
storage, and an absent fixture daemon socket. It does not control a user session
or execute an agent/deployment.
