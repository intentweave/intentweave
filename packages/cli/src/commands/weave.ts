/**
 * weave command - Run WX (Weave/Canonicalization) stage
 * 
 * Canonicalizes entities across artifacts within each role scope.
 * Creates unified identity layer for the graph.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import {
  generateBundleV2,
  type BundleV2Options,
} from '@intentweave/core';
import { IW_DIR } from '../constants.js';

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

export const weaveCommand = new Command('weave')
  .description('Canonicalize entities across artifacts (WX stage)')
  .option('--run <runId>', 'Run ID to weave (default: latest)')
  .option('--no-lx', 'Skip LX link proposal inclusion')
  .option('--jsonl-threshold <n>', 'Record count threshold for JSONL format', parseInt)
  .option('--explain <canonicalId>', 'Explain why entities merged into a canonical')
  .option('--debug', 'Include debug information in output')
  .action(async (options) => {
    const { run: runId, lx, jsonlThreshold, explain, debug } = options;
    
    const cwd = process.cwd();
    const iwDir = path.join(cwd, IW_DIR);
    const runsDir = path.join(iwDir, 'runs');
    
    if (!existsSync(runsDir)) {
      console.error(chalk.red('No runs found. Run the pipeline first with `iw run`.'));
      process.exit(1);
    }
    
    // Find run directory
    let targetRunId = runId;
    if (!targetRunId) {
      targetRunId = await findLatestRun(iwDir);
      if (!targetRunId) {
        console.error(chalk.red('No runs found.'));
        process.exit(1);
      }
    }
    
    const runDir = path.join(runsDir, targetRunId);
    
    if (!existsSync(runDir)) {
      console.error(chalk.red(`Run not found: ${targetRunId}`));
      process.exit(1);
    }
    
    // Handle explain mode
    if (explain) {
      await explainCanonical(runDir, explain);
      return;
    }
    
    console.log(chalk.blue(`Running WX (Weave) for: ${targetRunId}\n`));
    
    try {
      const bundleOptions: BundleV2Options = {
        weave: true,
        includeLx: lx !== false,
        prettyPrint: true,
        ...(debug && { debug: true }),
      };
      
      if (jsonlThreshold) {
        bundleOptions.jsonlThreshold = jsonlThreshold;
      }
      
      const result = await generateBundleV2({
        runDir,
        iwDir,
        options: bundleOptions,
      });
      
      const { stats, bundle } = result;
      
      console.log(chalk.green('✓ Weave completed successfully\n'));
      
      // Summary
      console.log(chalk.bold('Summary:'));
      console.log(`  Raw entities:       ${stats.rawEntityCount}`);
      console.log(`  Raw statements:     ${stats.rawStatementCount}`);
      console.log(`  ${chalk.cyan('Canonical entities:')} ${stats.canonicalEntityCount}`);
      console.log(`  ${chalk.cyan('Canonical stmts:')}    ${stats.canonicalStatementCount}`);
      console.log(`  Evidence records:   ${stats.evidenceCount}`);
      if (lx !== false) {
        console.log(`  LX links:           ${stats.lxCount}`);
      }
      
      // Merge stats
      if (stats.rawEntityCount > stats.canonicalEntityCount) {
        const mergeRatio = (1 - stats.canonicalEntityCount / stats.rawEntityCount) * 100;
        console.log(chalk.dim(`\n  Merge ratio: ${mergeRatio.toFixed(1)}% reduction`));
      }
      
      // Conflicts
      const conflicts = bundle.weave?.conflicts ?? [];
      if (conflicts.length > 0) {
        console.log(chalk.yellow(`\n⚠ ${conflicts.length} conflict(s) detected:`));
        for (const c of conflicts.slice(0, 5)) {
          console.log(`  - ${c.kind}: ${c.description}`);
        }
        if (conflicts.length > 5) {
          console.log(`  ... and ${conflicts.length - 5} more`);
        }
      }
      
      // Warnings
      const warnings = bundle.weave?.warnings ?? [];
      if (warnings.length > 0) {
        console.log(chalk.yellow(`\n⚠ ${warnings.length} warning(s):`));
        for (const w of warnings.slice(0, 3)) {
          console.log(`  - ${w}`);
        }
      }
      
      // Output files
      console.log(chalk.bold('\nOutput:'));
      console.log(`  Format: ${result.format === 'jsonl' ? 'JSONL (streaming)' : 'JSON'}`);
      console.log(`  Path:   ${result.bundlePath}`);
      
      // Top merges (debug info)
      if (debug && bundle.weave) {
        console.log(chalk.bold('\nTop Merge Clusters:'));
        const topClusters = [...bundle.weave.entities]
          .sort((a, b) => b.memberCgIds.length - a.memberCgIds.length)
          .slice(0, 5);
        
        for (const ce of topClusters) {
          if (ce.memberCgIds.length > 1) {
            console.log(`  ${chalk.cyan(ce.displayName)} (${ce.type})`);
            console.log(`    Members: ${ce.memberCgIds.length}`);
            console.log(`    Key: ${ce.key}`);
          }
        }
      }
      
    } catch (error) {
      console.error(chalk.red('Weave failed:'), error);
      process.exit(1);
    }
  });

/**
 * Explain why entities merged into a specific canonical
 */
async function explainCanonical(runDir: string, canonicalId: string): Promise<void> {
  const bundlePath = path.join(runDir, 'bundle', 'graph.v2.json');
  
  if (!existsSync(bundlePath)) {
    console.error(chalk.red('No v2 bundle found. Run `iw weave` first.'));
    process.exit(1);
  }
  
  const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
  
  if (!bundle.weave) {
    console.error(chalk.red('Bundle has no weave layer.'));
    process.exit(1);
  }
  
  // Find the canonical entity
  const canonical = bundle.weave.entities.find(
    (e: { canonicalId: string }) => e.canonicalId === canonicalId
  );
  
  if (!canonical) {
    // Try partial match
    const matches = bundle.weave.entities.filter(
      (e: { canonicalId: string; displayName: string }) =>
        e.canonicalId.includes(canonicalId) ||
        e.displayName.toLowerCase().includes(canonicalId.toLowerCase())
    );
    
    if (matches.length === 0) {
      console.error(chalk.red(`Canonical entity not found: ${canonicalId}`));
      console.log(chalk.dim('Use a canonical ID (ce_...) or entity name.'));
      process.exit(1);
    }
    
    if (matches.length > 1) {
      console.log(chalk.yellow('Multiple matches found:'));
      for (const m of matches.slice(0, 10)) {
        console.log(`  ${m.canonicalId} - ${m.displayName}`);
      }
      process.exit(1);
    }
    
    // Use single match
    Object.assign(canonical, matches[0]);
  }
  
  console.log(chalk.bold('\nCanonical Entity Explanation\n'));
  console.log(`  ${chalk.cyan('Canonical ID:')} ${canonical.canonicalId}`);
  console.log(`  ${chalk.cyan('Display Name:')} ${canonical.displayName}`);
  console.log(`  ${chalk.cyan('Type:')}         ${canonical.type}`);
  console.log(`  ${chalk.cyan('Role Scope:')}   ${canonical.artifactRole}`);
  console.log(`  ${chalk.cyan('Canonical Key:')} ${canonical.key}`);
  
  console.log(chalk.bold('\nMerged From:'));
  
  // Find raw entities by cgId
  for (const cgId of canonical.memberCgIds) {
    const raw = bundle.raw.entities.find(
      (e: { cgId: string }) => e.cgId === cgId
    );
    if (raw) {
      console.log(`  ${chalk.dim('•')} ${raw.name}`);
      console.log(`    ${chalk.dim('cgId:')} ${cgId}`);
      console.log(`    ${chalk.dim('artifact:')} ${raw.artifactId}`);
    }
  }
  
  // Evidence
  if (canonical.evidenceIds?.length > 0) {
    console.log(chalk.bold('\nEvidence:'));
    const evidenceRecords = bundle.evidence.filter(
      (e: { id: string }) => canonical.evidenceIds.includes(e.id)
    );
    for (const ev of evidenceRecords.slice(0, 5)) {
      console.log(`  ${chalk.dim('•')} ${ev.ref.uri}`);
      if (ev.excerpt) {
        console.log(`    "${ev.excerpt.slice(0, 80)}${ev.excerpt.length > 80 ? '...' : ''}"`);
      }
    }
    if (canonical.evidenceIds.length > 5) {
      console.log(`  ... and ${canonical.evidenceIds.length - 5} more`);
    }
  }
  
  // Related statements
  const relatedStmts = bundle.weave.statements.filter(
    (s: { subjectCanonicalId: string; objectCanonicalId?: string }) =>
      s.subjectCanonicalId === canonical.canonicalId ||
      s.objectCanonicalId === canonical.canonicalId
  );
  
  if (relatedStmts.length > 0) {
    console.log(chalk.bold('\nRelated Statements:'));
    for (const stmt of relatedStmts.slice(0, 5)) {
      const isSubject = stmt.subjectCanonicalId === canonical.canonicalId;
      if (isSubject) {
        const obj = stmt.objectCanonicalId
          ? bundle.weave.entities.find((e: { canonicalId: string }) => e.canonicalId === stmt.objectCanonicalId)?.displayName ?? stmt.objectCanonicalId
          : `"${stmt.objectLiteral}"`;
        console.log(`  ${chalk.dim('→')} ${stmt.predicate} ${obj}`);
      } else {
        const subj = bundle.weave.entities.find((e: { canonicalId: string }) => e.canonicalId === stmt.subjectCanonicalId)?.displayName ?? stmt.subjectCanonicalId;
        console.log(`  ${chalk.dim('←')} ${subj} ${stmt.predicate}`);
      }
    }
    if (relatedStmts.length > 5) {
      console.log(`  ... and ${relatedStmts.length - 5} more`);
    }
  }
  
  console.log();
}
