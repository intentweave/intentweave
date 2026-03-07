// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * analyze command - Extract entities and statements from files
 */

import { Command } from 'commander';
import { createAnalyzer } from '@intentweave/analyzer';
import { profileRegistry } from '@intentweave/profiles';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const analyzeCommand = new Command('analyze')
  .description('Analyze files and extract entities/statements')
  .argument('[files...]', 'Files or directories to analyze')
  .option('-p, --profile <name>', 'Analysis profile to use', 'standard')
  .option('-o, --output <path>', 'Output file path')
  .option('-f, --format <format>', 'Output format (json, cypher)', 'json')
  .option('--dry-run', 'Show what would be analyzed without running')
  .option('-v, --verbose', 'Verbose output')
  .action(async (files: string[], options) => {
    const { profile: profileName, output, format, dryRun, verbose } = options;
    
    // Resolve profile
    const profile = profileRegistry.resolve(profileName);
    if (!profile) {
      console.error(chalk.red(`Unknown profile: ${profileName}`));
      console.log('Available profiles:', profileRegistry.list().join(', '));
      process.exit(1);
    }
    
    if (verbose) {
      console.log(chalk.blue(`Using profile: ${profile.name}`));
    }
    
    // Collect files to analyze
    const filesToAnalyze = await collectFiles(files.length > 0 ? files : ['.']);
    
    if (dryRun) {
      console.log(chalk.yellow('Dry run - would analyze:'));
      filesToAnalyze.forEach(f => console.log(`  ${f}`));
      return;
    }
    
    if (filesToAnalyze.length === 0) {
      console.log(chalk.yellow('No files to analyze'));
      return;
    }
    
    console.log(chalk.blue(`Analyzing ${filesToAnalyze.length} files...`));
    
    // Create analyzer
    const analyzer = createAnalyzer({
      defaultNamespace: 'default',
    });
    
    // Read and analyze files
    const analysisFiles = await Promise.all(
      filesToAnalyze.map(async (filePath) => ({
        path: filePath,
        content: await fs.readFile(filePath, 'utf-8'),
      }))
    );
    
    const result = await analyzer.analyzeFiles(analysisFiles);
    
    // Output results
    console.log(chalk.green(`\nAnalysis complete:`));
    console.log(`  Files processed: ${result.files.length}`);
    console.log(`  Entities found: ${result.totalEntities}`);
    console.log(`  Statements found: ${result.totalStatements}`);
    console.log(`  Duration: ${result.totalDuration}ms`);
    
    if (result.errorCount > 0) {
      console.log(chalk.yellow(`  Errors: ${result.errorCount}`));
    }
    
    // Write output if requested
    if (output) {
      const outputData = format === 'json'
        ? JSON.stringify({ 
            entities: result.files.flatMap(f => f.entities),
            statements: result.files.flatMap(f => f.statements),
          }, null, 2)
        : generateCypher(result.files);
      
      await fs.writeFile(output, outputData, 'utf-8');
      console.log(chalk.green(`Output written to: ${output}`));
    }
  });

/**
 * Collect files to analyze from paths
 */
async function collectFiles(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  
  for (const p of paths) {
    const stat = await fs.stat(p);
    
    if (stat.isFile()) {
      if (p.endsWith('.md')) {
        files.push(p);
      }
    } else if (stat.isDirectory()) {
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(path.join(p, entry.name));
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subFiles = await collectFiles([path.join(p, entry.name)]);
          files.push(...subFiles);
        }
      }
    }
  }
  
  return files;
}

/**
 * Generate Cypher statements from analysis results
 */
function generateCypher(files: Array<{ entities: any[]; statements: any[] }>): string {
  const lines: string[] = [];
  
  for (const file of files) {
    for (const entity of file.entities) {
      lines.push(
        `MERGE (n:Entity {cgId: '${entity.cgId}'}) SET n.name = '${entity.name}', n.type = '${entity.type}';`
      );
    }
    for (const stmt of file.statements) {
      lines.push(
        `MATCH (a:Entity {cgId: '${stmt.subjectCgId}'}), (b:Entity {cgId: '${stmt.objectCgId}'}) MERGE (a)-[:${stmt.predicate}]->(b);`
      );
    }
  }
  
  return lines.join('\n');
}
