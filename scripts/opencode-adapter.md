# OpenCode Adapter Wiring

This directory contains shell adapters that bridge the bench harness's
`--problem-statement / --repo / --max-turns / --output-patch / --usage-json`
interface to OpenCode's actual CLI.

## How OpenCode is invoked

```
opencode run --format json --dir <repo> < problem.txt
```

- `--format json` — emits newline-delimited JSON events to stdout
- `--dir <repo>` — `process.chdir()` to the cloned repo before the session starts
- `< problem.txt` — problem statement piped via stdin (safe for large prompts)
- No `--session` flag — lets OpenCode create a fresh session each run

### Max steps

OpenCode doesn't accept `--max-turns` on the CLI.  Steps are injected via:

```bash
export OPENCODE_CONFIG_CONTENT='{"agent":{"build":{"steps":30}}}'
```

`build` is the default primary agent.  `OPENCODE_CONFIG_CONTENT` is merged
over any file-based config at startup (`Flag.OPENCODE_CONFIG_CONTENT`).

## Token extraction

With `--format json`, each `step_finish` event has:

```json
{
  "type": "step_finish",
  "sessionID": "...",
  "timestamp": 1234567890,
  "part": {
    "type": "step-finish",
    "reason": "stop",
    "cost": 0.012,
    "tokens": {
      "input": 4321,
      "output": 876,
      "reasoning": 0,
      "cache": { "read": 1200, "write": 0 }
    }
  }
}
```

The adapters sum `part.tokens.input` → `prompt_tokens` and
`part.tokens.output` → `completion_tokens` across all `step_finish` events.
The count of `step_finish` events = `turns`.

## Variants

| Variant  | Binary env var          | Storage env var           |
|----------|-------------------------|---------------------------|
| baseline | `OPENCODE_BIN`          | `OPENCODE_STORAGE=sqlite` |
| zengram  | `OPENCODE_ZENGRAM_BIN`  | (default — Zengram on)    |

Both default to `opencode` if the env var is not set, so point them at
different binaries if you have both installed:

```bash
export OPENCODE_BIN=/usr/local/bin/opencode            # vanilla
export OPENCODE_ZENGRAM_BIN=~/opencode/opencode        # fork build
export OPENCODE_BASELINE_CMD=scripts/run-baseline.sh
export OPENCODE_ZENGRAM_CMD=scripts/run-zengram.sh
bench run --variants baseline,zengram --runs 3
```

## Zengram session ID

The `run-zengram.sh` adapter writes an optional `session_id` field to the
usage JSON:

```json
{"turns":12,"prompt_tokens":45678,"completion_tokens":2345,"session_id":"01jq..."}
```

This can be used for offline querying of the Zengram DB
(`~/.local/share/opencode/zeta/`) via `@zengram/node`.
