// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * RX Stage - Raw Extraction
 *
 * Per-artifact stage that extracts entities and statements from input.
 * Uses ExtractionProvider (or hooks.strategy) for the actual extraction work.
 *
 * Input: in.json (ingested chunks)
 * Output: rx.json (extracted entities/statements, REF-resolved)
 *
 * POST-EXTRACTION RESOLUTION (REF):
 * RX output is guaranteed to have internally consistent cgIds.
 * REF runs at the end of extraction to resolve LLM-generated cgIds
 * to actual entity cgIds. This ensures CX/MX receive clean data.
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
  ContextBundle,
  BudgetPolicy,
} from "@intentweave/core";

import { DEFAULT_BUDGET } from "@intentweave/core";
import { resolveStatementRefs } from "./ref.js";

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
    /** REF resolution stats (internal consistency fix) */
    refStats?: {
      /** Number of statements with resolved cgIds */
      resolved: number;
      /** Number of statements that couldn't be resolved */
      unresolved: number;
      /** Number of ambiguous resolutions */
      ambiguous: number;
    };
  };
}

/**
 * Default entity schema
 *
 * NOTE: TRIGGERED_BY is required for state machine extraction.
 * The LLM extracts "transition TRIGGERED_BY action" relationships,
 * which MX stage inverts to canonical "action TRIGGERS transition".
 */
const DEFAULT_SCHEMA: EntitySchema = {
  kinds: ["role", "action", "resource", "state", "requirement", "component"],
  predicates: [
    "ROLE_CAN",
    "HAS_STATE",
    "TRANSITIONS_TO",
    "TRIGGERED_BY",
    "REQUIRES",
    "CONTAINS",
    "IMPLEMENTS",
  ],
};

/**
 * Default profile
 */
const DEFAULT_PROFILE: ExtractionProfile = {
  name: "default",
};

/**
 * Run RX stage on an artifact
 *
 * @param input - Artifact chunks and metadata
 * @param options - Extraction provider, schema, profile
 * @param hooks - Optional hooks for context, events, budget, trace, strategy
 */
export async function runRxStage(
  input: RxStageInput,
  options: RxStageOptions,
  hooks: ExtractionHooks = {},
): Promise<RxStageOutput> {
  const {
    extractionProvider,
    schema = DEFAULT_SCHEMA,
    profile = DEFAULT_PROFILE,
  } = options;

  const startTime = Date.now();

  // Emit start event
  hooks.events?.emit("rx.start", {
    artifactId: input.artifactId,
    filePath: input.filePath,
    chunkCount: input.chunks.length,
  });

  // Get context if provider available (ADVISORY - enriches prompts)
  const context: ContextBundle = hooks.context
    ? await hooks.context.getContext(
        input.artifactId,
        input.meta as Record<string, unknown>,
      )
    : {};

  // Trace context retrieval
  hooks.trace?.write({
    stage: "RX",
    timestamp: new Date().toISOString(),
    data: {
      event: "context.retrieved",
      artifactId: input.artifactId,
      hasContext: Object.keys(context).length > 0,
      contextKeys: Object.keys(context),
    },
  });

  // Build profile with artifact metadata
  const enrichedProfile: ExtractionProfile = {
    ...profile,
    artifactRole: input.meta?.artifactRole ?? profile.artifactRole,
  };

  // Budget-aware extraction with retry loop
  const budget: BudgetPolicy = hooks.budget ?? DEFAULT_BUDGET;
  let attempt = 0;
  let lastError: Error | null = null;
  let currentMaxTokens = budget.maxOutputTokens;

  while (attempt <= budget.maxRetries) {
    try {
      // Use hooks.strategy if provided, otherwise fall back to extractionProvider
      const result = hooks.strategy
        ? await hooks.strategy.extract(
            input.chunks,
            schema,
            enrichedProfile,
            context,
            { maxOutputTokens: currentMaxTokens },
          )
        : await extractionProvider.extract(
            input.chunks,
            schema,
            enrichedProfile,
          );

      const latencyMs = Date.now() - startTime;

      // Trace successful extraction
      hooks.trace?.write({
        stage: "RX",
        timestamp: new Date().toISOString(),
        data: {
          event: "extraction.success",
          artifactId: input.artifactId,
          attempt,
          entityCount: result.entities.length,
          statementCount: result.statements.length,
          latencyMs,
        },
      });

      // Emit complete event
      hooks.events?.emit("rx.complete", {
        artifactId: input.artifactId,
        entityCount: result.entities.length,
        statementCount: result.statements.length,
        latencyMs,
        retries: attempt,
      });

      // ────────────────────────────────────────────────────────────────────────
      // REF resolution: Resolve statement references before returning
      // This ensures RX output is always safe for downstream stages (MX, CX)
      // ────────────────────────────────────────────────────────────────────────
      const refResult = resolveStatementRefs(
        result.entities,
        result.statements,
      );

      hooks.trace?.write({
        stage: "RX",
        timestamp: new Date().toISOString(),
        data: {
          event: "ref.resolution",
          artifactId: input.artifactId,
          stats: refResult.stats,
        },
      });

      // Flatten to spec-compliant format (entities/statements at top level)
      return {
        $schema: "intentweave://schemas/rx-graph/v1",
        schemaVersion: "0.1",
        stage: "RX",
        artifactId: input.artifactId,
        filePath: input.filePath,
        entities: result.entities,
        statements: refResult.statements, // Use REF-resolved statements
        evidence: result.evidence,
        meta: {
          provider: result.meta.provider,
          model: result.meta.model,
          latencyMs,
          tokensUsed: result.meta.tokensUsed,
          chunksProcessed: result.meta.chunksProcessed,
          retries: attempt > 0 ? attempt : undefined,
          refStats: {
            resolved: refResult.stats.resolvedByName,
            unresolved: refResult.stats.unresolved,
            ambiguous: refResult.stats.ambiguous,
          },
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (
        attempt < budget.maxRetries &&
        budget.shouldRetry(lastError, attempt)
      ) {
        // Get expanded budget for retry
        currentMaxTokens = budget.getRetryBudget(attempt + 1, currentMaxTokens);

        // Trace retry
        hooks.trace?.write({
          stage: "RX",
          timestamp: new Date().toISOString(),
          data: {
            event: "extraction.retry",
            artifactId: input.artifactId,
            attempt,
            error: lastError.message,
            newMaxTokens: currentMaxTokens,
          },
        });

        // Emit retry event
        hooks.events?.emit("rx.retry", {
          artifactId: input.artifactId,
          attempt,
          error: lastError.message,
          newMaxTokens: currentMaxTokens,
        });

        attempt++;
        continue;
      }

      // No retry - emit error and rethrow
      hooks.events?.emit("rx.error", {
        artifactId: input.artifactId,
        error: lastError.message,
        attempts: attempt + 1,
      });

      hooks.trace?.write({
        stage: "RX",
        timestamp: new Date().toISOString(),
        data: {
          event: "extraction.failed",
          artifactId: input.artifactId,
          attempts: attempt + 1,
          error: lastError.message,
        },
      });

      throw lastError;
    }
  }

  // Should not reach here, but TypeScript needs it
  throw lastError ?? new Error("RX extraction failed");
}

/**
 * Create chunks from text content
 */
export function createChunksFromContent(
  content: string,
  filePath: string,
  options: {
    maxChunkSize?: number;
    artifactId?: string;
  } = {},
): Chunk[] {
  const maxSize = options.maxChunkSize ?? 8000;
  const chunks: Chunk[] = [];

  // For now, simple line-based chunking
  const lines = content.split("\n");
  let currentChunk = "";
  let startLine = 1;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (
      currentChunk.length + line.length + 1 > maxSize &&
      currentChunk.length > 0
    ) {
      // Save current chunk
      chunks.push({
        id: `${options.artifactId ?? filePath}-chunk-${chunkIndex}`,
        content: currentChunk,
        filePath,
        startLine,
        endLine: i,
      });

      currentChunk = "";
      startLine = i + 1;
      chunkIndex++;
    }

    currentChunk += (currentChunk ? "\n" : "") + line;
  }

  // Save remaining content
  if (currentChunk) {
    chunks.push({
      id: `${options.artifactId ?? filePath}-chunk-${chunkIndex}`,
      content: currentChunk,
      filePath,
      startLine,
      endLine: lines.length,
    });
  }

  return chunks;
}
