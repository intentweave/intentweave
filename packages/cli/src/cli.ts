#!/usr/bin/env node
// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * IntentWeave CLI
 *
 * Command-line interface for knowledge graph extraction and analysis.
 */

// ─── Crash guards ────────────────────────────────────────────────────────────
// Catch and report any unhandled errors so the process never dies silently.
process.on("uncaughtException", (err) => {
  console.error("\n[iw] Fatal: uncaught exception —", err);
  process.exitCode = 1;
});
process.on("unhandledRejection", (reason) => {
  console.error("\n[iw] Fatal: unhandled promise rejection —", reason);
  process.exitCode = 1;
});

// ─── SIGPIPE handling ────────────────────────────────────────────────────────
// When piped to `head`, `grep`, etc. the downstream process may close its stdin
// before we finish writing.  Node does NOT raise SIGPIPE by default — instead
// stdout emits an EPIPE error.  Swallow it and exit cleanly.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

import { Command } from "commander";
import { createRequire } from "node:module";
import { getPluginRegistry } from "@intentweave/core";
import { claimsCommand } from "./commands/claims.js";
import { docHealthCommand } from "./commands/doc-health.js";
import { driftCommand } from "./commands/drift.js";
import { hookCommand } from "./commands/hook.js";
import { indexCommand } from "./commands/indexBuild.js";
import { initCommand } from "./commands/init.js";
import { intentCommand } from "./commands/intent.js";
import { mcpCommand } from "./commands/mcp.js";
import { pluginCommand } from "./commands/plugin.js";
import { reportCommand, explainCommand } from "./commands/report.js";
import { statusCommand } from "./commands/status.js";
import { verifyCommand } from "./commands/verify.js";
import { CLI_NAME, PRODUCT_NAME } from "./constants.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// ─── iw intent argv translation ──────────────────────────────────────────────
// Translate `iw intent <sub>` to its canonical subcommand before Commander
// parses. Zero code duplication — all option/help handling falls through to the
// original subcommand implementation.
(function translateIntentArgs(): void {
  const intentMap: Record<string, string[]> = {
    check: ["index", "rules-check"],
    extract: ["index", "rules-extract"],
    scan: ["index", "scan-diagrams"],
    living: ["doc-health"],
    score: ["verify", "--score"],
  };

  const [node, bin, cmd, sub, ...rest] = process.argv;

  if (cmd === "intent" && sub && intentMap[sub]) {
    // iw intent check [--domain X] [...] → iw index rules-check [--domain X] [...]
    process.argv = [node, bin, ...intentMap[sub], ...rest];
    return;
  }
})();

const program = new Command();

program
  .name(CLI_NAME)
  .description(
    `${PRODUCT_NAME} - Semantic code intelligence and knowledge extraction`,
  )
  .version(version);

// Register commands (alphabetical order)
program.addCommand(claimsCommand);
program.addCommand(docHealthCommand);
program.addCommand(driftCommand);
program.addCommand(explainCommand);
program.addCommand(hookCommand);
program.addCommand(indexCommand);
program.addCommand(initCommand);
program.addCommand(intentCommand);
program.addCommand(mcpCommand);
program.addCommand(pluginCommand);
program.addCommand(reportCommand);
program.addCommand(statusCommand);
program.addCommand(verifyCommand);

// ─── Plugin discovery ────────────────────────────────────────────────────────
// Auto-discover installed @intentweave/plugin-* packages and register their
// CLI commands. Failures are silently ignored — missing plugins are normal.
const registry = getPluginRegistry();
await registry.discover((pkg) => import(pkg));
const pluginContext = {
  workspaceRoot: process.cwd(),
  indexDbPath: `${process.cwd()}/.iw/index.db`,
  session: process.env.IW_SESSION ?? "default",
  verbose: process.argv.includes("-v") || process.argv.includes("--verbose"),
};
registry.resolveCapabilities(pluginContext);
registry.registerAllCommands(program, pluginContext);

// Parse and execute
program.parse();
