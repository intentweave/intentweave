/**
 * SinglePassStrategy
 * 
 * Extracts entities and statements in a single LLM call per chunk.
 * This is the original extraction behavior - faster but may miss some relationships.
 * 
 * Use cases:
 * - Quick extraction for small documents
 * - When token budget is limited
 * - Initial exploration/prototyping
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
} from '@intentweave/core';
import {
  type StrategyConfig,
  createDefaultStrategyConfig,
  SINGLE_PASS_SYSTEM_PROMPT,
  EXTRACTION_RESPONSE_SCHEMA,
  type ExtractedData,
  buildExtractionPrompt,
  convertToEntity,
  convertToStatement,
  deduplicateEntities,
  createEvidence,
} from './shared.js';

/**
 * SinglePassStrategy: One LLM call per chunk (entities + statements together)
 */
export class SinglePassStrategy implements ExtractionStrategy {
  readonly name = 'single-pass';
  
  private readonly llmProvider: LLMProvider;
  private readonly config: StrategyConfig;
  
  constructor(llmProvider: LLMProvider, config?: Partial<StrategyConfig>) {
    this.llmProvider = llmProvider;
    this.config = createDefaultStrategyConfig(config);
  }
  
  /**
   * Extract from chunks using single-pass strategy
   * Processes chunks in parallel with configurable concurrency
   */
  async extract(
    chunks: Chunk[],
    schema: EntitySchema,
    profile: ExtractionProfile,
    context: ContextBundle,
    options?: StrategyOptions
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    const allEntities: Entity[] = [];
    const allStatements: Statement[] = [];
    const allEvidence: Evidence[] = [];
    let totalTokens = 0;
    
    // Get concurrency from config (default: 5 parallel requests)
    const concurrency = this.config.concurrency ?? 5;
    
    // Process chunks in parallel batches
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(chunk => this.extractFromChunk(chunk, schema, profile))
      );
      
      for (const result of results) {
        allEntities.push(...result.entities);
        allStatements.push(...result.statements);
        allEvidence.push(...result.evidence);
        totalTokens += result.tokensUsed;
      }
    }
    
    // Deduplicate entities by name+kind
    const deduplicatedEntities = deduplicateEntities(allEntities);
    
    return {
      entities: deduplicatedEntities,
      statements: allStatements,
      evidence: allEvidence,
      meta: {
        provider: 'strategy',
        llmProvider: this.llmProvider.name,
        model: undefined,
        latencyMs: Date.now() - startTime,
        tokensUsed: totalTokens,
        chunksProcessed: chunks.length,
      },
    };
  }
  
  /**
   * Extract from a single chunk
   */
  private async extractFromChunk(
    chunk: Chunk,
    schema: EntitySchema,
    profile: ExtractionProfile
  ): Promise<{
    entities: Entity[];
    statements: Statement[];
    evidence: Evidence[];
    tokensUsed: number;
  }> {
    const userPrompt = buildExtractionPrompt(chunk, schema, profile, 'single-pass');
    
    // Call LLM
    const response = await this.llmProvider.complete({
      system: SINGLE_PASS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      responseSchema: EXTRACTION_RESPONSE_SCHEMA,
      temperature: this.config.temperature,
    });
    
    if (response.finishReason === 'error') {
      console.error(`[SinglePass] Extraction error for chunk ${chunk.id}:`, response.error);
      return {
        entities: [],
        statements: [],
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
        console.error(`[SinglePass] Failed to parse response for chunk ${chunk.id}`);
        return {
          entities: [],
          statements: [],
          evidence: [],
          tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
        };
      }
    }
    
    // Convert to core types
    const entities = (parsed.entities ?? []).map(e => convertToEntity(e, chunk, schema));
    const statements = (parsed.statements ?? []).map(s => convertToStatement(s, chunk, entities));
    const evidence = createEvidence(chunk, entities, statements);
    
    return {
      entities,
      statements,
      evidence,
      tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
    };
  }
}
