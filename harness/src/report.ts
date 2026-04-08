/**
 * Report generator — reads run + score results and produces a comparison table.
 *
 * Usage (after scoring):
 *   bench report
 *   bench report --format json > results/summary.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult, ScoreResult, Variant, VariantSummary } from "./types.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const RUNS_DIR   = path.join(ROOT, "results", "runs");
const SCORES_DIR = path.join(ROOT, "results", "scores");

export function buildReport(): { baseline: VariantSummary; zengram: VariantSummary } {
  const runs   = loadJsonDir<RunResult>(RUNS_DIR);
  const scores = loadJsonDir<ScoreResult>(SCORES_DIR);

  return {
    baseline: summarize("baseline", runs, scores),
    zengram:  summarize("zengram",  runs, scores),
  };
}

function summarize(
  variant: Variant,
  runs: RunResult[],
  scores: ScoreResult[],
): VariantSummary {
  const myRuns   = runs.filter((r) => r.variant === variant && r.status === "completed");
  const myScores = scores.filter((s) => s.variant === variant);

  // Group by task_id.
  const taskIds = [...new Set(myRuns.map((r) => r.task_id))];

  const perTask = taskIds.map((task_id) => {
    const taskRuns   = myRuns.filter((r) => r.task_id === task_id);
    const taskScores = myScores.filter((s) => s.task_id === task_id);
    return {
      task_id,
      resolved_count: taskScores.filter((s) => s.resolved).length,
      mean_turns: mean(taskRuns.map((r) => r.turns)),
      mean_tokens: mean(taskRuns.map((r) => r.prompt_tokens + r.completion_tokens)),
    };
  });

  // Only include resolved runs in efficiency stats.
  const resolvedTaskIds = new Set(
    myScores.filter((s) => s.resolved).map((s) => s.task_id + "_" + s.run_index)
  );
  const resolvedRuns = myRuns.filter((r) =>
    resolvedTaskIds.has(r.task_id + "_" + r.run_index)
  );

  return {
    variant,
    total_tasks:                       taskIds.length,
    resolution_rate:                   perTask.filter((t) => t.resolved_count > 0).length / Math.max(taskIds.length, 1),
    median_turns_resolved:             median(resolvedRuns.map((r) => r.turns)),
    median_prompt_tokens_resolved:     median(resolvedRuns.map((r) => r.prompt_tokens)),
    median_completion_tokens_resolved: median(resolvedRuns.map((r) => r.completion_tokens)),
    median_duration_ms_resolved:       median(resolvedRuns.map((r) => r.duration_ms)),
    per_task:                          perTask,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function printReport(report: { baseline: VariantSummary; zengram: VariantSummary }): void {
  const { baseline, zengram } = report;

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const delta = (z: number, b: number, higherIsBetter: boolean) => {
    if (b === 0) return "—";
    const d = ((z - b) / b) * 100;
    const sign = d >= 0 ? "+" : "";
    const good = higherIsBetter ? d >= 0 : d <= 0;
    return `${sign}${d.toFixed(1)}% ${good ? "✓" : "✗"}`;
  };

  console.log("\n═══ Zengram Benchmark Results ═══════════════════════════════════\n");
  console.log(row("Metric", "Baseline", "Zengram", "Delta"));
  console.log("─".repeat(72));
  console.log(row(
    "Resolution rate",
    pct(baseline.resolution_rate),
    pct(zengram.resolution_rate),
    delta(zengram.resolution_rate, baseline.resolution_rate, true),
  ));
  console.log(row(
    "Median turns (resolved)",
    fmt(baseline.median_turns_resolved),
    fmt(zengram.median_turns_resolved),
    delta(zengram.median_turns_resolved, baseline.median_turns_resolved, false),
  ));
  console.log(row(
    "Median prompt tokens (resolved)",
    fmtK(baseline.median_prompt_tokens_resolved),
    fmtK(zengram.median_prompt_tokens_resolved),
    delta(zengram.median_prompt_tokens_resolved, baseline.median_prompt_tokens_resolved, false),
  ));
  console.log(row(
    "Median completion tokens (resolved)",
    fmtK(baseline.median_completion_tokens_resolved),
    fmtK(zengram.median_completion_tokens_resolved),
    delta(zengram.median_completion_tokens_resolved, baseline.median_completion_tokens_resolved, false),
  ));
  console.log(row(
    "Median duration (resolved)",
    fmtMs(baseline.median_duration_ms_resolved),
    fmtMs(zengram.median_duration_ms_resolved),
    "—",
  ));
  console.log("─".repeat(72));

  // Per-task breakdown.
  console.log("\n─── Per-task resolution ──────────────────────────────────────────\n");
  console.log(row("Task ID", "Baseline resolved", "Zengram resolved", ""));
  console.log("─".repeat(72));
  const taskIds = [...new Set([
    ...baseline.per_task.map((t) => t.task_id),
    ...zengram.per_task.map((t) => t.task_id),
  ])].sort();
  for (const tid of taskIds) {
    const b = baseline.per_task.find((t) => t.task_id === tid);
    const z = zengram.per_task.find((t) => t.task_id === tid);
    const bRes = b ? `${b.resolved_count} run(s)` : "—";
    const zRes = z ? `${z.resolved_count} run(s)` : "—";
    const mark = (z?.resolved_count ?? 0) > (b?.resolved_count ?? 0)
      ? "↑" : (z?.resolved_count ?? 0) < (b?.resolved_count ?? 0) ? "↓" : "=";
    console.log(row(tid.replace("django__django-", "djg-"), bRes, zRes, mark));
  }
  console.log("");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJsonDir<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function row(a: string, b: string, c: string, d: string): string {
  return `${a.padEnd(38)}${b.padEnd(14)}${c.padEnd(14)}${d}`;
}

function fmt(n: number): string { return n.toFixed(1); }
function fmtK(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)); }
function fmtMs(n: number): string {
  if (n >= 60000) return `${(n / 60000).toFixed(1)}m`;
  if (n >= 1000)  return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}
