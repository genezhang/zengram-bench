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
#   OPENCODE_ZENGRAM_BIN   path to zengram-fork binary or wrapper script.
#                          Default: sibling `opencode-fork.sh` (resolved via
#                          BASH_SOURCE so symlinks/PATH-invocation work).
#                          Validated to be executable; error on mismatch.
set -euo pipefail

PROBLEM="" REPO="" TURNS=30 PATCH="" USAGE="" TRAJ=""

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

# Resolve the adapter's own directory via BASH_SOURCE so the default below
# works when the script is invoked through a symlink, via PATH as
# `opencode-zengram`, or with `dirname "$0"` returning `.`. `readlink -f`
# canonicalises the path without relying on `$PWD` at call time.
ADAPTER_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"

# Default to the sibling fork wrapper — NOT the literal `opencode` on PATH.
# The unqualified `opencode` on most dev boxes resolves to an installed
# upstream release (e.g. ~/.opencode/bin/opencode), which silently runs the
# *wrong* codebase — no Zengram, no plays — while still producing
# plausible-looking bench output. Override OPENCODE_ZENGRAM_BIN when
# pointing at a hand-built fork binary elsewhere.
OPENCODE_ZENGRAM_BIN="${OPENCODE_ZENGRAM_BIN:-$ADAPTER_DIR/opencode-fork.sh}"

# Validate the target exists and is executable — a missing file here is the
# kind of silent cross-contamination we're specifically trying to prevent.
if [[ ! -x "$OPENCODE_ZENGRAM_BIN" ]]; then
  echo "ERROR: OPENCODE_ZENGRAM_BIN is not an executable: $OPENCODE_ZENGRAM_BIN" >&2
  echo "       Export OPENCODE_ZENGRAM_BIN to point at your fork binary or" >&2
  echo "       make $ADAPTER_DIR/opencode-fork.sh executable." >&2
  exit 1
fi
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
# Optional sampler overrides (e.g. for local llama.cpp where opencode's default
# top_p=1 hangs on small Qwen models). Falls back to opencode defaults if unset.
SAMPLER=""
[[ -n "${OPENCODE_BENCH_TOP_P:-}"      ]] && SAMPLER+=$(printf ',"top_p":%s'      "$OPENCODE_BENCH_TOP_P")
[[ -n "${OPENCODE_BENCH_TEMPERATURE:-}" ]] && SAMPLER+=$(printf ',"temperature":%s' "$OPENCODE_BENCH_TEMPERATURE")
OPENCODE_CONFIG_CONTENT=$(printf '{"agent":{"build":{"steps":%d%s}}}' "$TURNS" "$SAMPLER")

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
  local model_args=()
  if [[ -n "${OPENCODE_BENCH_MODEL:-}" ]]; then
    model_args=(--model "$OPENCODE_BENCH_MODEL")
  fi
  XDG_DATA_HOME="$RUN_DATA_DIR" "$OPENCODE_ZENGRAM_BIN" run \
    --format json \
    --dir    "$REPO" \
    "${model_args[@]}" \
    < "$PROBLEM" > "$EVENTS_FILE" 2>&1 || {
      echo "[adapter] opencode-zengram exited non-zero, capturing partial results" >&2
    }
}

# Whitespace-tolerant step_finish detection — substring grep for
# `"type":"step_finish"` misses lines whose formatter emits spaces
# (e.g. `"type": "step_finish"`), triggering a spurious 90 s retry.
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

# ── Extract token totals + trajectory from event stream ─────────────────────
# step_finish: tokens (input/output/cache.read) and turn count
# tool_use:    per-call records (tool, input summary, status, duration, output size)
# We also surface the Zengram session ID for downstream tracing.
python3 - "$EVENTS_FILE" "$USAGE" "${TRAJ:-}" <<'PY'
import sys, json

events_file = sys.argv[1]
usage_file  = sys.argv[2]
traj_file   = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

turns = 0
prompt_tok = 0
completion_tok = 0
cache_read_tok = 0
turns_with_cache_hit = 0
session_id = None

current_turn = 0
tool_counts = {}
records = []
files = {}
bash_commands = []

def file_stat(path):
    if path not in files:
        files[path] = {"reads": 0, "edits": 0}
    return files[path]

def summarize(tool, inp):
    if not isinstance(inp, dict):
        return ""
    fp = inp.get("filePath") or inp.get("path")
    if tool in ("read", "edit", "write") and fp:
        return f"path={fp}"
    if tool == "bash":
        cmd = (inp.get("command") or "")[:80]
        return f"cmd={cmd}"
    if tool == "grep":
        pat = inp.get("pattern") or ""
        where = inp.get("path") or inp.get("include") or ""
        return f"pattern={pat} path={where}".strip()
    if tool == "glob":
        return f"pattern={inp.get('pattern') or ''}"
    if tool == "codesearch":
        return f"q={inp.get('query') or inp.get('q') or ''}"
    if tool == "webfetch":
        return f"url={inp.get('url') or ''}"
    keys = ",".join(sorted(k for k in inp.keys() if not k.startswith('_')))[:80]
    return f"keys={keys}"

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
        et = evt.get("type")
        if et == "step_start":
            current_turn += 1
        elif et == "step_finish":
            turns += 1
            tok = (evt.get("part") or {}).get("tokens") or {}
            prompt_tok     += tok.get("input",  0)
            completion_tok += tok.get("output", 0)
            cache = (tok.get("cache") or {})
            cr = cache.get("read", 0)
            cache_read_tok += cr
            if cr > 0:
                turns_with_cache_hit += 1
        elif et == "tool_use":
            part = evt.get("part") or {}
            tool = part.get("tool") or "unknown"
            state = part.get("state") or {}
            status = state.get("status") or "unknown"
            inp = state.get("input") or {}
            t = state.get("time") or {}
            dur = int((t.get("end") or 0) - (t.get("start") or 0)) if t.get("end") and t.get("start") else 0
            out = state.get("output") or ""
            tool_counts[tool] = tool_counts.get(tool, 0) + 1
            records.append({
                "turn": max(current_turn, 1),
                "tool": tool,
                "input_summary": summarize(tool, inp),
                "status": status if status in ("completed", "error") else "completed",
                "duration_ms": dur,
                "output_chars": len(out) if isinstance(out, str) else 0,
            })
            fp = inp.get("filePath") or inp.get("path") if isinstance(inp, dict) else None
            if tool == "read" and fp:
                file_stat(fp)["reads"] += 1
            elif tool in ("edit", "write") and fp:
                file_stat(fp)["edits"] += 1
            elif tool == "bash" and isinstance(inp, dict):
                cmd = (inp.get("command") or "")[:80]
                if cmd:
                    bash_commands.append(cmd)

out = {
    "turns": turns,
    "prompt_tokens": prompt_tok,
    "completion_tokens": completion_tok,
    "cache_read_tokens": cache_read_tok,
    "turns_with_cache_hit": turns_with_cache_hit,
}
if session_id:
    out["session_id"] = session_id
with open(usage_file, "w") as f:
    json.dump(out, f)

if traj_file:
    files_touched = sorted(
        ({"path": p, **stats} for p, stats in files.items()),
        key=lambda r: -(r["reads"] + r["edits"]),
    )
    with open(traj_file, "w") as f:
        json.dump({
            "tool_counts": tool_counts,
            "files_touched": files_touched,
            "bash_commands": bash_commands,
            "records": records,
        }, f)
PY
