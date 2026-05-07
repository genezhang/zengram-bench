/**
 * Agent invocation — runs one variant of OpenCode against a repo checkout
 * and returns the generated patch plus usage metrics.
 *
 * Agent commands are configured via environment variables:
 *   OPENCODE_BASELINE_CMD   path/command for vanilla OpenCode (default: "opencode")
 *   OPENCODE_ZENGRAM_CMD    path/command for Zengram fork     (default: "opencode-zengram")
 *
 * Both commands must support the following interface:
 *   <cmd> run \
 *     --problem-statement <text|@file> \
 *     --repo <dir> \
 *     --max-turns <n> \
 *     --output-patch <file> \
 *     --usage-json <file> \
 *     --trajectory-json <file>   (optional; adapter may ignore)
 *
 * The command must exit 0 on success. It writes:
 *   <output-patch>      unified diff of changes made to the repo
 *   <usage-json>        { turns, prompt_tokens, completion_tokens, ... }
 *   <trajectory-json>   { tool_counts, files_touched, bash_commands, records }
 *                       (optional — adapters that don't write it cause
 *                       RunResult.trajectory to stay undefined)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunResult, SweTask, Trajectory, Variant } from "./types.js";

// Run a child to completion, killing its entire process group on timeout.
// `execFile`'s built-in timeout sends SIGTERM only to the immediate child,
// which leaves grandchildren orphaned when the adapter is bash → exec bun
// (round 9 dj-13033 wedged 8.5h past the 30-min cap this way). Putting the
// child in its own process group via `detached: true` and SIGKILL'ing the
// negative PID reaps every descendant regardless of how the wrapper handles
// signals. The promise rejects with `Error("ETIMEDOUT")` so the existing
// catch block in runAgent classifies the run as a timeout.
function runWithTimeout(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env:      opts.env,
      detached: true,
      stdio:    "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    }, opts.timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut)        return reject(new Error("ETIMEDOUT"));
      if (signal)          return reject(new Error(`killed by ${signal}`));
      if (code !== 0)      return reject(new Error(`exited with code ${code}`));
      resolve();
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const AGENT_CMDS: Record<Variant, string> = {
  baseline: process.env["OPENCODE_BASELINE_CMD"] ?? "opencode",
  zengram:  process.env["OPENCODE_ZENGRAM_CMD"]  ?? "opencode-zengram",
};

const DEFAULT_MAX_TURNS = Number(process.env["BENCH_MAX_TURNS"] ?? "30");
const DEFAULT_TIMEOUT_MS = Number(process.env["BENCH_TIMEOUT_MS"] ?? String(20 * 60 * 1000));

export interface RunAgentOptions {
  /**
   * If set, pin the adapter's XDG_DATA_HOME to this dir so Zengram state
   * persists across reps. The adapter scripts recognise this via the env
   * variable OPENCODE_PINNED_DATA_DIR (see scripts/run-zengram.sh).
   */
  pinnedDataDir?: string;
}

export async function runAgent(
  task: SweTask,
  variant: Variant,
  runIndex: number,
  repoDir: string,
  agentOpts: RunAgentOptions = {},
): Promise<RunResult> {
  const cmd = AGENT_CMDS[variant];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zengram-bench-"));
  const patchFile = path.join(tmpDir, "output.patch");
  const usageFile = path.join(tmpDir, "usage.json");
  const trajFile  = path.join(tmpDir, "trajectory.json");
  const problemFile = path.join(tmpDir, "problem.txt");
  // Optional SWE-bench preamble — frames the task as "produce a patch" rather
  // than a Q&A. Strong frontier models infer this from the system prompt;
  // smaller open models (e.g. Qwen3-Coder-30B-A3B) often need it explicit.
  // Toggle with BENCH_PREAMBLE=1 to keep prior baselines untouched.
  const preamble = process.env["BENCH_PREAMBLE"] === "1"
    ? `You are a software engineer working inside the project's own source-code checkout. The current working directory IS the project repository — for example, if the bug is in Django's migrations system, the file you need to edit is something like ./django/db/migrations/autodetector.py, not a new file you create.

Rules:
1. The bug is in EXISTING source files. Find the relevant tracked file with grep/glob/read tools, then edit it in place with the edit tool.
2. Do NOT create new files. Do NOT scaffold a sample project (no manage.py, no settings.py, no testapp/, no reproduction harness). The repository at cwd already contains the buggy code.
3. Do NOT modify any file under tests/ or *_test.py — only edit production source.
4. Do NOT explain the behavior in prose; the user wants a fix, not an explanation.
5. You MUST call the edit (or write) tool to actually modify the file. Reading the file, globbing, or seeing a hint in a <zengram-previously-helpful> block is NOT making an edit — only an edit/write tool call counts.
6. Stop IMMEDIATELY after the edit/write tool call succeeds. Do not run 'git diff' to verify, do not re-read the file, do not run tests, do not explain what you did. The bench harness verifies the patch externally — your job ends the moment the edit lands.
7. If a <zengram-previously-helpful> block tells you the file and shows the working change, use it as a shortcut: read the file ONCE for context, then call the edit tool with the equivalent change. Do not re-discover the fix from scratch — but you DO still have to call the edit tool.
8. CRITICAL: a <zengram-previously-helpful> block describes what worked in PRIOR sessions. Those edits DO NOT exist in the current checkout — every session starts from an unmodified clean checkout. The play is a HINT, not evidence the file is already fixed. You MUST call edit/write yourself in this session, even if the play looks like the answer. Ending the session without an edit/write tool call is a failure regardless of what the play shows.
9. KNOW WHEN TO QUIT. If after ~8 turns of exploration you cannot identify a concrete file and a concrete edit to make, write one short message saying "I cannot determine a fix for this issue" and stop. Spending all 15 turns reading and grepping without ever editing is strictly worse than admitting defeat at turn 8 — it wastes tokens and produces the same null result. Failing fast is success when the alternative is failing slow.

---

`
    : "";
  fs.writeFileSync(problemFile, preamble + task.problem_statement, "utf8");

  const timestamp = new Date().toISOString();
  const start = Date.now();

  const childEnv = {
    ...process.env,
    ...(agentOpts.pinnedDataDir
      ? { OPENCODE_PINNED_DATA_DIR: agentOpts.pinnedDataDir }
      : {}),
  };

  try {
    await runWithTimeout(
      cmd,
      [
        "run",
        "--problem-statement", `@${problemFile}`,
        "--repo",             repoDir,
        "--max-turns",        String(DEFAULT_MAX_TURNS),
        "--output-patch",     patchFile,
        "--usage-json",       usageFile,
        "--trajectory-json",  trajFile,
      ],
      { timeoutMs: DEFAULT_TIMEOUT_MS, env: childEnv },
    );

    const duration_ms = Date.now() - start;
    const patch = fs.existsSync(patchFile)
      ? fs.readFileSync(patchFile, "utf8")
      : "";
    const usage = fs.existsSync(usageFile)
      ? (JSON.parse(fs.readFileSync(usageFile, "utf8")) as {
          turns: number;
          prompt_tokens: number;
          completion_tokens: number;
          cache_read_tokens?: number;
          turns_with_cache_hit?: number;
          session_id?: string;
        })
      : { turns: 0, prompt_tokens: 0, completion_tokens: 0 };
    // Trajectory file is optional — older adapters that ignore the
    // --trajectory-json flag won't produce one. Missing trajectory is fine;
    // unparseable trajectory is a real bug — let it surface rather than mask it.
    const trajectory: Trajectory | undefined = fs.existsSync(trajFile)
      ? (JSON.parse(fs.readFileSync(trajFile, "utf8")) as Trajectory)
      : undefined;

    // A run that produced zero step_finish events is not "completed" no matter
    // how cleanly the subprocess exited. The zengram adapter swallows
    // opencode-fork's non-zero exit so the parent always sees status 0; without
    // this gate, a wedged backend produces 0-turn 0-token results stamped
    // "completed" — survey50_round7 (2026-05-06) lost 14 zengram runs this way.
    const noSteps = usage.turns === 0;
    return {
      task_id:              task.task_id,
      variant,
      run_index:            runIndex,
      timestamp,
      status:               noSteps ? "failed" : "completed",
      patch,
      turns:                usage.turns,
      prompt_tokens:        usage.prompt_tokens,
      completion_tokens:    usage.completion_tokens,
      cache_read_tokens:    usage.cache_read_tokens ?? 0,
      turns_with_cache_hit: usage.turns_with_cache_hit ?? 0,
      duration_ms,
      ...(noSteps ? { error: "agent produced no step_finish events (zero turns) — backend wedged or rate-limited past retry" } : {}),
      ...(usage.session_id ? { session_id: usage.session_id } : {}),
      ...(trajectory ? { trajectory } : {}),
    };
  } catch (err: unknown) {
    const duration_ms = Date.now() - start;
    const isTimeout = err instanceof Error && err.message.includes("ETIMEDOUT");
    return {
      task_id:              task.task_id,
      variant,
      run_index:            runIndex,
      timestamp,
      status:               isTimeout ? "timeout" : "failed",
      patch:                "",
      turns:                0,
      prompt_tokens:        0,
      completion_tokens:    0,
      cache_read_tokens:    0,
      turns_with_cache_hit: 0,
      duration_ms,
      error:                err instanceof Error ? err.message : String(err),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
