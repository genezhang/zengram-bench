#!/usr/bin/env python3
"""
Scorer: apply each agent's patch to the repo and run the test suite.

For each run result JSON in --runs-dir:
  1. Clone the repo, check out base_commit
  2. Apply the patch (git apply)
  3. Install the project (pip install -e .)
  4. Run tests via pytest --json-report for reliable per-test pass/fail
  5. resolved = all fail_to_pass pass AND all pass_to_pass still pass
  6. Write a ScoreResult JSON to --scores-dir

Usage:
    python score.py
    python score.py --runs-dir ../../results/runs --scores-dir ../../results/scores
    python score.py --task-id django__django-11099   # score a single task
"""

import argparse
import json
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
    """
    Run the given pytest node IDs and return (passed, failed).

    Uses pytest-json-report for structured per-test results — avoids the
    brittleness of parsing pytest's stdout.
    """
    if not test_ids:
        return [], []

    report_file = repo_dir / ".pytest_bench_report.json"
    try:
        subprocess.run(
            [
                "python", "-m", "pytest",
                "--json-report",
                f"--json-report-file={report_file}",
                "--tb=no", "-q", "--no-header",
                *test_ids,
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return [], test_ids   # treat timeout as all-failed

    if not report_file.exists():
        # pytest-json-report not installed or crashed before writing
        return [], test_ids

    try:
        report = json.loads(report_file.read_text())
    except json.JSONDecodeError:
        return [], test_ids
    finally:
        report_file.unlink(missing_ok=True)

    # Build a lookup from node ID → outcome
    outcome: dict[str, str] = {}
    for t in report.get("tests", []):
        outcome[t["nodeid"]] = t["outcome"]   # "passed" | "failed" | "error" | "skipped"

    passed, failed = [], []
    for tid in test_ids:
        result = outcome.get(tid, "missing")
        if result == "passed":
            passed.append(tid)
        else:
            failed.append(tid)

    return passed, failed


def score_run(run: dict, task: dict, scores_dir: Path) -> dict:
    task_id = run["task_id"]
    variant = run["variant"]
    run_idx = run["run_index"]
    patch   = run.get("patch", "")

    out_path = scores_dir / f"{task_id}_{variant}_{run_idx}.json"
    if out_path.exists():
        print(f"  skip {task_id} {variant} #{run_idx} (score exists)")
        return json.loads(out_path.read_text())

    print(f"  scoring {task_id} {variant} #{run_idx} …", end=" ", flush=True)

    def write(result: dict) -> dict:
        out_path.write_text(json.dumps(result, indent=2))
        return result

    if not patch.strip():
        print("empty patch")
        return write({
            "task_id": task_id, "variant": variant, "run_index": run_idx,
            "resolved": False,
            "fail_to_pass_passed": [], "fail_to_pass_failed": task["fail_to_pass"],
            "pass_to_pass_passed": [], "pass_to_pass_failed": task["pass_to_pass"],
            "scorer_error": "empty patch",
        })

    with tempfile.TemporaryDirectory() as tmp:
        repo_dir = Path(tmp) / "repo"

        # Clone and checkout base commit.
        clone = subprocess.run(
            ["git", "clone", "--depth", "1000",
             f"https://github.com/{task['repo']}.git", str(repo_dir)],
            capture_output=True, text=True,
        )
        if clone.returncode != 0:
            print("clone failed")
            return write({
                "task_id": task_id, "variant": variant, "run_index": run_idx,
                "resolved": False,
                "fail_to_pass_passed": [], "fail_to_pass_failed": task["fail_to_pass"],
                "pass_to_pass_passed": [], "pass_to_pass_failed": task["pass_to_pass"],
                "scorer_error": f"git clone failed: {clone.stderr.strip()}",
            })

        subprocess.run(
            ["git", "-C", str(repo_dir), "checkout", task["base_commit"]],
            capture_output=True, check=True,
        )

        # Apply patch.
        patch_file = Path(tmp) / "agent.patch"
        patch_file.write_text(patch)
        apply = subprocess.run(
            ["git", "-C", str(repo_dir), "apply", "--whitespace=fix", str(patch_file)],
            capture_output=True, text=True,
        )
        if apply.returncode != 0:
            print("patch apply failed")
            return write({
                "task_id": task_id, "variant": variant, "run_index": run_idx,
                "resolved": False,
                "fail_to_pass_passed": [], "fail_to_pass_failed": task["fail_to_pass"],
                "pass_to_pass_passed": [], "pass_to_pass_failed": task["pass_to_pass"],
                "scorer_error": f"git apply failed: {apply.stderr.strip()}",
            })

        # Install project dependencies.
        subprocess.run(
            ["pip", "install", "-e", ".", "--quiet", "--no-input"],
            cwd=repo_dir, capture_output=True,
        )
        subprocess.run(
            ["pip", "install", "pytest", "pytest-json-report", "--quiet", "--no-input"],
            cwd=repo_dir, capture_output=True,
        )

        # Run tests with structured reporting.
        ftp_passed, ftp_failed = run_tests(repo_dir, task["fail_to_pass"])
        ptp_passed, ptp_failed = run_tests(repo_dir, task["pass_to_pass"])

        resolved = len(ftp_failed) == 0 and len(ptp_failed) == 0
        print("resolved ✓" if resolved else "not resolved ✗")
        return write({
            "task_id": task_id, "variant": variant, "run_index": run_idx,
            "resolved": resolved,
            "fail_to_pass_passed": ftp_passed, "fail_to_pass_failed": ftp_failed,
            "pass_to_pass_passed": ptp_passed, "pass_to_pass_failed": ptp_failed,
        })


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

    # Quick summary.
    score_files = list(scores_dir.glob("*.json"))
    scores = [json.loads(f.read_text()) for f in score_files]
    for variant in ("baseline", "zengram"):
        vs = [s for s in scores if s["variant"] == variant]
        if not vs:
            continue
        resolved = sum(1 for s in vs if s["resolved"])
        print(f"\n{variant}: {resolved}/{len(vs)} runs resolved ({100*resolved/len(vs):.1f}%)")

    print("\nNext: bench report")


if __name__ == "__main__":
    main()
