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

PROBLEM="" REPO="" TURNS=30 PATCH="" USAGE="" TRAJ=""

while [[ $# -gt 0 ]]; do
  case $1 in
    run)                 shift ;;
    --problem-statement) PROBLEM="${2#@}"; shift 2 ;;   # strip leading @
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
EVENTS_FILE=$(mktemp /tmp/opencode-events-XXXXXX.jsonl)
# Each run gets its own XDG_DATA_HOME so SQLite and any cached state are
# isolated — prevents cross-run corruption from crashes or interrupts.
RUN_DATA_DIR=$(mktemp -d /tmp/opencode-baseline-data-XXXXXX)
trap 'rm -f "$EVENTS_FILE"; rm -rf "$RUN_DATA_DIR"' EXIT

# ── Inject max-steps into agent config via env var ───────────────────────────
# OPENCODE_CONFIG_CONTENT is merged over file-based config at startup.
# "build" is the default primary agent.
export OPENCODE_CONFIG_CONTENT
SAMPLER=""
[[ -n "${OPENCODE_BENCH_TOP_P:-}"      ]] && SAMPLER+=$(printf ',"top_p":%s'      "$OPENCODE_BENCH_TOP_P")
[[ -n "${OPENCODE_BENCH_TEMPERATURE:-}" ]] && SAMPLER+=$(printf ',"temperature":%s' "$OPENCODE_BENCH_TEMPERATURE")
OPENCODE_CONFIG_CONTENT=$(printf '{"agent":{"build":{"steps":%d%s}}}' "$TURNS" "$SAMPLER")

# ── Run OpenCode (baseline = SQLite, no Zengram) ─────────────────────────────
# Pipe problem statement via stdin — avoids shell-quoting issues for large prompts.
# OPENCODE_STORAGE=sqlite disables the Zengram storage layer in the fork.
# Retry once after 90 s if the run produces 0 step_finish events (rate limit).
run_once() {
  : > "$EVENTS_FILE"
  rm -rf "$RUN_DATA_DIR" && mkdir -p "$RUN_DATA_DIR"
  local model_args=()
  if [[ -n "${OPENCODE_BENCH_MODEL:-}" ]]; then
    model_args=(--model "$OPENCODE_BENCH_MODEL")
  fi
  XDG_DATA_HOME="$RUN_DATA_DIR" OPENCODE_STORAGE=sqlite "$OPENCODE_BIN" run \
    --format json \
    --dir    "$REPO" \
    "${model_args[@]}" \
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

# ── Extract token totals + trajectory from event stream ─────────────────────
# step_finish: { type:"step_finish", part:{ tokens:{input,output,cache:{read}} } }
# tool_use:    { type:"tool_use",    part:{ tool, callID, state:{ status, input,
#                                                                output, time:{start,end} } } }
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

current_turn = 0          # incremented on each step_start; tool_use rows tag the in-flight turn
tool_counts = {}
records = []
files = {}                # path -> {"reads": n, "edits": n}
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

with open(usage_file, "w") as f:
    json.dump({
        "turns": turns,
        "prompt_tokens": prompt_tok,
        "completion_tokens": completion_tok,
        "cache_read_tokens": cache_read_tok,
        "turns_with_cache_hit": turns_with_cache_hit,
    }, f)

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
