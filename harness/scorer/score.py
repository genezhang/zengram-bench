#!/usr/bin/env python3
"""
Scorer: apply each agent's patch to the repo and run the test suite.

For each run result JSON in --runs-dir:
  1. Clone the repo, check out base_commit
  2. Apply the patch (git apply)
  3. Install the project (pip install -e .)
  4. Run fail_to_pass tests — they must ALL pass
  5. Run pass_to_pass tests — they must ALL still pass
  6. Write a ScoreResult JSON to --scores-dir

Usage:
    python score.py
    python score.py --runs-dir ../../results/runs --scores-dir ../../results/scores
    python score.py --task-id django__django-11099   # score a single task
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT        = Path(__file__).resolve().parents[3]
RUNS_DIR    = ROOT / "results" / "runs"
SCORES_DIR  = ROOT / "results" / "scores"
TASKS_CACHE = ROOT / "tasks" / "cache" / "tasks.json"


def load_tasks(cache_path: Path) -> dict[str, dict]:
    if not cache_path.exists():
        print(f"ERROR: task cache not found at {cache_path}")
        print("Run: python setup_tasks.py")
        sys.exit(1)
    return {t["task_id"]: t for t in json.loads(cache_path.read_text())}


def run_tests(repo_dir: Path, test_ids: list[str]) -> tuple[list[str], list[str]]:
    """Run the given test node IDs with pytest. Returns (passed, failed)."""
    if not test_ids:
        return [], []

    result = subprocess.run(
        ["python", "-m", "pytest", "--tb=no", "-q", "--no-header", *test_ids],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=300,
    )

    passed, failed = [], []
    for tid in test_ids:
        # Crude heuristic: check if pytest output contains "PASSED" for this test.
        # A proper implementation would use pytest's JSON report plugin.
        short = tid.split("::")[-1]
        if f"PASSED" in result.stdout and short in result.stdout:
            passed.append(tid)
        elif result.returncode == 0 and tid not in result.stdout:
            # pytest didn't mention it failing → assume passed
            passed.append(tid)
        else:
            failed.append(tid)

    return passed, failed


def score_run(run: dict, task: dict, scores_dir: Path) -> dict:
    task_id  = run["task_id"]
    variant  = run["variant"]
    run_idx  = run["run_index"]
    patch    = run.get("patch", "")

    out_path = scores_dir / f"{task_id}_{variant}_{run_idx}.json"
    if out_path.exists():
        print(f"  skip {task_id} {variant} #{run_idx} (score exists)")
        return json.loads(out_path.read_text())

    print(f"  scoring {task_id} {variant} #{run_idx} …", end=" ", flush=True)

    if not patch.strip():
        result = {
            "task_id": task_id, "variant": variant, "run_index": run_idx,
            "resolved": False,
            "fail_to_pass_passed": [], "fail_to_pass_failed": task["fail_to_pass"],
            "pass_to_pass_passed": [], "pass_to_pass_failed": task["pass_to_pass"],
            "scorer_error": "empty patch",
        }
        out_path.write_text(json.dumps(result, indent=2))
        print("empty patch")
        return result

    with tempfile.TemporaryDirectory() as tmp:
        repo_dir = Path(tmp) / "repo"

        # Clone and checkout base commit.
        subprocess.run(
            ["git", "clone", "--depth", "1000",
             f"https://github.com/{task['repo']}.git", str(repo_dir)],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(repo_dir), "checkout", task["base_commit"]],
            check=True, capture_output=True,
        )

        # Apply patch.
        patch_file = Path(tmp) / "agent.patch"
        patch_file.write_text(patch)
        apply = subprocess.run(
            ["git", "-C", str(repo_dir), "apply", "--whitespace=fix", str(patch_file)],
            capture_output=True, text=True,
        )
        if apply.returncode != 0:
            result = {
                "task_id": task_id, "variant": variant, "run_index": run_idx,
                "resolved": False,
                "fail_to_pass_passed": [], "fail_to_pass_failed": task["fail_to_pass"],
                "pass_to_pass_passed": [], "pass_to_pass_failed": task["pass_to_pass"],
                "scorer_error": f"git apply failed: {apply.stderr.strip()}",
            }
            out_path.write_text(json.dumps(result, indent=2))
            print(f"patch apply failed")
            return result

        # Install the project in editable mode.
        subprocess.run(
            ["pip", "install", "-e", ".", "--quiet"],
            cwd=repo_dir, capture_output=True,
        )

        # Run tests.
        ftp_passed, ftp_failed = run_tests(repo_dir, task["fail_to_pass"])
        ptp_passed, ptp_failed = run_tests(repo_dir, task["pass_to_pass"])

        resolved = len(ftp_failed) == 0 and len(ptp_failed) == 0
        result = {
            "task_id": task_id, "variant": variant, "run_index": run_idx,
            "resolved": resolved,
            "fail_to_pass_passed": ftp_passed, "fail_to_pass_failed": ftp_failed,
            "pass_to_pass_passed": ptp_passed, "pass_to_pass_failed": ptp_failed,
        }
        out_path.write_text(json.dumps(result, indent=2))
        print("resolved ✓" if resolved else "not resolved ✗")
        return result


def main():
    parser = argparse.ArgumentParser(description="Score agent run results")
    parser.add_argument("--runs-dir",    default=str(RUNS_DIR))
    parser.add_argument("--scores-dir",  default=str(SCORES_DIR))
    parser.add_argument("--tasks-cache", default=str(TASKS_CACHE))
    parser.add_argument("--task-id",     help="Score only this task ID")
    args = parser.parse_args()

    runs_dir   = Path(args.runs_dir)
    scores_dir = Path(args.scores_dir)
    scores_dir.mkdir(parents=True, exist_ok=True)

    tasks = load_tasks(Path(args.tasks_cache))

    run_files = sorted(runs_dir.glob("*.json"))
    if args.task_id:
        run_files = [f for f in run_files if f.name.startswith(args.task_id)]

    if not run_files:
        print(f"No run files found in {runs_dir}")
        sys.exit(1)

    print(f"Scoring {len(run_files)} run(s)…")
    for rf in run_files:
        run = json.loads(rf.read_text())
        task_id = run["task_id"]
        if task_id not in tasks:
            print(f"  WARNING: task {task_id} not in cache, skipping")
            continue
        score_run(run, tasks[task_id], scores_dir)

    # Print quick summary.
    score_files = list(scores_dir.glob("*.json"))
    scores = [json.loads(f.read_text()) for f in score_files]
    for variant in ("baseline", "zengram"):
        vs = [s for s in scores if s["variant"] == variant]
        if not vs:
            continue
        resolved = sum(1 for s in vs if s["resolved"])
        print(f"\n{variant}: {resolved}/{len(vs)} runs resolved ({100*resolved/len(vs):.1f}%)")

    print(f"\nNext: bench report")


if __name__ == "__main__":
    main()
