#!/usr/bin/env bash
# Pi bench driver — the missing analog of run-ablation.sh for Pi runs.
#
# Sets all Pi/bronco env vars so the adapter scripts (run-pi-strategy.sh etc.)
# get what they need. Calls the harness with --multi-session so strategy state
# persists across reps. Runs under systemd-inhibit to survive lid-close/idle.
#
# Usage:
#   ./run-pi.sh [--filter ID,...] [--variants V,...] [--runs N] [--clean] [--dry-run]
#
# Examples:
#   ./run-pi.sh --dry-run --filter django__django-10097
#   ./run-pi.sh --filter django__django-10097 --clean
#   ./run-pi.sh --filter django__django-11099,django__django-13513 --variants strategy,both --runs 5

set -euo pipefail
BENCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
FILTER=""
VARIANTS="strategy"
RUNS="1"
CLEAN=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --filter)    FILTER="$2";   shift 2 ;;
    --variants)  VARIANTS="$2"; shift 2 ;;
    --runs)      RUNS="$2";     shift 2 ;;
    --clean)     CLEAN=1;       shift ;;
    --dry-run)   DRY_RUN=1;     shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── Pi + bronco env (hardcoded; override via env if needed) ───────────────────
export BENCH_AGENT="pi"
export PI_BIN="${PI_BIN:-$HOME/pi/pi-test.sh}"
export PI_BENCH_MODEL="${PI_BENCH_MODEL:-Qwen3-Coder-Next-UD-Q6_K_XL-00001-of-00003.gguf}"
export PI_BENCH_PROVIDER="${PI_BENCH_PROVIDER:-bronco}"
export PI_BENCH_API_KEY="${PI_BENCH_API_KEY:-bronco}"
export BENCH_LLM_SLOTS_URL="${BENCH_LLM_SLOTS_URL:-http://bronco.local:8080/slots}"
export ZENGRAM_EMBED_MODEL_DIR="${ZENGRAM_EMBED_MODEL_DIR:-$HOME/embed}"

# ── Pre-flight ────────────────────────────────────────────────────────────────
if ! curl -sf --max-time 5 "http://bronco.local:8080/health" > /dev/null 2>&1; then
  echo "ERROR: bronco not reachable at bronco.local:8080 — is llama-server running?" >&2
  exit 1
fi
if [[ ! -f "$PI_BIN" ]]; then
  echo "ERROR: PI_BIN not found: $PI_BIN" >&2
  exit 1
fi

echo "bronco: OK  |  model: $PI_BENCH_MODEL  |  PI_BIN: $PI_BIN"

# ── Optional clean ────────────────────────────────────────────────────────────
if [[ "$CLEAN" -eq 1 ]]; then
  VARIANT_LIST=(); IFS=',' read -ra VARIANT_LIST <<< "$VARIANTS"
  TASK_LIST=()
  if [[ -n "$FILTER" ]]; then
    IFS=',' read -ra TASK_LIST <<< "$FILTER"
  else
    while IFS= read -r line; do
      [[ "$line" =~ ^# || -z "$line" ]] && continue; TASK_LIST+=("$line")
    done < "$BENCH/tasks/django_subset.txt"
  fi
  echo "Cleaning:"
  for task in "${TASK_LIST[@]}"; do
    for v in "${VARIANT_LIST[@]}"; do
      for (( i=0; i<RUNS; i++ )); do
        f="$BENCH/results/runs/${task}_${v}_${i}.json"
        d="$BENCH/results/multi-session-state/_${task}_${v}"
        [[ -f "$f" ]] && { echo "  rm $f"; rm -f "$f"; }
        [[ -d "$d" ]] && { echo "  rm $d/"; rm -rf "$d"; }
      done
    done
  done
fi

# ── Build harness args ────────────────────────────────────────────────────────
HARNESS_ARGS=(--tasks "$BENCH/tasks/django_subset.txt" --variants "$VARIANTS" --runs "$RUNS" --multi-session)
[[ -n "$FILTER" ]]  && HARNESS_ARGS+=(--filter "$FILTER")
[[ "$DRY_RUN" -eq 1 ]] && HARNESS_ARGS+=(--dry-run)

# ── Run (under systemd-inhibit to survive lid-close/idle) ────────────────────
/usr/bin/systemd-inhibit \
  --what=sleep:idle:handle-lid-switch \
  --who="zengram-pi-bench" \
  --why="Pi bench: variants=$VARIANTS filter=${FILTER:-all} runs=$RUNS" \
  bun "$BENCH/harness/src/index.ts" run "${HARNESS_ARGS[@]}"

echo ""
echo "Done. Next steps:"
echo "  cd $BENCH/harness/scorer && python score.py"
echo "  bun run /home/gene/zengram/integrations/pi/writeback-outcomes.ts"
