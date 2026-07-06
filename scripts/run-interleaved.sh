#!/usr/bin/env bash
# run-interleaved.sh — per-rep lesson chain WITH outcome feedback.
#
# For each rep: run the agent → score just that run → write outcomes (incl.
# names of newly-broken tests) back into the task's strategy DB. The next rep
# then sees "did not resolve (BROKE previously-passing: …)" labels on both the
# session rows and the patch-derived lessons, instead of unlabeled recipes.
#
# This is the phase-2 counterpart of the lessons-only chain: the 14170
# experiment (2026-07-03) showed that without the outcome signal every rep
# repeats the same plausible-but-wrong fix that the lessons prescribe.
#
# Usage: ./run-interleaved.sh [task_id] [reps] [variants]
#   defaults: django__django-14170  5  both,strategy
#
# Env (required for pi/Ornith): PI_BIN, PI_BENCH_PROVIDER, PI_BENCH_MODEL,
#   BENCH_LLM_SLOTS_URL, BENCH_RESULTS_DIR — same contract as a direct harness run.
set -euo pipefail

TASK="${1:-django__django-14170}"
REPS="${2:-5}"
VARIANTS="${3:-both,strategy}"
# Task list the harness enumerates before --filter narrows to $TASK. Override
# for tasks outside pilot2 (e.g. the generalization candidates).
TASKS_FILE="${TASKS_FILE:-../tasks/pilot2_tasks.txt}"

SCRIPT_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
BENCH_DIR="$(dirname "$SCRIPT_DIR")"
ZENGRAM_PI_DIR="$(readlink -f "$BENCH_DIR/../zengram/integrations/pi")"

RESULTS_DIR="${BENCH_RESULTS_DIR:-$BENCH_DIR/results/runs}"
SCORES_DIR="${BENCH_SCORES_DIR:-$BENCH_DIR/results/scores-ornith}"
STATE_DIR="$BENCH_DIR/results/multi-session-state"

for ((k = 1; k <= REPS; k++)); do
  rep=$((k - 1))
  echo "════ rep $rep ════"

  # --runs $k re-runs nothing: earlier reps' result files exist and are skipped.
  (cd "$BENCH_DIR/harness" && npx tsx src/index.ts run \
    --tasks "$TASKS_FILE" \
    --variants "$VARIANTS" \
    --filter "$TASK" \
    --runs "$k" --concurrency 1 --multi-session)

  (cd "$BENCH_DIR/harness" && python3 scorer/score.py \
    --runs-dir "$RESULTS_DIR" --scores-dir "$SCORES_DIR" --task-id "$TASK")

  # Stale tantivy locks survive killed processes and block the DB open.
  find "$STATE_DIR" -name "*.lock" -delete 2>/dev/null || true

  (cd "$ZENGRAM_PI_DIR" && bun run writeback-outcomes.ts \
    --runs-dir "$RESULTS_DIR" --scores-dir "$SCORES_DIR" --state-dir "$STATE_DIR" \
    --task-id "$TASK" --run-index "$rep")
done

echo "════ interleaved chain done: $TASK × $REPS reps ($VARIANTS) ════"
