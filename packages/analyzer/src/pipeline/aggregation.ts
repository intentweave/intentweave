/**
 * Aggregation Step (AGG-Prep)
 * 
 * Per-run stage that combines outputs from all per-artifact stages.
 * 
 * Input: All artifact px.json files
 * Output: aggregate/*.json files (lx.proposals.json, coverage.json, validation.json)
 * 
 * Responsibilities:
 * - Merge all artifact PX outputs into unified entity/statement lists
 * - Generate LX proposals (cross-artifact linking candidates)
 * - Calculate coverage metrics
 * - Run validation checks
 * - Write to aggregate/ directory
 */

import type { PipelineContext, Profile } from './context.js';
import type { Entity, Statement, LinkProposal, LxStageOutput, ArtifactRole } from '@intentweave/core';
import type { PxStageOutput, FilterDecision } from '../stages/px.js';
import { getFilteredEntities, getFilteredStatements } from '../stages/px.js';
import { runLxCore, type LxArtifactInput } from '../linking/lxCore.js';
import { 
  generateCoverageReport, 
  type CoverageReport,
  type CoverageReportInput,
  type CoverageReportOptions 
} from '../linking/coverageReport.js';
import { 
  runValidation as runCoreValidation, 
  type ValidationInput, 
  type ValidationOutput 
} from '../validation/coreRules.js';
import { loadProfilePack, type ProfilePack } from '@intentweave/profiles';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Profile Adapter
// =============================================================================

/**
 * Creates a minimal ProfilePack from a Profile for validation
 * This allows the aggregation module to use the validation engine
 * without requiring a full ProfilePack to be loaded.
 */
function profileToProfilePack(profile: Profile, loadedPack?: ProfilePack): ProfilePack {
  return {
    meta: {
      name: profile.name,
      version: profile.version,
      description: `Auto-generated pack from profile ${profile.name}`,
    },
    kinds: profile.kinds.map(kind => ({
      id: kind,
      label: kind.charAt(0).toUpperCase() + kind.slice(1),
      roles: [],
    })),
    shapes: profile.shapes.map((shape, idx) => ({
      subject: shape.participatesIn[0] ?? '*',
      predicates: shape.participatesIn.map(pred => ({
        name: pred,
        targets: [shape.inferredKind],
      })),
    })),
    // Use rules from loaded pack if provided, otherwise empty
    rules: loadedPack?.rules ?? [],
    linkingRules: profile.artifactMappings.map(mapping => ({
      sourceRole: mapping.role as ArtifactRole,
      targetRole: mapping.role as ArtifactRole,
      predicate: 'RELATES_TO',
      confidence: 0.5,
    })),
    packPath: loadedPack?.packPath ?? '',
  };
}

/**
 * Load the starter profile pack from packages/profiles
 */
let cachedProfilePack: ProfilePack | null = null;
async function getProfilePack(): Promise<ProfilePack | undefined> {
  if (cachedProfilePack) return cachedProfilePack;
  try {
    // Try to resolve the profiles package path
    // From dist/pipeline -> packages/profiles/packs/starter/v1
    const packPath = path.resolve(__dirname, '../../profiles/packs/starter/v1');
    cachedProfilePack = await loadProfilePack(packPath);
    return cachedProfilePack;
  } catch {
    // If not found, try alternative path (for development)
    try {
      const altPath = path.resolve(__dirname, '../../../profiles/packs/starter/v1');
      cachedProfilePack = await loadProfilePack(altPath);
      return cachedProfilePack;
    } catch {
      return undefined;
    }
  }
}

// =============================================================================
// Aggregation Types (Local definitions for Phase 2)
// =============================================================================

/**
 * Validation finding
 */
export interface ValidationFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  entities?: string[];
}

/**
 * Coverage stage output
 */
export interface CoverageStageOutput {
  $schema: string;
  schemaVersion: string;
  stage: 'Coverage';
  summary: {
    totalArtifacts: number;
    totalConcepts: number;
    totalTransitions: number;
    avgConfidence: number;
    kindCounts: Record<string, number>;
    roleCounts: Record<string, number>;
  };
  artifacts: Array<{
    artifactId: string;
    artifactRole: string;
    conceptCount: number;
    transitionCount: number;
    kindCounts: Record<string, number>;
    avgConfidence: number;
  }>;
}

/**
 * Findings stage output
 */
export interface FindingsStageOutput {
  $schema: string;
  schemaVersion: string;
  stage: 'Validation';
  findings: ValidationFinding[];
  summary: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  };
}

// =============================================================================
// Aggregation Types
// =============================================================================

/**
 * Aggregation Input
 */
export interface AggregationInput {
  /** Run ID */
  runId: string;
  /** All artifact PX outputs to aggregate */
  artifactOutputs: PxStageOutput[];
}

/**
 * Aggregation Options
 */
export interface AggregationOptions {
  /** Whether to generate LX proposals */
  generateLxProposals?: boolean;
  /** Whether to calculate coverage metrics */
  calculateCoverage?: boolean;
  /** Whether to run validation checks */
  runValidation?: boolean;
  /** Minimum similarity for cross-artifact linking proposals */
  lxSimilarityThreshold?: number;
  /** Pre-loaded profile pack (if not provided, will attempt to load from disk) */
  profilePack?: ProfilePack;
}

const DEFAULT_OPTIONS: Required<Omit<AggregationOptions, 'profilePack'>> = {
  generateLxProposals: true,
  calculateCoverage: true,
  runValidation: true,
  lxSimilarityThreshold: 0.8,
};

/**
 * LX Proposal (cross-artifact linking candidate)
 */
export interface LxProposal {
  /** Proposal ID */
  id: string;
  /** Source concept ID */
  sourceId: string;
  /** Source artifact ID */
  sourceArtifact: string;
  /** Target concept ID */
  targetId: string;
  /** Target artifact ID */
  targetArtifact: string;
  /** Similarity score */
  similarity: number;
  /** Proposal type */
  type: 'same-entity' | 'related-entity' | 'hierarchy';
  /** Proposal confidence */
  confidence: number;
}

/**
 * Aggregate output combining all artifacts
 */
export interface AggregateOutput {
  /** All entities from all artifacts */
  entities: Array<Entity & { artifactId: string }>;
  /** All statements from all artifacts */
  statements: Array<Statement & { artifactId: string }>;
  /** LX proposals for cross-artifact linking */
  lxProposals: LinkProposal[];
  /** LX stage output (if generated) */
  lxOutput?: LxStageOutput;
  /** Coverage metrics (simple summary) */
  coverage: CoverageStageOutput;
  /** Validation findings (simple summary) */
  findings: FindingsStageOutput;
  /** Rich coverage report from coverageReport module (for file output) */
  coverageReport?: CoverageReport;
  /** Rich validation output from coreRules module (for file output) */
  validationOutput?: ValidationOutput;
}

// =============================================================================
// Cross-Artifact Linking
// =============================================================================

/**
 * Calculate name similarity (simple token overlap)
 */
function calculateNameSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/[\s_-]+/));
  const tokensB = new Set(b.toLowerCase().split(/[\s_-]+/));
  
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  
  return intersection.size / union.size;
}

/**
 * Generate LX proposals for cross-artifact entity linking
 */
function generateLxProposals(
  entities: Array<Entity & { artifactId: string }>,
  threshold: number
): LxProposal[] {
  const proposals: LxProposal[] = [];
  let proposalId = 0;
  
  // Group entities by artifact
  const byArtifact = new Map<string, Array<Entity & { artifactId: string }>>();
  for (const entity of entities) {
    const existing = byArtifact.get(entity.artifactId) ?? [];
    existing.push(entity);
    byArtifact.set(entity.artifactId, existing);
  }
  
  const artifactIds = [...byArtifact.keys()];
  
  // Compare entities across different artifacts
  for (let i = 0; i < artifactIds.length; i++) {
    for (let j = i + 1; j < artifactIds.length; j++) {
      const artifactA = artifactIds[i];
      const artifactB = artifactIds[j];
      const entitiesA = byArtifact.get(artifactA) ?? [];
      const entitiesB = byArtifact.get(artifactB) ?? [];
      
      for (const a of entitiesA) {
        for (const b of entitiesB) {
          // Same type check
          if (a.type !== b.type) continue;
          
          const similarity = calculateNameSimilarity(a.name, b.name);
          
          if (similarity >= threshold) {
            proposals.push({
              id: `lx-${proposalId++}`,
              sourceId: a.cgId,
              sourceArtifact: artifactA,
              targetId: b.cgId,
              targetArtifact: artifactB,
              similarity,
              type: similarity >= 0.95 ? 'same-entity' : 'related-entity',
              confidence: similarity,
            });
          }
        }
      }
    }
  }
  
  // Sort by similarity descending
  proposals.sort((a, b) => b.similarity - a.similarity);
  
  return proposals;
}

// =============================================================================
// Coverage Metrics
// =============================================================================

/**
 * Calculate coverage metrics across all artifacts
 */
function calculateCoverageMetrics(
  artifactOutputs: PxStageOutput[],
  entities: Array<Entity & { artifactId: string }>,
  statements: Array<Statement & { artifactId: string }>
): CoverageStageOutput {
  const artifactMetrics = artifactOutputs.map(output => {
    const artifactEntities = entities.filter(e => e.artifactId === output.artifactId);
    const artifactStatements = statements.filter(s => s.artifactId === output.artifactId);
    
    // Calculate type coverage
    const kindCounts: Record<string, number> = {};
    for (const e of artifactEntities) {
      kindCounts[e.type] = (kindCounts[e.type] ?? 0) + 1;
    }
    
    return {
      artifactId: output.artifactId,
      artifactRole: output.artifactRole,
      conceptCount: artifactEntities.length,
      transitionCount: artifactStatements.length,
      kindCounts,
      avgConfidence: artifactEntities.length > 0
        ? artifactEntities.reduce((sum, e) => sum + e.confidence, 0) / artifactEntities.length
        : 0,
    };
  });
  
  // Calculate overall metrics
  const totalConcepts = entities.length;
  const totalTransitions = statements.length;
  const avgConfidence = entities.length > 0
    ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
    : 0;
  
  // Count entities by type
  const kindCounts: Record<string, number> = {};
  for (const e of entities) {
    kindCounts[e.type] = (kindCounts[e.type] ?? 0) + 1;
  }
  
  // Count artifacts by role
  const roleCounts: Record<string, number> = {};
  for (const output of artifactOutputs) {
    roleCounts[output.artifactRole] = (roleCounts[output.artifactRole] ?? 0) + 1;
  }
  
  return {
    $schema: 'intentweave://schemas/coverage/v1',
    schemaVersion: '0.1',
    stage: 'Coverage',
    summary: {
      totalArtifacts: artifactOutputs.length,
      totalConcepts,
      totalTransitions,
      avgConfidence,
      kindCounts,
      roleCounts,
    },
    artifacts: artifactMetrics,
  };
}

// =============================================================================
// Validation Checks
// =============================================================================

/**
 * Run validation checks on aggregated data
 */
function runValidationChecks(
  entities: Array<Entity & { artifactId: string }>,
  statements: Array<Statement & { artifactId: string }>,
  lxProposals: LinkProposal[]
): FindingsStageOutput {
  const findings: ValidationFinding[] = [];
  
  // Check: Entities without evidence
  const entitiesWithoutEvidence = entities.filter(e => !e.evidence || e.evidence.length === 0);
  if (entitiesWithoutEvidence.length > 0) {
    findings.push({
      id: 'validation-001',
      severity: 'warning',
      category: 'completeness',
      message: `${entitiesWithoutEvidence.length} entities lack evidence`,
      entities: entitiesWithoutEvidence.slice(0, 10).map(e => e.cgId),
    });
  }
  
  // Check: Low confidence entities
  const lowConfidenceEntities = entities.filter(e => e.confidence < 0.5);
  if (lowConfidenceEntities.length > 0) {
    findings.push({
      id: 'validation-002',
      severity: 'info',
      category: 'quality',
      message: `${lowConfidenceEntities.length} entities have low confidence (<0.5)`,
      entities: lowConfidenceEntities.slice(0, 10).map(e => e.cgId),
    });
  }
  
  // Check: Orphan statements (referencing non-existent entities)
  const entityIds = new Set(entities.map(e => e.cgId));
  const orphanStatements = statements.filter(s => {
    const refs = [s.subjectCgId, s.objectCgId].filter(Boolean);
    return refs.some(ref => ref && !entityIds.has(ref));
  });
  if (orphanStatements.length > 0) {
    findings.push({
      id: 'validation-003',
      severity: 'warning',
      category: 'integrity',
      message: `${orphanStatements.length} statements reference non-existent entities`,
      entities: orphanStatements.map(s => s.id ?? `${s.subjectCgId}-${s.predicate}`),
    });
  }
  
  // Check: Possible duplicate entities (high confidence LX proposals)
  const possibleDupes = lxProposals.filter(p => p.confidence >= 0.95);
  if (possibleDupes.length > 0) {
    findings.push({
      id: 'validation-004',
      severity: 'info',
      category: 'deduplication',
      message: `${possibleDupes.length} possible duplicate entities across artifacts`,
      entities: possibleDupes.map(p => `${p.sourceCgId} <-> ${p.targetCgId}`),
    });
  }
  
  // Check: Entities by artifact
  const artifactEntityCounts = new Map<string, number>();
  for (const e of entities) {
    artifactEntityCounts.set(
      e.artifactId, 
      (artifactEntityCounts.get(e.artifactId) ?? 0) + 1
    );
  }
  
  // Check: States not in transitions
  const statesInStatements = new Set<string>();
  for (const s of statements) {
    if (s.predicate === 'TRANSITIONS_TO' || s.predicate === 'FROM_STATE' || s.predicate === 'TO_STATE') {
      statesInStatements.add(s.subjectCgId);
      if (s.objectCgId) statesInStatements.add(s.objectCgId);
    }
  }
  const statesNotInTransitions = entities
    .filter(e => e.type === 'state' && !statesInStatements.has(e.cgId));
  if (statesNotInTransitions.length > 0) {
    findings.push({
      id: 'validation-005',
      severity: 'info',
      category: 'graph',
      message: `${statesNotInTransitions.length} states not connected to any transition`,
      entities: statesNotInTransitions.map(e => e.cgId),
    });
  }
  
  return {
    $schema: 'intentweave://schemas/findings/v1',
    schemaVersion: '0.1',
    stage: 'Validation',
    findings,
    summary: {
      total: findings.length,
      byCategory: findings.reduce((acc, f) => {
        acc[f.category] = (acc[f.category] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      bySeverity: findings.reduce((acc, f) => {
        acc[f.severity] = (acc[f.severity] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    },
  };
}

// =============================================================================
// Aggregation Entry Point
// =============================================================================

/**
 * Run aggregation on all artifact outputs
 */
export async function runAggregation(
  input: AggregationInput,
  ctx: PipelineContext,
  options: AggregationOptions = {}
): Promise<AggregateOutput> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  const { artifactOutputs } = input;
  
  // Collect all entities and statements with artifact IDs
  const entities: Array<Entity & { artifactId: string }> = [];
  const statements: Array<Statement & { artifactId: string }> = [];
  
  for (const output of artifactOutputs) {
    const artifactEntities = getFilteredEntities(output);
    const artifactStatements = getFilteredStatements(output);
    
    for (const e of artifactEntities) {
      entities.push({ ...e, artifactId: output.artifactId });
    }
    
    for (const s of artifactStatements) {
      statements.push({ ...s, artifactId: output.artifactId });
    }
  }
  
  // Generate LX proposals using LX-Core
  let lxProposals: LinkProposal[] = [];
  let lxOutput: LxStageOutput | null = null;
  if (opts.generateLxProposals) {
    // Convert PX outputs to LX inputs
    const lxInputs: LxArtifactInput[] = artifactOutputs.map(px => ({
      artifactId: px.artifactId,
      filePath: px.artifactId, // Use artifactId as filePath if not available
      artifactRole: px.artifactRole,
      entities: px.entities,
    }));
    
    // Run LX-Core linking
    lxOutput = await runLxCore(lxInputs, {
      workspaceKey: ctx.workspace.key,
      runId: ctx.runId,
      profile: ctx.profile,
      minConfidence: opts.lxSimilarityThreshold,
    });
    
    lxProposals = lxOutput.proposals;
    ctx.logger.debug(`Generated ${lxProposals.length} LX proposals via LX-Core`);
  }
  
  // Calculate coverage
  let coverage: CoverageStageOutput;
  let coverageReport: CoverageReport | undefined;
  if (opts.calculateCoverage) {
    coverage = calculateCoverageMetrics(artifactOutputs, entities, statements);
    
    // Build entities and statements with artifactRole for rich coverage
    const entitiesWithRole = entities.map(e => {
      const px = artifactOutputs.find(p => p.artifactId === e.artifactId);
      return { ...e, artifactRole: (px?.artifactRole ?? 'code') as ArtifactRole };
    });
    const statementsWithRole = statements.map(s => {
      const px = artifactOutputs.find(p => p.artifactId === s.artifactId);
      return { ...s, artifactRole: (px?.artifactRole ?? 'code') as ArtifactRole };
    });
    
    // Also generate the rich coverage report
    const coverageInput: CoverageReportInput = {
      entities: entitiesWithRole,
      statements: statementsWithRole,
      linkProposals: lxProposals,
      artifacts: artifactOutputs.map(px => ({
        artifactId: px.artifactId,
        artifactRole: px.artifactRole as ArtifactRole,
      })),
    };
    const coverageOptions: CoverageReportOptions = {
      runId: input.runId,
      workspaceKey: ctx.workspace.key,
      minLinkConfidence: opts.lxSimilarityThreshold,
    };
    coverageReport = generateCoverageReport(coverageInput, coverageOptions);
    ctx.logger.debug(`Generated coverage report`, {
      roleTransitions: coverageReport.roleTransitions?.length ?? 0,
      inconsistencies: coverageReport.inconsistencies?.length ?? 0,
      incompletenesses: coverageReport.incompletenesses?.length ?? 0,
    });
  } else {
    coverage = {
      $schema: 'intentweave://schemas/coverage/v1',
      schemaVersion: '0.1',
      stage: 'Coverage',
      summary: {
        totalArtifacts: artifactOutputs.length,
        totalConcepts: entities.length,
        totalTransitions: statements.length,
        avgConfidence: 0,
        kindCounts: {},
        roleCounts: {},
      },
      artifacts: [],
    };
  }
  
  // Run validation
  let findings: FindingsStageOutput;
  let validationOutput: ValidationOutput | undefined;
  if (opts.runValidation) {
    findings = runValidationChecks(entities, statements, lxProposals);
    
    // Load profile pack for rules (use provided pack or load from disk)
    const loadedPack = opts.profilePack ?? await getProfilePack();
    if (loadedPack) {
      ctx.logger.debug(`Loaded profile pack for validation`, {
        packName: loadedPack.meta.name,
        rulesCount: loadedPack.rules.length,
      });
    }
    
    // Also run the core validation engine for rich output
    // Entities and statements need artifactRole for validation
    const validationEntities = entities.map(e => {
      const px = artifactOutputs.find(p => p.artifactId === e.artifactId);
      return { ...e, artifactRole: (px?.artifactRole ?? 'code') as ArtifactRole };
    });
    const validationStatements = statements.map(s => {
      const px = artifactOutputs.find(p => p.artifactId === s.artifactId);
      return { ...s, artifactRole: (px?.artifactRole ?? 'code') as ArtifactRole };
    });
    
    const validationInput: ValidationInput = {
      entities: validationEntities,
      statements: validationStatements,
      linkProposals: lxProposals,
      profilePack: profileToProfilePack(ctx.profile, loadedPack),
    };
    
    validationOutput = runCoreValidation(validationInput);
    ctx.logger.debug(`Core validation complete`, {
      findings: validationOutput.findings.length,
      rulesExecuted: validationOutput.rulesExecuted,
      timeMs: validationOutput.executionTimeMs,
    });
    
    // Merge core validation findings into findings output
    if (validationOutput.findings.length > 0) {
      for (const coreFinding of validationOutput.findings) {
        findings.findings.push({
          id: coreFinding.ruleId,
          severity: coreFinding.severity,
          category: 'semantic',
          message: coreFinding.message,
          entities: coreFinding.entityCgId ? [coreFinding.entityCgId] : [],
        });
      }
      // Update summary
      findings.summary.total = findings.findings.length;
      for (const f of findings.findings) {
        findings.summary.byCategory[f.category] = (findings.summary.byCategory[f.category] || 0) + 1;
        findings.summary.bySeverity[f.severity] = (findings.summary.bySeverity[f.severity] || 0) + 1;
      }
    }
  } else {
    findings = {
      $schema: 'intentweave://schemas/findings/v1',
      schemaVersion: '0.1',
      stage: 'Validation',
      findings: [],
      summary: {
        total: 0,
        byCategory: {},
        bySeverity: {},
      },
    };
  }
  
  const processingTimeMs = Date.now() - startTime;
  
  ctx.logger.info(`Aggregation complete`, {
    artifacts: artifactOutputs.length,
    entities: entities.length,
    statements: statements.length,
    lxProposals: lxProposals.length,
    findings: findings.findings.length,
    timeMs: processingTimeMs,
  });
  
  return {
    entities,
    statements,
    lxProposals,
    lxOutput: lxOutput ?? undefined,
    coverage,
    findings,
    coverageReport,
    validationOutput,
  };
}

/**
 * LX Proposals output format for aggregate/lx.proposals.json
 */
export interface LxProposalsFile {
  $schema: string;
  schemaVersion: string;
  stage: 'LX';
  processedAt: string;
  proposals: LxProposal[];
  meta: {
    proposalCount: number;
    sameConceptCount: number;
    relatedConceptCount: number;
    avgSimilarity: number;
  };
}

/**
 * Format LX proposals for file output
 */
export function formatLxProposals(
  proposals: LxProposal[],
  processedAt: string
): LxProposalsFile {
  const sameEntityCount = proposals.filter(p => p.type === 'same-entity').length;
  const relatedEntityCount = proposals.filter(p => p.type === 'related-entity').length;
  const avgSimilarity = proposals.length > 0
    ? proposals.reduce((sum, p) => sum + p.similarity, 0) / proposals.length
    : 0;
  
  return {
    $schema: 'intentweave://schemas/lx-proposals/json',
    schemaVersion: '0.1',
    stage: 'LX',
    processedAt,
    proposals,
    meta: {
      proposalCount: proposals.length,
      sameConceptCount: sameEntityCount,
      relatedConceptCount: relatedEntityCount,
      avgSimilarity,
    },
  };
}

// =============================================================================
// Persistence
// =============================================================================

/**
 * Convert simple coverage to store format
 */
function coverageStageToStoreFormat(
  coverage: CoverageStageOutput,
  runId: string
): { runId: string; coverage: Record<string, unknown>; overall: { total: number; linked: number; percentage: number } } {
  return {
    runId,
    coverage: coverage.summary.kindCounts,
    overall: {
      total: coverage.summary.totalConcepts,
      linked: coverage.summary.totalConcepts, // All are "linked" in simple view
      percentage: 100,
    },
  };
}

/**
 * Convert simple findings to store format
 */
function findingsStageToStoreFormat(
  findings: FindingsStageOutput,
  runId: string
): { runId: string; findings: ValidationFinding[]; summary: { errors: number; warnings: number; info: number } } {
  return {
    runId,
    findings: findings.findings,
    summary: {
      errors: findings.summary.bySeverity['error'] ?? 0,
      warnings: findings.summary.bySeverity['warning'] ?? 0,
      info: findings.summary.bySeverity['info'] ?? 0,
    },
  };
}

/**
 * Persist aggregate output to the store
 * 
 * Writes the following files to aggregate/:
 * - lx.proposals.json (with $schema)
 * - coverage.json (with $schema)
 * - findings.json (with $schema)
 * - coverage-report.json (rich, with $schema)
 * - validation.json (rich, with $schema)
 * 
 * @param output - The aggregate output to persist
 * @param runId - The run ID
 * @param runStore - The run store with saveAggregates method
 * @param logger - Optional logger for debug output
 */
export async function persistAggregateOutput(
  output: AggregateOutput,
  runId: string,
  runStore: { saveAggregates(runId: string, aggregates: Record<string, unknown>): Promise<void> },
  logger?: { debug(msg: string, meta?: Record<string, unknown>): void }
): Promise<void> {
  await runStore.saveAggregates(runId, {
    linkProposals: output.lxProposals,
    coverage: coverageStageToStoreFormat(output.coverage, runId),
    findings: findingsStageToStoreFormat(output.findings, runId),
    richCoverage: output.coverageReport,
    richValidation: output.validationOutput,
  });
  
  logger?.debug('Persisted aggregate output', {
    runId,
    lxProposalCount: output.lxProposals.length,
    hasCoverageReport: !!output.coverageReport,
    hasValidationOutput: !!output.validationOutput,
  });
}