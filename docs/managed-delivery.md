# Managed issue delivery

Managed launches own one issue through implementation, local preverification,
review/CI repair, authorized merge, deployment waiting, independent acceptance
and tracker closeout. They are opt-in:

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
supply new probe commands. Use `verification: local` only when every AC has
reliable local acceptance. It still requires a merged PR, independent evidence
and tracker closeout.

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
the AC hash; contract edits invalidate it. Every AC must occur exactly once with
passing evidence. Deployed acceptance needs applicable journey evidence bound to
the observed target/version. Completion rechecks the merged PR, current ACs,
tracker completion and serving deployment. A changed serving version requires
fresh applicable evidence.

The validator checks completeness and provenance bindings, not the semantic
truth of observations. The independent verifier/repository tools still own
observations, human acceptance and deferred-scope tracking.

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
