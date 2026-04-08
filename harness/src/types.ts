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
  duration_ms: number;
  error?: string;       // set if status !== "completed"
  session_id?: string;  // Zengram session ID (zengram variant only)
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
