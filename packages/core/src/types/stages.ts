// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage Output Schema Types
 * 
 * Defines the output types for each pipeline stage.
 * All stage outputs include $schema URI and schemaVersion for validation.
 * 
 * Per-artifact stages: IN → RX → CX → MX → PX
 * Per-run aggregation: LX, Coverage, Validation
 */

import type { Entity, Statement, Evidence } from './index.js';

// =============================================================================
// Schema Constants
// =============================================================================

/**
 * Schema URIs for each stage output
 */
export const STAGE_SCHEMAS = {
  in: 'intentweave://schemas/in-graph/v1',
  rx: 'intentweave://schemas/rx-graph/v1',
  cx: 'intentweave://schemas/cx-graph/v1',
  mx: 'intentweave://schemas/mx-graph/v1',
  px: 'intentweave://schemas/px-graph/v1',
  lx: 'intentweave://schemas/lx-proposals/v1',
  coverage: 'intentweave://schemas/coverage/v1',
  findings: 'intentweave://schemas/findings/v1',
} as const;

export type StageSchemaType = keyof typeof STAGE_SCHEMAS;

/**
 * Current schema version (semantic version string)
 */
export const CURRENT_SCHEMA_VERSION = '0.1' as const;

// =============================================================================
// Base Stage Output
// =============================================================================

/**
 * Base interface for all stage outputs
 */
export interface BaseStageOutput {
  /** JSON Schema URI for validation */
  $schema: string;
  /** Semantic version of the schema */
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  /** Stage identifier */
  stage: string;
  /** Artifact ID (for per-artifact stages) */
  artifactId?: string;
  /** Run ID (for aggregate stages) */
  runId?: string;
  /** Workspace key */
  workspaceKey?: string;
  /** Processing timestamp */
  processedAt: string;
}

// =============================================================================
// IN Stage (Ingestion)
// =============================================================================

/**
 * Semantic chunk from input file
 */
export interface SemanticChunk {
  /** Chunk identifier */
  id: string;
  /** Chunk content */
  content: string;
  /** Chunk type (section, block, paragraph, etc.) */
  type: 'section' | 'block' | 'paragraph' | 'code' | 'heading' | 'list' | 'other';
  /** Heading level (if applicable) */
  headingLevel?: number;
  /** Section title (if section type) */
  title?: string;
  /** Start line in source (1-based) */
  startLine: number;
  /** End line in source (1-based) */
  endLine: number;
  /** Start character offset */
  startChar?: number;
  /** End character offset */
  endChar?: number;
  /** Parent chunk ID (for hierarchical structure) */
  parentId?: string;
  /** Child chunk IDs */
  childIds?: string[];
  /** Chunk metadata */
  metadata?: Record<string, unknown>;
}

/**
 * IN Stage Output - Ingestion result
 */
export interface InStageOutput extends BaseStageOutput {
  $schema: typeof STAGE_SCHEMAS.in;
  stage: 'IN';
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Artifact format (markdown, typescript, etc.) */
  artifactFormat: string;
  /** Detected artifact role */
  artifactRole?: string;
  /** Semantic chunks extracted from input */
  chunks: SemanticChunk[];
  /** Ingestion metadata */
  meta: {
    /** Total chunks created */
    chunkCount: number;
    /** Total lines in source */
    totalLines: number;
    /** Total characters in source */
    totalChars: number;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

// =============================================================================
// RX Stage (Raw Extraction)
// =============================================================================

/**
 * RX Stage Output - Extraction result
 */
export interface RxStageOutput extends BaseStageOutput {
  $schema: typeof STAGE_SCHEMAS.rx;
  stage: 'RX';
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Extracted entities */
  entities: Entity[];
  /** Extracted statements */
  statements: Statement[];
  /** Evidence linking to source */
  evidence: Evidence[];
  /** Extraction metadata */
  meta: {
    /** Extraction provider name */
    provider: string;
    /** LLM provider name (if LLM-backed) */
    llmProvider?: string;
    /** Model used */
    model?: string;
    /** Total latency in ms */
    latencyMs: number;
    /** Tokens used (if LLM-backed) */
    tokensUsed?: number;
    /** Chunks processed */
    chunksProcessed: number;
    /** Profiles applied */
    profiles?: string[];
  };
}

// =============================================================================
// CX Stage (Consolidation)
// =============================================================================

/**
 * Alias created during normalization
 */
export interface AliasMapping {
  /** Original value */
  from: string;
  /** Normalized value */
  to: string;
  /** Rule that created the alias */
  rule: 'shape-inference' | 'canonicalization' | 'dedup' | 'manual';
  /** Confidence of the mapping */
  confidence?: number;
}

/**
 * CX Stage Output - Consolidation result
 */
export interface CxStageOutput extends BaseStageOutput {
  $schema: typeof STAGE_SCHEMAS.cx;
  stage: 'CX';
  artifactId: string;
  /** Parent stage */
  parentStage: 'RX';
  /** Source file path */
  filePath: string;
  /** Consolidated entities */
  entities: Entity[];
  /** Consolidated statements */
  statements: Statement[];
  /** Evidence */
  evidence: Evidence[];
  /** Aliases created during normalization */
  aliases: AliasMapping[];
  /** Consolidation metadata */
  meta: {
    /** Kind inferences applied */
    kindInferences: number;
    /** Entities merged */
    merges: number;
    /** Aliases created */
    aliasesCreated: number;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

// =============================================================================
// MX Stage (Materialization)
// =============================================================================

/**
 * Transition binding created during materialization
 */
export interface TransitionBinding {
  /** Transition entity cgId */
  transitionCgId: string;
  /** Source state cgId */
  fromStateCgId: string;
  /** Target state cgId */
  toStateCgId: string;
  /** Trigger action cgId (if any) */
  triggerCgId?: string;
  /** Guard condition cgId (if any) */
  guardCgId?: string;
}

/**
 * MX Stage Output - Materialization result
 */
export interface MxStageOutput extends BaseStageOutput {
  $schema: typeof STAGE_SCHEMAS.mx;
  stage: 'MX';
  artifactId: string;
  /** Parent stage */
  parentStage: 'CX';
  /** Source file path */
  filePath: string;
  /** Materialized entities (includes transitions) */
  entities: Entity[];
  /** Materialized statements (includes FROM_STATE, TO_STATE, TRIGGERS) */
  statements: Statement[];
  /** Evidence */
  evidence: Evidence[];
  /** Transition bindings created */
  transitionBindings: TransitionBinding[];
  /** Materialization metadata */
  meta: {
    /** Transitions created */
    transitionsCreated: number;
    /** Actions bound to transitions */
    actionsBound: number;
    /** Guards bound to transitions */
    guardsBound: number;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

// =============================================================================
// PX Stage (Presentation)
// =============================================================================

/**
 * Filtering decision for an entity
 */
export interface FilterDecision {
  /** Entity cgId */
  cgId: string;
  /** Whether entity was kept */
  kept: boolean;
  /** Reason for decision */
  reason: 'profile-match' | 'confidence-threshold' | 'kind-filter' | 'explicit-include' | 'explicit-exclude';
  /** Original confidence (if filtered by confidence) */
  originalConfidence?: number;
}

/**
 * PX Stage Output - Presentation result
 */
export interface PxStageOutput extends BaseStageOutput {
  $schema: typeof STAGE_SCHEMAS.px;
  stage: 'PX';
  artifactId: string;
  /** Parent stage */
  parentStage: 'MX';
  /** Source file path */
  filePath: string;
  /** Artifact role (from profile mapping) */
  artifactRole?: string;
  /** Filtered entities (presentation-ready) */
  entities: Entity[];
  /** Filtered statements */
  statements: Statement[];
  /** Evidence */
  evidence: Evidence[];
  /** Filtering decisions (for debugging) */
  filterDecisions?: FilterDecision[];
  /** Presentation metadata */
  meta: {
    /** Profile used for filtering */
    profile: string;
    /** Entities before filtering */
    entitiesBeforeFilter: number;
    /** Entities after filtering */
    entitiesAfterFilter: number;
    /** Statements before filtering */
    statementsBeforeFilter: number;
    /** Statements after filtering */
    statementsAfterFilter: number;
    /** Confidence threshold applied */
    confidenceThreshold: number;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

// =============================================================================
// Aggregate Outputs
// =============================================================================

/**
 * Coverage metrics for artifact linking
 */
export interface CoverageMetrics {
  /** Total entities in source artifact role */
  total: number;
  /** Linked entities count */
  linked: number;
  /** Coverage ratio (0-1) */
  coverage: number;
  /** Unlinked entity cgIds */
  unlinked: Array<{
    cgId: string;
    kind: string;
    name: string;
  }>;
}

/**
 * Coverage stage output
 */
export interface CoverageStageOutput extends BaseStageOutput {
  $schema: typeof STAGE_SCHEMAS.coverage;
  stage: 'COVERAGE';
  runId: string;
  workspaceKey: string;
  /** Coverage by artifact role pair */
  coverage: {
    'spec→impl'?: CoverageMetrics;
    'prompt→spec'?: CoverageMetrics;
    [key: string]: CoverageMetrics | undefined;
  };
  /** Detected inconsistencies */
  inconsistencies: Array<{
    type: 'semantic-drift' | 'naming-mismatch' | 'kind-mismatch';
    description: string;
    instances: Array<Record<string, string>>;
  }>;
  /** Detected incompletenesses */
  incompletenesses: Array<{
    type: 'missing-impl' | 'missing-spec' | 'orphan-entity';
    description: string;
    count: number;
    items: string[];
  }>;
  /** Coverage metadata */
  meta: {
    /** Strategy used */
    strategy: string;
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

/**
 * Validation finding
 */
export interface ValidationFinding {
  /** Finding ID */
  id: string;
  /** Rule that produced the finding */
  ruleId: string;
  /** Severity level */
  severity: 'error' | 'warning' | 'info';
  /** Affected entity cgId (if applicable) */
  entityCgId?: string;
  /** Affected statement ID (if applicable) */
  statementId?: string;
  /** Human-readable message */
  message: string;
  /** Suggested fix */
  suggestion?: string;
}

/**
 * Findings stage output
 */
export interface FindingsStageOutput extends BaseStageOutput {
  $schema: typeof STAGE_SCHEMAS.findings;
  stage: 'FINDINGS';
  runId: string;
  workspaceKey: string;
  /** Rules applied */
  rulesApplied: string[];
  /** Validation findings */
  findings: ValidationFinding[];
  /** Summary counts */
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  /** Findings metadata */
  meta: {
    /** Processing time in ms */
    processingTimeMs: number;
  };
}

// =============================================================================
// Type Guards
// =============================================================================

export function isInStageOutput(output: unknown): output is InStageOutput {
  return typeof output === 'object' && output !== null && (output as BaseStageOutput).stage === 'IN';
}

export function isRxStageOutput(output: unknown): output is RxStageOutput {
  return typeof output === 'object' && output !== null && (output as BaseStageOutput).stage === 'RX';
}

export function isCxStageOutput(output: unknown): output is CxStageOutput {
  return typeof output === 'object' && output !== null && (output as BaseStageOutput).stage === 'CX';
}

export function isMxStageOutput(output: unknown): output is MxStageOutput {
  return typeof output === 'object' && output !== null && (output as BaseStageOutput).stage === 'MX';
}

export function isPxStageOutput(output: unknown): output is PxStageOutput {
  return typeof output === 'object' && output !== null && (output as BaseStageOutput).stage === 'PX';
}
