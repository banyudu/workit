# workit

`workit` (“work it”) is a TypeScript CLI for opening issue worktrees in a
configured coding-agent session. It unifies the previous `linear-worktree` and
`gh-worktree` launchers behind one command.

```sh
workit 23              # infer GitHub issue #23
workit #23             # infer GitHub issue #23
workit ENG-123         # infer Linear issue ENG-123
workit ENG-123 24      # route each issue independently
```

## Configuration

Configuration is merged in this order:

1. `~/.agents/worktree-agents.yml` (legacy agent configuration)
2. `~/.config/workit/config.yml` or `~/.workit.yml` (user defaults)
3. `projects.<repository-or-root>` in a user config (optional project override)
4. `.workit.yml` in the current repository (project override)

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
