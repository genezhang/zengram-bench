/** A single SWE-bench task, loaded from the local task cache. */
export interface SweTask {
  task_id: string;
  repo: string;         // e.g. "django/django"
  base_commit: string;
  problem_statement: string;
  hints_text: string;
  fail_to_pass: string[];   // tests that must newly pass
  pass_to_pass: string[];   // tests that must continue to pass
  environment_setup_commit: string;
}

/** Which agent variant to run. */
export type Variant = "baseline" | "zengram";

/** One tool invocation captured from the run --format json event stream. */
export interface ToolCallRecord {
  turn: number;                              // step index in which the call ran (1-based)
  tool: string;                              // "read" | "edit" | "bash" | "grep" | ...
  input_summary: string;                     // tool-specific compact summary
  status: "completed" | "error";
  duration_ms: number;
  output_chars: number;                      // size of tool output
  /**
   * Raw structured tool input. Present on trajectories produced by opencode's
   * native --trajectory-json (since opencode#22). Older bench-produced
   * trajectories don't carry this field; consumers should treat it as
   * optional and fall back to `input_summary` when absent.
   */
  input?: Record<string, unknown>;
}

/** Per-file activity within a run; useful for spotting redundant reads. */
export interface FileTouchRecord {
  path: string;
  reads: number;
  edits: number;
}

/** Per-run trajectory of tool calls, the basis for wasted-action analysis. */
export interface Trajectory {
  tool_counts: Record<string, number>;
  files_touched: FileTouchRecord[];
  bash_commands: string[];
  records: ToolCallRecord[];
}

/** Raw output from one agent run against one task. */
export interface RunResult {
  task_id: string;
  variant: Variant;
  run_index: number;    // 0-based, for the 3× repetition
  timestamp: string;    // ISO-8601
  status: "completed" | "failed" | "timeout";
  patch: string;        // unified diff produced by the agent
  turns: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  turns_with_cache_hit: number;
  duration_ms: number;
  error?: string;       // set if status !== "completed"
  session_id?: string;  // Zengram session ID (zengram variant only)
  trajectory?: Trajectory;  // present when adapter supports --trajectory-json
}

/** Scoring result from the Python scorer. */
export interface ScoreResult {
  task_id: string;
  variant: Variant;
  run_index: number;
  resolved: boolean;
  fail_to_pass_passed: string[];
  fail_to_pass_failed: string[];
  pass_to_pass_passed: string[];
  pass_to_pass_failed: string[];
  scorer_error?: string;
  // SHA-256(patch)[:16] of the patch this score reflects. Added by score.py
  // since the patch-hash invalidation fix; legacy score files may lack it
  // and are treated as stale by the analyzer's integrity check.
  patch_hash?: string;
}

/** Aggregated stats for one variant over all tasks and repetitions. */
export interface VariantSummary {
  variant: Variant;
  total_tasks: number;
  resolution_rate: number;           // 0–1
  median_turns_resolved: number;
  median_prompt_tokens_resolved: number;
  median_completion_tokens_resolved: number;
  median_duration_ms_resolved: number;
  per_task: Array<{
    task_id: string;
    resolved_count: number;           // out of num_runs
    mean_turns: number;
    mean_tokens: number;
  }>;
}
