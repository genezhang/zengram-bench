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
const CLONE_CACHE  = path.join(ROOT, "results", "repo-cache");  // gitignored bare clones

export interface RunOptions {
  subsetFile?: string;
  variants: Variant[];
  numRuns: number;
  taskFilter?: string[];
  dryRun?: boolean;
  concurrency: number;
  /**
   * Multi-session mode: reps of the same (task, variant) share a persistent
   * XDG_DATA_HOME so Zengram state accumulates across runs. Surfaces the
   * compounding-value dimension of Zengram (B1 in zengram-elevation-plan.md);
   * turn-count reduction in rep 2+ vs rep 0 is the thesis test.
   */
  multiSession?: boolean;
}

const MULTI_SESSION_ROOT = path.join(ROOT, "results", "multi-session-state");

export async function runBenchmark(opts: RunOptions): Promise<void> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const allTasks = loadTasks(opts.subsetFile);
  const tasks = opts.taskFilter
    // When --filter is provided, preserve the FILTER list's order instead of
    // the subset-file's. Lets us script ordered passes (e.g. shuffle round 1
    // vs shuffle round 2) without rewriting the subset file each time.
    ? opts.taskFilter
        .map((id) => allTasks.find((t) => t.task_id === id))
        .filter((t): t is SweTask => !!t)
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

  // Multi-session mode REQUIRES reps of the same (task, variant) to run
  // serially — Zengram state accumulates rep-to-rep and concurrent writes
  // would race. In single-session mode there's no such constraint: each rep
  // uses its own temp dir, so we preserve the prior behavior of treating
  // each rep as a separate work item bounded by `--concurrency`.
  type WorkItem = {
    task: SweTask;
    variant: Variant;
    reps: Array<{ runIdx: number }>; // always 1 in single-session, N in multi-session
    pinnedDataDir: string | undefined;
  };
  const items: WorkItem[] = [];
  for (const task of tasks) {
    for (const variant of opts.variants) {
      // Only the Zengram fork reads OPENCODE_PINNED_DATA_DIR; baseline runs
      // ignore it, so there's no reason to allocate a dir on disk for them.
      const pinnedDataDir =
        opts.multiSession && variant === "zengram"
          ? ensureMultiSessionDir(task.task_id, variant)
          : undefined;
      if (opts.multiSession && pinnedDataDir) {
        items.push({
          task,
          variant,
          reps: Array.from({ length: opts.numRuns }, (_, runIdx) => ({ runIdx })),
          pinnedDataDir,
        });
      } else {
        for (let runIdx = 0; runIdx < opts.numRuns; runIdx++)
          items.push({ task, variant, reps: [{ runIdx }], pinnedDataDir: undefined });
      }
    }
  }

  let completed = 0;
  const sem = new Semaphore(opts.concurrency);

  await Promise.all(
    items.map(async ({ task, variant, reps, pinnedDataDir }) => {
      await sem.acquire();
      try {
        for (const { runIdx } of reps) {
          const label = `${task.task_id} ${variant} #${runIdx}`;
          const outPath = resultPath(task.task_id, variant, runIdx);
          if (fs.existsSync(outPath)) {
            console.log(`  [${++completed}/${total}] ${label} — skipped (exists)`);
            continue;
          }

          console.log(`  [${++completed}/${total}] ${label} …`);
          const repoDir = await setupRepo(task);
          try {
            const result = await runAgent(task, variant, runIdx, repoDir, {
              pinnedDataDir,
            });
            writeResult(result, outPath);
            const icon = result.status === "completed" ? "✓" : "✗";
            const tokens = result.prompt_tokens + result.completion_tokens;
            console.log(`  ${icon} ${label} — ${result.status} (${result.turns} turns, ${tokens} tok)`);
          } finally {
            fs.rmSync(repoDir, { recursive: true, force: true });
          }
        }
      } finally {
        sem.release();
      }
    }),
  );

  console.log(`\nDone. Results written to ${RESULTS_DIR}`);
  console.log(`Next: cd harness/scorer && python score.py`);
}

// ── Multi-session state ──────────────────────────────────────────────────────
//
// Each (task, variant) pair gets its own persistent dir so reps 2+ can read
// Zengram knowledge/workspace state from rep 0's writes. Pinned dirs stick
// around across harness invocations so you can keep adding reps; if you need
// a fresh start, delete `results/multi-session-state/` and re-run.

/**
 * Sanitize a value for use as a filesystem path segment. Task IDs are loaded
 * from an external tasks.json, so they can in principle contain `..`,
 * forward/back slashes, NUL bytes, etc. Replace anything outside
 * `[A-Za-z0-9._-]` with `_` so the resulting segment can't escape the root
 * or produce an invalid directory name.
 */
function toSafePathSlug(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return slug.length > 0 ? slug : "_";
}

function ensureMultiSessionDir(taskId: string, variant: Variant): string {
  // BENCH_SUITE_NAME, when set, collapses all tasks in this run into a single
  // shared pinned dir per variant. That makes plays from task A recallable
  // when task B starts — the only way to actually exercise cross-task
  // recall, since per-task dirs isolate zengram state by construction.
  // Empty/whitespace = unset (treat as per-task to keep the existing
  // single-task multi-rep behavior).
  const suite = process.env["BENCH_SUITE_NAME"]?.trim();
  const slug = suite ? `_suite_${toSafePathSlug(suite)}` : `_${toSafePathSlug(taskId)}`;
  const dir = path.resolve(MULTI_SESSION_ROOT, `${slug}_${toSafePathSlug(String(variant))}`);
  const relative = path.relative(MULTI_SESSION_ROOT, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resolved multi-session dir escapes root: ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Repo setup (with shared clone cache) ─────────────────────────────────────
//
// Strategy: keep one bare clone per repo under results/repo-cache/.
// Each run gets a local clone from the cache (git uses hardlinks → fast,
// near-zero extra disk). This cuts network traffic from O(runs) to O(repos).

// Serialise per-repo cache initialisation so concurrent tasks for the same
// repo don't race to create the bare clone.
const cacheInitLocks = new Map<string, Promise<string>>();

async function ensureCache(repo: string): Promise<string> {
  const cacheDir = path.join(CLONE_CACHE, repo.replace("/", "__"));
  if (!cacheInitLocks.has(repo)) {
    cacheInitLocks.set(repo, (async () => {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
        console.log(`    [cache] cloning ${repo} …`);
        await execFileAsync("git", [
          "clone", "--bare",
          `https://github.com/${repo}.git`, cacheDir,
        ]);
      } else {
        // Fetch any commits added since last run (fast, incremental).
        await execFileAsync("git", ["-C", cacheDir, "fetch", "--quiet"]).catch(() => {});
      }
      return cacheDir;
    })());
  }
  return cacheInitLocks.get(repo)!;
}

async function setupRepo(task: SweTask): Promise<string> {
  const cacheDir = await ensureCache(task.repo);
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), "zengram-bench-repo-"));
  // --local uses hardlinks from the cache: fast and disk-efficient.
  await execFileAsync("git", ["clone", "--local", cacheDir, tmpDir]);
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
