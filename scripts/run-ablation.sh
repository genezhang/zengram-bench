#!/usr/bin/env bash
# Per-task recall-layer ablation driver (round 16, 2026-05-16).
#
# Usage: ./run-ablation.sh <task_id> <variant>
#   variant ∈ {none, lessons, edits, both, wide}
#
# Each invocation:
#   1. Seeds a per-experiment XDG_DATA_HOME from the round-15 v4 corpus
#      (zeta knowledge table preserved, prior sessions/snapshots dropped)
#   2. Sets ZG_RECALL_* env knobs to isolate the layer being tested
#   3. Runs opencode against the task on a fresh repo
#   4. Stashes the result JSON at results/ablation/<task>__<variant>.json
#      so each variant's output survives the next variant's run
#
# Skips the multi-session bookkeeping of the harness on purpose — each
# ablation is single-shot, no cross-rep state.
#
# Hardcoded to the ai1 local model (don't drift to free-tier under load).

set -euo pipefail

TASK="${1:?task_id required}"
VARIANT="${2:?variant required (none|lessons|edits|both|wide)}"

BENCH=/home/gene/zengram-bench
SOURCE_CORPUS="$BENCH/results/multi-session-state/_suite_round15_reflect_v4_2026-05-13_zengram"
[[ -d "$SOURCE_CORPUS" ]] || { echo "ERROR: source corpus missing: $SOURCE_CORPUS" >&2; exit 1; }

EXP_NAME="ablation_${TASK//\//_}_${VARIANT}"
PIN_DIR="$BENCH/results/multi-session-state/_suite_${EXP_NAME}_zengram"
ABLATION_DIR="$BENCH/results/ablation"
mkdir -p "$ABLATION_DIR"

# Clean any prior copy of this exact (task, variant). Allows re-running.
if [[ -d "$PIN_DIR" ]]; then
  echo "[$EXP_NAME] removing prior copy" >&2
  rm -rf "$PIN_DIR"
fi

# Seed: copy the corpus, drop everything that was per-session in v4
# (snapshots, session DB, prior dev.log). The zeta knowledge dir is the
# only payload we want to carry over.
echo "[$EXP_NAME] seeding corpus from round-15 v4..." >&2
mkdir -p "$PIN_DIR/opencode"
cp -r "$SOURCE_CORPUS/opencode/zeta" "$PIN_DIR/opencode/"
# (omit: opencode-local.db, snapshot/, storage/, log/, tool-output/, repos/)

# Per-variant knobs. `both` is the round-15 default — no overrides.
case "$VARIANT" in
  none)
    export ZG_RECALL_FILTER=none ;;
  lessons)
    export ZG_RECALL_FILTER=lessons ZG_RECALL_LIMIT=5 ZG_RECALL_THRESHOLD=0.70 ;;
  edits)
    export ZG_RECALL_FILTER=edits   ZG_RECALL_LIMIT=5 ZG_RECALL_THRESHOLD=0.65 ;;
  both)
    : ;;  # defaults: filter=both, limit=10, threshold=0.65
  wide)
    export ZG_RECALL_LIMIT=10 ZG_RECALL_THRESHOLD=0.70 ;;
  *)
    echo "ERROR: unknown variant: $VARIANT" >&2; exit 1 ;;
esac

# Hardcode ai1 — don't drift to free tier. Belt-and-suspenders with v8's
# OPENCODE_BENCH_MODEL.
export OPENCODE_BENCH_MODEL="ai1/Qwen3-Coder-Next-UD-Q6_K_XL-00001-of-00003.gguf"
export OPENCODE_BIN="$BENCH/scripts/opencode-fork.sh"
export OPENCODE_ZENGRAM_CMD="$BENCH/scripts/run-zengram.sh"
export OPENCODE_BASELINE_CMD="$BENCH/scripts/run-baseline.sh"

# 30-min budget — round-15 showed 30 turns can take 20+ min on hard tasks.
export BENCH_TIMEOUT_MS=1800000
export BENCH_SUITE_NAME="$EXP_NAME"

# The harness writes to results/runs/<task>_zengram_0.json. We don't want
# variants to clobber each other or contaminate the main bench results, so
# pre-delete the slot and stash the output post-run under a variant-tagged
# name. Harness skips-if-exists logic forces the delete.
RAW_RESULT="$BENCH/results/runs/${TASK}_zengram_0.json"
rm -f "$RAW_RESULT"

echo "[$EXP_NAME] ENV: filter=${ZG_RECALL_FILTER:-both} limit=${ZG_RECALL_LIMIT:-10} threshold=${ZG_RECALL_THRESHOLD:-0.65}" >&2
echo "[$EXP_NAME] launching opencode..." >&2

# Wrap in systemd-inhibit so a midnight suspend can't poison the watchdog.
# Not using systemd-run here — keep it foreground so the caller can monitor
# directly. Logs to results/ablation/<exp>.log.
LOG_FILE="$ABLATION_DIR/${EXP_NAME}.log"
/usr/bin/systemd-inhibit \
  --what=sleep:idle:handle-lid-switch \
  --who="zengram-ablation-$EXP_NAME" \
  --why="round-16 recall ablation for $TASK ($VARIANT)" \
  bun "$BENCH/harness/src/index.ts" run \
    --variants zengram \
    --runs 1 \
    --tasks "$BENCH/tasks/django_50.txt" \
    --filter "$TASK" \
    --multi-session \
  > "$LOG_FILE" 2>&1 || true

# Stash result under a variant-tagged name so the next variant doesn't
# collide. Also REWRITE the JSON's `variant` field to include the ablation
# variant tag — the scorer keys its output files on (task_id, variant,
# run_index), so leaving variant="zengram" makes the scorer overwrite
# between ablation cells and we lose per-cell resolved/unresolved tracking.
# Tag format: zengram-ablation-<variant>.
STASH="$ABLATION_DIR/${EXP_NAME}.json"
if [[ -f "$RAW_RESULT" ]]; then
  python3 - "$RAW_RESULT" "$STASH" "$VARIANT" <<'PY'
import sys, json
src, dst, variant = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src))
d["variant"] = f"zengram-ablation-{variant}"
json.dump(d, open(dst, "w"), indent=2)
import os; os.remove(src)
PY
  echo "[$EXP_NAME] result → $STASH (variant retagged for scorer)" >&2
else
  echo "{\"task_id\":\"$TASK\",\"variant\":\"zengram-ablation-$VARIANT\",\"status\":\"no_result\"}" > "$STASH"
  echo "[$EXP_NAME] NO RESULT — see $LOG_FILE" >&2
fi

echo "[$EXP_NAME] done." >&2
