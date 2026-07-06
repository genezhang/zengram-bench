#!/usr/bin/env bash
# Adapter: OpenCode + zengram MEMORY + STRATEGY plugins (both active).
# "both" arm for BENCH_AGENT=opencode.
#
# Thin wrapper over run-zengram.sh: the combined plugin entry
# (integrations/opencode/index.ts) exposes both plugins; ZENGRAM_ARM=both
# leaves both ungated. All run logic is reused from run-zengram.sh.
set -euo pipefail
ADAPTER_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")"
export ZENGRAM_ARM=both
exec "$ADAPTER_DIR/run-zengram.sh" "$@"
