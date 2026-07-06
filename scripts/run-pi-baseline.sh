#!/usr/bin/env bash
# Adapter: vanilla Pi (genezhang/pi), no zengram. Baseline arm for BENCH_AGENT=pi.
#
# Implements the SAME flag contract as the OpenCode adapters so the harness is
# agent-agnostic. Pi has no native --max-turns flag; we enforce the limit by
# watching the events JSONL for turn_start events and killing pi when the count
# reaches TURNS (passed via --max-turns, defaulting to 100).
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

PI_BIN="${PI_BIN:-$HOME/pi/pi-test.sh}"

# Neutral scope prompt appended to the system prompt. MUST be byte-identical
# across all four Pi adapters — different text across arms confounds the
# comparison (pilot10 post-mortem: baseline's old "minimal change, don't run
# tests, stop" nudge suppressed test-driven iteration and made the arms
# incomparable). Encourages verification without capping effort. Set
# PI_BENCH_APPEND_PROMPT= (empty) to disable; the `-` (no colon) honors an
# explicit empty override.
PI_BENCH_APPEND_PROMPT="${PI_BENCH_APPEND_PROMPT-Work the issue end to end: locate the root cause, implement a fix, and verify it by running the relevant tests. Stay focused on the reported issue; avoid unrelated changes and repeated exploration of the same files. When your fix passes verification, stop.}"

ADAPTER_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"

# Loop-guard extension: detects exact-repeat tool calls and stagnation (many
# read-only calls without an edit) and injects corrective warnings into the
# model's context. Loaded in all arms so the floor is the same. Set
# PI_LOOP_GUARD_EXT= to disable.
LOOP_GUARD_EXT="${PI_LOOP_GUARD_EXT:-$ADAPTER_DIR/../../zengram/integrations/pi/loop-guard.ts}"
LOOP_GUARD_EXT="$(readlink -f -- "$LOOP_GUARD_EXT" 2>/dev/null || echo "$LOOP_GUARD_EXT")"
loop_guard_args=()
if [[ -f "$LOOP_GUARD_EXT" ]]; then
  loop_guard_args+=(-e "$LOOP_GUARD_EXT")
else
  echo "WARN: loop-guard extension not found at $LOOP_GUARD_EXT — running without it" >&2
fi

# Test-runner extension: after each edit/write, runs BENCH_FAIL_TO_PASS tests
# and appends pass/fail feedback to the tool result the model sees. No-ops
# when BENCH_FAIL_TO_PASS is absent. Set PI_TEST_RUNNER_EXT= to disable.
TEST_RUNNER_EXT="${PI_TEST_RUNNER_EXT:-$ADAPTER_DIR/../../zengram/integrations/pi/test-runner.ts}"
TEST_RUNNER_EXT="$(readlink -f -- "$TEST_RUNNER_EXT" 2>/dev/null || echo "$TEST_RUNNER_EXT")"
if [[ -f "$TEST_RUNNER_EXT" ]]; then
  loop_guard_args+=(-e "$TEST_RUNNER_EXT")
else
  echo "WARN: test-runner extension not found at $TEST_RUNNER_EXT — running without it" >&2
fi

EVENTS_FILE="${OPENCODE_EVENTS_FILE:-$(mktemp /tmp/pi-baseline-events-XXXXXX.jsonl)}"
PI_SESSION_DIR=$(mktemp -d /tmp/pi-baseline-session-XXXXXX)
trap 'rm -f "$EVENTS_FILE"; rm -rf "$PI_SESSION_DIR"' EXIT

# Poll the llama.cpp /slots endpoint until all slots are idle.
# Set BENCH_LLM_SLOTS_URL (e.g. http://bronco.local:8080/slots) to enable.
wait_for_bronco_idle() {
  local url="${BENCH_LLM_SLOTS_URL:-}"
  [[ -z "$url" ]] && return 0
  local waited=0 max_wait=${BENCH_LLM_IDLE_WAIT_SECS:-300}
  while [[ "$waited" -lt "$max_wait" ]]; do
    local state
    state=$(curl -sf --max-time 5 "$url" 2>/dev/null | python3 -c "
import json, sys
try:
    slots = json.load(sys.stdin)
    def slot_busy(s):
        if s.get('is_processing'):
            return True
        return any(t.get('has_next_token') for t in (s.get('next_token') or []))
    print('busy' if any(slot_busy(s) for s in slots) else 'idle')
except Exception:
    print('idle')
" 2>/dev/null || echo "idle")
    if [[ "$state" == "idle" ]]; then
      [[ "$waited" -gt 0 ]] && echo "[adapter] LLM server now idle after ${waited}s" >&2
      return 0
    fi
    echo "[adapter] LLM server busy (waited ${waited}s) — sleeping 10s" >&2
    sleep 10
    waited=$((waited + 10))
  done
  echo "[adapter] LLM server still busy after ${max_wait}s — proceeding anyway" >&2
}

# TERM the agent and escalate to KILL if it doesn't exit. Pi is exec'd in the
# launch subshell so $1 is Pi's real PID — a plain `kill` used to hit only the
# wrapper subshell, orphaning Pi, which then kept bronco's single slot busy and
# wedged every subsequent run (pilot10: hourly chains of 0-turn timeouts).
stop_pi() {
  kill "$1" 2>/dev/null || true
  local i
  for i in $(seq 1 15); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 1
  done
  echo "[adapter] pi ignored SIGTERM for 15s — sending SIGKILL" >&2
  kill -9 "$1" 2>/dev/null || true
}

run_once() {
  wait_for_bronco_idle
  : > "$EVENTS_FILE"
  git -C "$REPO" checkout -- . 2>/dev/null || true
  local model_args=()
  [[ -n "${PI_BENCH_MODEL:-}"    ]] && model_args+=(--model    "$PI_BENCH_MODEL")
  [[ -n "${PI_BENCH_PROVIDER:-}" ]] && model_args+=(--provider "$PI_BENCH_PROVIDER")
  [[ -n "${PI_BENCH_API_KEY:-}"  ]] && model_args+=(--api-key  "$PI_BENCH_API_KEY")
  [[ -n "${PI_BENCH_APPEND_PROMPT:-}" ]] && model_args+=(--append-system-prompt "$PI_BENCH_APPEND_PROMPT")
  # --no-extensions: baseline must not pick up any globally-installed extension.
  # loop_guard_args loads ONLY loop-guard via explicit -e (no zengram memory).
  ( cd "$REPO" && exec "$PI_BIN" \
      --print --mode json \
      --no-extensions "${loop_guard_args[@]}" --no-session \
      "${model_args[@]}" \
      "$(cat "$PROBLEM")" ) > "$EVENTS_FILE" 2>&1 &
  local pi_pid=$!
  # Kill pi when turn_start events reach the limit (poll every 5 s).
  # Also kill if no new turn_start appears for BENCH_STALL_TIMEOUT_SECS (default 15 min).
  (
    last_n=0
    last_change=$(date +%s)
    stall_secs=${BENCH_STALL_TIMEOUT_SECS:-900}
    poll=0
    while kill -0 "$pi_pid" 2>/dev/null; do
      sleep 5
      poll=$((poll + 1))
      # Snapshot the working diff every 30 s so a harness-level SIGKILL (60-min
      # timeout) still leaves the latest work in $PATCH instead of losing it.
      if (( poll % 6 == 0 )); then
        git -C "$REPO" diff HEAD > "$PATCH" 2>/dev/null || true
      fi
      n=$(grep -c '"type":"turn_start"' "$EVENTS_FILE" 2>/dev/null || echo 0)
      if [[ "$n" -gt "$last_n" ]]; then
        last_n=$n
        last_change=$(date +%s)
      fi
      if [[ "$n" -ge "$TURNS" ]]; then
        echo "[adapter] turn limit $TURNS reached ($n turns) — stopping pi" >&2
        stop_pi "$pi_pid"
        break
      fi
      elapsed=$(( $(date +%s) - last_change ))
      if [[ "$elapsed" -ge "$stall_secs" ]]; then
        echo "[adapter] stalled: no new turn_start in ${elapsed}s (at $n turns) — killing pi" >&2
        stop_pi "$pi_pid"
        break
      fi
    done
  ) &
  local watcher_pid=$!
  wait "$pi_pid" 2>/dev/null || true
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
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
  n=$(grep -c '"type":"turn_start"' "$EVENTS_FILE" 2>/dev/null || echo 0)
  if [[ "$n" -ge "$TURNS" ]]; then
    echo "[adapter] turn limit $TURNS reached — not retrying" >&2
  else
    # Snapshot attempt 1 before the retry resets the repo and truncates the
    # events file — a failed retry used to wipe real (sometimes resolving)
    # work and report it as a 0-turn empty-patch run.
    git -C "$REPO" diff HEAD > "${PATCH}.attempt1" 2>/dev/null || true
    cp -f "$EVENTS_FILE" "${EVENTS_FILE}.attempt1" 2>/dev/null || true
    echo "[adapter] no agent_end event — waiting 90 s then retrying once" >&2
    sleep 90
    run_once
  fi
fi

git -C "$REPO" diff HEAD > "$PATCH"
# If the retry came back empty but attempt 1 had a diff, restore attempt 1's
# patch and events so scoring and usage reflect the real work done.
if [[ ! -s "$PATCH" && -s "${PATCH}.attempt1" ]]; then
  echo "[adapter] retry produced no diff — keeping attempt 1's patch/events" >&2
  mv -f "${PATCH}.attempt1" "$PATCH"
  [[ -s "${EVENTS_FILE}.attempt1" ]] && mv -f "${EVENTS_FILE}.attempt1" "$EVENTS_FILE"
fi
rm -f "${PATCH}.attempt1" "${EVENTS_FILE}.attempt1"

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
if turns == 0:
    # No agent_end (Pi was killed mid-run): recover real usage from per-turn
    # turn_end events — same fallback the harness applies to SIGKILL'd runs.
    # Without this, a stall-killed run with 40 real turns reported 0 turns.
    with open(events_file, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: evt = json.loads(line)
            except Exception: continue
            if not isinstance(evt, dict) or evt.get("type") != "turn_end": continue
            u = (evt.get("message") or {}).get("usage") or {}
            turns += 1
            prompt_tok     += u.get("input",  0) or 0
            completion_tok += u.get("output", 0) or 0
            cr = u.get("cacheRead", 0) or 0
            cache_read_tok += cr
            if cr > 0: turns_with_cache_hit += 1
out = {"turns": turns, "prompt_tokens": prompt_tok, "completion_tokens": completion_tok,
       "cache_read_tokens": cache_read_tok, "turns_with_cache_hit": turns_with_cache_hit, "model": model}
if session_id: out["session_id"] = session_id
with open(usage_file, "w") as f: json.dump(out, f)
PY
