#!/usr/bin/env bash
# Adapter: Pi (genezhang/pi) + the zengram memory EXTENSION. Zengram arm for
# BENCH_AGENT=pi. Same flag contract as the other adapters.
#
# Pi has no --repo/--max-turns flags: it runs in CWD and is bounded by the
# wall-clock timeout, NOT a hard turn cap (asymmetry vs OpenCode arms — note it
# when comparing turn counts). The zengram extension is loaded explicitly with
# -e (under --no-extensions, so ONLY it loads — no other discovered extensions).
#
# Usage (harness sets PI_ZENGRAM_CMD to this):
#   ./run-pi-zengram.sh run --problem-statement @/tmp/p.txt --repo /tmp/repo \
#     --max-turns 100 --output-patch /tmp/out.patch --usage-json /tmp/usage.json
#
# Environment:
#   PI_BIN                    pi binary/wrapper (default: "pi")
#   ZENGRAM_PI_EXT            abs path to integrations/pi/zengram-memory.ts
#                             (default: sibling ../../zengram/... of this repo)
#   ZENGRAM_EMBED_MODEL_DIR   local ONNX embed model dir (default: ~/embed)
#   OPENCODE_PINNED_DATA_DIR  if set, persist zengram memory across reps here
#                             (multi-session / compounding); else fresh per run
#   PI_BENCH_MODEL / _PROVIDER / _API_KEY   model wiring
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
ADAPTER_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"

# Resolve the Pi extension entry (sibling zengram checkout by default).
ZENGRAM_PI_EXT="${ZENGRAM_PI_EXT:-$ADAPTER_DIR/../../zengram/integrations/pi/zengram-memory.ts}"
ZENGRAM_PI_EXT="$(readlink -f -- "$ZENGRAM_PI_EXT" 2>/dev/null || echo "$ZENGRAM_PI_EXT")"
if [[ ! -f "$ZENGRAM_PI_EXT" ]]; then
  echo "ERROR: zengram Pi extension not found at $ZENGRAM_PI_EXT" >&2
  echo "       Set ZENGRAM_PI_EXT to integrations/pi/zengram-memory.ts." >&2
  exit 1
fi
if [[ ! -d "$(dirname "$ZENGRAM_PI_EXT")/node_modules/@zengram" ]]; then
  echo "WARN: $(dirname "$ZENGRAM_PI_EXT")/node_modules/@zengram missing — run 'bun install' in the extension dir" >&2
fi

export ZENGRAM_EMBED_MODEL_DIR="${ZENGRAM_EMBED_MODEL_DIR:-$HOME/embed}"

# zengram memory dir: persist across reps when pinned (compounding), else fresh.
if [[ -n "${OPENCODE_PINNED_DATA_DIR:-}" ]]; then
  export ZENGRAM_DATA_DIR="$OPENCODE_PINNED_DATA_DIR"; mkdir -p "$ZENGRAM_DATA_DIR"; PINNED=1
else
  export ZENGRAM_DATA_DIR=$(mktemp -d /tmp/zengram-mem-XXXXXX); PINNED=0
fi
EVENTS_FILE="${OPENCODE_EVENTS_FILE:-$(mktemp /tmp/pi-zengram-events-XXXXXX.jsonl)}"
PI_SESSION_DIR=$(mktemp -d /tmp/pi-zengram-session-XXXXXX)
cleanup() {
  rm -f "$EVENTS_FILE"; rm -rf "$PI_SESSION_DIR"
  [[ "$PINNED" -eq 0 ]] && rm -rf "$ZENGRAM_DATA_DIR" || true
}
trap cleanup EXIT

run_once() {
  : > "$EVENTS_FILE"
  local model_args=()
  [[ -n "${PI_BENCH_MODEL:-}"    ]] && model_args+=(--model    "$PI_BENCH_MODEL")
  [[ -n "${PI_BENCH_PROVIDER:-}" ]] && model_args+=(--provider "$PI_BENCH_PROVIDER")
  [[ -n "${PI_BENCH_API_KEY:-}"  ]] && model_args+=(--api-key  "$PI_BENCH_API_KEY")
  # --no-extensions disables discovery; explicit -e still loads → ONLY zengram.
  ( cd "$REPO" && "$PI_BIN" \
      --print --mode json \
      --no-extensions -e "$ZENGRAM_PI_EXT" --no-session \
      "${model_args[@]}" \
      "$(cat "$PROBLEM")" ) > "$EVENTS_FILE" 2>&1 || {
        echo "[adapter] pi+zengram exited non-zero, capturing partial results" >&2
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

# ── Usage (same parser/schema as run-pi-baseline.sh) ─────────────────────────
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
