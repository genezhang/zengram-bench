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
import hashlib
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
ROOT         = Path(__file__).resolve().parents[2]
RUNS_DIR     = ROOT / "results" / "runs"
SCORES_DIR   = ROOT / "results" / "scores"
TASKS_CACHE  = ROOT / "tasks" / "cache" / "tasks.json"
REPO_CACHE   = ROOT / "results" / "repo-cache"
BASELINES_DIR = ROOT / "results" / "baselines"


def load_tasks(cache_path: Path) -> dict[str, dict]:
    if not cache_path.exists():
        print(f"ERROR: task cache not found at {cache_path}")
        print("Run: python setup_tasks.py")
        sys.exit(1)
    return {t["task_id"]: t for t in json.loads(cache_path.read_text())}


def _patch_target_files(patch: str) -> list[str]:
    """Files a unified diff modifies, taken from its `+++ b/<path>` headers."""
    return re.findall(r'^\+\+\+ b/(.+?)\s*$', patch, re.M)


def strip_test_file_hunks(patch: str, test_files: set[str]) -> tuple[str, list[str]]:
    """Drop per-file sections of `patch` that touch any file in `test_files`.

    Canonical SWE-bench semantics: the gold `test_patch` is authoritative for
    test files, and an agent's edits to those files are ignored (the official
    harness force-resets them). Our scorer applies `test_patch` first, so if the
    agent ALSO edited a test file its hunks collide on `git apply` → a false
    "patch apply failed". Splitting on `diff --git` boundaries and dropping the
    sections whose target is a test_patch file makes the agent's source-only
    change apply cleanly. Returns (filtered_patch, dropped_files)."""
    if not test_files:
        return patch, []
    sections = re.split(r'(?m)(?=^diff --git )', patch)
    kept: list[str] = []
    dropped: list[str] = []
    for sec in sections:
        if not sec.strip():
            continue
        targets = _patch_target_files(sec)
        if targets and all(t in test_files for t in targets):
            dropped.extend(targets)
        else:
            kept.append(sec)
    return "".join(kept), dropped


_DJANGO_TEST_ID = re.compile(r'^(\S+)\s*\((.+)\)$')


def _to_dotted(test_id: str) -> str:
    """SWE-bench Django tests come in unittest's `method (mod.Class)` format,
    but Django's runtests.py wants the dotted `mod.Class.method`."""
    m = _DJANGO_TEST_ID.match(test_id)
    return f"{m.group(2)}.{m.group(1)}" if m else test_id


def _is_runnable(test_id: str) -> bool:
    """Return True only for proper `method (mod.Class)` test IDs.

    SWE-bench sometimes records unittest shortDescription() output as test IDs
    — e.g. "SIGINT is ignored in Python and passed to psql to abort quries."
    These are docstring labels, not invocable identifiers. They can't be
    converted to a valid dotted path and will always fail to run, producing
    false "not resolved" verdicts even when the underlying fix is correct.
    Filter them out; they're counted as "skipped" rather than "failed".
    """
    return bool(_DJANGO_TEST_ID.match(test_id))


# A parenthesised dotted test path with at least module.Class.method structure
# (>=1 dot).  Deliberately strict so tracebacks like `basename(_sys.argv[0])`
# or `%(prog)s` don't get mistaken for a test id.
_ID_RE = re.compile(r'\(([A-Za-z_]\w*(?:\.\w+)+)\)')
_VERDICTS = r'ok|FAIL|ERROR|skipped|expected failure|unexpected success'
_INLINE_VERDICT_RE = re.compile(r'\.\.\.\s*(' + _VERDICTS + r')\b', re.IGNORECASE)
_BARE_VERDICT_RE = re.compile(r'^\s*(' + _VERDICTS + r')\b', re.IGNORECASE)


def _display(full: str) -> str:
    """`mod.Class.method` → the original `method (mod.Class)` id form."""
    mod_class, _, method = full.rpartition(".")
    return f"{method} ({mod_class})" if mod_class else full


def _parse_verdicts(stderr: str) -> dict:
    """
    Map each test's `method (mod.Class)` id → "passed"/"failed" from
    runtests.py --verbosity=2 output.

    A naive single-line regex (`^id ... verdict`) is WRONG for two reasons:
      1. When a test method has a DOCSTRING, unittest's descriptions mode
         prints the id and the docstring on separate lines and attaches the
         verdict to the docstring line, which carries no (mod.Class.method):
             test_x (mod.Class.test_x)
             <docstring first line> ... ok
      2. Django's "Testing against Django installed in …" banner can
         interleave between the " ... " and the verdict, pushing the verdict
         onto its own line:
             test_x (mod.Class.test_x)
             <docstring> ... Testing against Django installed in '…'
             ok
    A test whose verdict is never found is scored "missing" → FAILED, so a
    correct patch on a docstring'd test would look unresolved forever.  Parse
    statefully instead: remember the last test id, attach the next verdict
    token (inline or on its own line) to it.  setdefault keeps the first
    (real, inline) verdict and ignores the trailing FAIL:/ERROR: summary block.
    """
    outcome: dict = {}
    pending = None
    for line in stderr.splitlines():
        idm = _ID_RE.search(line)
        ivm = _INLINE_VERDICT_RE.search(line)
        if idm and ivm:                         # non-docstring: id + verdict together
            outcome.setdefault(_display(idm.group(1)),
                               "passed" if ivm.group(1).lower() == "ok" else "failed")
            pending = None
        elif ivm and pending is not None:       # verdict on the docstring line
            outcome.setdefault(pending,
                               "passed" if ivm.group(1).lower() == "ok" else "failed")
            pending = None
        elif idm:                               # id line, verdict deferred
            pending = _display(idm.group(1))
        else:
            bvm = _BARE_VERDICT_RE.match(line)
            if bvm and pending is not None:     # verdict pushed onto its own line
                outcome.setdefault(pending,
                                   "passed" if bvm.group(1).lower() == "ok" else "failed")
                pending = None
    return outcome


def run_tests(repo_dir: Path, test_ids: list[str]) -> tuple[list[str], list[str], list[str]]:
    """
    Run the given test IDs via Django's runtests.py and return
    (passed, failed, skipped).  `skipped` contains entries that aren't in
    `method (mod.Class)` format (docstring labels) and can't be run.

    Uses runtests.py (Django's own unittest-based runner) rather than pytest
    because SWE-bench Django tasks ship test IDs in unittest's
    `method (module.Class)` format, which pytest doesn't recognise. We
    translate to dotted form and parse runtests.py's verbose output.
    """
    if not test_ids:
        return [], [], []

    runnable = [t for t in test_ids if _is_runnable(t)]
    skipped  = [t for t in test_ids if not _is_runnable(t)]
    if skipped:
        print(f"\n    [scorer] skipping {len(skipped)} unrunnable (docstring) ID(s)",
              end=" ", flush=True)
    if not runnable:
        return [], [], skipped

    dotted = [_to_dotted(t) for t in runnable]
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

    outcome = _parse_verdicts(result.stderr)

    passed, failed = [], []
    for tid in runnable:
        res = outcome.get(tid, "missing")
        if res == "passed":
            passed.append(tid)
        else:
            failed.append(tid)

    return passed, failed, skipped


def get_ptp_preexisting(task: dict, repo_dir: Path, baselines_dir: Path,
                        rebaseline: bool = False) -> set[str]:
    """Return the set of pass_to_pass tests that were ALREADY failing at
    base_commit + test_patch (before any agent fix).

    These are pre-existing failures in the benchmark's test suite and should
    NOT be counted as regressions introduced by the agent's patch.  Without
    filtering them, tasks like 11728 and 13513 are unsolvable even when the
    agent's source fix is correct.

    The result is cached per task_id so we only run the tests once regardless
    of how many runs exist for that task.
    """
    ptp = task.get("pass_to_pass", [])
    if not ptp:
        return set()

    baselines_dir.mkdir(parents=True, exist_ok=True)
    baseline_file = baselines_dir / f"{task['task_id']}_baseline.json"

    if baseline_file.exists() and not rebaseline:
        cached = json.loads(baseline_file.read_text())
        return set(cached.get("ptp_preexisting", []))

    print(f"\n    [scorer] computing ptp baseline for {task['task_id']} …", end=" ", flush=True)
    _, ptp_pre, _ = run_tests(repo_dir, ptp)
    baseline_file.write_text(json.dumps({
        "task_id": task["task_id"],
        "base_commit": task.get("base_commit", ""),
        "ptp_preexisting": ptp_pre,
    }, indent=2))
    if ptp_pre:
        print(f"({len(ptp_pre)} pre-existing failures cached)", flush=True)
    else:
        print("(0 pre-existing failures)", flush=True)
    return set(ptp_pre)


def score_run(run: dict, task: dict, scores_dir: Path, force: bool = False,
              baselines_dir: Path = BASELINES_DIR, rebaseline: bool = False) -> dict:
    task_id = run["task_id"]
    variant = run["variant"]
    run_idx = run["run_index"]
    patch   = run.get("patch", "")
    # Hash the patch so we can detect when an existing score file was
    # generated from a different patch (e.g. a prior bench round wrote the
    # score, current round produced a different patch but shared task-id).
    # Skipping by file existence alone caused rounds 2+ to silently reuse
    # round 1's scores; the "low success rate" reported in the round 1-5
    # elevation-plan analysis was largely this caching artifact.
    import hashlib
    patch_hash = hashlib.sha256(patch.encode("utf-8")).hexdigest()[:16]

    out_path = scores_dir / f"{task_id}_{variant}_{run_idx}.json"
    if out_path.exists() and not force:
        # Distinguish three states so operators can diagnose:
        #   1. corrupt / unreadable JSON → re-score, log the parse error
        #   2. valid JSON but patch_hash mismatches → re-score (true staleness)
        #   3. valid JSON with matching patch_hash → skip (cache hit)
        try:
            cached = json.loads(out_path.read_text())
            cache_invalid = False
            cache_error = None
        except Exception as e:
            cached = {}
            cache_invalid = True
            cache_error = e
        if cache_invalid:
            print(f"  rescoring {task_id} {variant} #{run_idx} (cache file unreadable: {cache_error})")
        elif cached.get("patch_hash") == patch_hash:
            print(f"  skip {task_id} {variant} #{run_idx} (score current for this patch)")
            return cached
        else:
            print(f"  rescoring {task_id} {variant} #{run_idx} (cached for old patch)")

    print(f"  scoring {task_id} {variant} #{run_idx} …", end=" ", flush=True)

    def write(result: dict) -> dict:
        # Persist the patch hash so a future invocation can detect staleness
        # without re-running the test suite.
        result["patch_hash"] = patch_hash
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
        # Validate the cache actually has the commit before using it. A stale
        # or partially-created bare clone would otherwise fail the checkout
        # for every run on this repo with no fallback. `rev-parse --verify`
        # exits non-zero when the commit isn't reachable.
        cache_has_commit = cache_dir.exists() and subprocess.run(
            ["git", "-C", str(cache_dir), "rev-parse", "--verify", f"{task['base_commit']}^{{commit}}"],
            capture_output=True,
        ).returncode == 0
        if cache_has_commit:
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
                # Stop here — scoring against the unpatched test suite would
                # produce an indistinguishable "not resolved" result and hide
                # the infrastructure failure. Surface it in scorer_error
                # instead so the operator can fix the underlying conflict
                # (typically a stale base_commit or stale cached test_patch).
                print("test_patch apply failed")
                return write({
                    "task_id": task_id, "variant": variant, "run_index": run_idx,
                    "resolved": False,
                    "fail_to_pass_passed": [], "fail_to_pass_failed": task["fail_to_pass"],
                    "pass_to_pass_passed": [], "pass_to_pass_failed": task["pass_to_pass"],
                    "scorer_error": f"test_patch apply failed: {tpa.stderr.strip()}",
                })

        # Install the project under test before running any tests (baseline or
        # final). --break-system-packages is required on Python 3.12+ where
        # PEP 668 marks system Python as externally managed.  Use
        # sys.executable -m pip so the install lands in the same interpreter
        # run_tests() will use.
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "-e", ".",
             "--quiet", "--no-input", "--break-system-packages"],
            cwd=repo_dir, capture_output=True,
        )
        # No pytest install: run_tests() shells out to Django's tests/runtests.py.

        # Compute (or load from cache) the set of ptp tests that were ALREADY
        # failing before the agent's patch.  We run them here — after test_patch
        # and install but before agent_patch — so the baseline reflects exactly
        # the state the test suite starts from.  The result is cached per
        # task_id, so only the first run per task pays the extra test time.
        ptp_preexisting = get_ptp_preexisting(task, repo_dir, baselines_dir, rebaseline)

        # Apply agent patch — but first drop any hunks touching files the gold
        # test_patch owns. Those are already applied above and are authoritative;
        # an agent that ALSO edited a test fixture would otherwise collide on
        # `git apply` and be falsely scored "patch apply failed" despite a
        # correct source fix (canonical SWE-bench ignores agent test edits).
        test_files = set(_patch_target_files(task.get("test_patch", "")))
        patch_to_apply, dropped = strip_test_file_hunks(patch, test_files)
        if dropped:
            print(f"  (ignoring agent edits to test file(s): {', '.join(sorted(set(dropped)))})")
        agent_patch_was_test_only = bool(patch.strip()) and not patch_to_apply.strip()
        patch_file = Path(tmp) / "agent.patch"
        patch_file.write_text(patch_to_apply)
        apply = subprocess.run(
            ["git", "-C", str(repo_dir), "apply", "--whitespace=fix", str(patch_file)],
            capture_output=True, text=True,
        ) if patch_to_apply.strip() else None
        if apply is not None and apply.returncode != 0:
            print("patch apply failed")
            return write({
                "task_id": task_id, "variant": variant, "run_index": run_idx,
                "resolved": False,
                "fail_to_pass_passed": [], "fail_to_pass_failed": task["fail_to_pass"],
                "pass_to_pass_passed": [], "pass_to_pass_failed": task["pass_to_pass"],
                "scorer_error": f"git apply failed: {apply.stderr.strip()}",
            })
        if agent_patch_was_test_only:
            # Agent changed ONLY test files → no source fix to evaluate.
            print("agent patch was test-only (no source change)")

        # Run tests with structured reporting.
        ftp_passed, ftp_failed, ftp_skipped = run_tests(repo_dir, task["fail_to_pass"])
        ptp_passed, ptp_failed, ptp_skipped = run_tests(repo_dir, task["pass_to_pass"])

        # resolved: all runnable ftp tests pass AND no NEW ptp regressions.
        # "New" = failing post-patch but NOT in the pre-existing baseline set.
        # Unrunnable (docstring-label) entries are counted as skipped, not failed.
        ptp_failed_new = [t for t in ptp_failed if t not in ptp_preexisting]
        resolved = len(ftp_failed) == 0 and len(ptp_failed_new) == 0
        print("resolved ✓" if resolved else "not resolved ✗")
        result = {
            "task_id": task_id, "variant": variant, "run_index": run_idx,
            "resolved": resolved,
            "fail_to_pass_passed": ftp_passed, "fail_to_pass_failed": ftp_failed,
            "pass_to_pass_passed": ptp_passed, "pass_to_pass_failed": ptp_failed,
            "pass_to_pass_failed_new": ptp_failed_new,
        }
        if ptp_preexisting:
            result["ptp_preexisting_count"] = len(ptp_preexisting)
        if ftp_skipped:
            result["fail_to_pass_skipped"] = ftp_skipped
        if ptp_skipped:
            result["pass_to_pass_skipped"] = ptp_skipped
        return write(result)


def main():
    parser = argparse.ArgumentParser(description="Score agent run results")
    parser.add_argument("--runs-dir",      default=str(RUNS_DIR))
    parser.add_argument("--scores-dir",    default=str(SCORES_DIR))
    parser.add_argument("--tasks-cache",   default=str(TASKS_CACHE))
    parser.add_argument("--baselines-dir", default=str(BASELINES_DIR))
    parser.add_argument("--task-id",       help="Score only this task ID")
    parser.add_argument("--force",      action="store_true",
                        help="Re-score even when score file exists with matching patch hash")
    parser.add_argument("--rebaseline", action="store_true",
                        help="Recompute ptp baselines (pre-existing failure cache) even if cached")
    args = parser.parse_args()

    runs_dir      = Path(args.runs_dir)
    scores_dir    = Path(args.scores_dir)
    baselines_dir = Path(args.baselines_dir)
    scores_dir.mkdir(parents=True, exist_ok=True)
    baselines_dir.mkdir(parents=True, exist_ok=True)

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
        score_run(run, tasks[task_id], scores_dir, force=args.force,
                  baselines_dir=baselines_dir, rebaseline=args.rebaseline)

    # Quick summary — all variants present in the scores dir.
    score_files = list(scores_dir.glob("*.json"))
    scores = [json.loads(f.read_text()) for f in score_files]
    all_variants = sorted({s["variant"] for s in scores})
    print()
    for variant in all_variants:
        vs = [s for s in scores if s["variant"] == variant]
        if not vs:
            continue
        resolved = sum(1 for s in vs if s["resolved"])
        print(f"{variant:10s}: {resolved:3d}/{len(vs):3d} runs resolved ({100*resolved/len(vs):.1f}%)")

    # Per-task breakdown.
    all_task_ids = sorted({s["task_id"] for s in scores})
    print()
    header = f"{'Task':40s}" + "".join(f"  {v:10s}" for v in all_variants)
    print(header)
    print("-" * len(header))
    for tid in all_task_ids:
        row = f"{tid:40s}"
        for variant in all_variants:
            vs = [s for s in scores if s["task_id"] == tid and s["variant"] == variant]
            if not vs:
                row += f"  {'—':10s}"
            else:
                resolved = sum(1 for s in vs if s["resolved"])
                marks = "".join("✓" if s["resolved"] else "✗" for s in sorted(vs, key=lambda x: x["run_index"]))
                row += f"  {marks} {resolved}/{len(vs)}"
        print(row)

    # Report cached ptp baselines — pre-existing failures that are now
    # correctly excluded from the resolved criterion.
    baseline_files = sorted(Path(args.baselines_dir).glob("*_baseline.json"))
    tasks_with_preexisting = []
    for bf in baseline_files:
        try:
            data = json.loads(bf.read_text())
        except Exception:
            continue
        pre = data.get("ptp_preexisting", [])
        if pre:
            tasks_with_preexisting.append((data["task_id"], pre))

    if tasks_with_preexisting:
        print("\n─── ptp baselines: pre-existing failures excluded from resolved ──")
        for tid, pre in tasks_with_preexisting:
            print(f"  {tid}: {len(pre)} test(s) excluded")
            for t in sorted(pre)[:1]:
                print(f"    e.g. {t!r}")
            if len(pre) > 1:
                print(f"    … and {len(pre)-1} more")

    print("\nNext: bench report")


if __name__ == "__main__":
    main()
