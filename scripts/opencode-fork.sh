#!/usr/bin/env bash
# Thin wrapper: runs the local OpenCode fork via bun.
# Must be invoked from the fork's package dir so bunfig.toml is found.
# Used as both OPENCODE_BIN and OPENCODE_ZENGRAM_BIN — the adapters
# set OPENCODE_STORAGE=sqlite (baseline) or leave it unset (zengram).
cd /home/gene/opencode/packages/opencode
exec bun run --conditions=browser ./src/index.ts "$@"
