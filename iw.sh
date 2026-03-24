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

# Resolve tsx binary — caffeinate spawns a child sh that may lack PATH entries
# from version managers (nvm/fnm/volta), so we resolve the path up-front.
TSX_BIN="$(command -v tsx 2>/dev/null)"
[ -z "$TSX_BIN" ] && TSX_BIN="${SCRIPT_DIR}/node_modules/.bin/tsx"
[ ! -x "$TSX_BIN" ] && TSX_BIN="${SCRIPT_DIR}/node_modules/.pnpm/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "Error: tsx not found. Run 'pnpm add -Dw tsx' first."
  exit 1
fi

if [[ "$OSTYPE" == "darwin"* ]]; then
  NODE_OPTIONS="--max-old-space-size=4096" caffeinate -i "$TSX_BIN" "$CLI_ENTRY" "$@"
else
  NODE_OPTIONS="--max-old-space-size=4096" "$TSX_BIN" "$CLI_ENTRY" "$@"
fi
