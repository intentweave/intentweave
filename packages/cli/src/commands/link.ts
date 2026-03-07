/**
 * link command - Generate link proposals for a run
 * 
 * Runs the LX-Core cross-artifact entity linking on a completed run.
 * This is a focused command that only generates link proposals.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  createFileStore,
  convertProfileForAnalyzer,
  type Profile,
} from '@intentweave/analyzer';
// Import from linking directly to get the real implementation
import {
  runLxCore,
  type LxArtifactInput,
  type LxCoreOptions,
} from '@intentweave/analyzer/linking';
import { profileRegistry } from '@intentweave/profiles';
import { IW_DIR, CLI_NAME } from '../constants.js';

/**
 * Find the latest run in the workspace
 */
async function findLatestRun(iwDir: string): Promise<string | null> {
  const runsDir = path.join(iwDir, 'runs');
  try {
    const runs = await fs.readdir(runsDir);
    const validRuns = runs
      .filter(r => r.startsWith('run-'))
      .sort()
      .reverse();
    return validRuns[0] || null;
  } catch {
    return null;
  }
}

/**
 * Load artifact data from a run
 */
async function loadArtifacts(iwDir: string, runId: string): Promise<LxArtifactInput[]> {
  const artifactsDir = path.join(iwDir, 'runs', runId, 'artifacts');
  const artifacts: LxArtifactInput[] = [];
  
  try {
    const artifactDirs = await fs.readdir(artifactsDir);
    
    for (const artifactId of artifactDirs) {
      const artifactDir = path.join(artifactsDir, artifactId);
      const stat = await fs.stat(artifactDir);
      if (!stat.isDirectory()) continue;
      
      // Load PX output
      const pxPath = path.join(artifactDir, 'px.json');
      try {
        const pxData = JSON.parse(await fs.readFile(pxPath, 'utf-8'));
        
        artifacts.push({
          artifactId,
          filePath: pxData.artifact?.filePath || artifactId,
          artifactRole: pxData.artifact?.artifactRole || 'unknown',
          entities: pxData.entities || [],
        });
      } catch {
        // Skip artifacts without PX output
      }
    }
  } catch {
    throw new Error(`No artifacts found in run ${runId}`);
  }
  
  return artifacts;
}

export const linkCommand = new Command('link')
  .description('Generate link proposals for cross-artifact entity linking')
  .option('--run <runId>', 'Run to analyze (default: latest)')
  .option('-p, --profile <name>', 'Profile to use', 'standard')
  .option('--min-confidence <n>', 'Minimum confidence threshold (0-1)', '0.5')
  .option('--matchers <list>', 'Matchers to use: name,alias,structural,profile', 'name,alias,structural,profile')
  .option('-o, --output <path>', 'Output path for proposals')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    try {
    const { 
      run: runIdOpt, 
      profile: profileName, 
      minConfidence,
      matchers,
      output, 
      verbose 
    } = options;
    
    const cwd = process.cwd();
    const iwDir = path.join(cwd, IW_DIR);
    
    // Check for workspace
    try {
      await fs.access(iwDir);
    } catch {
      console.error(chalk.red(`No IntentWeave workspace found in this directory.`));
      console.log(`Run ${chalk.blue(`${CLI_NAME} init`)} to create one.`);
      process.exit(1);
    }
    
    // Find run
    const runId = runIdOpt || await findLatestRun(iwDir);
    if (!runId) {
      console.error(chalk.red('No runs found. Run `iw run` first.'));
      process.exit(1);
    }
    
    // Check run exists
    const runDir = path.join(iwDir, 'runs', runId);
    try {
      await fs.access(runDir);
    } catch {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    }
    
    // Resolve profile
    const registryProfile = profileRegistry.resolve(profileName);
    if (!registryProfile) {
      console.error(chalk.red(`Unknown profile: ${profileName}`));
      console.log('Available profiles:', profileRegistry.list().join(', '));
      process.exit(1);
    }
    const profile = convertProfileForAnalyzer(registryProfile);
    
    if (verbose) {
      console.log(chalk.blue(`Using profile: ${profile.name}`));
    }
    
    console.log(chalk.blue('\nIntentWeave Link Proposal Generator'));
    console.log(chalk.blue('═'.repeat(40)));
    console.log(`Run: ${runId}`);
    console.log(`Profile: ${profile.name}`);
    console.log('');
    
    // Load artifacts
    console.log('Loading artifacts...');
    const artifacts = await loadArtifacts(iwDir, runId);
    
    if (artifacts.length === 0) {
      console.error(chalk.red('No artifacts with PX output found in this run.'));
      process.exit(1);
    }
    
    console.log(`Found ${artifacts.length} artifacts`);
    
    // Count entities
    const totalEntities = artifacts.reduce((sum, a) => sum + a.entities.length, 0);
    console.log(`Total entities: ${totalEntities}`);
    console.log('');
    
    // Parse matcher options
    const matcherList = matchers.split(',').map((m: string) => m.trim());
    
    // Run LX-Core
    console.log(chalk.blue('Generating link proposals...'));
    const startTime = Date.now();
    
    // Load workspace config for keys
    let workspaceKey = 'default';
    try {
      const configPath = path.join(iwDir, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      workspaceKey = config.name || workspaceKey;
    } catch {
      // Use defaults
    }
    
    const lxOptions: LxCoreOptions = {
      workspaceKey,
      runId,
      profile,
      minConfidence: parseFloat(minConfidence),
      enableNameMatching: matcherList.includes('name'),
      enableAliasMatching: matcherList.includes('alias'),
      enableStructuralMatching: matcherList.includes('structural'),
      enableProfileMatching: matcherList.includes('profile'),
    };
    
    const result = await runLxCore(artifacts, lxOptions);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('');
    console.log(chalk.green('✓ Link generation complete'));
    console.log('');
    console.log(chalk.blue('Results:'));
    console.log(`  Proposals generated: ${result.proposals.length}`);
    console.log(`  Duration: ${duration}s`);
    
    if (result.meta) {
      console.log(`  Entities analyzed: ${result.meta.entitiesAnalyzed}`);
    }
    
    // Show top proposals if verbose
    if (verbose && result.proposals.length > 0) {
      console.log('');
      console.log(chalk.blue('Top proposals:'));
      result.proposals.slice(0, 5).forEach((p, i) => {
        console.log(`  ${i + 1}. ${p.sourceCgId} → ${p.targetCgId}`);
        console.log(`     Confidence: ${(p.confidence * 100).toFixed(0)}%`);
        console.log(`     Method: ${p.matchMethod}`);
      });
    }
    
    // Write output
    const outputPath = output || path.join(runDir, 'aggregate', 'lx.proposals.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    
    const outputData = {
      $schema: 'intentweave://schemas/lx-proposals/v1',
      schemaVersion: '0.1',
      runId,
      generatedAt: new Date().toISOString(),
      profile: profile.name,
      proposals: result.proposals,
      meta: result.meta,
    };
    
    await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
    
    console.log('');
    console.log(chalk.green(`Output written to: ${path.relative(cwd, outputPath)}`));
    console.log('');
    console.log('Next steps:');
    console.log(`  ${chalk.blue(`${CLI_NAME} validate --run ${runId}`)} - Validate the run`);
    console.log(`  ${chalk.blue(`${CLI_NAME} aggregate --run ${runId}`)} - Generate run-level summary`);
    } catch (err) {
      console.error(chalk.red(`Link generation failed: ${err instanceof Error ? err.message : String(err)}`));
      if (options.verbose && err instanceof Error && err.stack) {
        console.error(chalk.dim(err.stack));
      }
      process.exit(1);
    }
  });
