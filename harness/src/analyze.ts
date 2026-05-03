/**
 * Trajectory analyzer — classifies each tool call into a wasted-action bucket
 * and surfaces aggregates per variant.
 *
 * Reads:
 *   results/runs/*.json    (RunResult — must include `trajectory`)
 *   results/scores/*.json  (ScoreResult — to know resolved/unresolved)
 *
 * Writes:
 *   results/analysis.json  (per-run tagged records + aggregate)
 *
 * North-star metric: resolved_per_million_tokens = 1e6 × resolved / total_tokens.
 * Optimize this. Higher is better. Wasted-action buckets feed back into which
 * heuristic to attack first.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RunResult,
  ScoreResult,
  ToolCallRecord,
  Trajectory,
  Variant,
} from "./types.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const RUNS_DIR     = path.join(ROOT, "results", "runs");
const SCORES_DIR   = path.join(ROOT, "results", "scores");
const ANALYSIS_OUT = path.join(ROOT, "results", "analysis.json");

/** Per-call waste tag. "useful" is the catch-all for non-flagged calls. */
export type WasteTag =
  | "useful"
  | "redundant_read"   // literal re-read of same file+offset+limit (chunked re-reads of different ranges are NOT flagged when records carry `input`)
  | "premature_test"   // bash test runner ran before any edit/write landed
  | "lint_only"        // bash matched a formatter/linter, not a test
  | "error_retry";     // this call retried a same-tool same-input call that errored

/** Run-level pattern flags (orthogonal to per-call tags). */
export type RunFlag =
  | "no_edit"          // session ended without ever editing — pure exploration
  | "high_redundancy"; // > 30% of reads were redundant

export interface TaggedRecord extends ToolCallRecord {
  tag: WasteTag;
}

export interface RunAnalysis {
  task_id: string;
  variant: Variant;
  run_index: number;
  resolved: boolean;
  turns: number;
  total_tokens: number;
  tag_counts: Record<WasteTag, number>;
  run_flags: RunFlag[];
  tagged_records: TaggedRecord[];
}

export interface VariantAggregate {
  variant: Variant;
  n_runs: number;
  n_resolved: number;
  resolution_rate: number;
  total_tokens: number;
  resolved_per_million_tokens: number;     // <- the north star
  median_total_tokens: number;
  median_turns: number;
  tag_distribution: Record<WasteTag, number>;
  tag_share: Record<WasteTag, number>;     // tag_distribution normalised to fractions
  run_flag_counts: Record<RunFlag, number>;
  top_redundant_files: Array<{ path: string; redundant_reads: number; runs: number }>;
}

export interface Analysis {
  generated_at: string;
  per_run: RunAnalysis[];
  by_variant: Record<Variant, VariantAggregate>;
}

// ── Heuristic patterns ───────────────────────────────────────────────────────
//
// Test-runner detection: only the `cmd=...` substring of input_summary is
// matched (set by the adapter for tool=bash). Patterns are deliberately broad
// — false positives here label non-test bash as `premature_test`, but every
// project has its own incantation. Tune against bench data.
const TEST_RUNNER_PATTERNS = [
  /\bpytest\b/,
  /python\s+-m\s+pytest\b/,
  /python\s+manage\.py\s+test\b/,
  /\brunte?sts?\.py\b/,
  /\bbun\s+test\b/,
  /\bnpm\s+(?:run\s+)?test\b/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bgo\s+test\b/,
];

const LINT_PATTERNS = [
  /\bblack\b/,
  /\bruff\b/,
  /\bflake8\b/,
  /\bmypy\b/,
  /\bpylint\b/,
  /\beslint\b/,
  /\bprettier\b/,
];

// ── Per-run classification ───────────────────────────────────────────────────

/**
 * Build the dedup key used by `redundant_read` and `error_retry` detection.
 *
 * When `input` is present (opencode#22+ trajectories), key on `path|offset|limit`
 * for reads — distinguishes chunked re-reads of different ranges of the same
 * file from literal re-reads of the same lines. Both are common in agent
 * sessions and only the latter is genuine waste.
 *
 * Falls back to `input_summary` for older bench-produced trajectories that
 * don't carry the structured `input` field.
 */
function readDedupKey(r: ToolCallRecord): string {
  if (!r.input) return r.input_summary;
  const fp = typeof r.input.filePath === "string"
    ? r.input.filePath
    : typeof r.input.path === "string"
      ? r.input.path
      : "";
  if (!fp) return r.input_summary;
  // offset/limit may be number, undefined, or null — coerce to a stable string
  // so the key matches across "absent" and "explicitly default" forms.
  const off = typeof r.input.offset === "number" ? String(r.input.offset) : "";
  const lim = typeof r.input.limit === "number" ? String(r.input.limit) : "";
  return `path=${fp}|off=${off}|lim=${lim}`;
}

function retryDedupKey(r: ToolCallRecord): string {
  // For non-read tools fall back to input_summary; same-tool same-input is the
  // signal we want for error_retry across all tools.
  return r.tool === "read" ? readDedupKey(r) : r.input_summary;
}

function classifyRecords(records: ToolCallRecord[]): TaggedRecord[] {
  const seenReadKeys = new Set<string>();
  let firstEditIdx = records.findIndex(
    (r) => (r.tool === "edit" || r.tool === "write") && r.status === "completed",
  );
  if (firstEditIdx === -1) firstEditIdx = Number.POSITIVE_INFINITY;

  const tagged: TaggedRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    let tag: WasteTag = "useful";

    if (r.tool === "read") {
      const key = readDedupKey(r);
      if (seenReadKeys.has(key)) tag = "redundant_read";
      // Only successful reads count as "seen". An errored read produced no
      // output, so a later successful read of the same range isn't waste —
      // it's the agent recovering. error_retry still catches the immediate-
      // next-record retry case for both reads and other tools.
      if (r.status === "completed") seenReadKeys.add(key);
    } else if (r.tool === "bash") {
      const cmd = r.input_summary.startsWith("cmd=") ? r.input_summary.slice(4) : r.input_summary;
      if (LINT_PATTERNS.some((p) => p.test(cmd))) tag = "lint_only";
      else if (TEST_RUNNER_PATTERNS.some((p) => p.test(cmd)) && i < firstEditIdx) tag = "premature_test";
    }

    // error_retry overrides the above: if the *previous* record errored on
    // the same tool with the same input, this record is a retry.
    if (i > 0) {
      const prev = records[i - 1]!;
      if (prev.status === "error" && prev.tool === r.tool && retryDedupKey(prev) === retryDedupKey(r)) {
        tag = "error_retry";
      }
    }

    tagged.push({ ...r, tag });
  }
  return tagged;
}

function deriveRunFlags(tagged: TaggedRecord[]): RunFlag[] {
  const flags: RunFlag[] = [];
  const edits = tagged.filter((r) => (r.tool === "edit" || r.tool === "write") && r.status === "completed");
  if (edits.length === 0) flags.push("no_edit");

  const reads = tagged.filter((r) => r.tool === "read");
  const redundant = reads.filter((r) => r.tag === "redundant_read");
  if (reads.length >= 3 && redundant.length / reads.length > 0.3) flags.push("high_redundancy");

  return flags;
}

function emptyTagCounts(): Record<WasteTag, number> {
  return {
    useful: 0,
    redundant_read: 0,
    premature_test: 0,
    lint_only: 0,
    error_retry: 0,
  };
}

function emptyFlagCounts(): Record<RunFlag, number> {
  return { no_edit: 0, high_redundancy: 0 };
}

function analyzeRun(run: RunResult, score: ScoreResult | undefined): RunAnalysis | null {
  const traj: Trajectory | undefined = run.trajectory;
  if (!traj) return null; // skip pre-instrumentation runs silently

  const tagged = classifyRecords(traj.records);
  const tag_counts = emptyTagCounts();
  for (const r of tagged) tag_counts[r.tag]++;

  return {
    task_id: run.task_id,
    variant: run.variant,
    run_index: run.run_index,
    resolved: score?.resolved ?? false,
    turns: run.turns,
    total_tokens: run.prompt_tokens + run.completion_tokens,
    tag_counts,
    run_flags: deriveRunFlags(tagged),
    tagged_records: tagged,
  };
}

// ── Aggregate ────────────────────────────────────────────────────────────────

function aggregate(variant: Variant, runs: RunAnalysis[]): VariantAggregate {
  const mine = runs.filter((r) => r.variant === variant);
  const n_runs = mine.length;
  const n_resolved = mine.filter((r) => r.resolved).length;
  const total_tokens = mine.reduce((acc, r) => acc + r.total_tokens, 0);

  const tag_distribution = emptyTagCounts();
  for (const r of mine) {
    for (const k of Object.keys(r.tag_counts) as WasteTag[]) {
      tag_distribution[k] += r.tag_counts[k];
    }
  }
  const total_calls = (Object.values(tag_distribution) as number[]).reduce((a, b) => a + b, 0);
  const tag_share = emptyTagCounts() as unknown as Record<WasteTag, number>;
  if (total_calls > 0) {
    for (const k of Object.keys(tag_distribution) as WasteTag[]) {
      tag_share[k] = tag_distribution[k] / total_calls;
    }
  }

  const run_flag_counts = emptyFlagCounts();
  for (const r of mine) {
    for (const f of r.run_flags) run_flag_counts[f]++;
  }

  // Top files redundantly re-read across runs. Aggregate redundant_read tags
  // by file, count how many runs touched each.
  const fileMap = new Map<string, { redundant_reads: number; runs: Set<string> }>();
  for (const r of mine) {
    for (const tr of r.tagged_records) {
      if (tr.tag !== "redundant_read") continue;
      const path = tr.input_summary.startsWith("path=") ? tr.input_summary.slice(5) : tr.input_summary;
      const entry = fileMap.get(path) ?? { redundant_reads: 0, runs: new Set<string>() };
      entry.redundant_reads++;
      entry.runs.add(`${r.task_id}_${r.run_index}`);
      fileMap.set(path, entry);
    }
  }
  const top_redundant_files = [...fileMap.entries()]
    .map(([p, v]) => ({ path: p, redundant_reads: v.redundant_reads, runs: v.runs.size }))
    .sort((a, b) => b.redundant_reads - a.redundant_reads)
    .slice(0, 10);

  return {
    variant,
    n_runs,
    n_resolved,
    resolution_rate: n_runs > 0 ? n_resolved / n_runs : 0,
    total_tokens,
    resolved_per_million_tokens: total_tokens > 0 ? (n_resolved / total_tokens) * 1e6 : 0,
    median_total_tokens: median(mine.map((r) => r.total_tokens)),
    median_turns: median(mine.map((r) => r.turns)),
    tag_distribution,
    tag_share,
    run_flag_counts,
    top_redundant_files,
  };
}

// ── Public entry points ──────────────────────────────────────────────────────

export function buildAnalysis(): Analysis {
  const runs   = loadJsonDir<RunResult>(RUNS_DIR);
  const scores = loadJsonDir<ScoreResult>(SCORES_DIR);
  const scoreKey = (s: { task_id: string; variant: string; run_index: number }) =>
    `${s.task_id}|${s.variant}|${s.run_index}`;
  const scoreByKey = new Map(scores.map((s) => [scoreKey(s), s]));

  const per_run: RunAnalysis[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const a = analyzeRun(run, scoreByKey.get(scoreKey(run)));
    if (a) per_run.push(a);
  }

  return {
    generated_at: new Date().toISOString(),
    per_run,
    by_variant: {
      baseline: aggregate("baseline", per_run),
      zengram:  aggregate("zengram",  per_run),
    },
  };
}

export function writeAnalysis(a: Analysis): string {
  fs.mkdirSync(path.dirname(ANALYSIS_OUT), { recursive: true });
  fs.writeFileSync(ANALYSIS_OUT, JSON.stringify(a, null, 2), "utf8");
  return ANALYSIS_OUT;
}

export function printAnalysis(a: Analysis): void {
  const { baseline, zengram } = a.by_variant;
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const fmtK   = (n: number) => `${(n / 1000).toFixed(1)}k`;

  console.log("\n═══ Trajectory analysis ═════════════════════════════════════════\n");
  console.log(row("Metric", "Baseline", "Zengram"));
  console.log("─".repeat(60));
  console.log(row("n_runs (with trajectory)", String(baseline.n_runs), String(zengram.n_runs)));
  console.log(row("Resolved", `${baseline.n_resolved}/${baseline.n_runs}`, `${zengram.n_resolved}/${zengram.n_runs}`));
  console.log(row("Resolution rate", fmtPct(baseline.resolution_rate), fmtPct(zengram.resolution_rate)));
  console.log(row("Total tokens", fmtK(baseline.total_tokens), fmtK(zengram.total_tokens)));
  console.log(row("Resolved / 1M tok ★", baseline.resolved_per_million_tokens.toFixed(2), zengram.resolved_per_million_tokens.toFixed(2)));
  console.log(row("Median tokens / run", fmtK(baseline.median_total_tokens), fmtK(zengram.median_total_tokens)));
  console.log(row("Median turns / run", baseline.median_turns.toFixed(1), zengram.median_turns.toFixed(1)));

  console.log("\n─── Wasted-action distribution ──────────────────────────────────\n");
  console.log(row("Tag", "Baseline", "Zengram"));
  console.log("─".repeat(60));
  const tags: WasteTag[] = ["useful", "redundant_read", "premature_test", "lint_only", "error_retry"];
  for (const t of tags) {
    const b = baseline.tag_distribution[t];
    const z = zengram.tag_distribution[t];
    const bs = baseline.tag_share[t] ?? 0;
    const zs = zengram.tag_share[t] ?? 0;
    console.log(row(t, `${b} (${fmtPct(bs)})`, `${z} (${fmtPct(zs)})`));
  }

  console.log("\n─── Run flags ───────────────────────────────────────────────────\n");
  console.log(row("Flag", "Baseline", "Zengram"));
  console.log("─".repeat(60));
  for (const f of ["no_edit", "high_redundancy"] as RunFlag[]) {
    console.log(row(f, String(baseline.run_flag_counts[f]), String(zengram.run_flag_counts[f])));
  }

  if (baseline.top_redundant_files.length > 0 || zengram.top_redundant_files.length > 0) {
    console.log("\n─── Top redundantly-read files (zengram) ────────────────────────\n");
    for (const f of zengram.top_redundant_files.slice(0, 5)) {
      console.log(`  ${f.redundant_reads}× across ${f.runs} run(s)  ${trimPath(f.path)}`);
    }
  }
  console.log("");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function row(a: string, b: string, c: string): string {
  return `${a.padEnd(28)} ${b.padEnd(14)} ${c.padEnd(14)}`;
}

function trimPath(p: string): string {
  // Bench repo-cache paths look like /tmp/zengram-bench-repo-XXXXXX/django/...
  // Strip the unstable prefix so the same file across runs collapses visually.
  return p.replace(/^\/tmp\/zengram-bench-repo-[A-Za-z0-9]+\//, "");
}
