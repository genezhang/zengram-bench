#!/usr/bin/env bash
# Adapter: wraps the Zengram OpenCode fork for the bench harness.
# Zengram storage is enabled by default in the fork (OPENCODE_STORAGE != "sqlite").
#
# Usage (called automatically by harness when OPENCODE_ZENGRAM_CMD points here):
#   ./run-zengram.sh run \
#     --problem-statement @/tmp/problem.txt \
#     --repo /tmp/repo \
#     --max-turns 30 \
#     --output-patch /tmp/output.patch \
#     --usage-json /tmp/usage.json
#
# Environment:
#   OPENCODE_ZENGRAM_BIN   path to zengram-fork binary (default: "opencode")
set -euo pipefail

PROBLEM="" REPO="" TURNS=30 PATCH="" USAGE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    run)                 shift ;;
    --problem-statement) PROBLEM="${2#@}"; shift 2 ;;
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

# Default to the local fork script, NOT the literal `opencode` binary on PATH.
# The unqualified `opencode` on most dev boxes resolves to an installed
# upstream release (e.g. ~/.opencode/bin/opencode from March), which silently
# runs the *wrong* codebase — no Zengram, no plays — and the bench output
# still looks plausible. Override OPENCODE_ZENGRAM_BIN only when pointing at
# a hand-built fork binary elsewhere.
OPENCODE_ZENGRAM_BIN="${OPENCODE_ZENGRAM_BIN:-$(dirname "$0")/opencode-fork.sh}"
EVENTS_FILE=$(mktemp /tmp/opencode-zengram-events-XXXXXX.jsonl)

# OPENCODE_PINNED_DATA_DIR — when set, reuse this XDG_DATA_HOME across runs
# (multi-session mode: Zengram state accumulates so recall has something to
# return on the 2nd/3rd rep of the same task). When unset, allocate a fresh
# dir per invocation (single-session mode, prior behavior).
if [[ -n "${OPENCODE_PINNED_DATA_DIR:-}" ]]; then
  RUN_DATA_DIR="$OPENCODE_PINNED_DATA_DIR"
  mkdir -p "$RUN_DATA_DIR"
  trap 'rm -f "$EVENTS_FILE"' EXIT  # preserve data dir for next rep
else
  RUN_DATA_DIR=$(mktemp -d /tmp/opencode-zengram-data-XXXXXX)
  trap 'rm -f "$EVENTS_FILE"; rm -rf "$RUN_DATA_DIR"' EXIT
fi

# ── Inject max-steps into agent config via env var ───────────────────────────
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT=$(printf '{"agent":{"build":{"steps":%d}}}' "$TURNS")

# ── Run OpenCode fork (Zengram storage enabled by default) ───────────────────
# The fork writes every turn to Zengram as events arrive.  We also capture the
# JSON event stream so we can extract token totals without querying the DB.
# Retry once after 90 s if the run produces 0 step_finish events (rate limit).
run_once() {
  : > "$EVENTS_FILE"
  # Only wipe the data dir in single-session mode. Multi-session callers
  # (OPENCODE_PINNED_DATA_DIR set) depend on Zengram state persisting across
  # reps, so we must not nuke it between invocations.
  if [[ -z "${OPENCODE_PINNED_DATA_DIR:-}" ]]; then
    rm -rf "$RUN_DATA_DIR" && mkdir -p "$RUN_DATA_DIR"
  fi
  XDG_DATA_HOME="$RUN_DATA_DIR" "$OPENCODE_ZENGRAM_BIN" run \
    --format json \
    --dir    "$REPO" \
    < "$PROBLEM" > "$EVENTS_FILE" 2>&1 || {
      echo "[adapter] opencode-zengram exited non-zero, capturing partial results" >&2
    }
}

run_once
# If no step_finish events were produced, assume rate-limiting and retry once.
if ! grep -q '"type":"step_finish"' "$EVENTS_FILE"; then
  echo "[adapter] no step_finish events — waiting 90 s then retrying once" >&2
  sleep 90
  run_once
fi

# ── Capture diff ─────────────────────────────────────────────────────────────
git -C "$REPO" diff HEAD > "$PATCH"

# ── Extract token totals from step_finish events ─────────────────────────────
# step_finish events carry: { type:"step_finish", sessionID, part:{ tokens:{input,output,...} } }
# We also surface the Zengram session ID for downstream tracing.
python3 - "$EVENTS_FILE" "$USAGE" <<'PY'
import sys, json

events_file, usage_file = sys.argv[1], sys.argv[2]
turns = 0
prompt_tok = 0
completion_tok = 0
session_id = None

with open(events_file, "r", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if evt.get("sessionID") and not session_id:
            session_id = evt["sessionID"]
        if evt.get("type") == "step_finish":
            turns += 1
            tok = (evt.get("part") or {}).get("tokens") or {}
            prompt_tok     += tok.get("input",  0)
            completion_tok += tok.get("output", 0)

out = {"turns": turns, "prompt_tokens": prompt_tok, "completion_tokens": completion_tok}
if session_id:
    out["session_id"] = session_id
with open(usage_file, "w") as f:
    json.dump(out, f)
PY
