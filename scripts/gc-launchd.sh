#!/bin/bash
# launchd provides its own PATH. The installed wrapper must include Node,
# Python 3, Git, gh and lsof; recycling policy comes from normal workit config.
set -euo pipefail

WORKIT_GC_REPO="${WORKIT_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}"
WORKIT_GC_REPORT="${WORKIT_GC_REPORT:-${XDG_STATE_HOME:-$HOME/.local/state}/workit/last-gc.json}"
mkdir -p -- "$(dirname -- "$WORKIT_GC_REPORT")"
chmod 700 "$(dirname -- "$WORKIT_GC_REPORT")"

# Launchers, finish hooks and cache relief share the sweep lock. Wait for a
# bounded window so an hourly sweep is not silently skipped as "nothing to do".
exec "${WORKIT_NODE:-node}" "$WORKIT_GC_REPO/dist/cli.js" gc --apply --json \
  --lock-wait "${WORKIT_GC_LOCK_WAIT_SECONDS:-180}" --output "$WORKIT_GC_REPORT" "$@"
