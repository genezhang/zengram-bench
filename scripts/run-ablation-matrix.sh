#!/usr/bin/env bash
# Run the full 5-task × 4-variant ablation matrix sequentially.
# Single GPU on ai1.local means we can't parallelize inference anyway,
# so this is just a sequencer. Each cell takes ~10-20 min; total ~3-6h.
#
# Skip cells that already have a stash file (cheap resume after interrupt).

set -euo pipefail

BENCH=/home/gene/zengram-bench
TASKS=(
  django__django-14559   # ZG-only win (probe: does removing recall break it?)
  django__django-11099   # both resolved (negative control)
  django__django-15022   # ZG ran 30 turns no patch
  django__django-11141   # ZG no patch, BL had a wrong patch
  django__django-13821   # both produced patches but neither resolved
)
VARIANTS=(none lessons edits both wide)

START=$(date +%s)
DONE=0; SKIPPED=0; TOTAL=$((${#TASKS[@]} * ${#VARIANTS[@]}))
echo "=== Ablation matrix: $TOTAL cells ===" >&2

for task in "${TASKS[@]}"; do
  for variant in "${VARIANTS[@]}"; do
    stash="$BENCH/results/ablation/ablation_${task//\//_}_${variant}.json"
    if [[ -f "$stash" ]]; then
      echo "[skip] $task / $variant — stash exists" >&2
      SKIPPED=$((SKIPPED+1))
      continue
    fi
    cell_start=$(date +%s)
    echo "[run ] $task / $variant ..." >&2
    "$BENCH/scripts/run-ablation.sh" "$task" "$variant" 2>&1 | tail -3 >&2 || {
      echo "[fail] $task / $variant — see log" >&2
    }
    cell_dur=$(( $(date +%s) - cell_start ))
    DONE=$((DONE+1))
    echo "[done] $task / $variant — ${cell_dur}s  ($DONE+$SKIPPED of $TOTAL)" >&2
  done
done

TOTAL_DUR=$(( $(date +%s) - START ))
echo "=== Matrix complete in ${TOTAL_DUR}s ($DONE ran, $SKIPPED skipped) ===" >&2
