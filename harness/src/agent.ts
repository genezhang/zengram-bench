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
 *     --usage-json <file>
 *
 * The command must exit 0 on success. It writes:
 *   <output-patch>  unified diff of changes made to the repo
 *   <usage-json>    { turns, prompt_tokens, completion_tokens }
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunResult, SweTask, Variant } from "./types.js";

const execFileAsync = promisify(execFile);

const AGENT_CMDS: Record<Variant, string> = {
  baseline: process.env["OPENCODE_BASELINE_CMD"] ?? "opencode",
  zengram:  process.env["OPENCODE_ZENGRAM_CMD"]  ?? "opencode-zengram",
};

const DEFAULT_MAX_TURNS = Number(process.env["BENCH_MAX_TURNS"] ?? "30");
const DEFAULT_TIMEOUT_MS = Number(process.env["BENCH_TIMEOUT_MS"] ?? String(20 * 60 * 1000));

export async function runAgent(
  task: SweTask,
  variant: Variant,
  runIndex: number,
  repoDir: string,
): Promise<RunResult> {
  const cmd = AGENT_CMDS[variant];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zengram-bench-"));
  const patchFile = path.join(tmpDir, "output.patch");
  const usageFile = path.join(tmpDir, "usage.json");
  const problemFile = path.join(tmpDir, "problem.txt");
  fs.writeFileSync(problemFile, task.problem_statement, "utf8");

  const timestamp = new Date().toISOString();
  const start = Date.now();

  try {
    await execFileAsync(
      cmd,
      [
        "run",
        "--problem-statement", `@${problemFile}`,
        "--repo",             repoDir,
        "--max-turns",        String(DEFAULT_MAX_TURNS),
        "--output-patch",     patchFile,
        "--usage-json",       usageFile,
      ],
      { timeout: DEFAULT_TIMEOUT_MS },
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
          session_id?: string;
        })
      : { turns: 0, prompt_tokens: 0, completion_tokens: 0 };

    return {
      task_id:           task.task_id,
      variant,
      run_index:         runIndex,
      timestamp,
      status:            "completed",
      patch,
      turns:             usage.turns,
      prompt_tokens:     usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      duration_ms,
      ...(usage.session_id ? { session_id: usage.session_id } : {}),
    };
  } catch (err: unknown) {
    const duration_ms = Date.now() - start;
    const isTimeout = err instanceof Error && err.message.includes("ETIMEDOUT");
    return {
      task_id:           task.task_id,
      variant,
      run_index:         runIndex,
      timestamp,
      status:            isTimeout ? "timeout" : "failed",
      patch:             "",
      turns:             0,
      prompt_tokens:     0,
      completion_tokens: 0,
      duration_ms,
      error:             err instanceof Error ? err.message : String(err),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
