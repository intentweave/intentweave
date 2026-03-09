#!/bin/bash
# IntentWeave CLI — development wrapper
#
# Runs the CLI via tsx (no build required).
# Usage: ./iw.sh <command> [options]
#
# For production use, install via npm:
#   npx @intentweave/cli <command>
#   npm install -g @intentweave/cli && iw <command>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ENTRY="${SCRIPT_DIR}/packages/cli/src/cli.ts"

if [ ! -f "$CLI_ENTRY" ]; then
  echo "Error: CLI entry point not found at ${CLI_ENTRY}"
  echo "Make sure you're running from the IntentWeave repository root."
  exit 1
fi

# Increase heap for long-running pipeline operations with large files
# caffeinate -i: prevent macOS idle sleep during multi-hour pipeline runs
#   (network drops when the system sleeps are the #1 cause of silent failures)
if [[ "$OSTYPE" == "darwin"* ]]; then
  NODE_OPTIONS="--max-old-space-size=4096" caffeinate -i npx tsx "$CLI_ENTRY" "$@"
else
  NODE_OPTIONS="--max-old-space-size=4096" npx tsx "$CLI_ENTRY" "$@"
fi
