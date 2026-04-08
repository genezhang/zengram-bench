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
trap 'rm -f "$EVENTS_FILE"' EXIT

# ── Inject max-steps into agent config via env var ───────────────────────────
# OPENCODE_CONFIG_CONTENT is merged over file-based config at startup.
# "build" is the default primary agent.
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT=$(printf '{"agent":{"build":{"steps":%d}}}' "$TURNS")

# ── Run OpenCode (baseline = SQLite, no Zengram) ─────────────────────────────
# Pipe problem statement via stdin — avoids shell-quoting issues for large prompts.
# OPENCODE_STORAGE=sqlite disables the Zengram storage layer in the fork.
OPENCODE_STORAGE=sqlite "$OPENCODE_BIN" run \
  --format json \
  --dir    "$REPO" \
  < "$PROBLEM" > "$EVENTS_FILE" 2>&1 || {
    echo "[adapter] opencode exited non-zero, capturing partial results" >&2
  }

# ── Capture diff ─────────────────────────────────────────────────────────────
git -C "$REPO" diff HEAD > "$PATCH"

# ── Extract token totals from step_finish events ─────────────────────────────
# Each step_finish JSON line has: { type:"step_finish", part:{ tokens:{input,output,...} } }
node --input-type=module <<JS
import fs from 'node:fs';
const raw = fs.readFileSync('${EVENTS_FILE}', 'utf8');
let turns = 0, promptTok = 0, completionTok = 0;
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try {
    const evt = JSON.parse(line);
    if (evt.type === 'step_finish') {
      turns++;
      promptTok     += Number(evt.part?.tokens?.input  ?? 0);
      completionTok += Number(evt.part?.tokens?.output ?? 0);
    }
  } catch { /* skip non-JSON lines (stderr mixed in) */ }
}
fs.writeFileSync('${USAGE}', JSON.stringify({
  turns,
  prompt_tokens: promptTok,
  completion_tokens: completionTok,
}));
JS
