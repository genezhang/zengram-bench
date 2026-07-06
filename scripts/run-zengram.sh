#!/usr/bin/env bash
# Adapter: vanilla OpenCode + the zengram memory PLUGIN (new architecture).
#
# Replaces the old intrinsic-fork adapter. The zengram arm is now the SAME
# OpenCode binary as the baseline (built from the `work` branch = upstream/dev),
# with the zengram memory layer loaded as a runtime plugin via
# OPENCODE_CONFIG_CONTENT — no forked binary. See
# genezhang/zengram integrations/opencode/README.md.
#
# Usage (called by the harness when OPENCODE_ZENGRAM_CMD points here):
#   ./run-zengram.sh run \
#     --problem-statement @/tmp/problem.txt \
#     --repo /tmp/repo --max-turns 100 \
#     --output-patch /tmp/output.patch --usage-json /tmp/usage.json
#
# Environment:
#   OPENCODE_BIN              vanilla opencode binary (default: "opencode")
#   ZENGRAM_PLUGIN_PATH       abs path to integrations/opencode/zengram-memory.ts
#                             (default: sibling ../../zengram/... of this repo)
#   ZENGRAM_EMBED_MODEL_DIR   local ONNX embed model dir (default: ~/embed)
#   OPENCODE_PINNED_DATA_DIR  if set, persist zengram memory across reps here
#                             (multi-session / compounding); else fresh per run
#   OPENCODE_BENCH_MODEL      passed to opencode --model
#   OPENCODE_BENCH_TOP_P / _TEMPERATURE   optional sampler overrides
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

OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
ADAPTER_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"

# Resolve the plugin entry. Default: zengram checked out as a sibling of this
# bench repo (…/zengram next to …/zengram-bench). Must be absolute — opencode
# resolves plugin specs from OPENCODE_CONFIG_CONTENT with no config-file base
# dir, so a relative path would not resolve.
# Point at the combined entry (index.ts). OpenCode resolves a file-plugin spec
# to the containing dir's package.json `main` anyway (which is index.ts), but
# naming it explicitly is clearer and robust to `main` changes.
ZENGRAM_PLUGIN_PATH="${ZENGRAM_PLUGIN_PATH:-$ADAPTER_DIR/../../zengram/integrations/opencode/index.ts}"
ZENGRAM_PLUGIN_PATH="$(readlink -f -- "$ZENGRAM_PLUGIN_PATH" 2>/dev/null || echo "$ZENGRAM_PLUGIN_PATH")"
if [[ ! -f "$ZENGRAM_PLUGIN_PATH" ]]; then
  echo "ERROR: zengram plugin not found at $ZENGRAM_PLUGIN_PATH" >&2
  echo "       Set ZENGRAM_PLUGIN_PATH to integrations/opencode/index.ts." >&2
  exit 1
fi
# Plugin deps (@zengram/sdk + @zengram/node) must be installed next to it.
if [[ ! -d "$(dirname "$ZENGRAM_PLUGIN_PATH")/node_modules/@zengram" ]]; then
  echo "WARN: $(dirname "$ZENGRAM_PLUGIN_PATH")/node_modules/@zengram missing — run 'bun install' in the plugin dir" >&2
fi

# Local embedding model — the plugin probes SELECT embed(); without a model it
# degrades to importance-ordered recall and skips writes (pin/tool still work).
export ZENGRAM_EMBED_MODEL_DIR="${ZENGRAM_EMBED_MODEL_DIR:-$HOME/embed}"

# ── Arm selection ─────────────────────────────────────────────────────────────
# The combined plugin entry (integrations/opencode/index.ts) exposes BOTH the
# memory and strategy plugins and gates each on an env var. ZENGRAM_ARM picks
# which activate; the run-strategy.sh / run-both.sh wrappers set it. Default
# "memory" preserves this script's historical meaning (the zengram arm = memory
# only), which matters now that the package `main` loads both plugins by default
# — without this gate the zengram arm would silently become "both".
#   memory   → recall/pin only          (strategy off)
#   strategy → phase guide + gotchas     (memory off)
#   both     → memory + strategy
# Set BOTH gate vars explicitly in every branch (not just the "off" one) so an
# inherited ZENGRAM_MEMORY/ZENGRAM_STRATEGY from the launching environment can't
# silently zero out an arm — e.g. a leaked ZENGRAM_MEMORY=0 would otherwise turn
# the default memory arm into "nothing loads".
case "${ZENGRAM_ARM:-memory}" in
  memory)   export ZENGRAM_MEMORY=1 ZENGRAM_STRATEGY=0 ;;
  strategy) export ZENGRAM_MEMORY=0 ZENGRAM_STRATEGY=1 ;;
  both)     export ZENGRAM_MEMORY=1 ZENGRAM_STRATEGY=1 ;;
  *) echo "ERROR: unknown ZENGRAM_ARM='${ZENGRAM_ARM}' (want memory|strategy|both)" >&2; exit 1 ;;
esac

EVENTS_FILE="${OPENCODE_EVENTS_FILE:-$(mktemp /tmp/opencode-zengram-events-XXXXXX.jsonl)}"

# zengram memory dir: persist across reps when pinned (compounding), else fresh.
if [[ -n "${OPENCODE_PINNED_DATA_DIR:-}" ]]; then
  export ZENGRAM_DATA_DIR="$OPENCODE_PINNED_DATA_DIR"
  mkdir -p "$ZENGRAM_DATA_DIR"
  PINNED=1
else
  export ZENGRAM_DATA_DIR=$(mktemp -d /tmp/zengram-mem-XXXXXX)
  PINNED=0
fi
# opencode's OWN session storage stays isolated per run regardless.
OC_DATA_DIR=$(mktemp -d /tmp/opencode-zengram-ocdata-XXXXXX)
cleanup() {
  rm -f "$EVENTS_FILE"; rm -rf "$OC_DATA_DIR"
  [[ "$PINNED" -eq 0 ]] && rm -rf "$ZENGRAM_DATA_DIR" || true
}
trap cleanup EXIT

# ── Build agent config: load the plugin + cap steps (+ optional sampler) ──────
export OPENCODE_CONFIG_CONTENT
NUM_RE='^[0-9]+(\.[0-9]+)?$'
require_numeric() {
  local name="$1" val="$2"
  if ! [[ "$val" =~ $NUM_RE ]]; then
    echo "ERROR: $name must be numeric (got: '$val')" >&2; exit 1
  fi
}
SAMPLER=""
if [[ -n "${OPENCODE_BENCH_TOP_P:-}" ]]; then
  require_numeric OPENCODE_BENCH_TOP_P "$OPENCODE_BENCH_TOP_P"
  SAMPLER+=$(printf ',"top_p":%s' "$OPENCODE_BENCH_TOP_P")
fi
if [[ -n "${OPENCODE_BENCH_TEMPERATURE:-}" ]]; then
  require_numeric OPENCODE_BENCH_TEMPERATURE "$OPENCODE_BENCH_TEMPERATURE"
  SAMPLER+=$(printf ',"temperature":%s' "$OPENCODE_BENCH_TEMPERATURE")
fi
# JSON-encode the plugin path (handles spaces / odd chars) via python.
PLUGIN_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ZENGRAM_PLUGIN_PATH")
OPENCODE_CONFIG_CONTENT=$(printf '{"plugin":[%s],"agent":{"build":{"steps":%d%s}}}' "$PLUGIN_JSON" "$TURNS" "$SAMPLER")

# ── Run OpenCode + zengram plugin ────────────────────────────────────────────
run_once() {
  : > "$EVENTS_FILE"
  if [[ -n "${TRAJ:-}" ]]; then rm -f "$TRAJ"; fi
  # Reset opencode's own session store each attempt; keep zengram memory.
  rm -rf "$OC_DATA_DIR" && mkdir -p "$OC_DATA_DIR"
  local model_args=()
  if [[ -n "${OPENCODE_BENCH_MODEL:-}" ]]; then model_args=(--model "$OPENCODE_BENCH_MODEL"); fi
  local traj_args=()
  if [[ -n "${TRAJ:-}" ]]; then traj_args=(--trajectory-json "$TRAJ"); fi
  XDG_DATA_HOME="$OC_DATA_DIR" "$OPENCODE_BIN" run \
    --format json \
    --dir    "$REPO" \
    "${model_args[@]}" \
    "${traj_args[@]}" \
    < "$PROBLEM" > "$EVENTS_FILE" 2>&1 || {
      echo "[adapter] opencode+zengram exited non-zero, capturing partial results" >&2
    }
}

has_step_finish() {
  python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1], "r", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: evt = json.loads(line)
        except Exception: continue
        if evt.get("type") == "step_finish": sys.exit(0)
sys.exit(1)
PY
}

run_once
if ! has_step_finish "$EVENTS_FILE"; then
  echo "[adapter] no step_finish events — waiting 90 s then retrying once" >&2
  sleep 90
  run_once
fi

# ── Capture diff ─────────────────────────────────────────────────────────────
git -C "$REPO" diff HEAD > "$PATCH"

# ── Extract token totals from step_finish events (same schema as baseline) ───
python3 - "$EVENTS_FILE" "$USAGE" "${OPENCODE_BENCH_MODEL:-}" <<'PY'
import sys, json
events_file, usage_file = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else ""
turns = prompt_tok = completion_tok = cache_read_tok = turns_with_cache_hit = 0
session_id = None
with open(events_file, "r", errors="replace") as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: evt = json.loads(line)
        except Exception: continue
        if evt.get("sessionID") and not session_id: session_id = evt["sessionID"]
        if evt.get("type") == "step_finish":
            turns += 1
            tok = (evt.get("part") or {}).get("tokens") or {}
            prompt_tok     += tok.get("input",  0)
            completion_tok += tok.get("output", 0)
            cr = (tok.get("cache") or {}).get("read", 0)
            cache_read_tok += cr
            if cr > 0: turns_with_cache_hit += 1
out = {"turns": turns, "prompt_tokens": prompt_tok, "completion_tokens": completion_tok,
       "cache_read_tokens": cache_read_tok, "turns_with_cache_hit": turns_with_cache_hit, "model": model}
if session_id: out["session_id"] = session_id
with open(usage_file, "w") as f: json.dump(out, f)
PY
