#!/usr/bin/env bash
# Thin wrapper: runs the local OpenCode fork via bun.
# Must be invoked from the fork's package dir so bunfig.toml is found.
# Used as both OPENCODE_BIN and OPENCODE_ZENGRAM_BIN — the adapters
# set OPENCODE_STORAGE=sqlite (baseline) or leave it unset (zengram).
#
# Fork location resolution order:
#   1. OPENCODE_FORK_DIR env var (explicit override)
#   2. Sibling repo at ../../opencode/packages/opencode, relative to this script
#   3. $HOME/opencode/packages/opencode (the original convention)
set -euo pipefail

SCRIPT_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"

if [[ -n "${OPENCODE_FORK_DIR:-}" ]]; then
  FORK_DIR="$OPENCODE_FORK_DIR"
elif [[ -f "$SCRIPT_DIR/../../opencode/packages/opencode/bunfig.toml" ]]; then
  FORK_DIR="$(readlink -f -- "$SCRIPT_DIR/../../opencode/packages/opencode")"
elif [[ -f "$HOME/opencode/packages/opencode/bunfig.toml" ]]; then
  FORK_DIR="$HOME/opencode/packages/opencode"
else
  echo "ERROR: opencode fork not found." >&2
  echo "       Set OPENCODE_FORK_DIR to the fork's packages/opencode dir," >&2
  echo "       or place the fork at ../../opencode (relative to this script)" >&2
  echo "       or at \$HOME/opencode." >&2
  exit 1
fi

if [[ ! -f "$FORK_DIR/bunfig.toml" ]]; then
  echo "ERROR: $FORK_DIR does not look like an opencode package dir (no bunfig.toml)" >&2
  exit 1
fi

cd "$FORK_DIR"
exec bun run --conditions=browser ./src/index.ts "$@"
