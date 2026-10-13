# Managed issue delivery

Managed launches own one issue through implementation, local preverification,
review/CI repair, authorized merge, deployment waiting, independent acceptance
and tracker closeout. They are opt-in:

```bash
workit --managed 23
workit --managed TASK-123
workit --managed --acceptance local 23
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
supply new probe commands. Use `verification: local` only when every AC has
reliable local acceptance. It still requires a merged PR, independent evidence
and tracker closeout.

`--unmanaged` overrides the project setting. Shell-only, unprompted, iTerm and
current-terminal launches remain unmanaged. Explicit `--managed` rejects
incompatible options.

## Acceptance planning and correction

`--acceptance local|deployed` overrides the configured profile for one managed
launch. Select local only after reviewing **all current ACs** and establishing
local acceptance probes for each. Workit rejects local scope when an AC requires
deployment or human acceptance. Scope is never inferred from changed filenames.
Local reports still need a merged source, an independent reviewer and complete
criterion evidence; they need no fabricated deployment or journey evidence.

For an unfinished job launched with the wrong profile, inspect its current plan
and live issue binding, then explicitly correct it:

```bash
workit job acceptance JOB_ID
workit job acceptance JOB_ID --profile local --reason "All current CLI/type ACs have isolated local probes" --expected-revision 12 --expected-ac-hash CURRENT_AC_HASH
```

Inspection is read-only and returns the job revision, saved/current AC hashes,
current labels and local eligibility. The correction requires a reason, the
displayed revision and the hash of the **current** ACs. A stale revision or live
hash fails without mutation. Reviewing an intentional AC change and supplying
its new hash reconciles the saved binding; Workit never edits the issue ACs.
Deployment and human requirements cannot be waived by choosing local. Use
explicit AC tags and clear requirements; the verifier remains responsible for
proving the meaning of each criterion.

Corrections append an audit entry with old/new profile and AC hash, reason,
revision and time. They invalidate cached deployment, report and dispatch
bindings and require evidence observed after the correction. Active or uncertain
verifier identities remain in the audit and retain their capacity slot until
inspected reconciliation. Pending wakes also remain held for inspection.
Existing pauses and human holds stay held; use `job resume` separately after
resolving them. Correction is never permission to merge, deploy or close an issue.
No SQLite edits or automatic migration of existing jobs are needed.

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
policy; it does not authorize a merge/deployment. There is no global stability
sleep. Optional verifier capacity is reserved in the same durable store.

Use one scheduler per issue. Managed guidance suppresses the built-in Codex
goal instruction and asks agents not to add native goals or schedules. Handle an
already-active unrelated goal explicitly before onboarding that conversation.
Workit does not pick additional backlog issues.

## Attention and blocker ownership

```bash
workit job attention --format json
workit job attention --format text
workit tick --job JOB_ID
```

Attention is a read-only closeout view of durable observations. The JSON view
contains grouped `items` and per-job facts. Each item gives a reason, responsible
party (`owner`, `external`, `system` or `verifier`), opaque dependency identity
when configured, observation time, recheck trigger and concrete next action.
It distinguishes missing verification, recoverable tools, unchanged external
waits, source provenance repair and owner acceptance/hold decisions.

The existing heartbeat refreshes held jobs' GitHub merge/head/check facts at the
job interval without reading or waking their agent conversations. A merged PR
is shown as merged, and a conflicting or failed head loses its previous ready
status. Original hold detail and wake receipts remain available in job status.
Readiness is an observation for policy assessment, never merge authority.
Failed refreshes report an actionable tool error instead of presenting cached
readiness as current. Paused jobs receive only observation/projection work.

Set the same trusted `lifecycle.deploymentDependency` key on jobs that genuinely
share a deployment/provenance dependency. Workit groups matching blocker types
using a digest of that key; attention does not expose the configured key, probe
argv, deployment targets or credentials. Unconfigured dependencies remain
separate per job until explicitly configured as shared. Unrelated configured
keys remain separate. A healthy runtime without its built source/version is an
external repair dependency, never an accepted journey. This workflow does not
modify downstream deployment code.

## Optional independent verifier dispatch

Dispatch is disabled by default. It is read from current trusted user/project
configuration, separate from the launch acceptance snapshot. To explicitly opt
in for a project, configure a review-tagged agent in the shared registry and add:

```yaml
lifecycle:
  verifier:
    enabled: true
    agent: independent-reviewer
    concurrency: 1
    maxAttempts: 2
    timeoutSeconds: 300
```

Example registry entry (the command must already be installed and authorized):

```yaml
agents:
  independent-reviewer:
    command: codex
    tags: [review]
    weight: 1
```

This does not install a scheduler or enable dispatch for other projects. Bounds
are positive integers: concurrency at most 16, attempts at most 10 and timeout
at most 3600 seconds. The default bounds are 1, 2 and 300 respectively. The
store counts reserved, running, uncertain and invalidated runs against capacity;
each reservation consumes one attempt. Failed known outcomes can retry on a
later job interval, within that budget. Budget exhaustion leaves a concrete
manual verification/recovery action. Dispatch disabled or an unavailable review
agent also produces a concrete next action; it never installs an agent.

The heartbeat checks the current AC and merged/serving bindings before reserving
capacity atomically in SQLite. It persists a new independent run/session ID,
binding, attempt count, report path and outcome path **before** calling the
existing Banyan launch integration. The separate headless verifier has a bounded
process timeout and instructions to verify only, without creating native goals
or another scheduler. Explicit human ACs remain owner decisions. Dispatch grants
no permission for paid/provider journeys, external messages, merge, deployment,
AC edits, tracker checklist changes or Done transitions.

Repeated/concurrent ticks and restarts reuse the persisted run. Reports are read
only after the bounded runner writes a complete outcome. Returned reviewer
identity must match that run, and reports pass the ordinary current-AC,
merged-source and serving-version gate. Rejected reports remain unfinished.
Accepted evidence with an open tracker produces `tracker-closeout`; only an
external authorized tracker completion lets a subsequent recheck mark the job
verified. Workit never changes the tracker to Done itself.

A lost launch acknowledgement or crashed reservation becomes uncertain and
holds the job for inspection; no fresh verifier is blindly launched. Inspect
the saved run/session, report, outcome and original conversation before using:

```bash
workit job verifier-reconcile JOB_ID --run-id VERIFIER_RUN_ID --outcome not-delivered --reason "Inspection established no delivered prompt" --expected-revision 18
workit job resume JOB_ID --detail "Inspected hold released"
```

Use `delivered` to continue observing that same compatible run. Use `completed`
only after inspection establishes the run has finished, including an invalidated
run, to archive its identity and release capacity. `not-delivered` permits a
later bounded retry after inspection establishes no delivery. Reconciliation
checks revision and run identity, preserves attempt counts and never releases a
pause/human hold. A cancelled job can reconcile an in-flight verifier receipt
to release capacity while remaining cancelled. Pause/cancel stop new scheduling;
they do not interrupt an already launched verifier. Use Banyan to control its
process. Do not use another reviewer's report to silently replace an active run.

## Owner pause bridge

Banyan's [owner-pause UI integration](https://github.com/banyudu/banyan/issues/142)
must use this exact contract, supplying the revision
and session from the displayed job:

```text
workit job pause JOB_ID --detail TEXT --expected-revision N --expected-session-id SESSION_ID
```

Both expected fields remain optional for older CLI callers. Workit checks them
in the atomic revision update. Either mismatch fails without changing the job
or projecting anything. Success returns the resulting job as JSON, including
`projection: {status, sessionID, revision}`. `status` is `confirmed` when the
Banyan projection command succeeds and `pending` when the durable pause saved
but projection failed. The heartbeat retries projection even for held jobs.
The UI must keep the terminal open until it observes the matching job/session,
revision and paused workflow in Banyan; a durable pause alone is insufficient.

Pause removes future continuation scheduling and preserves the issue, acceptance
history and pending wake audit. It does not verify or cancel the issue, interrupt
an active turn or close a process. If a pending wake exists, inspect the original
conversation and run `job reconcile` before explicitly resuming. Reconciliation
also supports paused jobs and leaves the hold in place. Workit never treats an
uncertain delivery as permission to dispatch a fresh conversation.

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

Stages: `implementing`, `preverifying`, `reviewing`, `waiting-ci`,
`waiting-deploy`, `verifying`, `fixing`, `needs-you`, `paused`, `cancelled`,
`verified`. A follow-up PR clears stale merge/deployment evidence. Ordinary
checkpoints cannot bypass pause/human gates. Pause/cancel stop future automatic
continuations; use Banyan's interrupt control to stop an active turn. They do not
roll back completed effects.

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
Missing/ambiguous conversation identity, unreadable journals, removed worktrees
and uncertain launches never fall back to replaying the initial task in a new
conversation. Recover the named Banyan session first. Repeated auth/control
failures use bounded exponential backoff, then become `needs-you`.

## Verified completion

An independent verifier produces a report covering every current AC. After
acceptance is proven, reconcile the issue's evidence/checklist and completed
state under repository policy, then submit:

```bash
workit job verify JOB_ID --report /absolute/path/verification.json
```

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
the AC hash; contract edits invalidate it, including indented requirements in
separate paragraphs within a criterion. Every AC must occur exactly once with
passing evidence. Deployed acceptance needs applicable journey evidence bound to
the observed target/version. Completion rechecks the merged PR, current ACs,
tracker completion and serving deployment. A changed serving version requires
fresh applicable evidence.

The validator checks completeness and provenance bindings, not the semantic
truth of observations. The independent verifier/repository tools still own
observations, human acceptance and deferred-scope tracking.

Each explicitly deployed AC needs its own serving-bound journey evidence, and
human ACs need explicit `human` evidence. Changing checkbox check marks preserves
the binding; changes to indented criterion requirements also invalidate it.

Process exit, merge, healthy deployment and agent claims do not mark jobs
verified. Verified/cancelled jobs stop scheduling after their final Banyan
projection is delivered. Banyan shows an independent workflow badge and offers
**Close verified sessions**. Repository merge/deployment authorization remains
in force throughout.

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

The closeout suites use disposable SQLite stores, a local Git repository,
GitHub/Banyan command fixtures and a fake bounded review command. They cover
explicit local launch/correction, scope rejection, held merge/conflict refresh,
dependency grouping, competing processes, restart and uncertain-delivery
recovery, dispatch budgets, local/deployed closeout and the exact owner-pause
argv. They do not migrate live jobs, enable dispatch on the developer host or
replace a running CLI. Banyan owns the companion UI and terminal close; its owner
pause integration must observe the matching projected pause before closing.
