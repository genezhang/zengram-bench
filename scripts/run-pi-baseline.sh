#!/usr/bin/env bash
# Adapter: vanilla Pi (genezhang/pi), no zengram. Baseline arm for BENCH_AGENT=pi.
#
# Implements the SAME flag contract as the OpenCode adapters so the harness is
# agent-agnostic. Pi has no --repo/--max-turns flags: it runs in CWD, and turn
# count is bounded by the wall-clock timeout (BENCH_TIMEOUT_MS), NOT a hard cap
# — an asymmetry vs the OpenCode arms (which cap via agent.build.steps). Note it
# when comparing turn counts.
#
# Usage (harness sets PI_BASELINE_CMD to this):
#   ./run-pi-baseline.sh run --problem-statement @/tmp/p.txt --repo /tmp/repo \
#     --max-turns 100 --output-patch /tmp/out.patch --usage-json /tmp/usage.json
#
# Environment:
#   PI_BIN             pi binary/wrapper (default: "pi"; e.g. /home/gene/pi/pi-test.sh)
#   PI_BENCH_MODEL     passed to pi --model
#   PI_BENCH_PROVIDER  passed to pi --provider
#   PI_BENCH_API_KEY   passed to pi --api-key
set -euo pipefail

PROBLEM="" REPO="" TURNS=100 PATCH="" USAGE="" TRAJ=""
while [[ $# -gt 0 ]]; do
  case $1 in
    run)                 shift ;;
    --problem-statement) PROBLEM="${2#@}"; shift 2 ;;
    --repo)              REPO="$2";        shift 2 ;;
    --max-turns)         TURNS="$2";       shift 2 ;;
    --output-patch)      PATCH="$2";       shift 2 ;;
    --usage-json)        USAGE="$2";       shift 2 ;;
    --trajectory-json)   TRAJ="$2";        shift 2 ;;
    *)                   shift ;;
  esac
done
[[ -z "$PROBLEM" || -z "$REPO" || -z "$PATCH" || -z "$USAGE" ]] && {
  echo "ERROR: missing required flags" >&2; exit 1
}

PI_BIN="${PI_BIN:-pi}"
EVENTS_FILE="${OPENCODE_EVENTS_FILE:-$(mktemp /tmp/pi-baseline-events-XXXXXX.jsonl)}"
PI_SESSION_DIR=$(mktemp -d /tmp/pi-baseline-session-XXXXXX)
trap 'rm -f "$EVENTS_FILE"; rm -rf "$PI_SESSION_DIR"' EXIT

run_once() {
  : > "$EVENTS_FILE"
  local model_args=()
  [[ -n "${PI_BENCH_MODEL:-}"    ]] && model_args+=(--model    "$PI_BENCH_MODEL")
  [[ -n "${PI_BENCH_PROVIDER:-}" ]] && model_args+=(--provider "$PI_BENCH_PROVIDER")
  [[ -n "${PI_BENCH_API_KEY:-}"  ]] && model_args+=(--api-key  "$PI_BENCH_API_KEY")
  # --no-extensions: baseline must not pick up any globally-installed zengram
  # extension (the silent cross-contamination trap). --no-session: ephemeral.
  ( cd "$REPO" && "$PI_BIN" \
      --print --mode json \
      --no-extensions --no-session \
      "${model_args[@]}" \
      "$(cat "$PROBLEM")" ) > "$EVENTS_FILE" 2>&1 || {
        echo "[adapter] pi exited non-zero, capturing partial results" >&2
      }
}

has_turn() {
  python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1], "r", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: evt = json.loads(line)
        except Exception: continue
        if isinstance(evt, dict) and evt.get("type") == "agent_end": sys.exit(0)
sys.exit(1)
PY
}

run_once
if ! has_turn "$EVENTS_FILE"; then
  echo "[adapter] no agent_end event — waiting 90 s then retrying once" >&2
  sleep 90
  run_once
fi

git -C "$REPO" diff HEAD > "$PATCH"

# ── Usage from Pi's json event stream ────────────────────────────────────────
# Pi --mode json emits AgentSessionEvent objects as JSONL. The terminal
# `agent_end` event carries the final messages[]; each assistant message has
# usage {input, output, cacheRead, cacheWrite}. Take the LAST agent_end (dedups
# auto-retries); turns = assistant-message count. Same usage.json schema as the
# OpenCode adapters.
python3 - "$EVENTS_FILE" "$USAGE" "${PI_BENCH_MODEL:-}" <<'PY'
import sys, json
events_file, usage_file = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else ""
last_msgs = None; session_id = None
with open(events_file, "r", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: evt = json.loads(line)
        except Exception: continue
        if not isinstance(evt, dict): continue
        if session_id is None:
            session_id = evt.get("id") or evt.get("sessionId") or evt.get("sessionID")
        if evt.get("type") == "agent_end" and isinstance(evt.get("messages"), list):
            last_msgs = evt["messages"]
turns = prompt_tok = completion_tok = cache_read_tok = turns_with_cache_hit = 0
for m in (last_msgs or []):
    if not isinstance(m, dict) or m.get("role") != "assistant": continue
    u = m.get("usage") or {}
    turns += 1
    prompt_tok     += u.get("input",     0) or 0
    completion_tok += u.get("output",    0) or 0
    cr = u.get("cacheRead", 0) or 0
    cache_read_tok += cr
    if cr > 0: turns_with_cache_hit += 1
out = {"turns": turns, "prompt_tokens": prompt_tok, "completion_tokens": completion_tok,
       "cache_read_tokens": cache_read_tok, "turns_with_cache_hit": turns_with_cache_hit, "model": model}
if session_id: out["session_id"] = session_id
with open(usage_file, "w") as f: json.dump(out, f)
PY
