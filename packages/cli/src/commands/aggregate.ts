/**
 * aggregate command - Run-level rollup of linking, coverage, and validation
 * 
 * This is the convenience wrapper that runs all aggregation steps:
 * - Link proposals (LX)
 * - Coverage report
 * - Validation findings
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ArtifactRole, LinkProposal, Entity, Statement } from '@intentweave/core';
import {
  runLxCore,
  generateCoverageReport,
  type LxArtifactInput,
  type LxCoreOptions,
  type CoverageReportInput,
  type CoverageReportOptions,
} from '@intentweave/analyzer/linking';
import {
  runValidation,
  type ValidationInput,
} from '@intentweave/analyzer/validation';
import { convertProfileForAnalyzer, type Profile } from '@intentweave/analyzer';
import { profileRegistry, loadProfilePack, type ProfilePack } from '@intentweave/profiles';
import { IW_DIR, CLI_NAME } from '../constants.js';
import { fileURLToPath } from 'node:url';

// Get the directory containing this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
 * Load all data needed for aggregation from a run
 */
async function loadRunData(iwDir: string, runId: string): Promise<{
  artifacts: Array<{ artifactId: string; artifactRole: ArtifactRole; filePath: string }>;
  lxArtifacts: LxArtifactInput[];
  entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }>;
  statements: Array<Statement & { artifactId: string; artifactRole: ArtifactRole }>;
}> {
  const artifacts: Array<{ artifactId: string; artifactRole: ArtifactRole; filePath: string }> = [];
  const lxArtifacts: LxArtifactInput[] = [];
  const entities: Array<Entity & { artifactId: string; artifactRole: ArtifactRole }> = [];
  const statements: Array<Statement & { artifactId: string; artifactRole: ArtifactRole }> = [];
  
  const artifactsDir = path.join(iwDir, 'runs', runId, 'artifacts');
  
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
        const artifactRole = (pxData.artifact?.artifactRole || 'code') as ArtifactRole;
        const filePath = pxData.artifact?.filePath || artifactId;
        
        artifacts.push({ artifactId, artifactRole, filePath });
        
        // Build LX input
        lxArtifacts.push({
          artifactId,
          filePath,
          artifactRole,
          entities: pxData.entities || [],
        });
        
        // Add entities with artifact metadata
        for (const entity of pxData.entities || []) {
          entities.push({
            ...entity,
            artifactId,
            artifactRole,
          });
        }
        
        // Add statements with artifact metadata
        for (const statement of pxData.statements || []) {
          statements.push({
            ...statement,
            artifactId,
            artifactRole,
          });
        }
      } catch {
        // Skip artifacts without PX output
      }
    }
  } catch {
    throw new Error(`No artifacts found in run ${runId}`);
  }
  
  return { artifacts, lxArtifacts, entities, statements };
}

export const aggregateCommand = new Command('aggregate')
  .description('Run-level rollup: linking, coverage, and validation')
  .option('--run <runId>', 'Run to aggregate (default: latest)')
  .option('-p, --profile <name>', 'Profile to use', 'standard')
  .option('--all', 'Run all steps including linking (default: coverage + validation only)')
  .option('--skip-link', 'Skip link proposal generation')
  .option('--skip-coverage', 'Skip coverage report')
  .option('--skip-validate', 'Skip validation')
  .option('-o, --output <dir>', 'Output directory override')
  .option('-v, --verbose', 'Verbose output')
  .action(async (options) => {
    const { 
      run: runIdOpt, 
      profile: profileName, 
      all,
      skipLink,
      skipCoverage,
      skipValidate,
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
    
    // Load profile pack from starter/v1 directory
    // The packs are in packages/profiles/packs/starter/v1
    let profilePack: ProfilePack;
    try {
      // Resolve path relative to the CLI package
      const packPath = path.resolve(__dirname, '../../../profiles/packs/starter/v1');
      profilePack = await loadProfilePack(packPath);
      if (verbose) {
        console.log(chalk.dim(`Loaded profile pack from ${packPath}`));
        console.log(chalk.dim(`  Rules: ${profilePack.rules.length}`));
      }
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Could not load profile pack, using minimal defaults`));
      // Fallback to minimal pack
      profilePack = {
        meta: { name: 'default', version: '1.0.0' },
        kinds: [],
        shapes: [],
        rules: [],
        linkingRules: [],
        packPath: '<built-in>',
      };
    }
    
    console.log(chalk.blue('\nIntentWeave Aggregation'));
    console.log(chalk.blue('═'.repeat(40)));
    console.log(`Run: ${runId}`);
    console.log(`Profile: ${profile.name}`);
    console.log('');
    
    // Load run data
    console.log('Loading run data...');
    const { artifacts, lxArtifacts, entities, statements } = await loadRunData(iwDir, runId);
    
    console.log(`Found ${artifacts.length} artifacts, ${entities.length} entities`);
    console.log('');
    
    const outputDir = output || path.join(runDir, 'aggregate');
    await fs.mkdir(outputDir, { recursive: true });
    
    // Load workspace config for keys
    let workspaceKey = 'default';
    try {
      const configPath = path.join(iwDir, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      workspaceKey = config.name || workspaceKey;
    } catch {
      // Use defaults
    }
    
    const startTime = Date.now();
    let linkProposals: LinkProposal[] = [];
    
    // Step 1: Link Proposals (if --all or not skipped and no existing proposals)
    const lxPath = path.join(outputDir, 'lx.proposals.json');
    const runLink = all || (!skipLink && !(await fs.access(lxPath).then(() => true).catch(() => false)));
    
    if (runLink) {
      console.log(chalk.blue('Step 1: Generating link proposals...'));
      
      const lxOptions: LxCoreOptions = {
        workspaceKey,
        runId,
        profile,
        minConfidence: 0.5,
        enableNameMatching: true,
        enableAliasMatching: true,
        enableStructuralMatching: true,
        enableProfileMatching: true,
      };
      
      const lxResult = await runLxCore(lxArtifacts, lxOptions);
      linkProposals = lxResult.proposals;
      
      // Write LX output
      const lxOutput = {
        $schema: 'intentweave://schemas/lx-proposals/v1',
        schemaVersion: '0.1',
        runId,
        generatedAt: new Date().toISOString(),
        profile: profile.name,
        proposals: lxResult.proposals,
        meta: lxResult.meta,
      };
      await fs.writeFile(lxPath, JSON.stringify(lxOutput, null, 2), 'utf-8');
      
      console.log(`  ✓ Generated ${linkProposals.length} link proposals`);
    } else if (!skipLink) {
      // Load existing proposals
      try {
        const lxData = JSON.parse(await fs.readFile(lxPath, 'utf-8'));
        linkProposals = lxData.proposals || [];
        console.log(chalk.dim(`Step 1: Using existing ${linkProposals.length} link proposals`));
      } catch {
        console.log(chalk.dim('Step 1: No existing link proposals'));
      }
    } else {
      console.log(chalk.dim('Step 1: Skipped (--skip-link)'));
    }
    
    // Step 2: Coverage Report
    if (!skipCoverage) {
      console.log(chalk.blue('Step 2: Generating coverage report...'));
      
      const coverageInput: CoverageReportInput = {
        entities,
        statements,
        linkProposals,
        artifacts,
      };
      
      const coverageOptions: CoverageReportOptions = {
        runId,
        workspaceKey,
        minLinkConfidence: 0.5,
        detectInconsistencies: true,
        detectIncompletenesses: true,
      };
      
      const coverageResult = generateCoverageReport(coverageInput, coverageOptions);
      
      // Write coverage output - result already has all schema fields
      const coveragePath = path.join(outputDir, 'coverage.json');
      await fs.writeFile(coveragePath, JSON.stringify(coverageResult, null, 2), 'utf-8');
      
      console.log(`  ✓ Traceability score: ${coverageResult.summary.traceabilityScore.toFixed(1)}%`);
      
      if (verbose) {
        coverageResult.roleTransitions.forEach(rt => {
          console.log(`    ${rt.sourceRole} → ${rt.targetRole}: ${rt.coveragePercent.toFixed(1)}%`);
        });
      }
    } else {
      console.log(chalk.dim('Step 2: Skipped (--skip-coverage)'));
    }
    
    // Step 3: Validation
    if (!skipValidate) {
      console.log(chalk.blue('Step 3: Running validation...'));
      
      const validationInput: ValidationInput = {
        entities,
        statements,
        linkProposals,
        profilePack,
      };
      
      const validationResult = runValidation(validationInput);
      
      // Write findings output
      const findingsPath = path.join(outputDir, 'findings.json');
      const findingsOutput = {
        $schema: 'intentweave://schemas/findings/v1',
        schemaVersion: '0.1',
        runId,
        generatedAt: new Date().toISOString(),
        profile: profilePack.meta.name,
        summary: validationResult.summary,
        rulesExecuted: validationResult.rulesExecuted,
        findings: validationResult.findings,
      };
      await fs.writeFile(findingsPath, JSON.stringify(findingsOutput, null, 2), 'utf-8');
      
      console.log(`  ✓ ${validationResult.summary.errors} errors, ${validationResult.summary.warnings} warnings`);
    } else {
      console.log(chalk.dim('Step 3: Skipped (--skip-validate)'));
    }
    
    // Update run.meta.json
    const metaPath = path.join(runDir, 'run.meta.json');
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      meta.aggregatedAt = new Date().toISOString();
      meta.aggregationDurationMs = Date.now() - startTime;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch {
      // No meta file to update
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('');
    console.log(chalk.green('✓ Aggregation complete'));
    console.log(`  Duration: ${duration}s`);
    console.log('');
    console.log(chalk.green(`Output written to: ${path.relative(cwd, outputDir)}/`));
    console.log('');
    console.log('Generated files:');
    if (runLink && !skipLink) console.log(`  ${chalk.blue('lx.proposals.json')} - Link proposals`);
    if (!skipCoverage) console.log(`  ${chalk.blue('coverage.json')} - Coverage report`);
    if (!skipValidate) console.log(`  ${chalk.blue('findings.json')} - Validation findings`);
  });
