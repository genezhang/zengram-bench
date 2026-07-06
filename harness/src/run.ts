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

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { loadTasks } from "./task.js";
import type { RunResult, SweTask, Variant } from "./types.js";

// Variants whose multi-session state dir is written to by zengram extensions.
// Lesson extraction only makes sense for these (they have a pinnedDataDir).
const LESSON_VARIANTS = new Set<Variant>(["zengram", "strategy", "both"]);

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const RESULTS_DIR = process.env["BENCH_RESULTS_DIR"] ?? path.join(ROOT, "results", "runs");
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

/**
 * Trigger ONNX JIT compilation once before any timed bench runs.
 *
 * The first call to embed() in a fresh OS session compiles the 127 MB ONNX
 * model, which can take tens of seconds on a cold CPU. Every subsequent
 * process loads the compiled model from the OS page cache in <1 s. Running
 * one throwaway Pi session here absorbs the cold-start cost up front so no
 * timed run is penalised.
 *
 * Conditions: only for multi-session runs that include an ONNX-using variant
 * (strategy/both). Failures are non-fatal — the
 * worst case is that the first real run pays the JIT cost itself.
 */
function prewarmEmbed(opts: RunOptions): void {
  const ONNX_VARIANTS = new Set(["strategy", "both"]);
  if (!opts.multiSession) return;
  if (!opts.variants.some((v) => ONNX_VARIANTS.has(v))) return;

  // Resolve the standalone prewarm script next to the strategy extension.
  const scriptsDir = process.env["BENCH_SCRIPTS_DIR"] ?? path.join(ROOT, "scripts");
  const defaultExt = path.join(scriptsDir, "../../zengram/integrations/pi/zengram-strategy.ts");
  const strategyExt = process.env["ZENGRAM_PI_STRATEGY_EXT"] ?? defaultExt;
  const prewarmScript = path.join(path.dirname(strategyExt), "prewarm-embed.ts");
  const resolved = (() => { try { return fs.realpathSync(prewarmScript); } catch { return prewarmScript; } })();
  if (!fs.existsSync(resolved)) {
    console.log("  (skipping ONNX pre-warm: prewarm-embed.ts not found)");
    return;
  }

  // Run via bun directly — no pi, no LLM call. Only triggers ONNX JIT.
  // This avoids the orphaned-bronco-request problem that plagued the old
  // approach (pi --print warmup would make a real LLM call; if SIGKILL'd
  // mid-inference, bronco's single slot stayed busy for the next real run).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zengram-prewarm-"));
  console.log("  Pre-warming ONNX embed model (no LLM call)…");
  const t0 = Date.now();
  try {
    // 600 s: ONNX JIT alone takes ~300 s on a cold CPU. With bun import
    // overhead the realistic ceiling is ~400 s; 600 s gives ample headroom.
    // Ensure ZENGRAM_EMBED_MODEL_DIR is set so the native open() call finds the
    // model at ~/embed even when the harness is invoked directly (not via the
    // adapter scripts that normally export this var).
    const embedModelDir =
      process.env["ZENGRAM_EMBED_MODEL_DIR"] ??
      path.join(os.homedir(), "embed");

    const result = spawnSync(
      "bun",
      ["run", resolved],
      {
        env: {
          ...process.env,
          ZENGRAM_DATA_DIR: tmpDir,
          ZENGRAM_EMBED_MODEL_DIR: embedModelDir,
        },
        timeout: 600_000,
        killSignal: "SIGKILL",
        stdio: "pipe",
      },
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.error) {
      console.log(`  (ONNX pre-warm error after ${elapsed}s: ${result.error.message} — first real run will pay JIT cost)\n`);
    } else if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim().slice(0, 200);
      console.log(`  (ONNX pre-warm exited ${result.status} after ${elapsed}s${stderr ? `: ${stderr}` : ""} — first real run will pay JIT cost)\n`);
    } else {
      console.log(`  ONNX pre-warm done in ${elapsed}s\n`);
    }
  } catch {
    console.log("  (ONNX pre-warm failed — first real run will pay JIT cost)\n");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Poll BENCH_LLM_SLOTS_URL until all llama.cpp slots are idle, then return.
 *
 * Busy = slot.is_processing || any(slot.next_token[].has_next_token).
 * Mirrors the shell wait_for_bronco_idle() in the adapter scripts, but
 * runs from inside the Node harness so it can be called between every rep —
 * not just once at script startup.
 *
 * Non-fatal: if the URL is unset, the server is unreachable, or the timeout
 * elapses, the function returns silently rather than aborting the run.
 */
async function waitForBroncoIdle(
  timeoutMs = 300_000,
  intervalMs = 5_000,
): Promise<void> {
  const url = process.env["BENCH_LLM_SLOTS_URL"] ?? "http://bronco.local:8080/slots";
  if (!url) return;

  const deadline = Date.now() + timeoutMs;
  let reported = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const slots = (await res.json()) as Array<{
          is_processing: boolean;
          next_token?: Array<{ has_next_token: boolean }>;
        }>;
        // Use only is_processing — has_next_token can linger in a stale state
        // after a client disconnects mid-stream (slot idle but token state not
        // cleared). The /health endpoint also confirms idle when is_processing=false.
        const busy = slots.some((s) => s.is_processing);
        if (!busy) {
          if (reported) console.log("  (LLM server idle — continuing)\n");
          return;
        }
        if (!reported) {
          console.log("  (waiting for LLM server to go idle…)");
          reported = true;
        }
      }
    } catch {
      // server may be momentarily unreachable — keep polling
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  console.log("  (LLM server idle-wait timed out — proceeding anyway)\n");
}

/**
 * Post-run lesson extraction.
 *
 * After each completed rep, calls the LLM (bronco) with the task description
 * + the patch produced to extract 3-5 actionable lessons, then writes them to
 * the task's persistent zengram DB via write-lessons.ts. Lessons are stored at
 * /strategy scope so the strategy extension surfaces them as hints in the next
 * rep's system-prompt injection AND the recall_memory tool can retrieve them.
 *
 * This is the "external write" path — it runs OUTSIDE Pi, after the agent has
 * exited, and it knows the full patch text (unlike the in-session reflection
 * which only has truncated excerpts). It does NOT know whether the tests passed
 * (scoring happens later), so it writes lessons from POSSIBLY-WRONG patches at
 * high importance — the "unverified self-reported lessons reinforce failure"
 * risk that the outcome-labeled writeback path (writeback-outcomes.ts, run via
 * run-interleaved.sh) was built to address.
 *
 * EXPERIMENTAL — OFF BY DEFAULT (opt-in). This crude unverified-lesson injector
 * is unproven and can confound multi-session runs (and double-write against the
 * verified writeback path on the same DB). It is gated OFF so every run is a
 * clean baseline; enable it deliberately with BENCH_LESSON_EXTRACT=1 only when
 * running an explicit A/B to evaluate it. Promote to default-on only if a
 * powered run shows it helps.
 *
 * Only fires when:
 *   - BENCH_LESSON_EXTRACT === "1" (explicit opt-in; default off)
 *   - The run completed (status === "completed", turns > 0)
 *   - pinnedDataDir is set (multi-session mode, a LESSON_VARIANT)
 */
/**
 * Parse a lesson JSON array, salvaging complete items from truncated output.
 * A max_tokens cutoff mid-string used to discard the whole extraction; instead
 * trim back to the last complete object and close the array.
 */
function parseLessonsLenient(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText);
  } catch {
    const last = jsonText.lastIndexOf("}");
    if (last === -1) return null;
    try {
      return JSON.parse(jsonText.slice(0, last + 1).replace(/,\s*$/, "") + "]");
    } catch {
      return null;
    }
  }
}

async function extractAndStoreLessons(
  task: SweTask,
  result: RunResult,
  pinnedDataDir: string,
): Promise<void> {
  // Experimental, opt-in: default OFF so it never silently confounds a run.
  if (process.env["BENCH_LESSON_EXTRACT"] !== "1") return;
  if (result.status !== "completed" || result.turns === 0) return;

  const patch = result.patch?.trim();
  if (!patch) return; // no patch → nothing to extract lessons from

  // Derive bronco completions URL from slots URL or a dedicated env var.
  const slotsUrl = process.env["BENCH_LLM_SLOTS_URL"] ?? "http://bronco.local:8080/slots";
  const completionsUrl =
    process.env["BENCH_LLM_COMPLETIONS_URL"] ??
    slotsUrl.replace(/\/slots$/, "/v1/chat/completions");

  const model = result.model || "default";
  const taskDesc = task.problem_statement?.slice(0, 800) ?? task.task_id;
  const patchExcerpt = patch.slice(0, 4000);

  const prompt =
    `/no_think\n` +
    `You are a software engineering teacher writing notes for the NEXT agent that will attempt this task.\n\n` +
    `Task: ${taskDesc}\n\n` +
    `Patch the agent produced (first 4000 chars):\n${patchExcerpt}\n\n` +
    `Write exactly 3 to 5 lessons that will help a future agent solve this task faster. ` +
    `Each lesson must be concrete: name the specific file, class, method, or pattern involved. ` +
    `Do NOT write generic advice. Focus on what files to look at first, what the root cause likely is, ` +
    `and what approach the patch suggests.\n\n` +
    `Output ONLY a JSON array. No prose, no markdown fences.\n` +
    `Each item: {"subject": "<filename or topic>", "content": "<one concrete lesson>", "importance": 0.91}\n` +
    `Output [] if the patch is empty or trivial.`;

  let lessons: Array<{ subject: string; content: string; importance: number }>;
  try {
    const res = await fetch(completionsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer bronco` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        // 1500, not 600: Ornith writes longer lesson strings than Qwen and
        // 600 truncated the JSON mid-string in 28/36 pilot1 extractions.
        max_tokens: 1500,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      console.log(`  (lesson extract: HTTP ${res.status} — skipped)`);
      return;
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    // Strip Qwen3 <think>...</think> reasoning block, then markdown fences.
    const stripped = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
    const jsonText = stripped.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    lessons = parseLessonsLenient(jsonText) as typeof lessons;
    if (!Array.isArray(lessons) || lessons.length === 0) return;
  } catch (err) {
    console.log(`  (lesson extract: ${(err as Error).message?.slice(0, 80)} — skipped)`);
    return;
  }

  // Resolve write-lessons.ts relative to this file:
  // harness/src/ → harness/ → zengram-bench/ → ~/ → ~/zengram/...
  const writeLessonsScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../zengram/integrations/pi/write-lessons.ts",
  );
  if (!fs.existsSync(writeLessonsScript)) {
    console.log(`  (lesson extract: write-lessons.ts not found at ${writeLessonsScript} — skipped)`);
    return;
  }

  const embedModelDir =
    process.env["ZENGRAM_EMBED_MODEL_DIR"] ?? path.join(os.homedir(), "embed");

  const writeResult = spawnSync("bun", ["run", writeLessonsScript], {
    input: JSON.stringify(lessons),
    env: {
      ...process.env,
      ZENGRAM_DATA_DIR: pinnedDataDir,
      ZENGRAM_EMBED_MODEL_DIR: embedModelDir,
    },
    timeout: 60_000,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (writeResult.error) {
    console.log(`  (lesson write: ${writeResult.error.message.slice(0, 80)} — skipped)`);
  } else if (writeResult.status !== 0) {
    const stderr = writeResult.stderr?.toString().trim().slice(0, 120);
    console.log(`  (lesson write exit ${writeResult.status}${stderr ? `: ${stderr}` : ""} — skipped)`);
  } else {
    const stdout = writeResult.stdout?.toString().trim();
    if (stdout) console.log(`  ${stdout}`);
  }
}

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

  prewarmEmbed(opts);
  await waitForBroncoIdle(); // ensure server is free after pre-warm before first real run

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
      // Variants that persist state across reps get their own pinned data dir.
      // "strategy" and "both" share the same OPENCODE_PINNED_DATA_DIR mechanism
      // as "zengram" — the adapter scripts map it to ZENGRAM_DATA_DIR.
      const PINNED_VARIANTS = new Set<string>(["zengram", "strategy", "both"]);
      const pinnedDataDir =
        opts.multiSession && PINNED_VARIANTS.has(variant)
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
          let runResult: RunResult | undefined;
          try {
            runResult = await runAgent(task, variant, runIdx, repoDir, {
              pinnedDataDir,
            });
            writeResult(runResult, outPath);
            const icon = runResult.status === "completed" ? "✓" : "✗";
            const tokens = runResult.prompt_tokens + runResult.completion_tokens;
            console.log(`  ${icon} ${label} — ${runResult.status} (${runResult.turns} turns, ${tokens} tok)`);
          } finally {
            fs.rmSync(repoDir, { recursive: true, force: true });
          }

          // Wait for the LLM server to drain before starting the next rep.
          // The agent's agent_end hook (e.g. zengram reflection) may have made
          // a final LLM call just before Pi exited. If the server is still
          // generating when the next rep's Pi starts, the first call queues
          // behind the in-flight request and can push total init time past the
          // stall-detection threshold → 0-turn failure.
          await waitForBroncoIdle();

          // Optionally extract lessons from the completed run and store them in
          // zengram so the next rep starts with patch-grounded hints. EXPERIMENTAL
          // and OFF unless BENCH_LESSON_EXTRACT=1 (extractAndStoreLessons early-
          // returns otherwise). Runs AFTER waitForBroncoIdle so bronco is free.
          if (runResult && pinnedDataDir && LESSON_VARIANTS.has(variant)) {
            await extractAndStoreLessons(task, runResult, pinnedDataDir);
            // Wait again after extraction — the extraction call itself uses bronco
            // and the server needs to fully settle before the next rep's Pi starts.
            await waitForBroncoIdle();
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
  // Apply test_patch so all FTP tests exist in the repo before the agent
  // starts. Without this, tests added by test_patch give AttributeError
  // ("class has no attribute 'test_xxx'") instead of proper pass/fail
  // feedback, which confuses the model.
  //
  // Commit the patch so `git diff HEAD` (the adapter's output) only includes
  // the agent's implementation changes, not the test additions. The adapter's
  // `git checkout -- .` retry reset also only reverts uncommitted changes,
  // so the test_patch commit survives across retries.
  if (task.test_patch) {
    const patchFile = path.join(tmpDir, ".test_patch.diff");
    fs.writeFileSync(patchFile, task.test_patch, "utf8");
    try {
      execFileSync("git", ["-C", tmpDir, "apply", "--index", patchFile], { stdio: "ignore" });
      execFileSync("git", [
        "-C", tmpDir, "commit", "-m", "bench: apply test_patch",
        "--no-gpg-sign", "--author=bench <bench@bench>",
      ], { stdio: "ignore" });
    } catch {
      // Non-fatal: test_patch may not apply cleanly to all checkouts.
      // Fall through with an unpatched repo rather than aborting the run.
    } finally {
      try { fs.unlinkSync(patchFile); } catch { /* ignore */ }
    }
  }
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
