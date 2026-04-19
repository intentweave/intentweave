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
import { aggregateCommand } from "./commands/aggregate.js";
import { analyzeCommand } from "./commands/analyze.js";
import { bundleCommand } from "./commands/bundle.js";
import { buildCommand } from "./commands/buildKwg.js";
import { codeCommand } from "./commands/code.js";
import { contextCommand } from "./commands/context.js";
import { docHealthCommand } from "./commands/doc-health.js";
import { driftCommand } from "./commands/drift.js";
import { embedCommand } from "./commands/embed.js";
import { evalCommand } from "./commands/eval.js";
import { evidenceCommand } from "./commands/evidence.js";
import { impactCommand } from "./commands/impact.js";
import { importCommand } from "./commands/import.js";
import { indexCommand } from "./commands/indexBuild.js";
import { initCommand } from "./commands/init.js";
import { linkCommand } from "./commands/link.js";
import { mcpCommand } from "./commands/mcp.js";
import { openCommand } from "./commands/open.js";
import { persistCommand } from "./commands/persist.js";
import { pluginCommand } from "./commands/plugin.js";
import { queryCommand } from "./commands/query.js";
import { reportCommand, explainCommand } from "./commands/report.js";
import { roleCommand } from "./commands/role.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { triageCommand } from "./commands/triage.js";
import { validateCommand } from "./commands/validate.js";
import { vizCommand } from "./commands/viz.js";
import { watchCommand } from "./commands/watch.js";
import { weaveCommand } from "./commands/weave.js";
import { xlinkCommand } from "./commands/xlink.js";
import { CLI_NAME, PRODUCT_NAME } from "./constants.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

program
  .name(CLI_NAME)
  .description(
    `${PRODUCT_NAME} - Semantic code intelligence and knowledge extraction`,
  )
  .version(version);

// Register commands (alphabetical order)
program.addCommand(aggregateCommand);
program.addCommand(analyzeCommand);
program.addCommand(buildCommand);
program.addCommand(bundleCommand);
program.addCommand(codeCommand);
program.addCommand(contextCommand);
program.addCommand(docHealthCommand);
program.addCommand(driftCommand);
program.addCommand(embedCommand);
program.addCommand(evalCommand);
program.addCommand(evidenceCommand);
program.addCommand(explainCommand);
program.addCommand(impactCommand);
program.addCommand(importCommand);
program.addCommand(indexCommand);
program.addCommand(initCommand);
program.addCommand(linkCommand);
program.addCommand(mcpCommand);
program.addCommand(openCommand);
program.addCommand(persistCommand);
program.addCommand(pluginCommand);
program.addCommand(queryCommand);
program.addCommand(reportCommand);
program.addCommand(roleCommand);
program.addCommand(runCommand);
program.addCommand(statusCommand);
program.addCommand(triageCommand);
program.addCommand(validateCommand);
program.addCommand(vizCommand);
program.addCommand(watchCommand);
program.addCommand(weaveCommand);
program.addCommand(xlinkCommand);

// ─── Plugin discovery ────────────────────────────────────────────────────────
// Auto-discover installed @intentweave/plugin-* packages and register their
// CLI commands. Failures are silently ignored — missing plugins are normal.
const registry = getPluginRegistry();
await registry.discover((pkg) => import(pkg));
registry.registerAllCommands(program, {
  workspaceRoot: process.cwd(),
  indexDbPath: `${process.cwd()}/.iw/index.db`,
  session: process.env.IW_SESSION ?? "default",
  verbose: process.argv.includes("-v") || process.argv.includes("--verbose"),
});

// Parse and execute
program.parse();
