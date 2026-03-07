// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * status command - Show workspace status
 */

import { Command } from 'commander';
import { validateWorkspaceConfig } from '@intentweave/core';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IW_DIR, CLI_NAME } from '../constants.js';

export const statusCommand = new Command('status')
  .description('Show workspace status')
  .argument('[directory]', 'Workspace directory', '.')
  .option('--json', 'Output as JSON')
  .action(async (directory: string, options) => {
    const { json } = options;
    
    const absoluteDir = path.resolve(directory);
    const configPath = path.join(absoluteDir, IW_DIR, 'config.json');
    
    let config: Record<string, unknown> | null = null;
    
    try {
      const configContent = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(configContent);
    } catch {
      if (json) {
        console.log(JSON.stringify({ initialized: false, error: 'No workspace found' }));
      } else {
        console.log(chalk.yellow('No IntentWeave workspace found in this directory.'));
        console.log(`Run ${chalk.blue(`${CLI_NAME} init`)} to create one.`);
      }
      return;
    }
    
    if (!validateWorkspaceConfig(config)) {
      if (json) {
        console.log(JSON.stringify({ initialized: false, error: 'Invalid configuration' }));
      } else {
        console.error(chalk.red('Invalid workspace configuration'));
      }
      return;
    }
    
    // Count staged files
    const stagingDir = path.join(absoluteDir, IW_DIR, 'staging');
    let stagedCount = 0;
    try {
      const stagedFiles = await fs.readdir(stagingDir);
      stagedCount = stagedFiles.length;
    } catch {
      // Staging directory doesn't exist
    }
    
    // Count runs
    const runsDir = path.join(absoluteDir, IW_DIR, 'runs');
    let runsCount = 0;
    try {
      const runs = await fs.readdir(runsDir);
      runsCount = runs.length;
    } catch {
      // Runs directory doesn't exist
    }
    
    const status = {
      initialized: true,
      workspaceId: config.id,
      workspaceName: config.name,
      rootPath: config.rootPath,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      stagedFiles: stagedCount,
      totalRuns: runsCount,
    };
    
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(chalk.green('IntentWeave Workspace Status'));
      console.log('');
      console.log(`  ID:           ${status.workspaceId}`);
      console.log(`  Name:         ${status.workspaceName}`);
      console.log(`  Root:         ${status.rootPath}`);
      console.log(`  Created:      ${status.createdAt}`);
      console.log(`  Updated:      ${status.updatedAt}`);
      console.log('');
      console.log(`  Staged files: ${status.stagedFiles}`);
      console.log(`  Total runs:   ${status.totalRuns}`);
    }
  });
