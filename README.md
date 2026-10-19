# workit

`workit` (“work it”) is a TypeScript CLI for opening issue worktrees in a
configured coding-agent session. It unifies the previous `linear-worktree` and
`gh-worktree` launchers behind one command.

```sh
workit 23              # infer GitHub issue #23
workit '#23'           # infer GitHub issue #23; quote # in shells
workit ENG-123         # infer Linear issue ENG-123 (auto-resolves repo from project)
workit ENG-123 24      # route each issue independently (Linear ids may land in different repos)
```

## Linear project resolution

`workit ENG-123` works from anywhere. Each Linear id resolves its local repo
independently:

1. explicit `--repo-path <path>` (or path-like `--repo <path>`)
2. current repo, when its `.agents/context.md` declares the same `linear.project`
3. static map(s): `$WORKIT_MAP` > `~/.config/workit/map.yml` >
   `$REVIEW_LINEAR_MAP` > `~/.config/review-linear/map.yml`
4. dynamic scan of `.agents/context.md` (`linear.project`) under the roots
   (`--roots` > `$WORKIT_ROOTS` > `$REVIEW_LINEAR_ROOTS` > `~/dev`)
5. current git repo fallback (or an error outside a repo)

Maps share the neutral `project: repo-path` format, so workit's map and
review-linear's map are symlink-compatible. Regenerate workit's map with:

```sh
workit sync-map [--map <path>] [--roots <dirs>]
```

Smart `--repo`: path-like values (`~/`, `/`, `./`, `../`, or an existing
directory) switch the worktree root; otherwise the value is a GitHub
`owner/name` override. `--no-resolve` disables auto-switching. Per-repo
`.workit.yml` may set `resolve: {map, roots, auto}`.

## Install

Install globally from npm; the package registers the `workit` executable:

```sh
npm install --global @banyudu/workit
workit --help
```

## Worktree dependencies

For a disposable verification worktree, prepare dependencies after checking out
the revision being verified:

```sh
workit prepare --worktree /path/to/repo/.worktrees/review-job --dependencies clone
```

`clone` gives the worktree its own root and workspace `node_modules` directories
using copy-on-write filesystem clones. It reuses the source installation only
when manifests, lockfiles and package-manager configuration match. Absolute
workspace links are rebased into the worktree. If cloning is unavailable or any
dependency link escapes the worktree, preparation falls back to a frozen install
using the package manager's cache. Package installation scripts are disabled.
Use `--dependencies install` to always reconcile against the target lockfile,
or `none` for checks that do not need dependencies. The command copies configured
environment files and allows direnv, without fetching or changing an issue.

For normal issue launches, `--build` selects clone mode and `--install` selects
install mode. Both upgrade existing `node_modules` directory symlinks without
modifying the original checkout's dependencies. The default issue-launch mode
remains `symlink`; verification launchers should explicitly choose `clone` or
`install` when their tooling requires dependencies to stay inside the worktree.

## Configuration

Configuration is merged in this order:

1. `~/.agents/worktree-agents.yml` (legacy agent configuration)
2. `~/.config/workit/config.yml` or `~/.workit.yml` (user defaults)
3. `~/.agents/agents.yml` (canonical coding-agent registry — see below)
4. `projects.<repository-or-root>` in a user config (optional project override)
5. `.workit.yml` in the current repository (project override)

The project file wins. YAML and JSON are supported. A minimal user
configuration is:

```yaml
provider: auto
default: codex
agents:
  claude:
    provider: claude
    weight: 3
    command: claude --dangerously-skip-permissions
  codex:
    provider: codex
    weight: 2
    command: codex -p terra --dangerously-bypass-approvals-and-sandbox
```

Positive agent weights are sampled independently for every issue. If all
weights are zero, `default` is used.

### Time-sensitive weights

Models with peak/off-peak pricing can carry `timeWeights`, a list of windows
whose `weight` replaces the static one while the window is in force. Windows
are read in their own `tz`, so the weekday boundary follows the vendor's
calendar rather than UTC's:

```yaml
agents:
  dpsk-flash:
    weight: 4          # off-peak: half price, so preferred
    horizon: 60m       # expected session length
    tags: [coding]
    command: opencode --agent dpsk-v4-flash
    timeWeights:
      - tz: Asia/Shanghai
        weekdays: [mon, tue, wed, thu, fri]
        ranges: ["09:00-12:00", "14:00-18:00"]
        weight: 1      # peak: 2x price, so avoided
        bufferBefore: 0m
```

A rule applies when `[now, now + horizon + bufferBefore]` **overlaps** one of
its ranges — not merely when `now` falls inside one. Sessions run for many
rounds, so one started at 13:59 bleeds into the 14:00 peak and is billed at
peak rates; with a 60m horizon it is priced as peak from 13:00 onward. The
expansion is deliberately one-sided: starting at 11:59, inside a peak tail,
stays peak-weighted even though most of the session lands off-peak.

| field | default | meaning |
|---|---|---|
| `tz` | `UTC` | IANA zone the ranges and weekdays are read in |
| `weekdays` | every day | whitelist of `mon`..`sun` |
| `ranges` | all day | `HH:MM-HH:MM`; an end at or before the start wraps past midnight |
| `weight` | — | required; weight used while the rule is in force |
| `bufferBefore` | `0m` | extra lookahead on top of `horizon` |
| `horizon` (on the entry) | `60m` | expected session length |

Ranges are half-open, so a `09:00-12:00` window has already closed at `12:00`.
The first matching rule wins, letting specific windows precede general ones.
An effective weight of `0` drops the agent from the pool entirely.

Entries without `timeWeights` are sampled on their static `weight` exactly as
before. Preview the arithmetic without launching anything:

```sh
workit agents --at 2026-09-14T05:59:00Z   # Beijing Mon 13:59 -> weight 4→1
workit --dry-run --verbose 23             # effective weights + the rule that fired
```

### Coding-agent registry (single source of truth)

`~/.agents/agents.yml` defines every coding agent once and drives all
surfaces that need them:

- **workit** reads it directly for weighted issue launching.
- **banyan** model picker (`~/.banyan/config.yml`) is generated from it.
- **opencode** (`~/.config/opencode/opencode.jsonc`) is generated from it.

Every `workit` run quietly regenerates the derived files when they differ
(backups of the last hand-written versions are kept as `<file>.orig`), or run
`workit sync` explicitly (`--check` exits non-zero when stale).

Each registry entry can drive up to three surfaces:

| field | workit | banyan | opencode |
|---|---|---|---|
| `command` + `weight` + `aliases` + `horizon` + `timeWeights` | ✓ launch pool | — | — |
| `label` + `provider` + `icon` + `banyanCommand` | — | ✓ session launch | — |
| `puckProvider` + `puckModel` + `puckAccount` | — | ✓ puckd session route | — |
| `opencodeName` + `opencode` | — | — | ✓ agent definition |

Rules: an entry only surfaces on a surface whose tag it carries — `tags` is a
whitelist and entries without tags appear nowhere. Concretely: entries tagged
`coding` with a non-empty `command` join the workit pool; entries tagged
`banyan` with a defined `command` (empty string allowed, e.g. zsh) appear in
banyan's picker; entries with an `opencode` block land in opencode.jsonc.

```yaml
default: codex

agents:
  claude:
    label: Claude
    provider: claude
    weight: 3
    tags: [banyan, coding, review] # banyan picker + workit pool + review-linear
    command: claude --dangerously-skip-permissions --model 'opus' --effort xhigh
    banyanCommand: claude          # optional picker-specific command

  muse:
    label: Muse Spark
    provider: muse
    weight: 0
    tags: [banyan, coding]
    aliases: [muse-spark]          # extra --agent names for workit
    command: opencode --agent muse-spark
    puckProvider: opencode-go       # Banyan uses puckd; workit keeps its CLI command
    puckModel: muse-spark-1.2-contributor
    puckAccount: personal
    opencodeName: muse-spark       # key inside opencode.jsonc
    opencode:                      # raw block written into opencode.jsonc
      mode: primary
      model: opencode-go/muse-spark-1.2-contributor
      reasoningEffort: xhigh
      permission: allow

opencode:                          # non-agent passthrough into opencode.jsonc
  default_agent: ox-alpha
  provider: {}
```

### Built-in agents

`workit` ships with fallback defaults used when no registry exists (see
`src/config.ts:116`):

| workit name | opencode agent | command | shortcut |
|---|---|---|---|
| `claude` | — | `claude --dangerously-skip-permissions ...` | `--claude` |
| `codex` | — | `codex -p terra ...` | `--codex` |
| `opencode` | default | `opencode` | `--opencode` |
| `muse` / `muse-spark` | `muse-spark` | `opencode --agent muse-spark` | `--muse` |
| `mimo` | `mimo` | `opencode --agent mimo` | `--mimo` |
| `hy` / `hy3` | `hy3` | `opencode --agent hy3` | `--hy` |
| `dpsk-flash` / `dpsk-v4-flash` | `dpsk-v4-flash` | `opencode --agent dpsk-v4-flash` | `--dpsk-flash` |
| `dpsk-pro` / `dpsk-v4-pro` | `dpsk-v4-pro` | `opencode --agent dpsk-v4-pro` | `--dpsk-pro` |
| `qwen` | `qwen` | `opencode --agent qwen` | `--qwen` |

Override any agent via YAML, e.g.:

```yaml
agents:
  muse:
    provider: opencode
    weight: 1
    command: opencode --agent muse-spark
```

Explicit selection:

```sh
workit --muse ENG-123        # same as --agent muse
workit --agent dpsk-pro 42   # any name in `agents`
workit --mimo --here 23      # mimo agent, current terminal
```

OpenCode prompt handling injects `--prompt` automatically for `opencode` TUI commands
(`opencode run` keeps positional message).

### Prompt guidance

Every issue prompt ends with `launch.instructions`, a list of guidance lines
appended after the issue body. The built-in default (`DEFAULT_LAUNCH_INSTRUCTIONS`
in `src/config.ts`) asks the agent to:

- Implement, test, commit, push, and open a ready-for-review PR, or reuse the
  branch's existing PR.
- Wait for Superdog's review, address actionable review and CI feedback, test,
  and push fixes. Repeat until Superdog scores the **current PR head commit
  5/5**, actionable feedback is addressed, and required checks pass.
- Verify the reviewed commit SHA using review/check metadata. Older scores and
  missing or pending reviews do not satisfy completion. Report unavailable
  reviewers or other external blockers with evidence.
- Hand a merged Linear issue over: attach the PR and set the issue state to
  **In Review**. After independent acceptance verification and evidence/checklist
  reconciliation, move it to **Done**. Managed jobs do this automatically when
  `workit job verify` accepts the report, with heartbeat retries for tracker failures.
- Stay within the issue and review scope.

For Codex, the prompt explicitly requests `get_goal` and `create_goal` before
starting, so the delivery and review objective can persist across turns. It
reuses a matching active goal and reports unrelated unfinished or inactive
goals instead of replacing or resuming them automatically. If native goal tools
are unavailable, the agent is asked to disclose that limitation and continue
the review loop. Other agents receive the review-loop instructions without a
request to use Codex's goal tools.

For unmanaged launches this is prompt guidance; continuation depends on the
selected agent. [Managed issue delivery](docs/managed-delivery.md) uses workit's
durable heartbeat and guarded Banyan continuation instead of the built-in native
goal instruction, and it performs the Linear review handoff itself once it
observes the merge, so that guidance is dropped from managed prompts.
Managed verification follows the issue's ACs. Use
`workit --managed --verification local ENG-123` for locally verifiable tooling;
`job checkpoint` and `job resume` also accept `--verification local|deployed` to
correct an inherited default for one job. Local mode still requires merged
source and independent evidence for every AC.
Repositories without Superdog can replace the guidance below with their own
review policy.

Banyan launches inherit the calling session from `BANYAN_SESSION_ID`. Set
`BANYAN_PARENT_SESSION_ID` to nest under a different session. Workit resolves
the parent before clearing the child CLI's identity variables, and uses
`--no-parent` when neither variable contains an ID. If the parent is missing or closed,
workit retries once as a top-level session after a confirmed HTTP 400
missing-parent rejection. Other errors are reported without retrying.
Set `launch.parentFallback: false` or pass `--no-parent-fallback` to require the
parent; `--parent-fallback` enables fallback for a single run.

Override the prompt guidance per repository — the list replaces the default,
so `[]` disables it:

```yaml
launch:
  instructions:
    - Use the repo ship skill to open the pull request.
    - Then address any review comments.
```

For a single run, `--instructions <text>` appends one line (repeatable) and
`--no-instructions` drops the guidance entirely.

Project-specific settings can be as small as:

```yaml
provider: github
github:
  repo: banyudu/example
launch:
  target: banyan
```

The default provider is `auto`: numeric identifiers route to GitHub and
`PROJECT-123`-style identifiers route to Linear. Use `--linear` or `--github`
to override inference.

## Worktree recycling

`workit gc` reports lifecycle decisions without changing checkouts. Pass `--apply`
to execute them. Clean inactive checkouts are deleted directly; branches stay in
the repository, and `refs/workit-gc/retired/<record-id>-<head>` pins their commits,
including detached revisions. Routine GC makes no full-checkout archives or Git
bundles and needs no external SSD. With `preserveLocalState`, only unique local
files are copied and hash/mode/link verified under the internal runtime state
directory before retirement. Existing
archives remain untouched and keep their original `RESTORE.txt` instructions.

Use `--json` or `--output /path/to/report.json` for automation. Reports include
operation, elapsed milliseconds and archive/restored bytes (zero for routine
GC). Runtime records live in `~/.local/state/workit/state.sqlite`, outside the
checkout; `WORKIT_GC_STATE` overrides that path. Python 3, Git and `lsof` are
required; GitHub CLI supplies exact merged PR head evidence when available.

```sh
workit gc --dry-run
workit gc --apply --max-actions 4
workit gc --dry-run --only-repo ~/dev/my-project
workit gc --dry-run --remnants-only
workit gc register --worktree /path/to/checkout --role implementation
workit gc register --worktree /path/to/slot --role pool
workit gc keep --worktree /path/to/checkout
workit gc keep --worktree /path/to/checkout --off
# Recover a deleted checkout at its saved revision:
git worktree add --detach /path/to/restored refs/workit-gc/retired/RECORD-ID-HEAD
# Recreate committed source and restore preserved local files together:
workit gc restore --state ~/.local/state/workit/retained-state/SNAPSHOT --worktree /path/to/restored
```

Issue launchers register implementation checkouts and lease them during
preparation. Review launchers register immutable `job.json` ownership before
setup, hand off the lease to the supervisor, and call `gc finish --apply` after
the agent exits. Result JSON and agent logs stay in the external job directory.
PID and process start time identify leases, so PID reuse cannot keep a dead job
alive. Pool owners call `gc lease --worktree PATH --pid PID` before use and
`gc release` afterward. Keep flags and repository exclusions always win.

Configure defaults in `~/.config/workit/config.yml`; `.workit.yml` supplies
repository overrides:

```yaml
gc:
  enabled: true
  repositories: [~/dev/my-project]
  excludedRepositories: [~/dev/never-clean]
  # banyanctl: /path/to/banyanctl
  reviewGraceHours: 1
  mergedIdleHours: 24
  cacheIdleDays: 14
  retireIdleDays: 30
  warmPoolSize: 2
  poolIdleDays: 7
  minFreeGB: 100
  maxActions: 4
  maxRunMinutes: 2
  # Keep live checkouts plus this many warm idle checkouts per repository:
  idleWorktrees: 2
  preserveLocalState: true
  maxLocalStateMB: 256
  # Optional soft targets; protected or locally changed work can exceed them.
  # targetWorktrees: 5
  # excessIdleHours: 1
  # recycleUnclassified: true
  # cleanupRemnants: true
  # remnantIdleHours: 24
  # Exact relative paths, only when all their local contents are disposable:
  # disposablePaths: [.greptile/config.json]
  # repositoryPolicies:
  #   ~/dev/busy-project:
  #     idleWorktrees: 1
```

Open Banyan sessions (including waiting/suspended sessions), live process working
directories or open files, keep flags, Git locks, nested checkouts and live leases
protect a checkout. An unavailable configured activity source prevents cleanup.
Agent history, Git operations and index activity determine idle age. Local edits,
staged changes, untracked files, and ignored local data such as databases or
environment files are retained regardless of age. Index flags that can conceal
changes (`skip-worktree` or `assume-unchanged`) also retain the checkout.
Local files do not prevent independent trimming of generated caches. With
`preserveLocalState: true`, a clean checkout can retire after its unique local
roots are copied and verified. Only these roots are hashed; committed source and
dependencies are not backed up. Files exceeding `maxLocalStateMB`, special files,
or changing data prevent retirement. Snapshots retain permissions and symlinks,
contain `record.json` and restoration instructions, and are never auto-deleted.

Known rebuildable caches (`node_modules`, `.build`, `.next`, `target`, and
`.direnv/nix-sources`) may be removed from valid Git checkouts. Tracked files
inside them remain protected. `disposablePaths` explicitly permits additional
exact files/directories; unknown siblings stay protected. GC does not follow
symlinks when deleting caches and only makes owned cache directories writable.
Native agent session histories are never part of worktree cleanup.

Clean implementations recycle after their exact PR head is merged and idle,
or after `retireIdleDays`. Idle implementations below that age can trim caches.
Clean completed reviews recycle promptly; interrupted reviews wait for their
owner to exit and the recovery grace. Pools retain the newest two idle slots
plus active leases. Dirty reviews remain available for inspection.

`targetWorktrees` reserves capacity for protected sessions/jobs and recently
used idle checkouts, then removes excess inactive clean checkouts after
`excessIdleHours`. `recycleUnclassified` opts unknown Git checkouts under
`.worktrees` into this policy. `recycleExternalWorktrees` additionally opts in
Git-registered checkouts outside that directory. Neither flag overrides local
state protection. `repositoryPolicies` supplies per-repository personal policy.
`idleWorktrees` replaces the fixed total target with an idle allowance in addition
to protected live work. Its newest idle checkouts stay warm; excess checkouts
retire after `excessIdleHours`. Local modifications always remain protected.
`--only-repo` restricts discovery and actions; `--repo` adds repositories to the
normal inventory. Legacy `archiveIdleDays`, `archiveUnclassified`, and
`archiveExternalWorktrees` remain aliases when the new fields are absent.
Legacy archive destination and dirty-review archive settings do not enable
backups or force deletion of dirty work.

`cleanupRemnants` opts in unregistered, non-hidden direct folders under
`.worktrees`. Without Git metadata, remaining files cannot be assumed to exist
in a commit: only empty folders or explicitly disposable contents can be
removed after `remnantIdleHours`. Unknown source files and agent metadata stay.
Git-owned roots, nested Git directories, symlinks and control directories stay.
`--remnants-only` limits a run to these folders and partial review deletions.

All apply paths share one nonblocking cleanup worker: scheduled sweeps,
`gc finish`, and cache pressure relief cannot delete different worktrees in
parallel. Busy finish calls record completion first and leave cleanup pending
for the next sweep. Per-checkout locks still coordinate creators and leases.
`maxActions` and `maxRunMinutes` bound inspections/actions after discovery and
activity collection; an in-progress deletion finishes safely. Persistent
inspection checkpoints rotate successive sweeps past retained/dirty entries
without changing lifecycle age. Apply commands run at reduced process priority
when supported.

The four-hour scheduler runs `scripts/gc-launchd.sh`; its report is
`~/.local/state/workit/last-gc.json` (`WORKIT_GC_REPORT` overrides it). Launchers
also provide bounded cache-only pressure relief below `minFreeGB`, at most once
per repository per five minutes. Discovery imports known review metadata and
matching workit launches. Failures are reported with a nonzero exit.

## Development commands

```sh
bun install
bun run typecheck
bun test
bun run build
```

The old `linear-worktree`, `gh-worktree`, and `banyan-worktree` commands can be
kept as compatibility wrappers that delegate to this CLI.

## Automated npm publishing

The repository publishes `@banyudu/workit` when a GitHub Release is published.
Configure npm Trusted Publishing for this repository under the package's npm
Settings → Trusted publishing:

- Provider: GitHub Actions
- Organization or user: `banyudu`
- Repository: `workit`
- Workflow filename: `npm-publish.yml`
- Allowed action: `npm publish`

No `NPM_TOKEN` secret is required. GitHub Actions supplies a short-lived OIDC
credential, and npm generates provenance automatically. The release tag must
match the package version, with an optional `v` prefix (`v0.1.0` for version
`0.1.0`). The workflow can also be started manually from the Actions tab.

For a brand-new npm package, npm requires the package to exist before its
trusted publisher can be configured. Seed the first version once with an
interactive local `npm publish --access public`, configure Trusted Publishing,
and use the workflow for subsequent releases.
