# workit

`workit` (“work it”) is a TypeScript CLI for opening issue worktrees in a
configured coding-agent session. It unifies the previous `linear-worktree` and
`gh-worktree` launchers behind one command.

```sh
workit 23              # infer GitHub issue #23
workit '#23'           # infer GitHub issue #23; quote # in shells
workit ENG-123         # infer Linear issue ENG-123
workit ENG-123 24      # route each issue independently
```

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
| `command` + `weight` + `aliases` | ✓ launch pool | — | — |
| `label` + `provider` + `icon` + `banyanCommand` | — | ✓ session launch | — |
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
