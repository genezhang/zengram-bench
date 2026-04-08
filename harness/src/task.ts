/**
 * Task loading — reads the local task cache written by scorer/setup_tasks.py.
 *
 * Run `python scorer/setup_tasks.py` once before benchmarking to populate
 * the cache at `../tasks/cache/tasks.json`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SweTask } from "./types.js";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const CACHE_PATH = path.join(ROOT, "tasks", "cache", "tasks.json");
const SUBSET_PATH = path.join(ROOT, "tasks", "django_subset.txt");

/** Load the task subset, using the local cache populated by setup_tasks.py. */
export function loadTasks(subsetFile = SUBSET_PATH): SweTask[] {
  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error(
      `Task cache not found at ${CACHE_PATH}.\n` +
      `Run: cd harness/scorer && pip install -r requirements.txt && python setup_tasks.py`
    );
  }

  const allTasks: SweTask[] = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const wantIds = readSubset(subsetFile);
  const taskMap = new Map(allTasks.map((t) => [t.task_id, t]));

  const missing: string[] = [];
  const result: SweTask[] = [];
  for (const id of wantIds) {
    const t = taskMap.get(id);
    if (!t) {
      missing.push(id);
    } else {
      result.push(t);
    }
  }

  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} task IDs not found in cache:\n  ${missing.join("\n  ")}`);
    console.warn(`Re-run setup_tasks.py to refresh the cache.`);
  }

  return result;
}

function readSubset(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
