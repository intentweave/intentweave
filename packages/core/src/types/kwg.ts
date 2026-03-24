// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWG (Keyword Graph) Types — Phase A Evidence Graph
 *
 * The KWG is the evidence layer of the IntentWeave knowledge graph.
 * It extracts keyword mentions from documents, computes co-occurrence
 * relationships, and clusters related entities — all without LLM calls.
 *
 * Pipeline: KWX (keyword extraction) → COX (co-occurrence) → CLX (clustering)
 *
 * @version 0.1
 */

import type { BaseStageOutput } from "./stages.js";
import { CURRENT_SCHEMA_VERSION } from "./stages.js";

// Re-export for convenience
export { CURRENT_SCHEMA_VERSION };

// =============================================================================
// Schema Constants
// =============================================================================

/**
 * Schema URIs for KWG stage outputs
 */
export const KWG_SCHEMAS = {
  kwx: "intentweave://schemas/kwx/v1",
  cox: "intentweave://schemas/cox/v1",
  clx: "intentweave://schemas/clx/v1",
} as const;

// =============================================================================
// Signal Qualifiers
// =============================================================================

/**
 * A qualifier that categorizes the *intent* of a mention.
 *
 * Examples:
 *   "We decided for Neo4j"          → 'decision'
 *   "@deprecated since v2"          → 'deprecated'
 *   "TODO: migrate to PostgreSQL"   → 'planned'
 *   "We chose X over Y"             → 'alternative'
 */
export type SignalQualifier =
  | "decision"
  | "deprecated"
  | "planned"
  | "must"
  | "should"
  | "alternative"
  | "risk"
  | "example";

// =============================================================================
// Keyword Match (extractor output)
// =============================================================================

/**
 * A single keyword match from the heuristic extractor.
 * Represents a raw detection before it becomes a MentionRecord.
 */
export interface KeywordMatch {
  /** Normalized keyword name (lowercased, trimmed) */
  name: string;

  /** Original text as it appeared in source */
  originalText: string;

  /** Character offset within the chunk */
  offset: number;

  /** Length of the original text in characters */
  length: number;

  /** How this keyword was detected */
  source: "heading" | "bold" | "code-span" | "identifier" | "dictionary";
}

// =============================================================================
// Mention Record
// =============================================================================

/**
 * A single keyword mention in source text.
 *
 * This is the KWG's fundamental evidence unit. Every piece of knowledge
 * in the evidence graph traces back to one or more MentionRecords.
 */
export interface MentionRecord {
  /** Normalized entity name (lowercased, trimmed) */
  entityName: string;

  /** The source sentence containing the mention */
  text: string;

  /** Heading under which this mention appears (markdown H1-H4) */
  heading?: string;

  /** File path relative to workspace root */
  filePath: string;

  /** Start line in source file (1-based) */
  startLine: number;

  /** End line in source file (1-based) */
  endLine: number;

  /** Character offset within the chunk */
  startChar: number;

  /** End character offset within the chunk */
  endChar: number;

  /** Signal qualifiers detected on this mention */
  qualifiers: SignalQualifier[];

  /** How this mention was detected */
  source: "heading" | "bold" | "code-span" | "identifier" | "dictionary" | "custom-pattern";

  /** Chunk ID from IN stage (for co-occurrence windowing) */
  chunkId: string;

  /** Chunk type (section, paragraph, code, etc.) */
  chunkType: string;
}

// =============================================================================
// KWG Entity Record
// =============================================================================

/**
 * A keyword entity — aggregation of all mentions with the same normalized name.
 */
export interface KwgEntityRecord {
  /** Normalized entity name */
  name: string;

  /** Total mention count across all files */
  mentionCount: number;

  /** Files this entity appears in */
  filePaths: string[];

  /** Union of all qualifiers found across mentions */
  qualifiers: SignalQualifier[];

  /** Predominant source type (most common detection method) */
  predominantSource: MentionRecord["source"];
}

// =============================================================================
// Co-Occurrence Edge
// =============================================================================

/**
 * A co-occurrence relationship between two keyword entities.
 *
 * Co-occurrence is always computed per-document (within sentence windows),
 * then aggregated across documents at session level. A sentence window
 * cannot span files — that would be semantically meaningless.
 */
export interface CoOccurrenceEdge {
  /** First entity name (alphabetically smaller for consistency) */
  entityA: string;

  /** Second entity name */
  entityB: string;

  /** Number of times these entities co-occur within a window */
  count: number;

  /** Normalized co-occurrence score (e.g., Jaccard index) */
  score: number;

  /** File paths where co-occurrence was observed */
  filePaths: string[];
}

// =============================================================================
// Entity Cluster
// =============================================================================

/**
 * A concept cluster — a group of entities that frequently co-occur.
 */
export interface EntityCluster {
  /** Cluster identifier (auto-generated) */
  id: string;

  /** Label — the name of the envelope entity (highest-degree member) */
  label: string;

  /** Entity names in this cluster */
  members: string[];

  /** The envelope entity (representative, highest degree) */
  envelope: string;

  /** Internal edge count (co-occurrence edges within the cluster) */
  internalEdges: number;

  /** External edge count (edges connecting to entities outside the cluster) */
  externalEdges: number;
}

// =============================================================================
// Stage Input Types
// =============================================================================

/**
 * Input for the KWX (keyword extraction) stage.
 * KWX runs per-file, processing one IN stage output at a time.
 *
 * Uses a structural type to accept both core's InStageOutput and
 * analyzer's local InStageOutput (which may not extend BaseStageOutput).
 */
export interface KwxStageInput {
  /** IN stage output (chunks with text, headings, positions) */
  inOutput: {
    artifactId: string;
    filePath: string;
    chunks: import("./stages.js").SemanticChunk[];
  };
}

/**
 * Input for the COX (co-occurrence) stage.
 * COX runs at session level after all KWX outputs are ready.
 */
export interface CoxStageInput {
  /** KWX outputs for all files in the session */
  kwxOutputs: KwxStageOutput[];
}

/**
 * Input for the CLX (clustering) stage.
 * CLX runs at session level after COX.
 */
export interface ClxStageInput {
  /** COX output with co-occurrence edges */
  coxOutput: CoxStageOutput;

  /** KWX outputs for entity metadata (mention counts, qualifiers) */
  kwxOutputs: KwxStageOutput[];
}

// =============================================================================
// Stage Output Types
// =============================================================================

/**
 * KWX Stage Output — keyword extraction results for a single file.
 */
export interface KwxStageOutput extends BaseStageOutput {
  $schema: typeof KWG_SCHEMAS.kwx;
  stage: "KWX";
  artifactId: string;

  /** Source file path */
  filePath: string;

  /** All mentions found in this file */
  mentions: MentionRecord[];

  /** Unique entity names extracted (deduplicated across mentions) */
  entities: KwgEntityRecord[];

  /** Processing metadata */
  meta: {
    mentionCount: number;
    entityCount: number;
    qualifiedMentionCount: number;
    processingTimeMs: number;
  };
}

/**
 * COX Stage Output — co-occurrence edges at session level.
 */
export interface CoxStageOutput extends BaseStageOutput {
  $schema: typeof KWG_SCHEMAS.cox;
  stage: "COX";

  /** Co-occurrence edges (session-level, aggregated from all docs) */
  edges: CoOccurrenceEdge[];

  /** Processing metadata */
  meta: {
    edgeCount: number;
    pairsConsidered: number;
    windowType: string;
    processingTimeMs: number;
  };
}

/**
 * CLX Stage Output — entity clusters at session level.
 */
export interface ClxStageOutput extends BaseStageOutput {
  $schema: typeof KWG_SCHEMAS.clx;
  stage: "CLX";

  /** Detected clusters */
  clusters: EntityCluster[];

  /** Entities not assigned to any cluster (singletons) */
  unclustered: string[];

  /** Processing metadata */
  meta: {
    clusterCount: number;
    clusteredEntityCount: number;
    unclusteredEntityCount: number;
    processingTimeMs: number;
  };
}

// =============================================================================
// Combined Pipeline Output
// =============================================================================

/**
 * Combined output from the full KWG pipeline (KWX → COX → CLX).
 */
export interface KwgPipelineOutput {
  /** Per-file KWX outputs, keyed by file path */
  kwxOutputs: Map<string, KwxStageOutput>;

  /** Co-occurrence edges (session-level) */
  coxOutput: CoxStageOutput;

  /** Clusters (session-level) */
  clxOutput: ClxStageOutput;

  /** Pipeline metadata */
  meta: {
    totalFiles: number;
    totalTimeMs: number;
  };
}

// =============================================================================
// Persist Result
// =============================================================================

/**
 * Result of persisting KWG data to Neo4j.
 */
export interface PersistResult {
  nodesCreated: number;
  nodesUpdated: number;
  relsCreated: number;
  relsDeleted: number;
  durationMs: number;
}
