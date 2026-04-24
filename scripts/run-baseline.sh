#!/usr/bin/env bash
# Adapter: wraps vanilla OpenCode (SQLite storage) for the bench harness.
#
# Usage (called automatically by harness when OPENCODE_BASELINE_CMD points here):
#   ./run-baseline.sh run \
#     --problem-statement @/tmp/problem.txt \
#     --repo /tmp/repo \
#     --max-turns 30 \
#     --output-patch /tmp/output.patch \
#     --usage-json /tmp/usage.json
#
# Environment:
#   OPENCODE_BIN   path to opencode binary (default: "opencode")
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
EVENTS_FILE=$(mktemp /tmp/opencode-events-XXXXXX.jsonl)
# Each run gets its own XDG_DATA_HOME so SQLite and any cached state are
# isolated — prevents cross-run corruption from crashes or interrupts.
RUN_DATA_DIR=$(mktemp -d /tmp/opencode-baseline-data-XXXXXX)
trap 'rm -f "$EVENTS_FILE"; rm -rf "$RUN_DATA_DIR"' EXIT

# ── Inject max-steps into agent config via env var ───────────────────────────
# OPENCODE_CONFIG_CONTENT is merged over file-based config at startup.
# "build" is the default primary agent.
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT=$(printf '{"agent":{"build":{"steps":%d}}}' "$TURNS")

# ── Run OpenCode (baseline = SQLite, no Zengram) ─────────────────────────────
# Pipe problem statement via stdin — avoids shell-quoting issues for large prompts.
# OPENCODE_STORAGE=sqlite disables the Zengram storage layer in the fork.
# Retry once after 90 s if the run produces 0 step_finish events (rate limit).
run_once() {
  : > "$EVENTS_FILE"
  rm -rf "$RUN_DATA_DIR" && mkdir -p "$RUN_DATA_DIR"
  XDG_DATA_HOME="$RUN_DATA_DIR" OPENCODE_STORAGE=sqlite "$OPENCODE_BIN" run \
    --format json \
    --dir    "$REPO" \
    < "$PROBLEM" > "$EVENTS_FILE" 2>&1 || {
      echo "[adapter] opencode exited non-zero, capturing partial results" >&2
    }
}

# Whitespace-tolerant step_finish detection — substring grep for
# `"type":"step_finish"` misses lines whose formatter emits spaces, causing
# spurious 90 s retries.
has_step_finish() {
  python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1], "r", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if evt.get("type") == "step_finish":
            sys.exit(0)
sys.exit(1)
PY
}

run_once
# If no step_finish events were produced, assume rate-limiting and retry once.
if ! has_step_finish "$EVENTS_FILE"; then
  echo "[adapter] no step_finish events — waiting 90 s then retrying once" >&2
  sleep 90
  run_once
fi

# ── Capture diff ─────────────────────────────────────────────────────────────
git -C "$REPO" diff HEAD > "$PATCH"

# ── Extract token totals from step_finish events ─────────────────────────────
# Each step_finish JSON line has: { type:"step_finish", part:{ tokens:{input,output,...} } }
python3 - "$EVENTS_FILE" "$USAGE" <<'PY'
import sys, json

events_file, usage_file = sys.argv[1], sys.argv[2]
turns = 0
prompt_tok = 0
completion_tok = 0

with open(events_file, "r", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if evt.get("type") == "step_finish":
            turns += 1
            tok = (evt.get("part") or {}).get("tokens") or {}
            prompt_tok     += tok.get("input",  0)
            completion_tok += tok.get("output", 0)

with open(usage_file, "w") as f:
    json.dump({"turns": turns, "prompt_tokens": prompt_tok, "completion_tokens": completion_tok}, f)
PY
