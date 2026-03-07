/**
 * eval command - Evaluate pipeline runs with regression testing
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

interface EvaluationThresholds {
  entityCountMin: number;
  entityCountMax: number;
  proposalCountMin: number;
  statementCountMin: number;
  crossArtifactLinksMin: number;
  entityOverlapMin: number;
  proposalOverlapMin: number;
  confidenceMin: number;
  findingsMaxCritical: number;
  coverageMin: number;
}

interface EvaluationWeights {
  entityCount: number;
  proposalCount: number;
  crossArtifactLinks: number;
  entityOverlap: number;
  proposalOverlap: number;
  avgConfidence: number;
  findingsScore: number;
  coverageScore: number;
}

const THRESHOLDS: EvaluationThresholds = {
  entityCountMin: 40,
  entityCountMax: 200,
  proposalCountMin: 10,
  statementCountMin: 0,
  crossArtifactLinksMin: 5,
  entityOverlapMin: 0.70,
  proposalOverlapMin: 0.60,
  confidenceMin: 0.5,
  findingsMaxCritical: 2,
  coverageMin: 0.80,
};

const WEIGHTS: EvaluationWeights = {
  entityCount: 0.20,
  proposalCount: 0.20,
  crossArtifactLinks: 0.15,
  entityOverlap: 0.15,
  proposalOverlap: 0.15,
  avgConfidence: 0.05,
  findingsScore: 0.05,
  coverageScore: 0.05,
};

// ============================================================================
// Types
// ============================================================================

interface ContractResult {
  passed: boolean;
  errors: string[];
}

interface SemanticScores {
  entityCount: number;
  entityCountRaw: number;
  proposalCount: number;
  proposalCountRaw: number;
  crossArtifactLinks: number;
  crossArtifactLinksRaw: number;
  entityOverlap: number;
  proposalOverlap: number;
}

interface QualityScores {
  avgConfidence: number;
  avgConfidenceRaw: number;
  findingsScore: number;
  findingsCountRaw: number;
  criticalFindingsRaw: number;
  coverageScore: number;
  coverageRaw: number;
}

interface EvaluationResult {
  passed: boolean;
  score: number;
  contracts: ContractResult;
  semantics: SemanticScores;
  quality: QualityScores;
  breakdown: Record<string, number>;
}

// ============================================================================
// Layer 1: Hard Contracts
// ============================================================================

async function checkHardContracts(runDir: string): Promise<ContractResult> {
  const errors: string[] = [];

  // Check run.meta.json
  try {
    const metaPath = path.join(runDir, 'run.meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));

    if (!meta.$schema) errors.push('Missing $schema in run.meta.json');
    if (!meta.schemaVersion) errors.push('Missing schemaVersion in run.meta.json');
    if (meta.status !== 'completed') errors.push(`Run status is ${meta.status}, expected 'completed'`);
  } catch (err) {
    errors.push(`Cannot read run.meta.json: ${(err as Error).message}`);
  }

  // Check aggregate files exist
  const aggregateFiles = ['lx.proposals.json', 'coverage.json', 'findings.json'];
  for (const file of aggregateFiles) {
    try {
      const filePath = path.join(runDir, 'aggregate', file);
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!data.$schema) errors.push(`Missing $schema in ${file}`);
      if (!data.schemaVersion) errors.push(`Missing schemaVersion in ${file}`);
    } catch (err) {
      errors.push(`Cannot read aggregate/${file}: ${(err as Error).message}`);
    }
  }

  // Check artifact stage files
  const artifactsDir = path.join(runDir, 'artifacts');
  try {
    const artifacts = await fs.readdir(artifactsDir);
    for (const artifact of artifacts) {
      const artifactDir = path.join(artifactsDir, artifact);
      const stat = await fs.stat(artifactDir);
      if (!stat.isDirectory()) continue;

      const stages = ['in.json', 'rx.json', 'cx.json', 'mx.json', 'px.json'];
      for (const stage of stages) {
        const stagePath = path.join(artifactDir, stage);
        try {
          await fs.access(stagePath);
        } catch {
          errors.push(`Missing ${artifact}/${stage}`);
        }
      }
    }
  } catch (err) {
    errors.push(`Cannot read artifacts directory: ${(err as Error).message}`);
  }

  return { passed: errors.length === 0, errors };
}

// ============================================================================
// Layer 2: Semantic Similarity
// ============================================================================

async function evaluateSemantics(
  runDir: string,
  baselineDir: string | null
): Promise<SemanticScores> {
  const meta = JSON.parse(await fs.readFile(path.join(runDir, 'run.meta.json'), 'utf8'));
  const proposals = JSON.parse(
    await fs.readFile(path.join(runDir, 'aggregate/lx.proposals.json'), 'utf8')
  );

  const entityCount = meta.summary.entityCount;
  const proposalCount = proposals.proposals.length;

  // Cross-artifact links
  const crossLinks = proposals.proposals.filter(
    (p: any) => p.sourceArtifact && p.targetArtifact && p.sourceArtifact !== p.targetArtifact
  ).length;

  const scores: SemanticScores = {
    entityCount: scoreRange(entityCount, THRESHOLDS.entityCountMin, THRESHOLDS.entityCountMax),
    entityCountRaw: entityCount,
    proposalCount: scoreMin(proposalCount, THRESHOLDS.proposalCountMin),
    proposalCountRaw: proposalCount,
    crossArtifactLinks: scoreMin(crossLinks, THRESHOLDS.crossArtifactLinksMin),
    crossArtifactLinksRaw: crossLinks,
    entityOverlap: 1.0,
    proposalOverlap: 1.0,
  };

  // Overlap scores (if baseline provided)
  if (baselineDir) {
    const baselineMeta = JSON.parse(
      await fs.readFile(path.join(baselineDir, 'run.meta.json'), 'utf8')
    );
    const baselineProposals = JSON.parse(
      await fs.readFile(path.join(baselineDir, 'aggregate/lx.proposals.json'), 'utf8')
    );

    // Entity overlap (by count approximation)
    scores.entityOverlap =
      1.0 -
      Math.abs(entityCount - baselineMeta.summary.entityCount) /
        Math.max(entityCount, baselineMeta.summary.entityCount);
    scores.entityOverlap = Math.max(0, scores.entityOverlap);

    // Proposal overlap (Jaccard by predicate+artifacts)
    const currentSet = new Set(
      proposals.proposals.map(
        (p: any) => `${p.predicate}:${p.sourceArtifact}:${p.targetArtifact}`
      )
    );
    const baselineSet = new Set(
      baselineProposals.proposals.map(
        (p: any) => `${p.predicate}:${p.sourceArtifact}:${p.targetArtifact}`
      )
    );
    const intersection = [...currentSet].filter((x) => baselineSet.has(x)).length;
    const union = new Set([...currentSet, ...baselineSet]).size;
    scores.proposalOverlap = union > 0 ? intersection / union : 0;
  }

  return scores;
}

// ============================================================================
// Layer 3: Quality Rubrics
// ============================================================================

async function evaluateQuality(runDir: string): Promise<QualityScores> {
  const proposals = JSON.parse(
    await fs.readFile(path.join(runDir, 'aggregate/lx.proposals.json'), 'utf8')
  );
  const coverage = JSON.parse(
    await fs.readFile(path.join(runDir, 'aggregate/coverage.json'), 'utf8')
  );
  const findings = JSON.parse(
    await fs.readFile(path.join(runDir, 'aggregate/findings.json'), 'utf8')
  );

  const scores: QualityScores = {
    avgConfidence: 0,
    avgConfidenceRaw: 0,
    findingsScore: 0,
    findingsCountRaw: findings.findings.length,
    criticalFindingsRaw: 0,
    coverageScore: 0,
    coverageRaw: 0,
  };

  // Average confidence score
  if (proposals.proposals.length > 0) {
    const avgConfidence =
      proposals.proposals.reduce((sum: number, p: any) => sum + (p.confidence ?? 0.5), 0) /
      proposals.proposals.length;
    scores.avgConfidence = scoreMin(avgConfidence, THRESHOLDS.confidenceMin);
    scores.avgConfidenceRaw = avgConfidence;
  }

  // Findings score
  const criticalFindings = findings.findings.filter((f: any) => f.severity === 'critical').length;
  scores.criticalFindingsRaw = criticalFindings;
  scores.findingsScore = criticalFindings <= THRESHOLDS.findingsMaxCritical ? 1.0 : 0.5;

  // Coverage score
  const totalConcepts = coverage.summary.totalConcepts ?? 0;
  scores.coverageScore = totalConcepts > 0 ? 1.0 : 0.5;
  scores.coverageRaw = totalConcepts;

  return scores;
}

// ============================================================================
// Scoring Helpers
// ============================================================================

function scoreMin(value: number, min: number): number {
  return Math.min(1.0, value / min);
}

function scoreRange(value: number, min: number, max: number): number {
  if (value < min) return value / min;
  if (value > max) return Math.max(0, 1.0 - (value - max) / max);
  return 1.0;
}

// ============================================================================
// Aggregate Score
// ============================================================================

function calculateTotalScore(
  semanticScores: SemanticScores,
  qualityScores: QualityScores
): { scores: Record<string, number>; total: number } {
  const scores = {
    entityCount: semanticScores.entityCount * WEIGHTS.entityCount,
    proposalCount: semanticScores.proposalCount * WEIGHTS.proposalCount,
    crossArtifactLinks: semanticScores.crossArtifactLinks * WEIGHTS.crossArtifactLinks,
    entityOverlap: semanticScores.entityOverlap * WEIGHTS.entityOverlap,
    proposalOverlap: semanticScores.proposalOverlap * WEIGHTS.proposalOverlap,
    avgConfidence: qualityScores.avgConfidence * WEIGHTS.avgConfidence,
    findingsScore: qualityScores.findingsScore * WEIGHTS.findingsScore,
    coverageScore: qualityScores.coverageScore * WEIGHTS.coverageScore,
  };

  const total = Object.values(scores).reduce((sum, s) => sum + s, 0);

  return { scores, total: Math.round(total * 100) / 100 };
}

// ============================================================================
// Main Evaluation
// ============================================================================

export async function evaluateRun(
  runDir: string,
  baselineDir: string | null,
  options: { quiet?: boolean; json?: boolean } = {}
): Promise<EvaluationResult> {
  const { quiet = false, json = false } = options;

  if (!quiet && !json) {
    console.log(chalk.blue('🔬 LLM Regression Testing Evaluation'));
    console.log(chalk.blue('═══════════════════════════════════════\n'));
    console.log(`Run: ${chalk.cyan(runDir)}`);
    if (baselineDir) {
      console.log(`Baseline: ${chalk.cyan(baselineDir)}`);
    }
    console.log('');
  }

  // Layer 1: Hard Contracts
  if (!quiet && !json) {
    console.log(chalk.bold('📋 Layer 1: Hard Contracts'));
  }
  const contracts = await checkHardContracts(runDir);
  if (contracts.passed) {
    if (!quiet && !json) {
      console.log(chalk.green('   ✅ All contracts passed\n'));
    }
  } else {
    if (!quiet && !json) {
      console.log(chalk.red('   ❌ Contract violations:'));
      contracts.errors.forEach((err) => console.log(chalk.red(`      - ${err}`)));
      console.log(chalk.yellow('\n   ⚠️  Cannot proceed with scoring - fix contracts first\n'));
    }
    return {
      passed: false,
      score: 0,
      contracts,
      semantics: {} as SemanticScores,
      quality: {} as QualityScores,
      breakdown: {},
    };
  }

  // Layer 2: Semantic Similarity
  if (!quiet && !json) {
    console.log(chalk.bold('🔍 Layer 2: Semantic Similarity'));
  }
  const semantics = await evaluateSemantics(runDir, baselineDir);
  if (!quiet && !json) {
    console.log(
      `   Entities: ${chalk.cyan(semantics.entityCountRaw)} (score: ${chalk.yellow((semantics.entityCount * 100).toFixed(1) + '%')})`
    );
    console.log(
      `   Proposals: ${chalk.cyan(semantics.proposalCountRaw)} (score: ${chalk.yellow((semantics.proposalCount * 100).toFixed(1) + '%')})`
    );
    console.log(
      `   Cross-artifact links: ${chalk.cyan(semantics.crossArtifactLinksRaw)} (score: ${chalk.yellow((semantics.crossArtifactLinks * 100).toFixed(1) + '%')})`
    );
    if (baselineDir) {
      console.log(`   Entity overlap: ${chalk.yellow((semantics.entityOverlap * 100).toFixed(1) + '%')}`);
      console.log(`   Proposal overlap: ${chalk.yellow((semantics.proposalOverlap * 100).toFixed(1) + '%')}`);
    }
    console.log('');
  }

  // Layer 3: Quality Rubrics
  if (!quiet && !json) {
    console.log(chalk.bold('⭐ Layer 3: Quality Rubrics'));
  }
  const quality = await evaluateQuality(runDir);
  if (!quiet && !json) {
    console.log(
      `   Avg confidence: ${chalk.cyan(quality.avgConfidenceRaw.toFixed(2))} (score: ${chalk.yellow((quality.avgConfidence * 100).toFixed(1) + '%')})`
    );
    console.log(
      `   Findings: ${chalk.cyan(quality.findingsCountRaw)} total, ${chalk.cyan(quality.criticalFindingsRaw)} critical (score: ${chalk.yellow((quality.findingsScore * 100).toFixed(1) + '%')})`
    );
    console.log(
      `   Coverage: ${chalk.cyan(quality.coverageRaw)} concepts (score: ${chalk.yellow((quality.coverageScore * 100).toFixed(1) + '%')})`
    );
    console.log('');
  }

  // Calculate total score
  const result = calculateTotalScore(semantics, quality);

  const passThreshold = 0.7;
  const passed = result.total >= passThreshold;

  if (!quiet && !json) {
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    const scoreColor = passed ? chalk.green : chalk.red;
    console.log(
      scoreColor.bold(`📊 REGRESSION RATING: ${result.total}/1.00`) +
        chalk.gray(` (${(result.total * 100).toFixed(1)}%)`)
    );
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    console.log('Component scores:');
    Object.entries(result.scores).forEach(([key, score]) => {
      const percent = (score * 100).toFixed(1) + '%';
      console.log(`  ${key.padEnd(20)} ${chalk.yellow(percent)}`);
    });
    console.log('');

    if (passed) {
      console.log(chalk.green(`✅ PASS`) + chalk.gray(` (threshold: ${passThreshold})\n`));
    } else {
      console.log(
        chalk.red(`❌ FAIL`) + chalk.gray(` (threshold: ${passThreshold}, got: ${result.total})\n`)
      );
    }
  }

  return {
    passed,
    score: result.total,
    contracts,
    semantics,
    quality,
    breakdown: result.scores,
  };
}

// ============================================================================
// CLI Command
// ============================================================================

export const evalCommand = new Command('eval')
  .description('Evaluate pipeline run with regression testing')
  .argument('<run-dir>', 'Run directory to evaluate (.iw/runs/<run-id>)')
  .option('--baseline <dir>', 'Baseline run directory for comparison')
  .option('--json', 'Output as JSON')
  .option('-q, --quiet', 'Suppress progress output')
  .option('--threshold <number>', 'Pass threshold (default: 0.7)', '0.7')
  .action(async (runDir: string, options) => {
    try {
      const result = await evaluateRun(runDir, options.baseline || null, {
        quiet: options.quiet,
        json: options.json,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      }

      process.exit(result.passed ? 0 : 1);
    } catch (err) {
      console.error(chalk.red('❌ Evaluation failed:'), (err as Error).message);
      if (process.env.DEBUG) {
        console.error((err as Error).stack);
      }
      process.exit(1);
    }
  });
