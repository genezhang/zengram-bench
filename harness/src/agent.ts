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
import { fileURLToPath } from "node:url";
import type { RunResult, SweTask, Trajectory, Variant } from "./types.js";

// Run a child to completion, killing its entire process group on timeout.
// `execFile`'s built-in timeout sends SIGTERM only to the immediate child,
// which leaves grandchildren orphaned when the adapter is bash → exec bun
// (a round 9 task wedged for hours past the configured timeout this way).
// Putting the child in its own process group via `detached: true` and
// SIGKILL'ing the negative PID reaps every descendant regardless of how
// the wrapper handles signals. The promise rejects with `Error("ETIMEDOUT")`
// so the existing catch block in runAgent classifies the run as a timeout.
//
// POSIX-only: `process.kill(-pid, ...)` is not supported on Windows. The
// bench is Linux-only by design (llama.cpp / opencode-fork adapter chain),
// but if that ever changes the negative-PID call will throw and we fall
// back to a best-effort direct kill of the immediate child.
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
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    // Poll against an *awake-time* deadline. Earlier rounds (10→15) iterated
    // through: setTimeout (silently missed fires) → Date.now() polling
    // (suspend counted against budget) → performance.now() polling (turns
    // out CLOCK_MONOTONIC on Linux ALSO advances during suspend, contrary
    // to my round-15 comment — 2026-05-16 ablation diag confirmed this when
    // a 56-min suspend ate a 30-min cell budget while only 5 min of useful
    // work had happened).
    //
    // Suspend-resilient algorithm: maintain an `elapsed` accumulator. On
    // each tick, advance elapsed by at most ~1.5× tickMs — any larger gap
    // (which only happens on suspend) is clamped, so the post-resume jump
    // doesn't drain the budget. systemd-inhibit at the launcher level
    // SHOULD prevent suspends in the first place, but this is defense in
    // depth for desktop-env triggered suspends that slip past the inhibit.
    let elapsed = 0;
    let lastTick = performance.now();
    const tickMs = Math.min(30_000, opts.timeoutMs);
    const maxCreditPerTick = tickMs * 1.5;
    const timer = setInterval(() => {
      const now = performance.now();
      elapsed += Math.min(now - lastTick, maxCreditPerTick);
      lastTick = now;
      if (elapsed < opts.timeoutMs) return;
      clearInterval(timer);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Negative-PID kill failed (e.g. Windows, or the group is already
        // gone). Best-effort fallback to the immediate child — descendants
        // may survive but at least the wrapper dies and the harness moves on.
        try { child.kill("SIGKILL"); } catch {}
      }
      // Reject immediately rather than waiting for `exit`. If the SIGKILL
      // doesn't take (unkillable state, permission error, non-POSIX platform
      // where negative-PID isn't supported), waiting on `exit` would
      // resurrect the wedge pathology this fix exists to prevent.
      settle(() => reject(new Error("ETIMEDOUT")));
    }, tickMs);
    child.once("exit", (code, signal) => {
      clearInterval(timer);
      settle(() => {
        if (signal)     return reject(new Error(`killed by ${signal}`));
        if (code !== 0) return reject(new Error(`exited with code ${code}`));
        resolve();
      });
    });
    child.once("error", (err) => {
      clearInterval(timer);
      settle(() => reject(err));
    });
  });
}

/**
 * Re-derive usage stats from the raw opencode --format json event stream.
 * Same fields the adapter's post-run python computes, written here in TS so
 * the harness can fall back to it on SIGKILL'd timeouts where the python
 * never ran. Tolerant of a truncated tail line (the kill can land mid-write).
 */
function recoverFromEvents(file: string): {
  turns: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  turns_with_cache_hit: number;
  session_id?: string;
} {
  const empty = {
    turns: 0, prompt_tokens: 0, completion_tokens: 0,
    cache_read_tokens: 0, turns_with_cache_hit: 0,
  };
  if (!fs.existsSync(file)) return empty;
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return empty; }
  let turns = 0, prompt = 0, completion = 0, cacheRead = 0, cacheHits = 0;
  let sessionId: string | undefined;
  // Pi emits `turn_end` once per complete turn with usage on message.usage.
  // Counting these gives real turn data even from SIGKILL'd runs — the last
  // complete turn before the kill is on disk; in-progress turns are absent.
  // OpenCode emits `step_finish` instead — fall through to that if no
  // turn_end events are found (heterogeneous result dirs).
  let hasTurnEnd = false;
  type Evt = {
    type?: string;
    id?: string; sessionID?: string;
    // Pi turn_end
    message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } };
    // OpenCode step_finish
    part?: { tokens?: { input?: number; output?: number; cache?: { read?: number } } };
  };
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: Evt;
    try { evt = JSON.parse(trimmed); } catch { continue; } // tail truncation OK
    if (!sessionId) sessionId = evt.id ?? evt.sessionID;
    if (evt.type !== "turn_end") continue;
    hasTurnEnd = true;
    turns++;
    const u = evt.message?.usage ?? {};
    prompt     += u.input     ?? 0;
    completion += u.output    ?? 0;
    const cr    = u.cacheRead ?? 0;
    cacheRead  += cr;
    if (cr > 0) cacheHits++;
  }
  if (!hasTurnEnd) {
    // OpenCode / legacy format: step_finish per turn.
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt: Evt;
      try { evt = JSON.parse(trimmed); } catch { continue; }
      if (!sessionId) sessionId = evt.id ?? evt.sessionID;
      if (evt.type !== "step_finish") continue;
      turns++;
      const tok = evt.part?.tokens ?? {};
      prompt     += tok.input  ?? 0;
      completion += tok.output ?? 0;
      const cr    = tok.cache?.read ?? 0;
      cacheRead  += cr;
      if (cr > 0) cacheHits++;
    }
  }
  return {
    turns,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cache_read_tokens: cacheRead,
    turns_with_cache_hit: cacheHits,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

// Which agent to bench: "opencode" (default) or "pi". The harness is
// agent-agnostic — each adapter implements the same flag contract — so we run
// it once per agent (into separate result dirs) and compare the
// baseline→zengram delta across agents. Defaults resolve to the sibling
// adapter scripts; the *_CMD envs override.
const AGENT = (process.env["BENCH_AGENT"] ?? "opencode").toLowerCase();
const SCRIPTS_DIR =
  process.env["BENCH_SCRIPTS_DIR"] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");
const AGENT_CMDS: Record<Variant, string> =
  AGENT === "pi"
    ? {
        baseline: process.env["PI_BASELINE_CMD"]  ?? path.join(SCRIPTS_DIR, "run-pi-baseline.sh"),
        zengram:  process.env["PI_ZENGRAM_CMD"]   ?? path.join(SCRIPTS_DIR, "run-pi-zengram.sh"),
        strategy: process.env["PI_STRATEGY_CMD"]  ?? path.join(SCRIPTS_DIR, "run-pi-strategy.sh"),
        both:     process.env["PI_BOTH_CMD"]      ?? path.join(SCRIPTS_DIR, "run-pi-both.sh"),
      }
    : {
        baseline: process.env["OPENCODE_BASELINE_CMD"] ?? path.join(SCRIPTS_DIR, "run-baseline.sh"),
        zengram:  process.env["OPENCODE_ZENGRAM_CMD"]  ?? path.join(SCRIPTS_DIR, "run-zengram.sh"),
        // strategy/both load the combined plugin entry (integrations/opencode/
        // index.ts) with ZENGRAM_ARM gating; run-zengram.sh = memory-only arm.
        strategy: process.env["OPENCODE_STRATEGY_CMD"] ?? path.join(SCRIPTS_DIR, "run-strategy.sh"),
        both:     process.env["OPENCODE_BOTH_CMD"]     ?? path.join(SCRIPTS_DIR, "run-both.sh"),
      };

// 250: most SWE tasks need well above the old 30 cap to resolve; a low cap
// truncated long solves into failures for BOTH arms and flattened the
// zengram-vs-vanilla delta. We deliberately let the model explore many paths
// rather than capping it. COUPLED KNOB: BENCH_TIMEOUT_MS is raised to 60 min to
// match — a high turn cap at the old 20 min/task just traded turn-truncation for
// wall-clock-truncation. Both env-overridable; tune once the box's tokens/sec is
// known (a wander turn on the local model is ~5s, so 250 turns ≈ 20+ min).
const DEFAULT_MAX_TURNS = Number(process.env["BENCH_MAX_TURNS"] ?? "250");
const DEFAULT_TIMEOUT_MS = Number(process.env["BENCH_TIMEOUT_MS"] ?? String(60 * 60 * 1000));

// Gate `--trajectory-json` on OPENCODE_HAS_TRAJECTORY_JSON=1.
// The flag was added by the old zengram fork and adopted by adapters in PR #8;
// vanilla upstream OpenCode (and the v2 fork rebuilt directly off upstream/dev)
// does not recognise it. When the flag is missing, opencode prints CLI help and
// exits, producing zero step_finish events — which the harness then re-tries
// after a 90 s sleep before giving up. Default OFF so a fresh setup runs against
// upstream cleanly; export `1` once the trajectory feature lands in the fork.
const HAS_TRAJECTORY_JSON = process.env["OPENCODE_HAS_TRAJECTORY_JSON"] === "1";

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
  // Pin the adapter's events file inside tmpDir (instead of letting the
  // adapter mktemp /tmp/opencode-*-events-XXX.jsonl). Reasons:
  //   1. On SIGKILL'd timeout, the adapter's post-run python that writes
  //      usage.json never executes — usage_file ends up missing and the
  //      harness recorded "0 turns" for a session that actually ran 29/30
  //      turns (2026-05-15 incident, django-15022 / django-11141).
  //   2. With the events file in tmpDir we can fall back to parsing it
  //      directly on timeout, recovering real turn/token counts.
  //   3. tmpDir is rm'd in `finally` so no leftover litter in /tmp.
  const eventsFile = path.join(tmpDir, "events.jsonl");
  // Optional SWE-bench preamble — frames the task as "produce a patch" rather
  // than a Q&A. Strong frontier models infer this from the system prompt;
  // smaller open models (e.g. Qwen3-Coder-30B-A3B) often need it explicit.
  // Toggle with BENCH_PREAMBLE=1 to keep prior baselines untouched.
  // Memory guidance — only meaningful for the zengram arm, whose memory layer
  // (the OpenCode plugin / Pi extension) surfaces prior-session lessons via a
  // pinned "## Project memory (durable lessons & facts)" block in the system
  // prompt and a `recall_memory` tool. (The old intrinsic <zengram-previously-
  // helpful> tag no longer exists under the plugin/extension architecture.)
  const memoryRules = (variant === "zengram" || variant === "both")
    ? `7. You may see a "## Project memory (durable lessons & facts)" section in your system prompt, and you have a recall_memory tool. These carry lessons from PRIOR sessions on similar tasks — treat them as HINTS, not proof. If a hint names the likely file and change, use it as a shortcut: read that file ONCE for context, then call edit/write with the equivalent change. Do not re-discover the fix from scratch.
8. CRITICAL: prior-session edits DO NOT exist in this checkout — every session starts from an unmodified clean checkout. A memory hint is never evidence the file is already fixed; you MUST still call edit/write yourself this session. Ending without an edit/write tool call is a failure regardless of what memory shows.
`
    : "";
  const preamble = process.env["BENCH_PREAMBLE"] === "1"
    ? `You are a software engineer working inside the project's own source-code checkout. The current working directory IS the project repository — for example, if the bug is in Django's migrations system, the file you need to edit is something like ./django/db/migrations/autodetector.py, not a new file you create.

Rules:
1. The bug is in EXISTING source files. Find the relevant tracked file with grep/glob/read tools, then edit it in place with the edit tool.
2. Do NOT create new files. Do NOT scaffold a sample project (no manage.py, no settings.py, no testapp/, no reproduction harness). The repository at cwd already contains the buggy code.
3. Do NOT modify any file under tests/ or *_test.py — only edit production source.
4. Do NOT explain the behavior in prose; the user wants a fix, not an explanation.
5. You MUST call the edit (or write) tool to actually modify the file. Reading the file, globbing, or seeing a memory hint is NOT making an edit — only an edit/write tool call counts.
6. Stop IMMEDIATELY after the edit/write tool call succeeds. Do not run 'git diff' to verify, do not re-read the file, do not run tests, do not explain what you did. The bench harness verifies the patch externally — your job ends the moment the edit lands.
${memoryRules}9. KNOW WHEN TO QUIT. If after ~8 turns of exploration you cannot identify a concrete file and a concrete edit to make, write one short message saying "I cannot determine a fix for this issue" and stop. Spending dozens of turns reading and grepping without ever editing is strictly worse than admitting defeat early — it wastes tokens and produces the same null result. Failing fast is success when the alternative is failing slow.

---

`
    : "";
  fs.writeFileSync(problemFile, preamble + task.problem_statement, "utf8");

  const timestamp = new Date().toISOString();
  const start = Date.now();

  const childEnv = {
    ...process.env,
    // Adapter scripts honour this and emit opencode --format json into the
    // path we picked instead of an mktemp'd /tmp file — see eventsFile above.
    OPENCODE_EVENTS_FILE: eventsFile,
    // Expose fail_to_pass test IDs to the test-runner extension loaded inside
    // pi. The extension no-ops when this is absent so it's safe for all arms.
    BENCH_FAIL_TO_PASS: JSON.stringify(task.fail_to_pass),
    ...(agentOpts.pinnedDataDir
      ? { OPENCODE_PINNED_DATA_DIR: agentOpts.pinnedDataDir }
      : {}),
  };

  try {
    const args = [
      "run",
      "--problem-statement", `@${problemFile}`,
      "--repo",             repoDir,
      "--max-turns",        String(DEFAULT_MAX_TURNS),
      "--output-patch",     patchFile,
      "--usage-json",       usageFile,
    ];
    if (HAS_TRAJECTORY_JSON) {
      args.push("--trajectory-json", trajFile);
    }
    await runWithTimeout(
      cmd,
      args,
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
          model?: string;
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
      // Record the model the run was asked to use. Empty string means
      // OPENCODE_BENCH_MODEL was unset and opencode auto-picked from its
      // recent-model cache — that silently drifted to opencode/qwen3.6-plus-free
      // on 2026-05-15. Always carry this through to results/runs/ so we can
      // grep across past runs without relying on the per-startup dev.log.
      model: usage.model ?? "",
      ...(usage.session_id ? { session_id: usage.session_id } : {}),
      ...(trajectory ? { trajectory } : {}),
    };
  } catch (err: unknown) {
    const duration_ms = Date.now() - start;
    const isTimeout = err instanceof Error && err.message.includes("ETIMEDOUT");
    // SIGKILL recovery: when the watchdog kills the adapter, the post-run
    // python that writes usage.json never executes, so usage_file is missing
    // and the harness used to report "0 turns 0 tok" even for a session that
    // had 29/30 step_finish events on disk (2026-05-15 incident). Parse the
    // raw events file ourselves to recover real counts. Best-effort: a
    // truncated last line from the SIGKILL is tolerated.
    const recovered = recoverFromEvents(eventsFile);
    // Patch may also be partial — capture whatever the adapter wrote before
    // the kill. Empty string is still the right answer if nothing landed.
    const partialPatch = fs.existsSync(patchFile)
      ? fs.readFileSync(patchFile, "utf8")
      : "";
    return {
      task_id:              task.task_id,
      variant,
      run_index:            runIndex,
      timestamp,
      status:               isTimeout ? "timeout" : "failed",
      patch:                partialPatch,
      turns:                recovered.turns,
      prompt_tokens:        recovered.prompt_tokens,
      completion_tokens:    recovered.completion_tokens,
      cache_read_tokens:    recovered.cache_read_tokens,
      turns_with_cache_hit: recovered.turns_with_cache_hit,
      duration_ms,
      error:                err instanceof Error ? err.message : String(err),
      // Record the model that was requested even on failure — helps tell
      // "ai1 stalled on this task" from "wrong-model auto-pick".
      model:                process.env["OPENCODE_BENCH_MODEL"] ?? "",
      ...(recovered.session_id ? { session_id: recovered.session_id } : {}),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
