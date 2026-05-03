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
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# score.py lives at <root>/harness/scorer/score.py — that's parents[2] from
# the file. The previous parents[3] resolved one dir too far (e.g. /home/gene
# instead of /home/gene/zengram-bench); harness CLI overrides masked the bug
# for RUNS_DIR/SCORES_DIR/TASKS_CACHE but REPO_CACHE has no override so the
# local-clone fast path silently never matched. Fixing the depth makes all
# defaults resolve correctly.
ROOT        = Path(__file__).resolve().parents[2]
RUNS_DIR    = ROOT / "results" / "runs"
SCORES_DIR  = ROOT / "results" / "scores"
TASKS_CACHE = ROOT / "tasks" / "cache" / "tasks.json"
REPO_CACHE  = ROOT / "results" / "repo-cache"


def load_tasks(cache_path: Path) -> dict[str, dict]:
    if not cache_path.exists():
        print(f"ERROR: task cache not found at {cache_path}")
        print("Run: python setup_tasks.py")
        sys.exit(1)
    return {t["task_id"]: t for t in json.loads(cache_path.read_text())}


_DJANGO_TEST_ID = re.compile(r'^(\S+)\s*\((.+)\)$')


def _to_dotted(test_id: str) -> str:
    """SWE-bench Django tests come in unittest's `method (mod.Class)` format,
    but Django's runtests.py wants the dotted `mod.Class.method`."""
    m = _DJANGO_TEST_ID.match(test_id)
    return f"{m.group(2)}.{m.group(1)}" if m else test_id


def run_tests(repo_dir: Path, test_ids: list[str]) -> tuple[list[str], list[str]]:
    """
    Run the given test IDs via Django's runtests.py and return (passed, failed).

    Uses runtests.py (Django's own unittest-based runner) rather than pytest
    because SWE-bench Django tasks ship test IDs in unittest's
    `method (module.Class)` format, which pytest doesn't recognise. We
    translate to dotted form and parse runtests.py's verbose output.
    """
    if not test_ids:
        return [], []

    dotted = [_to_dotted(t) for t in test_ids]
    try:
        result = subprocess.run(
            [
                # sys.executable so we always invoke the same interpreter the
                # scorer is running in — boxes with only `python3` on PATH
                # (no `python` symlink) would otherwise FileNotFoundError.
                # --parallel=1 disables Django's multiprocessing pool — needed
                # on Python 3.12+ where older Django's RemoteTestResult lacks
                # the addDuration method unittest now calls; the pool crashes
                # before any test result is reported.
                sys.executable, "tests/runtests.py", "--verbosity=2", "--noinput",
                "--parallel=1", *dotted,
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return [], test_ids   # treat timeout as all-failed

    # runtests --verbosity=2 prints lines like:
    #   test_reversed (utils_tests.test_datastructures.OrderedSetTests.test_reversed) ... ok
    #   test_X (mod.Class.test_X) ... FAIL
    #   test_Y (mod.Class.test_Y) ... ERROR
    # Parse stderr (where unittest writes verbose output) line-by-line.
    outcome: dict[str, str] = {}
    for line in result.stderr.splitlines():
        # Match the dotted path inside parens; strip a trailing `.method` so
        # we recover the original `method (mod.Class)` form for lookup.
        m = re.match(r'^\S+\s*\((\S+)\)\s*\.\.\.\s*(\w+)', line)
        if not m:
            continue
        full = m.group(1)               # e.g. mod.Class.method
        verdict = m.group(2).lower()    # ok | FAIL | ERROR | skipped
        # Translate full back to the original `method (mod.Class)` form so
        # the caller's test_ids list can match.
        parts = full.rsplit(".", 1)
        if len(parts) == 2:
            mod_class, method = parts
            display = f"{method} ({mod_class})"
        else:
            display = full
        outcome[display] = "passed" if verdict == "ok" else "failed"

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

        # Prefer the harness's bare-clone cache (full history) over a shallow
        # GitHub clone — older base_commits like dj-12713's 2020-era 003bb34b
        # are past the --depth 1000 cutoff and would fail to check out.
        cache_dir = REPO_CACHE / task["repo"].replace("/", "__")
        if cache_dir.exists():
            clone = subprocess.run(
                ["git", "clone", "--local", str(cache_dir), str(repo_dir)],
                capture_output=True, text=True,
            )
        else:
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

        # Apply test_patch first — SWE-bench fail_to_pass tests are typically
        # NEW tests added in the upstream PR. Without this they don't exist
        # in the test files and runtests.py reports "no such test", marking
        # every run failed regardless of agent correctness.
        if task.get("test_patch", "").strip():
            tp_file = Path(tmp) / "test.patch"
            tp_file.write_text(task["test_patch"])
            tpa = subprocess.run(
                ["git", "-C", str(repo_dir), "apply", "--whitespace=fix", str(tp_file)],
                capture_output=True, text=True,
            )
            if tpa.returncode != 0:
                # Don't bail — record the issue but continue scoring against the
                # agent's patch alone. (Some test_patches conflict with the
                # base_commit's tree; better to surface that than to silently
                # mark resolved=false with no diagnostic.)
                print(f"test_patch apply failed: {tpa.stderr.strip()[:80]}")

        # Apply agent patch.
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

        # Install project dependencies. --break-system-packages is required on
        # Python 3.12+ where PEP 668 marks system Python as externally managed
        # and pip refuses to install into it without that flag (or a venv).
        # For an offline scoring tool this is the simpler choice; per-run venv
        # would be cleaner but adds ~5 s/run overhead × 30 runs.
        subprocess.run(
            ["pip", "install", "-e", ".", "--quiet", "--no-input", "--break-system-packages"],
            cwd=repo_dir, capture_output=True,
        )
        subprocess.run(
            ["pip", "install", "pytest", "pytest-json-report", "--quiet", "--no-input", "--break-system-packages"],
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
