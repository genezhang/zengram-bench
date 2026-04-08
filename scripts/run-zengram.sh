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

OPENCODE_ZENGRAM_BIN="${OPENCODE_ZENGRAM_BIN:-opencode}"
EVENTS_FILE=$(mktemp /tmp/opencode-zengram-events-XXXXXX.jsonl)
trap 'rm -f "$EVENTS_FILE"' EXIT

# ── Inject max-steps into agent config via env var ───────────────────────────
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT=$(printf '{"agent":{"build":{"steps":%d}}}' "$TURNS")

# ── Run OpenCode fork (Zengram storage enabled by default) ───────────────────
# The fork writes every turn to Zengram as events arrive.  We also capture the
# JSON event stream so we can extract token totals without querying the DB.
"$OPENCODE_ZENGRAM_BIN" run \
  --format json \
  --dir    "$REPO" \
  < "$PROBLEM" > "$EVENTS_FILE" 2>&1 || {
    echo "[adapter] opencode-zengram exited non-zero, capturing partial results" >&2
  }

# ── Capture diff ─────────────────────────────────────────────────────────────
git -C "$REPO" diff HEAD > "$PATCH"

# ── Extract token totals from step_finish events ─────────────────────────────
# step_finish events carry: { type:"step_finish", sessionID, part:{ tokens:{input,output,...} } }
# We also surface the Zengram session ID for downstream tracing.
node --input-type=module <<JS
import fs from 'node:fs';
const raw = fs.readFileSync('${EVENTS_FILE}', 'utf8');
let turns = 0, promptTok = 0, completionTok = 0, sessionID = null;
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try {
    const evt = JSON.parse(line);
    if (evt.sessionID && !sessionID) sessionID = evt.sessionID;
    if (evt.type === 'step_finish') {
      turns++;
      promptTok     += Number(evt.part?.tokens?.input  ?? 0);
      completionTok += Number(evt.part?.tokens?.output ?? 0);
    }
  } catch { /* skip non-JSON lines */ }
}
const out = { turns, prompt_tokens: promptTok, completion_tokens: completionTok };
if (sessionID) out.session_id = sessionID;
fs.writeFileSync('${USAGE}', JSON.stringify(out));
JS
