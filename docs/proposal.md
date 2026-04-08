# Zengram OpenCode Evaluation — Benchmark Proposal

## Motivation

Zengram augments OpenCode with agent-native persistence: 6-phase context assembly,
hybrid retrieval (vector + FTS + MMR), cross-session knowledge, provenance tracking,
and multi-agent coordination. None of these capabilities show up in standard code
metrics. This document specifies how to measure whether they actually help.

---

## What Zengram Changes for a Coding Agent

| Capability | Vanilla OpenCode | OpenCode + Zengram |
|---|---|---|
| Context selection | Recency-based window | 6-phase assembly: hot/warm/cold tiers, MMR dedup, provenance-weighted |
| File/symbol retrieval | Text search | Hybrid: vector similarity + FTS, composite scoring |
| Cross-session memory | None (starts cold) | Knowledge base persists decisions, conventions, dead ends |
| Provenance | None | Every file touch linked to the turn/task that caused it |
| Multi-agent | Serial | Agent registry + mailboxes + task graph; parallel subagents |

---

## Benchmark Suite

### 1. SWE-bench Evaluation (primary)

**Dataset**: SWE-bench Verified (`princeton-nlp/SWE-bench_Verified`, ~500 tasks)  
**Subset**: 25 tasks from the `django` repository (controlled for repo — same codebase
eliminates confounds from repo size/language/test framework)

**Metrics per task, per variant**:
- `resolved` — all `fail_to_pass` tests pass AND all `pass_to_pass` tests still pass
- `turns` — number of agent turns taken
- `prompt_tokens` — total prompt tokens consumed
- `completion_tokens` — total completion tokens consumed
- `duration_s` — wall-clock time

**Aggregate metrics**:
- Resolution rate: `resolved / total`
- Median turns per resolved task
- Median token cost per resolved task (proxy for context quality)

The tasks that most favor Zengram are those requiring understanding of large,
interconnected codebases — exactly where context assembly and retrieval matter most.

**Variants**:
- `baseline` — vanilla OpenCode (SQLite, no Zengram)
- `zengram` — OpenCode fork with Zengram embedded

**Statistical rigour**: run each task 3× per variant; report mean ± std.
LLMs are stochastic; a single run is insufficient.

---

### 2. Cross-Session Retention (secondary)

Tests what Zengram uniquely enables: knowledge that persists across sessions.

**Protocol**:
1. **Warm-up session** — run a set of 10 tasks against the django repo; let Zengram
   learn the codebase structure, conventions, and architectural decisions.
2. **Transfer session** — run 10 *different* tasks against the same repo, in a new
   session. Baseline starts cold. Zengram fork starts with knowledge from warm-up.

**Metrics**: turns and tokens on transfer tasks for both variants.

**Hypothesis**: Zengram fork requires fewer turns and tokens on transfer tasks because
it already knows the module structure, test conventions, and common pitfalls.

---

### 3. Multi-Agent Coordination (tertiary)

Tests parallel subagent speedup via Zengram's agent registry and task graph.

**Task**: "Add test coverage to 10 independent modules" — a task that trivially
decomposes into 10 independent subtasks.

**Variants**:
- `baseline-serial` — vanilla OpenCode runs subtasks one at a time
- `zengram-parallel` — fork spawns N subagents via agent_registry; coordinator
  merges patches, resolving conflicts via provenance graph

**Metrics**: wall-clock time, patch quality (does the merged result compile + pass?),
duplicate work rate (# files touched by >1 subagent unnecessarily).

---

## Harness Architecture

```
zengram-bench/
├── tasks/django_subset.txt       # 25 SWE-bench Verified task IDs
├── harness/
│   ├── src/
│   │   ├── index.ts              # CLI: bench run / bench score / bench report
│   │   ├── run.ts                # task execution loop
│   │   ├── task.ts               # SWE-bench task loader (HuggingFace → local)
│   │   ├── agent.ts              # configurable agent invocation
│   │   └── report.ts             # comparison table + summary stats
│   └── scorer/
│       ├── setup_tasks.py        # download & cache SWE-bench task metadata
│       └── score.py              # apply patch + run tests → resolved bool
└── results/                      # gitignored run + score JSONs
```

**Runner** (TypeScript): orchestrates task setup, agent invocation, result capture.
**Scorer** (Python): applies the generated patch, runs the test suite, records
`resolved` per the SWE-bench protocol (fail_to_pass + pass_to_pass).
**Results**: plain JSON files per run/score — readable without any tooling,
optionally indexed into Zengram for analysis.

---

## First Step

Run the 25-task django subset, 3× each, comparing `baseline` vs `zengram`.
Report:
- Resolution rate (primary headline number)
- Median turns per resolved task
- Median token cost per resolved task

Target: demonstrate ≥10 percentage point improvement in resolution rate and/or
≥15% reduction in token cost per resolved task.
