#!/usr/bin/env bash
# Adapter: wraps vanilla OpenCode to match the bench harness interface.
# Adjust the opencode invocation to match your actual binary's flags.
#
# Usage (set automatically by harness when OPENCODE_BASELINE_CMD points here):
#   ./run-baseline.sh run \
#     --problem-statement @/tmp/problem.txt \
#     --repo /tmp/repo \
#     --max-turns 30 \
#     --output-patch /tmp/output.patch \
#     --usage-json /tmp/usage.json
set -euo pipefail

PROBLEM="" REPO="" TURNS=30 PATCH="" USAGE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    run)                 shift ;;
    --problem-statement) PROBLEM="${2#@}"; shift 2 ;;   # strip leading @
    --repo)              REPO="$2";        shift 2 ;;
    --max-turns)         TURNS="$2";       shift 2 ;;
    --output-patch)      PATCH="$2";       shift 2 ;;
    --usage-json)        USAGE="$2";       shift 2 ;;
    *)                   shift ;;
  esac
done

[[ -z "$PROBLEM" || -z "$REPO" || -z "$PATCH" || -z "$USAGE" ]] && {
  echo "ERROR: missing required flags" >&2; exit 1
}

OPENCODE_BIN="${OPENCODE_BIN:-opencode}"

# ── Invoke OpenCode ────────────────────────────────────────────────────────────
# TODO: adjust these flags to match your opencode binary's actual CLI.
# The key requirement: run non-interactively, apply changes to $REPO.
"$OPENCODE_BIN" run \
  --message "$(cat "$PROBLEM")" \
  --cwd    "$REPO" \
  --max-turns "$TURNS" \
  --no-tui

# ── Capture diff ───────────────────────────────────────────────────────────────
git -C "$REPO" diff HEAD > "$PATCH"

# ── Write usage ────────────────────────────────────────────────────────────────
# TODO: extract real token counts from OpenCode's output or log file.
# Replace the zeros below with actual values once OpenCode exposes them.
TURNS_ACTUAL=$(git -C "$REPO" log --oneline HEAD..HEAD 2>/dev/null | wc -l || echo 0)
cat > "$USAGE" <<JSON
{"turns": ${TURNS_ACTUAL}, "prompt_tokens": 0, "completion_tokens": 0}
JSON
