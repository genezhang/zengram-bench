#!/usr/bin/env python3
"""
Download and cache the SWE-bench Verified task metadata for our django subset.

Uses the HuggingFace datasets-server HTTP API — no extra Python packages needed.

Usage:
    python setup_tasks.py
    python setup_tasks.py --verify      # check all subset task IDs exist
    python setup_tasks.py --subset ../../tasks/django_subset.txt
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SUBSET = ROOT / "tasks" / "django_subset.txt"
DEFAULT_CACHE  = ROOT / "tasks" / "cache" / "tasks.json"

HF_API  = "https://datasets-server.huggingface.co/rows"
DATASET = "princeton-nlp/SWE-bench_Verified"
PAGE    = 100   # max rows per request


def load_subset(subset_file: Path) -> list[str]:
    lines = subset_file.read_text().splitlines()
    return [l.strip() for l in lines if l.strip() and not l.startswith("#")]


def fetch_page(offset: int, limit: int) -> dict:
    params = urllib.parse.urlencode({
        "dataset": DATASET,
        "config":  "default",
        "split":   "test",
        "offset":  offset,
        "limit":   limit,
    })
    url = f"{HF_API}?{params}"
    with urllib.request.urlopen(url, timeout=60) as resp:
        return json.loads(resp.read())


def fetch_from_huggingface(task_ids: set[str]) -> list[dict]:
    """Paginate HuggingFace datasets-server to find matching tasks."""
    print(f"Fetching from HuggingFace datasets-server…")
    found: list[dict] = []
    offset = 0

    while True:
        data = fetch_page(offset, PAGE)
        rows = data.get("rows", [])
        total = data.get("num_rows_total", 0)

        for entry in rows:
            row = entry["row"]
            if row["instance_id"] not in task_ids:
                continue
            found.append({
                "task_id":                  row["instance_id"],
                "repo":                     row["repo"],
                "base_commit":              row["base_commit"],
                "problem_statement":        row["problem_statement"],
                "hints_text":               row.get("hints_text", ""),
                "fail_to_pass":             json.loads(row["FAIL_TO_PASS"]),
                "pass_to_pass":             json.loads(row["PASS_TO_PASS"]),
                "environment_setup_commit": row.get("environment_setup_commit", row["base_commit"]),
            })

        offset += len(rows)
        print(f"  {offset}/{total} rows scanned, {len(found)} matched so far…")

        if offset >= total or not rows:
            break

        if len(found) == len(task_ids):
            print("  All target tasks found early — stopping.")
            break

    return found


def main():
    parser = argparse.ArgumentParser(description="Download SWE-bench task metadata")
    parser.add_argument("--subset",  default=str(DEFAULT_SUBSET), help="Path to task-ID file")
    parser.add_argument("--output",  default=str(DEFAULT_CACHE),  help="Output cache JSON path")
    parser.add_argument("--verify",  action="store_true",         help="Check all subset IDs exist in cache")
    args = parser.parse_args()

    subset_file = Path(args.subset)
    cache_file  = Path(args.output)

    task_ids = load_subset(subset_file)
    print(f"Subset: {len(task_ids)} task IDs from {subset_file}")

    if args.verify:
        if not cache_file.exists():
            print(f"Cache not found at {cache_file}. Run without --verify first.")
            sys.exit(1)
        cached = {t["task_id"] for t in json.loads(cache_file.read_text())}
        missing = [tid for tid in task_ids if tid not in cached]
        if missing:
            print(f"MISSING ({len(missing)}):")
            for m in missing:
                print(f"  {m}")
            sys.exit(1)
        print(f"All {len(task_ids)} task IDs found in cache. ✓")
        return

    tasks = fetch_from_huggingface(set(task_ids))
    print(f"Found {len(tasks)}/{len(task_ids)} tasks in SWE-bench_Verified")

    missing = set(task_ids) - {t["task_id"] for t in tasks}
    if missing:
        print(f"WARNING: {len(missing)} task IDs not found in dataset:")
        for m in sorted(missing):
            print(f"  {m}")
        print("These may be in SWE-bench (not Verified). Update tasks/django_subset.txt if needed.")

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(tasks, indent=2))
    print(f"Cached {len(tasks)} tasks to {cache_file}")


if __name__ == "__main__":
    main()
