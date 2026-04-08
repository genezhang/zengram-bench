#!/usr/bin/env bash
# Adapter: wraps the Zengram OpenCode fork to match the bench harness interface.
# The fork stores turn/token data in Zengram — this script extracts it via
# the Zengram SDK after the run.
#
# Usage (set automatically by harness when OPENCODE_ZENGRAM_CMD points here):
#   ./run-zengram.sh run \
#     --problem-statement @/tmp/problem.txt \
#     --repo /tmp/repo \
#     --max-turns 30 \
#     --output-patch /tmp/output.patch \
#     --usage-json /tmp/usage.json
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

OPENCODE_ZENGRAM_BIN="${OPENCODE_ZENGRAM_BIN:-opencode-zengram}"

# ── Invoke the Zengram fork ───────────────────────────────────────────────────
# The fork writes a session to Zengram and exits. It should support a
# --bench-session-id flag (or similar) so we can query the session after.
SESSION_ID="bench-$(uname -n)-$$-$(date +%s)"

"$OPENCODE_ZENGRAM_BIN" run \
  --message    "$(cat "$PROBLEM")" \
  --cwd        "$REPO" \
  --max-turns  "$TURNS" \
  --no-tui \
  --session-id "$SESSION_ID"

# ── Capture diff ───────────────────────────────────────────────────────────────
git -C "$REPO" diff HEAD > "$PATCH"

# ── Extract usage from Zengram ────────────────────────────────────────────────
# Query the Zengram embedded DB for the session's token totals.
# Adjust the DB path to wherever the fork stores its Zengram data.
ZENGRAM_DB="${OPENCODE_ZENGRAM_DB:-$HOME/.opencode/zengram}"

node --input-type=module <<JS
import { open } from '@zengram/node';
const db = open('${ZENGRAM_DB}');
const rows = db.query(
  \`SELECT COUNT(*) as turns,
          COALESCE(SUM(prompt_tokens), 0) as pt,
          COALESCE(SUM(completion_tokens), 0) as ct
   FROM turn WHERE session_id = \$1\`,
  ['${SESSION_ID}']
);
const r = rows[0] ?? { turns: 0, pt: 0, ct: 0 };
const fs = await import('node:fs');
fs.writeFileSync('${USAGE}', JSON.stringify({
  turns: Number(r.turns),
  prompt_tokens: Number(r.pt),
  completion_tokens: Number(r.ct),
}));
JS
