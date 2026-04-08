/**
 * Task execution loop.
 *
 * For each task × variant × repetition:
 *   1. Clone the repo to a temp directory and check out base_commit
 *   2. Run the agent
 *   3. Write the RunResult JSON to results/runs/
 *
 * Tasks run with controlled concurrency (--concurrency N).
 * Variant × rep pairs within a task always run serially to avoid
 * git-checkout races in the same temp directory.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { loadTasks } from "./task.js";
import type { RunResult, SweTask, Variant } from "./types.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const RESULTS_DIR = path.join(ROOT, "results", "runs");

export interface RunOptions {
  subsetFile?: string;
  variants: Variant[];
  numRuns: number;
  taskFilter?: string[];
  dryRun?: boolean;
  concurrency: number;
}

export async function runBenchmark(opts: RunOptions): Promise<void> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const allTasks = loadTasks(opts.subsetFile);
  const tasks = opts.taskFilter
    ? allTasks.filter((t) => opts.taskFilter!.includes(t.task_id))
    : allTasks;

  const total = tasks.length * opts.variants.length * opts.numRuns;
  console.log(`Running ${tasks.length} tasks × ${opts.variants.length} variants × ${opts.numRuns} reps`);
  console.log(`= ${total} total agent invocations  (concurrency=${opts.concurrency})\n`);

  if (opts.dryRun) {
    for (const task of tasks)
      for (const variant of opts.variants)
        for (let i = 0; i < opts.numRuns; i++)
          console.log(`  [dry-run] ${task.task_id} ${variant} #${i}`);
    return;
  }

  // Each work item is one (task, variant, runIdx) triple.
  type WorkItem = { task: SweTask; variant: Variant; runIdx: number; label: string };
  const queue: WorkItem[] = [];
  for (const task of tasks)
    for (const variant of opts.variants)
      for (let runIdx = 0; runIdx < opts.numRuns; runIdx++)
        queue.push({ task, variant, runIdx, label: `${task.task_id} ${variant} #${runIdx}` });

  let completed = 0;
  const sem = new Semaphore(opts.concurrency);

  await Promise.all(
    queue.map(async ({ task, variant, runIdx, label }) => {
      const outPath = resultPath(task.task_id, variant, runIdx);
      if (fs.existsSync(outPath)) {
        console.log(`  [${++completed}/${total}] ${label} — skipped (exists)`);
        return;
      }

      await sem.acquire();
      console.log(`  [${++completed}/${total}] ${label} …`);
      const repoDir = await setupRepo(task);
      try {
        const result = await runAgent(task, variant, runIdx, repoDir);
        writeResult(result, outPath);
        const icon = result.status === "completed" ? "✓" : "✗";
        const tokens = result.prompt_tokens + result.completion_tokens;
        console.log(`  ${icon} ${label} — ${result.status} (${result.turns} turns, ${tokens} tok)`);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
        sem.release();
      }
    }),
  );

  console.log(`\nDone. Results written to ${RESULTS_DIR}`);
  console.log(`Next: cd harness/scorer && python score.py`);
}

// ── Repo setup ────────────────────────────────────────────────────────────────

async function setupRepo(task: SweTask): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zengram-bench-repo-"));
  const repoUrl = `https://github.com/${task.repo}.git`;
  await execFileAsync("git", ["clone", "--depth", "1000", repoUrl, tmpDir]);
  execFileSync("git", ["-C", tmpDir, "checkout", task.base_commit], { stdio: "ignore" });
  return tmpDir;
}

// ── Result I/O ────────────────────────────────────────────────────────────────

function resultPath(taskId: string, variant: Variant, runIdx: number): string {
  return path.join(RESULTS_DIR, `${taskId}_${variant}_${runIdx}.json`);
}

function writeResult(result: RunResult, outPath: string): void {
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
}

export function loadRunResults(): RunResult[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8")) as RunResult);
}

// ── Semaphore ─────────────────────────────────────────────────────────────────

class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(limit: number) {
    this.count = limit;
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }
}
