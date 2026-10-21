#!/bin/bash
# launchd provides its own PATH. The installed wrapper must include Node,
# Python 3, Git, gh and lsof; recycling policy comes from normal workit config.
set -euo pipefail

WORKIT_GC_REPO="${WORKIT_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}"
WORKIT_GC_REPORT="${WORKIT_GC_REPORT:-${XDG_STATE_HOME:-$HOME/.local/state}/workit/last-gc.json}"
mkdir -p -- "$(dirname -- "$WORKIT_GC_REPORT")"
chmod 700 "$(dirname -- "$WORKIT_GC_REPORT")"

exec "${WORKIT_NODE:-node}" "$WORKIT_GC_REPO/dist/cli.js" gc --apply --json --output "$WORKIT_GC_REPORT" "$@"
