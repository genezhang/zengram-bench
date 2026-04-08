# OpenCode Adapter — Wiring the bench harness to your OpenCode fork

The harness invokes agents via a configurable shell command.
Both `opencode` (baseline) and `opencode-zengram` (fork) must accept:

```
<cmd> run \
  --problem-statement @/path/to/problem.txt \
  --repo /path/to/repo \
  --max-turns 30 \
  --output-patch /path/to/output.patch \
  --usage-json /path/to/usage.json
```

Exit code must be 0 on success. The command writes:
- `output.patch` — unified diff of all changes made to the repo
- `usage.json` — `{ "turns": N, "prompt_tokens": N, "completion_tokens": N }`

---

## Option A — Add a `bench` subcommand to OpenCode (recommended)

Add a non-interactive `bench run` subcommand to both OpenCode variants that:
1. Reads the problem statement from the file path after `@`
2. Runs the agent against `--repo` in headless mode
3. On finish, runs `git diff` to write `--output-patch`
4. Writes token usage to `--usage-json`

This is the cleanest approach. The fork already captures turn/token counts
in Zengram — expose them here.

---

## Option B — Wrapper scripts

If you want to keep the OpenCode CLI unchanged, write a thin shell wrapper
that adapts the harness interface to what OpenCode actually supports.

Example `scripts/run-baseline.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Parse harness flags
while [[ $# -gt 0 ]]; do
  case $1 in
    run) shift ;;
    --problem-statement) PROBLEM="$2"; shift 2 ;;
    --repo)              REPO="$2";    shift 2 ;;
    --max-turns)         TURNS="$2";   shift 2 ;;
    --output-patch)      PATCH="$2";   shift 2 ;;
    --usage-json)        USAGE="$2";   shift 2 ;;
    *) shift ;;
  esac
done

# Strip leading @ from problem file path
PROBLEM="${PROBLEM#@}"

# Run vanilla OpenCode in headless mode (adjust flags to match actual CLI)
opencode \
  --no-tui \
  --message "$(cat "$PROBLEM")" \
  --cwd "$REPO" \
  --max-turns "$TURNS"

# Capture the diff
git -C "$REPO" diff HEAD > "$PATCH"

# Write usage (OpenCode may log this to stderr or a file — adapt as needed)
echo '{"turns": 0, "prompt_tokens": 0, "completion_tokens": 0}' > "$USAGE"
```

Set the harness to use this wrapper:
```bash
export OPENCODE_BASELINE_CMD=/path/to/zengram-bench/scripts/run-baseline.sh
export OPENCODE_ZENGRAM_CMD=/path/to/zengram-bench/scripts/run-zengram.sh
```

---

## Option C — Environment variable override per run

The harness reads `OPENCODE_BASELINE_CMD` and `OPENCODE_ZENGRAM_CMD` at
startup, so you can also just point them at any executable that honours
the interface — a Python script, a Docker entrypoint, anything.

---

## Token usage extraction

The `usage.json` file is the main gap. OpenCode itself gets token counts
from the LLM response. For the fork, these are already stored in Zengram's
`turn` table — add an export step at the end of the agent run:

```typescript
// In your fork's bench mode exit handler:
const turns = await db.query(
  'SELECT COUNT(*) as n, SUM(prompt_tokens) as pt, SUM(completion_tokens) as ct FROM turn WHERE session_id = $1',
  [sessionId]
);
fs.writeFileSync(usageJsonPath, JSON.stringify({
  turns: turns[0].n,
  prompt_tokens: turns[0].pt,
  completion_tokens: turns[0].ct,
}));
```
