// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw mcp — Start the IntentWeave MCP server (stdio transport).
 *
 * Usage:
 *   iw mcp --session planpling
 *   iw mcp --session planpling --verbose
 */

import { Command } from "commander";
import chalk from "chalk";

export const mcpCommand = new Command("mcp")
  .description(
    "Start the MCP server (stdio transport) for knowledge graph tools",
  )
  .requiredOption("-s, --session <id>", "Session ID to scope all queries")
  .option("-v, --verbose", "Log activity to stderr")
  .action(async (options) => {
    const { session: sessionId, verbose } = options;

    try {
      // Dynamic import to avoid loading MCP SDK unless needed
      const { startMcpServer } = await import("../mcp/server.js");

      await startMcpServer({
        sessionId,
        verbose,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Write to stderr since stdout is the MCP transport
      process.stderr.write(chalk.red(`MCP server failed: ${message}\n`));
      if (verbose && err instanceof Error && err.stack) {
        process.stderr.write(chalk.dim(err.stack + "\n"));
      }
      process.exit(1);
    }
  });
