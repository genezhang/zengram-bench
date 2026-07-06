#!/usr/bin/env bash
# Adapter: OpenCode + zengram STRATEGY plugin only (phase guide + gotchas,
# no code-level memory recall). "strategy" arm for BENCH_AGENT=opencode.
#
# Thin wrapper over run-zengram.sh: the combined plugin entry
# (integrations/opencode/index.ts) exposes both plugins and gates each on an
# env var; ZENGRAM_ARM=strategy disables the memory plugin. All run logic
# (config build, model, retries, usage extraction) is reused from run-zengram.sh.
set -euo pipefail
ADAPTER_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
export ZENGRAM_ARM=strategy
exec "$ADAPTER_DIR/run-zengram.sh" "$@"
