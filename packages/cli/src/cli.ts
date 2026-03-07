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
process.on('uncaughtException', (err) => {
  console.error('\n[iw] Fatal: uncaught exception —', err);
  process.exitCode = 1;
});
process.on('unhandledRejection', (reason) => {
  console.error('\n[iw] Fatal: unhandled promise rejection —', reason);
  process.exitCode = 1;
});

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { aggregateCommand } from './commands/aggregate.js';
import { analyzeCommand } from './commands/analyze.js';
import { bundleCommand } from './commands/bundle.js';
import { codeCommand } from './commands/code.js';
import { contextCommand } from './commands/context.js';
import { docHealthCommand } from './commands/doc-health.js';
import { evalCommand } from './commands/eval.js';
import { impactCommand } from './commands/impact.js';
import { importCommand } from './commands/import.js';
import { initCommand } from './commands/init.js';
import { linkCommand } from './commands/link.js';
import { mcpCommand } from './commands/mcp.js';
import { openCommand } from './commands/open.js';
import { persistCommand } from './commands/persist.js';
import { queryCommand } from './commands/query.js';
import { reportCommand, explainCommand } from './commands/report.js';
import { roleCommand } from './commands/role.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { validateCommand } from './commands/validate.js';
import { vizCommand } from './commands/viz.js';
import { watchCommand } from './commands/watch.js';
import { weaveCommand } from './commands/weave.js';
import { xlinkCommand } from './commands/xlink.js';
import { CLI_NAME, PRODUCT_NAME } from './constants.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const program = new Command();

program
  .name(CLI_NAME)
  .description(`${PRODUCT_NAME} - Semantic code intelligence and knowledge extraction`)
  .version(version);

// Register commands (alphabetical order)
program.addCommand(aggregateCommand);
program.addCommand(analyzeCommand);
program.addCommand(bundleCommand);
program.addCommand(codeCommand);
program.addCommand(contextCommand);
program.addCommand(docHealthCommand);
program.addCommand(evalCommand);
program.addCommand(explainCommand);
program.addCommand(impactCommand);
program.addCommand(importCommand);
program.addCommand(initCommand);
program.addCommand(linkCommand);
program.addCommand(mcpCommand);
program.addCommand(openCommand);
program.addCommand(persistCommand);
program.addCommand(queryCommand);
program.addCommand(reportCommand);
program.addCommand(roleCommand);
program.addCommand(runCommand);
program.addCommand(statusCommand);
program.addCommand(validateCommand);
program.addCommand(vizCommand);
program.addCommand(watchCommand);
program.addCommand(weaveCommand);
program.addCommand(xlinkCommand);

// Parse and execute
program.parse();
