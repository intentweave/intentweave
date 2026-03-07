/**
 * code command - Extract code symbols and link to spec entities
 * 
 * Runs AX stage (AST extraction) on TypeScript/JavaScript codebase
 * and optionally links extracted symbols to spec entities.
 * 
 * Usage:
 *   iw code ./src                    # Extract symbols from ./src
 *   iw code ./src --link .iw/rx.json # Extract and link to spec entities
 *   iw code ./src --coverage         # Show implementation coverage report
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { 
  runAxStage, 
  runAxStageIncremental,
  loadAxOutput, 
  saveAxOutput,
  type AxOutput,
  type AxStageOptions
} from '@intentweave/analyzer';

// ============================================================================
// Code Linker Types (inline to avoid src/ import issues)
// ============================================================================

interface AxSymbol {
  id: string;
  kind: string;
  name: string;
  container?: string;
  filePath: string;
  export: 'exported' | 'internal';
}

interface CodeLinkCandidate {
  specEntityId: string;
  specEntityName: string;
  specEntityKind: string;
  codeSymbolId: string;
  codeSymbolName: string;
  codeSymbolKind: string;
  codeContainer?: string;
  codeFilePath: string;
  matchType: string;
  confidence: number;
  rationale: string;
}

interface CodeLinkerResult {
  candidates: CodeLinkCandidate[];
  unmatched: Array<{ entityId: string; entityName: string; entityKind: string }>;
  stats: {
    totalSpecEntities: number;
    totalCodeSymbols: number;
    matchedByExact: number;
    matchedByAlias: number;
    matchedByPathHint: number;
    unmatchedSpec: number;
  };
}

// ============================================================================
// Inline Code Linker (minimal v0 implementation)
// ============================================================================

function normalizeToSlug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s/g, '');
}

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0);
}

function tokenOverlapScore(tokens1: string[], tokens2: string[]): number {
  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);
  let overlap = 0;
  for (const t of set1) if (set2.has(t)) overlap++;
  const union = new Set([...tokens1, ...tokens2]).size;
  return union > 0 ? overlap / union : 0;
}

interface Entity {
  cgId: string;
  type: string;
  name: string;
}

function linkSpecToCode(
  specEntities: Entity[],
  codeOutput: AxOutput,
  options?: { minConfidence?: number; includeInternal?: boolean; specKinds?: string[]; codeKinds?: string[] }
): CodeLinkerResult {
  const opts = {
    minConfidence: options?.minConfidence ?? 0.5,
    includeInternal: options?.includeInternal ?? false,
    specKinds: options?.specKinds ?? ['action', 'resource', 'service', 'endpoint', 'function'],
    codeKinds: options?.codeKinds ?? ['function', 'class', 'method', 'interface'],
  };

  const relevantSpec = specEntities.filter(e => opts.specKinds.includes(e.type));
  
  const codeSymbols: AxSymbol[] = [];
  for (const file of codeOutput.files) {
    for (const symbol of file.symbols) {
      if (!opts.codeKinds.includes(symbol.kind)) continue;
      if (!opts.includeInternal && symbol.export === 'internal') continue;
      codeSymbols.push(symbol);
    }
  }

  const candidates: CodeLinkCandidate[] = [];
  const matchedSpec = new Set<string>();
  const stats = {
    totalSpecEntities: relevantSpec.length,
    totalCodeSymbols: codeSymbols.length,
    matchedByExact: 0,
    matchedByAlias: 0,
    matchedByPathHint: 0,
    unmatchedSpec: 0,
  };

  for (const entity of relevantSpec) {
    let bestMatch: CodeLinkCandidate | null = null;

    for (const symbol of codeSymbols) {
      // Exact match
      if (entity.name.toLowerCase() === symbol.name.toLowerCase()) {
        const candidate: CodeLinkCandidate = {
          specEntityId: entity.cgId,
          specEntityName: entity.name,
          specEntityKind: entity.type,
          codeSymbolId: symbol.id,
          codeSymbolName: symbol.name,
          codeSymbolKind: symbol.kind,
          codeContainer: symbol.container,
          codeFilePath: symbol.filePath,
          matchType: 'exact-name',
          confidence: 0.95,
          rationale: `Exact name match: "${entity.name}" = "${symbol.name}"`,
        };
        if (!bestMatch || candidate.confidence > bestMatch.confidence) {
          bestMatch = candidate;
        }
        continue;
      }

      // Alias match
      const specSlug = normalizeToSlug(entity.name);
      const codeSlug = normalizeToSlug(symbol.name);
      if (specSlug === codeSlug) {
        const candidate: CodeLinkCandidate = {
          specEntityId: entity.cgId,
          specEntityName: entity.name,
          specEntityKind: entity.type,
          codeSymbolId: symbol.id,
          codeSymbolName: symbol.name,
          codeSymbolKind: symbol.kind,
          codeContainer: symbol.container,
          codeFilePath: symbol.filePath,
          matchType: 'alias-match',
          confidence: 0.85,
          rationale: `Alias match: "${specSlug}" = "${codeSlug}"`,
        };
        if (!bestMatch || candidate.confidence > bestMatch.confidence) {
          bestMatch = candidate;
        }
        continue;
      }

      // Path hint match
      const specTokens = tokenize(entity.name);
      const codeTokens = tokenize(symbol.name);
      if (symbol.container) codeTokens.push(...tokenize(symbol.container));
      const overlap = tokenOverlapScore(specTokens, codeTokens);
      if (overlap >= 0.5) {
        const confidence = 0.6 + (overlap * 0.2);
        if (confidence >= opts.minConfidence) {
          const candidate: CodeLinkCandidate = {
            specEntityId: entity.cgId,
            specEntityName: entity.name,
            specEntityKind: entity.type,
            codeSymbolId: symbol.id,
            codeSymbolName: symbol.name,
            codeSymbolKind: symbol.kind,
            codeContainer: symbol.container,
            codeFilePath: symbol.filePath,
            matchType: 'path-hint',
            confidence,
            rationale: `Token overlap: "${entity.name}" ↔ "${symbol.container ? symbol.container + '.' : ''}${symbol.name}"`,
          };
          if (!bestMatch || candidate.confidence > bestMatch.confidence) {
            bestMatch = candidate;
          }
        }
      }
    }

    if (bestMatch) {
      candidates.push(bestMatch);
      matchedSpec.add(entity.cgId);
      switch (bestMatch.matchType) {
        case 'exact-name': stats.matchedByExact++; break;
        case 'alias-match': stats.matchedByAlias++; break;
        case 'path-hint': stats.matchedByPathHint++; break;
      }
    }
  }

  const unmatched = relevantSpec
    .filter(e => !matchedSpec.has(e.cgId))
    .map(e => ({ entityId: e.cgId, entityName: e.name, entityKind: e.type }));

  stats.unmatchedSpec = unmatched.length;

  return { candidates, unmatched, stats };
}

// ============================================================================
// Command Implementation
// ============================================================================

export const codeCommand = new Command('code')
  .description('Extract code symbols and link to spec entities')
  .argument('<directory>', 'Directory containing TypeScript/JavaScript code')
  .option('-o, --output <path>', 'Output AX file path', '.iw/ax.json')
  .option('-l, --link <spec-file>', 'Link to spec entities from RX/CX output')
  .option('-c, --coverage', 'Show implementation coverage report')
  .option('--incremental', 'Only re-extract changed files')
  .option('--include-internal', 'Include non-exported symbols')
  .option('-v, --verbose', 'Verbose output')
  .option('--include <patterns...>', 'File patterns to include')
  .option('--exclude <patterns...>', 'File patterns to exclude')
  .action(async (directory: string, options) => {
    const { 
      output, 
      link: specFile, 
      coverage: showCoverage, 
      incremental,
      includeInternal,
      verbose,
      include,
      exclude,
    } = options;

    const workspaceRoot = path.resolve(directory);
    
    // Check directory exists
    try {
      const stat = await fs.stat(workspaceRoot);
      if (!stat.isDirectory()) {
        console.error(chalk.red(`Not a directory: ${directory}`));
        process.exit(1);
      }
    } catch {
      console.error(chalk.red(`Directory not found: ${directory}`));
      process.exit(1);
    }

    console.log(chalk.blue(`\n📦 Extracting code symbols from: ${workspaceRoot}\n`));

    // Prepare options
    const axOptions: AxStageOptions = {
      workspaceRoot,
      include,
      exclude,
      includePrivate: includeInternal,
      includeMembers: true,
      maxDepth: 2,
    };

    // Load previous output if incremental
    let previousOutput: AxOutput | null = null;
    if (incremental) {
      previousOutput = await loadAxOutput(path.resolve(output));
      if (previousOutput) {
        console.log(chalk.gray(`  Incremental mode: reusing ${previousOutput.totalFiles} cached files`));
      }
    }

    // Run AX stage
    const startTime = Date.now();
    const axOutput = incremental && previousOutput
      ? await runAxStageIncremental(axOptions, previousOutput)
      : await runAxStage(axOptions);
    const duration = Date.now() - startTime;

    // Display results
    console.log(chalk.green(`✓ Extraction complete (${duration}ms)\n`));
    console.log(`  Files:   ${axOutput.totalFiles}`);
    console.log(`  Symbols: ${axOutput.totalSymbols}`);
    console.log(`  Exported: ${axOutput.stats.exported} | Internal: ${axOutput.stats.internal}`);
    
    if (verbose) {
      console.log(chalk.gray(`\n  By kind:`));
      for (const [kind, count] of Object.entries(axOutput.stats.byKind)) {
        console.log(chalk.gray(`    ${kind}: ${count}`));
      }
    }

    // Save output
    const outputPath = path.resolve(output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await saveAxOutput(axOutput, outputPath);
    console.log(chalk.green(`\n  Output: ${output}`));

    // Link to spec entities if requested
    if (specFile) {
      console.log(chalk.blue(`\n🔗 Linking to spec entities from: ${specFile}\n`));
      
      try {
        const specContent = await fs.readFile(path.resolve(specFile), 'utf-8');
        const specData = JSON.parse(specContent);
        
        // Extract entities from various possible formats
        let specEntities: Entity[] = [];
        if (Array.isArray(specData.entities)) {
          specEntities = specData.entities;
        } else if (Array.isArray(specData)) {
          specEntities = specData;
        } else if (specData.files && Array.isArray(specData.files)) {
          // RX output format
          for (const file of specData.files) {
            if (Array.isArray(file.entities)) {
              specEntities.push(...file.entities);
            }
          }
        }

        if (specEntities.length === 0) {
          console.log(chalk.yellow('  No spec entities found in file'));
        } else {
          const linkResult = linkSpecToCode(specEntities, axOutput, { includeInternal });
          
          console.log(chalk.green(`✓ Linking complete\n`));
          console.log(`  Spec entities: ${linkResult.stats.totalSpecEntities}`);
          console.log(`  Code symbols:  ${linkResult.stats.totalCodeSymbols}`);
          console.log(`  Matched:       ${linkResult.candidates.length}`);
          console.log(`    by exact:    ${linkResult.stats.matchedByExact}`);
          console.log(`    by alias:    ${linkResult.stats.matchedByAlias}`);
          console.log(`    by path:     ${linkResult.stats.matchedByPathHint}`);
          console.log(`  Unmatched:     ${linkResult.stats.unmatchedSpec}`);

          // Show top matches
          if (verbose && linkResult.candidates.length > 0) {
            console.log(chalk.gray(`\n  Top matches:`));
            const topMatches = linkResult.candidates.slice(0, 10);
            for (const m of topMatches) {
              const container = m.codeContainer ? `${m.codeContainer}.` : '';
              console.log(chalk.gray(`    ${m.specEntityKind}:${m.specEntityName} → ${container}${m.codeSymbolName} (${m.codeFilePath})`));
            }
            if (linkResult.candidates.length > 10) {
              console.log(chalk.gray(`    ... and ${linkResult.candidates.length - 10} more`));
            }
          }

          // Save link results
          const linkOutputPath = outputPath.replace('.json', '-links.json');
          await fs.writeFile(linkOutputPath, JSON.stringify({
            version: '1.0',
            specFile,
            axFile: output,
            linkedAt: new Date().toISOString(),
            ...linkResult,
          }, null, 2));
          console.log(chalk.green(`\n  Links: ${linkOutputPath}`));

          // Show coverage if requested
          if (showCoverage) {
            const coverage = calculateCoverage(linkResult, specEntities);
            printCoverageReport(coverage);
          }
        }
      } catch (err) {
        console.error(chalk.red(`Failed to read spec file: ${(err as Error).message}`));
      }
    } else if (showCoverage) {
      console.log(chalk.yellow('\n--coverage requires --link <spec-file>'));
    }
  });

// ============================================================================
// Coverage Report
// ============================================================================

interface CoverageReport {
  totalSpec: number;
  covered: number;
  coveragePercent: number;
  byKind: Record<string, { total: number; covered: number; percent: number }>;
  unimplemented: string[];
}

function calculateCoverage(result: CodeLinkerResult, specEntities: Entity[]): CoverageReport {
  const byKind: Record<string, { total: number; covered: number; percent: number }> = {};
  const matchedIds = new Set(result.candidates.map(c => c.specEntityId));
  
  for (const entity of specEntities) {
    if (!byKind[entity.type]) {
      byKind[entity.type] = { total: 0, covered: 0, percent: 0 };
    }
    byKind[entity.type].total++;
    if (matchedIds.has(entity.cgId)) {
      byKind[entity.type].covered++;
    }
  }

  for (const kind of Object.keys(byKind)) {
    const k = byKind[kind];
    k.percent = k.total > 0 ? Math.round((k.covered / k.total) * 100) : 0;
  }

  const totalSpec = specEntities.length;
  const covered = matchedIds.size;

  return {
    totalSpec,
    covered,
    coveragePercent: totalSpec > 0 ? Math.round((covered / totalSpec) * 100) : 0,
    byKind,
    unimplemented: result.unmatched.map(u => u.entityName),
  };
}

function printCoverageReport(coverage: CoverageReport): void {
  console.log(chalk.blue(`\n📊 Implementation Coverage Report\n`));
  
  // Overall coverage with bar
  const bar = renderBar(coverage.coveragePercent);
  const color = coverage.coveragePercent >= 80 ? chalk.green 
    : coverage.coveragePercent >= 50 ? chalk.yellow 
    : chalk.red;
  console.log(`  Overall: ${bar} ${color(`${coverage.coveragePercent}%`)} (${coverage.covered}/${coverage.totalSpec})`);
  
  // By kind
  console.log(chalk.gray(`\n  By kind:`));
  for (const [kind, stats] of Object.entries(coverage.byKind)) {
    if (stats.total === 0) continue;
    const kindBar = renderBar(stats.percent, 20);
    const kindColor = stats.percent >= 80 ? chalk.green 
      : stats.percent >= 50 ? chalk.yellow 
      : chalk.red;
    console.log(`    ${kind.padEnd(12)} ${kindBar} ${kindColor(`${stats.percent}%`)} (${stats.covered}/${stats.total})`);
  }

  // Unimplemented
  if (coverage.unimplemented.length > 0) {
    console.log(chalk.yellow(`\n  Unimplemented (${coverage.unimplemented.length}):`));
    const toShow = coverage.unimplemented.slice(0, 10);
    for (const name of toShow) {
      console.log(chalk.gray(`    - ${name}`));
    }
    if (coverage.unimplemented.length > 10) {
      console.log(chalk.gray(`    ... and ${coverage.unimplemented.length - 10} more`));
    }
  }
}

function renderBar(percent: number, width = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}
