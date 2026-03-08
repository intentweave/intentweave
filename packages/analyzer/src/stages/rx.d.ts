// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * RX Stage - Raw Extraction
 *
 * Per-artifact stage that extracts entities and statements from input.
 * Uses ExtractionProvider (or hooks.strategy) for the actual extraction work.
 *
 * Input: in.json (ingested chunks)
 * Output: rx.json (extracted entities/statements)
 *
 * HOOKS INTEGRATION:
 * - context: Enriches prompts with prior knowledge (advisory)
 * - events: Notifies external systems (fire-and-forget)
 * - budget: Advises retry/expansion policy (RX decides)
 * - trace: Records debug info (no behavior change)
 * - strategy: Selects LLM calling pattern (explicit)
 */
import type {
  ExtractionProvider,
  Chunk,
  EntitySchema,
  ExtractionProfile,
  Entity,
  Statement,
  Evidence,
  ExtractionHooks,
} from "@intentweave/core";
/**
 * RX Stage Options
 */
export interface RxStageOptions {
  /** Extraction provider to use */
  extractionProvider: ExtractionProvider;
  /** Entity schema (kinds and predicates to extract) */
  schema?: EntitySchema;
  /** Profile for extraction hints */
  profile?: ExtractionProfile;
  /** Workspace key for cgId generation */
  workspaceKey?: string;
}
/**
 * RX Stage Input (from IN stage)
 */
export interface RxStageInput {
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Chunks to extract from */
  chunks: Chunk[];
  /** Artifact metadata */
  meta?: {
    artifactRole?: string;
    artifactFormat?: string;
  };
}
/**
 * RX Stage Output (spec-compliant: entities/statements at top level)
 */
export interface RxStageOutput {
  /** JSON Schema reference */
  $schema: string;
  /** Schema version */
  schemaVersion: "0.1";
  /** Stage identifier */
  stage: "RX";
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Extracted entities (flattened, not nested) */
  entities: Entity[];
  /** Extracted statements (flattened, not nested) */
  statements: Statement[];
  /** Evidence records */
  evidence: Evidence[];
  /** Extraction metadata */
  meta: {
    provider: string;
    model?: string;
    latencyMs?: number;
    tokensUsed?: number;
    chunksProcessed: number;
    /** Number of retries if truncation occurred */
    retries?: number;
  };
}
/**
 * Run RX stage on an artifact
 *
 * @param input - Artifact chunks and metadata
 * @param options - Extraction provider, schema, profile
 * @param hooks - Optional hooks for context, events, budget, trace, strategy
 */
export declare function runRxStage(
  input: RxStageInput,
  options: RxStageOptions,
  hooks?: ExtractionHooks,
): Promise<RxStageOutput>;
/**
 * Create chunks from text content
 */
export declare function createChunksFromContent(
  content: string,
  filePath: string,
  options?: {
    maxChunkSize?: number;
    artifactId?: string;
  },
): Chunk[];
//# sourceMappingURL=rx.d.ts.map
