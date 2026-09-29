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
in `src/config.ts`) states the finish line explicitly:

```text
Delivery: when the implementation is complete and tests pass, commit and push your
work, then open a pull request (not draft) that describes the change and links this issue.
If a pull request already exists for this branch, do not open a new one: fetch its
review comments, address every unresolved one including automated/bot and CI feedback,
push follow-up commits, and re-request review.
Stay within the scope of the issue and the review feedback; do not expand into
unrelated refactors.
```

The wording is conditional on purpose: a fresh worktree opens the PR, while a
resumed worktree reuses the same prompt and fixes the review comments on it.

Override it per repository — the list replaces the default, so `[]` disables it:

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

## Development

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
