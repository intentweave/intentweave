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
import { intentCommand } from "./commands/intent.js";
import { driftCommand } from "./commands/drift.js";
import { embedCommand } from "./commands/embed.js";
import { evalCommand } from "./commands/eval.js";
import { evidenceCommand } from "./commands/evidence.js";
import { hookCommand } from "./commands/hook.js";
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
import { verifyCommand } from "./commands/verify.js";
import { vizCommand } from "./commands/viz.js";
import { watchCommand } from "./commands/watch.js";
import { weaveCommand } from "./commands/weave.js";
import { xlinkCommand } from "./commands/xlink.js";
import { CLI_NAME, PRODUCT_NAME } from "./constants.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// ─── Phase 0: iw intent / iw living argv translation ─────────────────────────
// Translate `iw intent <sub>` to its canonical command before Commander parses.
// This is the Phase 0 alias layer — zero code duplication, all option/help
// handling falls through to the original subcommand implementation.
// Phase 1 will promote these to first-class subcommands under iw intent.
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

  if (cmd === "living") {
    if (sub === "verify") {
      // iw living verify [...] → iw index rules-check --domain documentary [...]
      process.argv = [
        node,
        bin,
        "index",
        "rules-check",
        "--domain",
        "documentary",
        ...rest,
      ];
      return;
    }
    // iw living [...] → iw doc-health [...]
    process.argv = [node, bin, "doc-health", sub ?? "", ...rest].filter(
      Boolean,
    );
    return;
  }

  if (cmd === "guardrails" && sub && intentMap[sub]) {
    // iw guardrails check [...] → iw index rules-check [...]
    process.argv = [node, bin, ...intentMap[sub], ...rest];
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
program.addCommand(aggregateCommand);
program.addCommand(analyzeCommand);
program.addCommand(buildCommand);
program.addCommand(bundleCommand);
program.addCommand(codeCommand);
program.addCommand(contextCommand);
program.addCommand(docHealthCommand);
program.addCommand(driftCommand);
program.addCommand(intentCommand);
program.addCommand(embedCommand);
program.addCommand(evalCommand);
program.addCommand(evidenceCommand);
program.addCommand(explainCommand);
program.addCommand(hookCommand);
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
program.addCommand(verifyCommand);
program.addCommand(vizCommand);
program.addCommand(watchCommand);
program.addCommand(weaveCommand);
program.addCommand(xlinkCommand);

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
