#!/usr/bin/env node
/**
 * bench — Zengram evaluation harness CLI
 *
 * Commands:
 *   bench run     [options]   Run agent(s) against task subset
 *   bench score   [options]   Score generated patches (calls Python scorer)
 *   bench report  [options]   Print comparison table
 *
 * Quick start:
 *   1. python scorer/setup_tasks.py           # download task metadata
 *   2. bench run --variants baseline,zengram --runs 3
 *   3. python scorer/score.py                 # apply patches + run tests
 *   4. bench report
 */

import { program } from "commander";
import { runBenchmark } from "./run.js";
import { buildReport, printReport } from "./report.js";
import { buildAnalysisWithIntegrity, formatIntegrityReport, printAnalysis, writeAnalysis } from "./analyze.js";
import type { Variant } from "./types.js";

program
  .name("bench")
  .description("Zengram OpenCode evaluation harness")
  .version("0.1.0");

// ── bench run ─────────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Run agent(s) against the task subset and record results")
  .option(
    "--variants <list>",
    "comma-separated agent variants to run",
    "baseline,zengram",
  )
  .option("--runs <n>", "repetitions per task×variant", "3")
  .option("--tasks <file>", "path to task-ID file", "../tasks/django_subset.txt")
  .option("--filter <ids>", "comma-separated task IDs to run (subset of --tasks)")
  .option("--concurrency <n>", "number of tasks to run in parallel", "1")
  .option("--dry-run", "print what would run without invoking agents", false)
  .option("--skip-disk-check", "skip the free-disk-space preflight check", false)
  .option(
    "--multi-session",
    "persist Zengram state across reps of the same (task, variant) so runs 2+ can recall from run 1 — measures compounding value",
    false,
  )
  .action(async (opts) => {
    const variants = (opts.variants as string)
      .split(",")
      .map((v) => v.trim()) as Variant[];
    const numRuns     = parseInt(opts.runs as string, 10);
    const concurrency = parseInt(opts.concurrency as string, 10);
    const taskFilter = opts.filter
      ? (opts.filter as string).split(",").map((s: string) => s.trim())
      : undefined;

    if (!opts.skipDiskCheck) {
      await checkDiskSpace();
    }

    await runBenchmark({
      subsetFile: opts.tasks as string,
      variants,
      numRuns,
      taskFilter,
      concurrency,
      dryRun: opts.dryRun as boolean,
      multiSession: opts.multiSession as boolean,
    });
  });

// ── bench score ───────────────────────────────────────────────────────────────

program
  .command("score")
  .description("Apply patches and run tests via Python scorer (writes results/scores/)")
  .option("--runs-dir <dir>", "path to run results directory", "../results/runs")
  .option("--scores-dir <dir>", "output directory for score JSONs", "../results/scores")
  .option("--tasks-cache <file>", "path to tasks.json cache", "../tasks/cache/tasks.json")
  .action(async (opts) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const execAsync = promisify(execFile);
    const scorerDir = path.resolve(
      fileURLToPath(import.meta.url),
      "../../scorer",
    );
    const scorerScript = path.join(scorerDir, "score.py");

    console.log("Running Python scorer…");
    try {
      const { stdout, stderr } = await execAsync("python3", [
        scorerScript,
        "--runs-dir",    opts.runsDir as string,
        "--scores-dir",  opts.scoresDir as string,
        "--tasks-cache", opts.tasksCache as string,
      ]);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
    } catch (err) {
      console.error("Scorer failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ── bench report ──────────────────────────────────────────────────────────────

program
  .command("report")
  .description("Print comparison table from scored results")
  .option("--format <fmt>", "output format: table (default) or json", "table")
  .action((opts) => {
    const report = buildReport();
    if (opts.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
  });

// ── bench analyze ─────────────────────────────────────────────────────────────

program
  .command("analyze")
  .description("Tag tool calls with wasted-action classes and print aggregates")
  .option("--format <fmt>", "stdout format: table (default) or json", "table")
  .option("--no-write", "skip writing results/analysis.json")
  .option("--allow-stale", "produce a report even if score integrity check fails (for debugging)")
  .action((opts) => {
    const { analysis: a, integrity } = buildAnalysisWithIntegrity();
    // Score-integrity gating: if any run lacks a fresh score, refuse to
    // write analysis.json. This is the prevention layer for the round1–5
    // caching artifact — the analyzer was happily aggregating stale data
    // before because nothing checked. With this gate, fresh scoring is a
    // precondition for an authoritative aggregate.
    const integrityText = formatIntegrityReport(integrity);
    if (integrity.issues.length === 0) {
      if (opts.format !== "json") console.log(integrityText);
    } else {
      if (!opts.allowStale) {
        console.error(integrityText);
        console.error(`\nRefusing to write results/analysis.json with stale/missing scores.`);
        process.exit(2);
      }
      console.error(integrityText);
      console.error(`\n--allow-stale set: producing report anyway. DO NOT trust these numbers as authoritative.\n`);
    }
    if (opts.write !== false) {
      const out = writeAnalysis(a);
      if (opts.format !== "json") console.log(`Wrote ${out}`);
    }
    if (opts.format === "json") {
      console.log(JSON.stringify(a, null, 2));
    } else {
      printAnalysis(a);
    }
  });

program.parse();

// ── Preflight ─────────────────────────────────────────────────────────────────

async function checkDiskSpace(): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(execFile);

  try {
    // df -k gives 1 KB blocks; available is column 4 of the data row.
    const { stdout } = await execAsync("df", ["-k", "."]);
    const lines = stdout.trim().split("\n");
    const dataLine = lines[lines.length - 1]!;
    const available_kb = parseInt(dataLine.trim().split(/\s+/)[3]!, 10);
    const available_gb = available_kb / 1024 / 1024;

    // Estimate: one bare clone of django ≈ 200 MB; per-run working copy via
    // hardlinks ≈ near-zero extra. Scorer pip installs ≈ 100 MB per run.
    // Warn below 10 GB; hard-stop below 5 GB.
    if (available_gb < 5) {
      console.error(`\nERROR: only ${available_gb.toFixed(1)} GB free. Need at least 5 GB.`);
      console.error(`Free up space or use --skip-disk-check to override.`);
      process.exit(1);
    }
    if (available_gb < 10) {
      console.warn(`\nWARNING: only ${available_gb.toFixed(1)} GB free (recommended ≥ 10 GB).`);
      console.warn(`Run will proceed — watch disk usage during scoring.\n`);
    } else {
      console.log(`Disk: ${available_gb.toFixed(1)} GB free — OK\n`);
    }
  } catch {
    // Non-fatal; df may not be available everywhere.
  }
}
