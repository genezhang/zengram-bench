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
  .option("--dry-run", "print what would run without invoking agents", false)
  .action(async (opts) => {
    const variants = (opts.variants as string)
      .split(",")
      .map((v) => v.trim()) as Variant[];
    const numRuns = parseInt(opts.runs as string, 10);
    const taskFilter = opts.filter
      ? (opts.filter as string).split(",").map((s: string) => s.trim())
      : undefined;

    await runBenchmark({
      subsetFile: opts.tasks as string,
      variants,
      numRuns,
      taskFilter,
      dryRun: opts.dryRun as boolean,
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

program.parse();
