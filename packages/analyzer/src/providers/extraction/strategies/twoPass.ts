// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * TwoPassStrategy
 *
 * Extracts entities first (Pass 1), then statements (Pass 2).
 * This produces higher quality results by:
 * - Focusing on entity extraction first
 * - Using extracted entities to guide relationship extraction
 * - Ensuring statements reference known entities
 *
 * Use cases:
 * - Production extraction for important documents
 * - When relationship quality is important
 * - When entity deduplication is needed before relationship extraction
 */

import type {
  ExtractionStrategy,
  ExtractionResult,
  Chunk,
  EntitySchema,
  ExtractionProfile,
  ContextBundle,
  StrategyOptions,
  LLMProvider,
  Entity,
  Statement,
  Evidence,
} from "@intentweave/core";
import {
  type StrategyConfig,
  createDefaultStrategyConfig,
  ENTITIES_ONLY_SYSTEM_PROMPT,
  STATEMENTS_ONLY_SYSTEM_PROMPT,
  ENTITIES_ONLY_SCHEMA,
  STATEMENTS_ONLY_SCHEMA,
  type ExtractedData,
  buildExtractionPrompt,
  convertToEntity,
  convertToStatement,
  deduplicateEntities,
  createEvidence,
} from "./shared.js";

/**
 * TwoPassStrategy: Entities first, then statements
 */
export class TwoPassStrategy implements ExtractionStrategy {
  readonly name = "two-pass";

  private readonly llmProvider: LLMProvider;
  private readonly config: StrategyConfig;

  constructor(llmProvider: LLMProvider, config?: Partial<StrategyConfig>) {
    this.llmProvider = llmProvider;
    this.config = createDefaultStrategyConfig(config);
  }

  /**
   * Extract from chunks using two-pass strategy
   */
  async extract(
    chunks: Chunk[],
    schema: EntitySchema,
    profile: ExtractionProfile,
    context: ContextBundle,
    options?: StrategyOptions,
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    const allEntities: Entity[] = [];
    const allStatements: Statement[] = [];
    const allEvidence: Evidence[] = [];
    let totalTokens = 0;

    // Pass 1: Extract entities only from each chunk
    console.log("[TwoPass] Pass 1: Extracting entities...");
    for (const chunk of chunks) {
      const result = await this.extractEntitiesFromChunk(
        chunk,
        schema,
        profile,
      );

      allEntities.push(...result.entities);
      allEvidence.push(...result.evidence);
      totalTokens += result.tokensUsed;
    }

    // Deduplicate entities by name+kind before Pass 2
    const deduplicatedEntities = deduplicateEntities(allEntities);
    console.log(
      `[TwoPass] Pass 1 complete: ${deduplicatedEntities.length} unique entities extracted`,
    );

    // Pass 2: Extract statements given the entities
    if (deduplicatedEntities.length > 0) {
      console.log("[TwoPass] Pass 2: Extracting statements...");
      for (const chunk of chunks) {
        const result = await this.extractStatementsFromChunk(
          chunk,
          schema,
          profile,
          deduplicatedEntities,
        );

        allStatements.push(...result.statements);
        totalTokens += result.tokensUsed;
      }
      console.log(
        `[TwoPass] Pass 2 complete: ${allStatements.length} statements extracted`,
      );
    } else {
      console.log("[TwoPass] No entities found, skipping Pass 2");
    }

    return {
      entities: deduplicatedEntities,
      statements: allStatements,
      evidence: allEvidence,
      meta: {
        provider: "strategy",
        llmProvider: this.llmProvider.name,
        model: undefined,
        latencyMs: Date.now() - startTime,
        tokensUsed: totalTokens,
        chunksProcessed: chunks.length,
      },
    };
  }

  /**
   * Pass 1: Extract entities from a single chunk
   */
  private async extractEntitiesFromChunk(
    chunk: Chunk,
    schema: EntitySchema,
    profile: ExtractionProfile,
  ): Promise<{
    entities: Entity[];
    evidence: Evidence[];
    tokensUsed: number;
  }> {
    const userPrompt = buildExtractionPrompt(
      chunk,
      schema,
      profile,
      "entities-only",
    );

    // Call LLM for entities only
    const response = await this.llmProvider.complete({
      system: ENTITIES_ONLY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      responseSchema: ENTITIES_ONLY_SCHEMA,
      temperature: this.config.temperature,
    });

    if (response.finishReason === "error") {
      console.error(
        `[TwoPass] Pass 1 error for chunk ${chunk.id}:`,
        response.error,
      );
      return {
        entities: [],
        evidence: [],
        tokensUsed: 0,
      };
    }

    // Parse response
    let parsed = response.parsed as ExtractedData | undefined;

    if (!parsed) {
      try {
        parsed = JSON.parse(response.content) as ExtractedData;
      } catch {
        console.error(
          `[TwoPass] Failed to parse Pass 1 response for chunk ${chunk.id}`,
        );
        return {
          entities: [],
          evidence: [],
          tokensUsed:
            response.tokensUsed.prompt + response.tokensUsed.completion,
        };
      }
    }

    // Convert to core types
    const entities = (parsed.entities ?? []).map((e) =>
      convertToEntity(e, chunk, schema),
    );
    const evidence = createEvidence(chunk, entities, []);

    return {
      entities,
      evidence,
      tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
    };
  }

  /**
   * Pass 2: Extract statements from a single chunk given entities
   */
  private async extractStatementsFromChunk(
    chunk: Chunk,
    schema: EntitySchema,
    profile: ExtractionProfile,
    entities: Entity[],
  ): Promise<{
    statements: Statement[];
    tokensUsed: number;
  }> {
    const userPrompt = buildExtractionPrompt(
      chunk,
      schema,
      profile,
      "statements-only",
      entities,
    );

    // Call LLM for statements only
    const response = await this.llmProvider.complete({
      system: STATEMENTS_ONLY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      responseSchema: STATEMENTS_ONLY_SCHEMA,
      temperature: this.config.temperature,
    });

    if (response.finishReason === "error") {
      console.error(
        `[TwoPass] Pass 2 error for chunk ${chunk.id}:`,
        response.error,
      );
      return {
        statements: [],
        tokensUsed: 0,
      };
    }

    // Parse response
    let parsed = response.parsed as ExtractedData | undefined;

    if (!parsed) {
      try {
        parsed = JSON.parse(response.content) as ExtractedData;
      } catch {
        console.error(
          `[TwoPass] Failed to parse Pass 2 response for chunk ${chunk.id}`,
        );
        return {
          statements: [],
          tokensUsed:
            response.tokensUsed.prompt + response.tokensUsed.completion,
        };
      }
    }

    // Convert to core types, filtering to only statements with known entities
    const statements = (parsed.statements ?? [])
      .map((s) => convertToStatement(s, chunk, entities))
      .filter(
        (s) =>
          !s.subjectCgId.startsWith("unknown:") &&
          !(s.objectCgId ?? "").startsWith("unknown:"),
      );

    return {
      statements,
      tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
    };
  }
}
