# zengram-bench

Evaluation harness for comparing vanilla OpenCode against the Zengram-augmented
fork on SWE-bench tasks.

See [docs/proposal.md](docs/proposal.md) for the full benchmark design.

---

## Quick start

### 1. Prerequisites

| Tool | Purpose |
|------|---------|
| Node.js ≥ 18 / Bun | TypeScript runner |
| Python ≥ 3.11 | Task setup + scorer |
| git | Repo cloning during scoring |
| `opencode` in PATH | Baseline agent binary |
| `opencode-zengram` in PATH | Zengram fork agent binary |

Configure agent command paths if they differ from the defaults:
```bash
export OPENCODE_BASELINE_CMD=/path/to/opencode
export OPENCODE_ZENGRAM_CMD=/path/to/opencode-zengram
```

Both commands must implement the `run` subcommand interface — see
[harness/src/agent.ts](harness/src/agent.ts) for the expected flags.

### 2. Set up task metadata

```bash
cd harness/scorer
pip install -r requirements.txt
python setup_tasks.py          # downloads from princeton-nlp/SWE-bench_Verified
python setup_tasks.py --verify # confirm all 25 task IDs were found
```

### 3. Install harness dependencies

```bash
cd harness
bun install        # or: npm install
```

### 4. Run agents

```bash
# Dry run first — see what would execute without calling agents
bun bench run --dry-run

# Full run: both variants, 3 repetitions each (= 150 agent invocations)
bun bench run --variants baseline,zengram --runs 3

# Run only a few tasks to verify the pipeline
bun bench run --filter django__django-11099,django__django-11179 --runs 1
```

Results land in `results/runs/*.json`.

### 5. Score the results

```bash
cd harness/scorer
python score.py
```

Scores land in `results/scores/*.json`.

### 6. Report

```bash
bun bench report

# Machine-readable output:
bun bench report --format json > results/summary.json
```

---

## Task subset

`tasks/django_subset.txt` — 25 tasks from the `django/django` repository,
spanning ORM, migrations, forms, views, template engine, and admin.

All tasks are from the **SWE-bench Verified** split, meaning they have been
manually verified to have correct test suites and unambiguous problem statements.

To swap in a different subset, edit `tasks/django_subset.txt` (one task ID per
line) and re-run `setup_tasks.py`.

---

## Results format

**`results/runs/<task_id>_<variant>_<run_idx>.json`**
```json
{
  "task_id": "django__django-11099",
  "variant": "zengram",
  "run_index": 0,
  "status": "completed",
  "patch": "diff --git ...",
  "turns": 12,
  "prompt_tokens": 45200,
  "completion_tokens": 3100,
  "duration_ms": 187000
}
```

**`results/scores/<task_id>_<variant>_<run_idx>.json`**
```json
{
  "task_id": "django__django-11099",
  "variant": "zengram",
  "run_index": 0,
  "resolved": true,
  "fail_to_pass_passed": ["tests.test_foo.FooTest.test_bar"],
  "fail_to_pass_failed": [],
  "pass_to_pass_passed": ["tests.test_foo.FooTest.test_existing"],
  "pass_to_pass_failed": []
}
```

---

## Repo structure

```
zengram-bench/
├── docs/proposal.md          benchmark design and hypotheses
├── tasks/
│   ├── django_subset.txt     25 SWE-bench Verified task IDs
│   └── cache/tasks.json      downloaded task metadata (gitignored)
├── harness/
│   ├── src/
│   │   ├── index.ts          CLI entry point (bench run/score/report)
│   │   ├── run.ts            execution loop + repo setup
│   │   ├── task.ts           task loader
│   │   ├── agent.ts          configurable agent invocation
│   │   ├── report.ts         comparison table
│   │   └── types.ts          shared types
│   └── scorer/
│       ├── setup_tasks.py    download SWE-bench metadata
│       ├── score.py          apply patches + run tests
│       └── requirements.txt
└── results/                  gitignored run + score JSONs
```
