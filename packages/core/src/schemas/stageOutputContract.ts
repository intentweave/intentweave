// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified Stage Output Contract
 *
 * Normalizes stage output formats between:
 * - Server/Interactive mode: Uses StagingSnapshot (simple { entities, statements })
 * - Core/Rich mode: Uses RxStageOutput, CxStageOutput, MxStageOutput, PxStageOutput
 *
 * This contract provides:
 * 1. Re-exports of existing stage output types from types/stages.ts
 * 2. Converters: StagingSnapshot -> Core Stage Output
 * 3. Serializers for rx.json, cx.json, mx.json, px.json format compatibility
 *
 * Goal: Both modes can produce the same JSON output format for parity testing
 * and analysis tools.
 *
 * @version 1.0.0
 */

import type {
  Entity,
  Statement,
  Evidence,
  StagingSnapshot,
} from "../types/index.js";
import {
  type InStageOutput,
  type RxStageOutput,
  type CxStageOutput,
  type MxStageOutput,
  type PxStageOutput,
  type AliasMapping,
  type FilterDecision,
  type BaseStageOutput,
  STAGE_SCHEMAS,
  CURRENT_SCHEMA_VERSION,
} from "../types/stages.js";

// Re-export stage types for consumers of this module
export type {
  InStageOutput,
  RxStageOutput,
  CxStageOutput,
  MxStageOutput,
  PxStageOutput,
  AliasMapping,
  FilterDecision,
  BaseStageOutput,
};

export { STAGE_SCHEMAS, CURRENT_SCHEMA_VERSION };

// =============================================================================
// Contract-Specific Types (not in stages.ts)
// =============================================================================

/**
 * Stage identifiers
 */
export type StageId = "IN" | "RX" | "CX" | "MX" | "PX" | "LX" | "AGG";

/**
 * Base processing metadata for converters
 */
export interface StageMetadata {
  /** Entities count */
  entityCount: number;
  /** Statements count */
  statementCount: number;
  /** Processing time in ms */
  processingTimeMs: number;
}

/**
 * Normalization record for CX stage
 */
export interface NormalizationRecord {
  /** Entity cgId */
  cgId: string;
  /** Type of normalization */
  type: "name" | "kind" | "merge";
  /** Original value */
  from: string;
  /** New value */
  to: string;
  /** Reason */
  reason: string;
}

/**
 * Complete artifact pipeline output (all stages)
 */
export interface ArtifactPipelineOutput {
  artifactId: string;
  in: InStageOutput;
  rx: RxStageOutput;
  cx: CxStageOutput;
  mx: MxStageOutput;
  px: PxStageOutput;
}

/**
 * Server stage envelope (tracking which stages have run)
 */
export interface ServerStageEnvelope {
  artifactId: string;
  rx: StagingSnapshot;
  cx?: StagingSnapshot;
  mx?: StagingSnapshot;
  px?: StagingSnapshot;
  stagesRun: StageId[];
  meta: {
    provider?: string;
    model?: string;
    latencyMs?: number;
    tokensUsed?: number;
    processedAt: string;
  };
}

// =============================================================================
// Converters: StagingSnapshot -> Core Stage Output
// =============================================================================

/**
 * Schema URLs for stage outputs (external references)
 */
export const STAGE_SCHEMA_URLS = {
  IN: "https://intentweave.dev/schemas/in-stage-output.json",
  RX: "https://intentweave.dev/schemas/rx-stage-output.json",
  CX: "https://intentweave.dev/schemas/cx-stage-output.json",
  MX: "https://intentweave.dev/schemas/mx-stage-output.json",
  PX: "https://intentweave.dev/schemas/px-stage-output.json",
} as const;

/**
 * Convert StagingSnapshot to RxStageOutput format
 */
export function toRxStageOutput(
  snapshot: StagingSnapshot,
  artifactId: string,
  options: {
    filePath?: string;
    provider?: string;
    model?: string;
    latencyMs?: number;
    tokensUsed?: number;
  } = {},
): RxStageOutput {
  const now = new Date().toISOString();

  // Extract evidence from statements
  const evidence: Evidence[] = snapshot.statements
    .filter((s: Statement) => s.evidence && s.evidence.length > 0)
    .flatMap((s: Statement) => s.evidence ?? []);

  return {
    $schema: STAGE_SCHEMAS.rx,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "RX",
    artifactId,
    processedAt: now,
    filePath: options.filePath ?? artifactId,
    entities: snapshot.entities,
    statements: snapshot.statements,
    evidence,
    meta: {
      provider: options.provider ?? "server",
      model: options.model,
      latencyMs: options.latencyMs ?? 0,
      tokensUsed: options.tokensUsed,
      chunksProcessed: 1,
    },
  };
}

/**
 * Convert StagingSnapshot to CxStageOutput format
 */
export function toCxStageOutput(
  snapshot: StagingSnapshot,
  artifactId: string,
  options: {
    filePath?: string;
    aliases?: AliasMapping[];
    processingTimeMs?: number;
  } = {},
): CxStageOutput {
  const now = new Date().toISOString();

  const evidence: Evidence[] = snapshot.statements
    .filter((s: Statement) => s.evidence && s.evidence.length > 0)
    .flatMap((s: Statement) => s.evidence ?? []);

  return {
    $schema: STAGE_SCHEMAS.cx,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "CX",
    artifactId,
    parentStage: "RX",
    processedAt: now,
    filePath: options.filePath ?? artifactId,
    entities: snapshot.entities,
    statements: snapshot.statements,
    evidence,
    aliases: options.aliases ?? [],
    meta: {
      kindInferences: 0,
      merges: 0,
      aliasesCreated: options.aliases?.length ?? 0,
      processingTimeMs: options.processingTimeMs ?? 0,
    },
  };
}

/**
 * Convert StagingSnapshot to MxStageOutput format
 */
export function toMxStageOutput(
  snapshot: StagingSnapshot,
  artifactId: string,
  options: {
    filePath?: string;
    transitionsCreated?: number;
    processingTimeMs?: number;
  } = {},
): MxStageOutput {
  const now = new Date().toISOString();

  const evidence: Evidence[] = snapshot.statements
    .filter((s: Statement) => s.evidence && s.evidence.length > 0)
    .flatMap((s: Statement) => s.evidence ?? []);

  return {
    $schema: STAGE_SCHEMAS.mx,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "MX",
    artifactId,
    parentStage: "CX",
    processedAt: now,
    filePath: options.filePath ?? artifactId,
    entities: snapshot.entities,
    statements: snapshot.statements,
    evidence,
    transitionBindings: [],
    meta: {
      transitionsCreated: options.transitionsCreated ?? 0,
      actionsBound: 0,
      guardsBound: 0,
      processingTimeMs: options.processingTimeMs ?? 0,
    },
  };
}

/**
 * Convert StagingSnapshot to PxStageOutput format
 */
export function toPxStageOutput(
  snapshot: StagingSnapshot,
  artifactId: string,
  options: {
    filePath?: string;
    artifactRole?: string;
    filterDecisions?: FilterDecision[];
    processingTimeMs?: number;
    entitiesBeforeFilter?: number;
    statementsBeforeFilter?: number;
    confidenceThreshold?: number;
    profile?: string;
  } = {},
): PxStageOutput {
  const now = new Date().toISOString();

  const evidence: Evidence[] = snapshot.statements
    .filter((s: Statement) => s.evidence && s.evidence.length > 0)
    .flatMap((s: Statement) => s.evidence ?? []);

  return {
    $schema: STAGE_SCHEMAS.px,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "PX",
    artifactId,
    parentStage: "MX",
    processedAt: now,
    filePath: options.filePath ?? artifactId,
    artifactRole: options.artifactRole,
    entities: snapshot.entities,
    statements: snapshot.statements,
    evidence,
    filterDecisions: options.filterDecisions,
    meta: {
      profile: options.profile ?? "default",
      entitiesBeforeFilter:
        options.entitiesBeforeFilter ?? snapshot.entities.length,
      entitiesAfterFilter: snapshot.entities.length,
      statementsBeforeFilter:
        options.statementsBeforeFilter ?? snapshot.statements.length,
      statementsAfterFilter: snapshot.statements.length,
      confidenceThreshold: options.confidenceThreshold ?? 0.5,
      processingTimeMs: options.processingTimeMs ?? 0,
    },
  };
}

/**
 * Convert ServerStageEnvelope to ArtifactPipelineOutput format
 *
 * This allows server outputs to be compared directly with core outputs
 */
export function serverEnvelopeToArtifactOutput(
  envelope: ServerStageEnvelope,
  content: string = "",
): ArtifactPipelineOutput {
  const artifactId = envelope.artifactId;
  const filePath = artifactId;

  // Build IN stage (minimal)
  const inOutput: InStageOutput = {
    $schema: STAGE_SCHEMAS.in,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    stage: "IN",
    artifactId,
    processedAt: envelope.meta.processedAt,
    filePath,
    artifactFormat: "text",
    chunks: [
      {
        id: `${artifactId}:chunk:0`,
        content,
        type: "block",
        startLine: 1,
        endLine: content.split("\n").length,
      },
    ],
    meta: {
      chunkCount: 1,
      totalLines: content.split("\n").length,
      totalChars: content.length,
      processingTimeMs: 0,
    },
  };

  // Convert RX
  const rxOutput = toRxStageOutput(envelope.rx, artifactId, {
    filePath,
    provider: envelope.meta.provider,
    model: envelope.meta.model,
    latencyMs: envelope.meta.latencyMs,
    tokensUsed: envelope.meta.tokensUsed,
  });

  // Convert CX (or use RX if not run)
  const cxOutput = toCxStageOutput(envelope.cx ?? envelope.rx, artifactId, {
    filePath,
  });

  // Convert MX (or use CX if not run)
  const mxOutput = toMxStageOutput(
    envelope.mx ?? envelope.cx ?? envelope.rx,
    artifactId,
    { filePath },
  );

  // Convert PX (or use MX if not run)
  const pxOutput = toPxStageOutput(
    envelope.px ?? envelope.mx ?? envelope.cx ?? envelope.rx,
    artifactId,
    { filePath },
  );

  return {
    artifactId,
    in: inOutput,
    rx: rxOutput,
    cx: cxOutput,
    mx: mxOutput,
    px: pxOutput,
  };
}

// =============================================================================
// Converters: Core Stage Output -> StagingSnapshot
// =============================================================================

/**
 * Extract StagingSnapshot from any stage output
 */
export function toStagingSnapshot(
  stageOutput: RxStageOutput | CxStageOutput | MxStageOutput | PxStageOutput,
): StagingSnapshot {
  return {
    entities: stageOutput.entities,
    statements: stageOutput.statements,
  };
}

/**
 * Extract final snapshot from ArtifactPipelineOutput
 * Uses PX (filtered) output as the final state
 */
export function getFinalSnapshot(
  output: ArtifactPipelineOutput,
): StagingSnapshot {
  return toStagingSnapshot(output.px);
}

// =============================================================================
// JSON Serializers (for file output)
// =============================================================================

/**
 * Serialize stage output to JSON string
 */
export function serializeStageOutput(
  output:
    | InStageOutput
    | RxStageOutput
    | CxStageOutput
    | MxStageOutput
    | PxStageOutput,
): string {
  return JSON.stringify(output, null, 2);
}

/**
 * Write stage outputs to files (CLI-compatible format)
 */
export interface StageOutputFiles {
  "in.json": string;
  "rx.json": string;
  "cx.json": string;
  "mx.json": string;
  "px.json": string;
}

export function serializeAllStageOutputs(
  output: ArtifactPipelineOutput,
): StageOutputFiles {
  return {
    "in.json": serializeStageOutput(output.in),
    "rx.json": serializeStageOutput(output.rx),
    "cx.json": serializeStageOutput(output.cx),
    "mx.json": serializeStageOutput(output.mx),
    "px.json": serializeStageOutput(output.px),
  };
}
