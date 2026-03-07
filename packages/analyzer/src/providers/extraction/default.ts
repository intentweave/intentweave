// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Default Extraction Provider
 * 
 * RX-stage service that uses an injected LLMProvider for entity extraction.
 * Owns chunking, schema orchestration, evidence tracking, and result aggregation.
 */

import type {
  ExtractionProvider,
  ExtractionProviderCapabilities,
  ExtractionResult,
  Chunk,
  EntitySchema,
  ExtractionProfile,
  LLMProvider,
  Entity,
  Statement,
  Evidence,
  EntityType,
  Predicate,
} from '@intentweave/core';
import { 
  buildCgId,
  getAllowedSubjectTypes,
  getAllowedObjectTypes,
} from '@intentweave/core';
import type { DefaultExtractionConfig } from './types.js';

/** Debug logger that only logs when DEBUG_EXTRACTION env var is set */
const debugLog = process.env.DEBUG_EXTRACTION ? console.log.bind(console) : () => {};
const debugWarn = process.env.DEBUG_EXTRACTION ? console.warn.bind(console) : () => {};

// =============================================================================
// Reference Normalization
// =============================================================================

/**
 * Normalize a reference name for matching.
 * 
 * Steps:
 * 1. casefold (toLowerCase)
 * 2. split camelCase → tokens (e.g., "UserDeactivated" → "user deactivated")
 * 3. slugify (unify spaces/underscores/dashes to single separator)
 * 4. remove punctuation
 * 
 * Examples:
 *   "UserDeactivated" → "user-deactivated"
 *   "user_deactivated" → "user-deactivated"
 *   "User Deactivated" → "user-deactivated"
 *   "user-deactivated" → "user-deactivated"
 *   "ACTIVE" → "active"
 */
function normalizeReference(name: string): string {
  // Step 1: Split camelCase/PascalCase into tokens
  // "UserDeactivated" → "User Deactivated"
  const withSpaces = name.replace(/([a-z])([A-Z])/g, '$1 $2')
                         .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  
  // Step 2: casefold
  const lower = withSpaces.toLowerCase();
  
  // Step 3: Replace spaces, underscores, multiple dashes with single dash
  const slugified = lower
    .replace(/[\s_]+/g, '-')  // spaces and underscores → dash
    .replace(/-+/g, '-');     // multiple dashes → single dash
  
  // Step 4: Remove punctuation (except dashes)
  const cleaned = slugified.replace(/[^a-z0-9-]/g, '');
  
  // Step 5: Trim leading/trailing dashes
  return cleaned.replace(/^-+|-+$/g, '');
}
import { 
  EXTRACTION_RESPONSE_SCHEMA,
  ENTITIES_ONLY_SCHEMA,
  STATEMENTS_ONLY_SCHEMA,
  type ExtractionMode,
} from './types.js';

const DEFAULT_SYSTEM_PROMPT = `You are an expert at extracting structured knowledge from documents.
Your task is to identify entities and their relationships from the given text.

Entity kinds to look for:
- role: An actor or user role (e.g., "admin", "customer")
- action: Something that can be done (e.g., "create", "delete", "approve")
- resource: A thing that can be acted upon (e.g., "document", "order", "user")
- state: A lifecycle status that a resource transitions through (e.g., "pending", "approved", "archived")
- event: Something that happened, audit trail entries (e.g., "created", "edited", "deleted")
- requirement: A stated need or constraint
- component: A system part or module
- constraint: A limitation or rule (e.g., "must be archived ≥30 days")
- policy: A business rule governing behavior
- issue: A detected problem (contradiction, ambiguity, tension)

🔴 DETECT SEMANTIC ISSUES (extract as kind: "issue"):

1. CONTRADICTION: "MUST NOT delete" + "MAY request erasure" → kind: "issue"
2. AMBIGUITY: "maybe", "see spec", unclear language → kind: "issue"
3. TENSION: Conflicting time constraints or overlapping permissions → kind: "issue"
4. MISSING: Audit trail required but events not specified → kind: "issue"

🚨 STATES vs ATTRIBUTE VALUES vs EVENTS (CRITICAL):

STATES = Lifecycle stages with transitions:
  ✅ status: open → done → archived (YES - these are states)
  → States answer: "What status is it IN right now?"

ATTRIBUTE VALUES = Static enums - NOT states:
  ❌ priority: low | medium | high (NO - skip these)
  ❌ severity: minor | major | critical (NO - attribute values)

EVENTS = Audit entries - use kind: "event" NOT "state":
  ❌ task-created, task-edited, task-deleted → kind: "event"
  ❌ created, edited, deleted, reopened → kind: "event"
  → Events answer: "What HAPPENED to it?"
  
  🔍 PATTERN: Past-tense words = EVENT, not state:
     • "created", "edited", "deleted", "updated" → kind: "event"
     • "task-created", "user-deleted" → kind: "event"

HTTP CODES = Response codes - NOT states:
  ❌ HTTP 400, HTTP 409 (NO - skip these)

Relationship predicates to use:
- ROLE_CAN: role can perform action
- HAS_STATE: resource has state
- TRANSITIONS_TO: state transitions to state
- REQUIRES: action requires condition
- CONTAINS: component contains component
- IMPLEMENTS: entity implements requirement
- CONFLICTS_WITH: issue conflicts with requirement/policy

Extract all relevant entities and relationships from the text.`;

const ENTITIES_ONLY_SYSTEM_PROMPT = `You are an expert at identifying and extracting entities from documents.
Your task is to extract ONLY entities - NOT relationships.

CRITICAL NAMING RULES:
1. Entity.name MUST be an exact phrase or word from the source text
2. NO concatenation - "document rejected" is correct, NOT "documentrejected"
3. Use natural spacing: "Draft State" not "DraftState"
4. For states/statuses, use the format: "Resource: Status" (e.g., "Document: Approved", "Order: Pending")
5. If the text says "the document is rejected", extract state name as "Document: Rejected"
6. Preserve case and spacing as it appears in the source text
7. NO paraphrasing, NO rewriting, NO singular/plural changes

🚨 STATES vs ATTRIBUTE VALUES vs EVENTS (CRITICAL):

STATES = Lifecycle stages with transitions:
  ✅ status: open → done → archived (YES - extract as kind: "state")
  → States answer: "What status is it IN right now?"

ATTRIBUTE VALUES = Static enums - DO NOT extract as states:
  ❌ priority: low | medium | high (NO - skip these entirely)
  ❌ severity: minor | major | critical (NO - attribute values)

EVENTS = Audit entries - use kind: "event" NOT "state":
  ❌ task-created, task-edited, task-deleted → kind: "event"
  ❌ created, edited, deleted, reopened → kind: "event"
  → Events answer: "What HAPPENED to it?"
  
  🔍 PATTERN: Past-tense words = EVENT, not state:
     • "created", "edited", "deleted", "updated" → kind: "event"
     • "task-created", "user-deleted" → kind: "event"

HTTP CODES = Response codes - DO NOT extract as states:
  ❌ HTTP 400, HTTP 409 (NO - skip these)

Entity extraction guidelines:
- Extract entities that match the allowed kinds provided
- Provide a brief but accurate description
- Assign confidence based on clarity and certainty
- Focus on entities that are explicitly mentioned, not inferred`;

const STATEMENTS_ONLY_SYSTEM_PROMPT = `You are an expert at identifying relationships between entities.
Your task is to extract ONLY statements (relationships) - NOT new entities.

You will be provided with a list of entities that were already extracted.
Your job is to find relationships between these entities.

CRITICAL RULES:
1. Subject and object MUST exactly match entity names from the provided list
2. Only use predicates from the allowed list provided
3. Extract explicit relationships mentioned in the text
4. Do not infer relationships that aren't clearly stated
5. Assign confidence based on how explicitly the relationship is stated

Relationship extraction guidelines:
- Look for verbs and connecting phrases that link entities
- Consider modalities (can, must, should) when assigning confidence
- Focus on actionable and meaningful relationships
- Skip trivial or redundant relationships`;

/**
 * Default Extraction Provider Implementation
 */
export class DefaultExtractionProvider implements ExtractionProvider {
  readonly name = 'default';
  
  private readonly llmProvider: LLMProvider;
  private readonly config: Required<DefaultExtractionConfig>;
  
  constructor(llmProvider: LLMProvider, config: DefaultExtractionConfig = {}) {
    this.llmProvider = llmProvider;
    this.config = {
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      parallelChunks: config.parallelChunks ?? 5, // Default 5 parallel API calls
      enableConfidence: config.enableConfidence ?? true,
      enableEvidenceSpans: config.enableEvidenceSpans ?? true,
      temperature: config.temperature ?? 0.1,
      extractionMode: config.extractionMode ?? 'two-pass', // Default to 2-pass for better quality
      workspaceKey: config.workspaceKey ?? 'ws_0000', // Default workspace for cgId generation
    };
  }
  
  /**
   * Provider capabilities (derived from LLM provider)
   */
  get capabilities(): ExtractionProviderCapabilities {
    return {
      supportsConfidence: this.config.enableConfidence,
      supportsEvidenceSpans: this.config.enableEvidenceSpans,
      supportsParallelChunks: this.config.parallelChunks > 1,
      llmCapabilities: this.llmProvider.capabilities,
    };
  }
  
  /**
   * Get extraction configuration metadata for run.meta.json
   * Used for parity evaluation and reproducibility tracking
   */
  getConfigMetadata(): {
    provider: string;
    temperature: number;
    extractionMode: string;
  } {
    return {
      provider: this.llmProvider.name,
      temperature: this.config.temperature,
      extractionMode: this.config.extractionMode,
    };
  }
  
  /**
   * Extract entities and relationships from chunks
   */
  async extract(
    chunks: Chunk[],
    schema: EntitySchema,
    profile: ExtractionProfile
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    
    // Choose extraction strategy based on mode
    if (this.config.extractionMode === 'two-pass') {
      return this.extractTwoPass(chunks, schema, profile, startTime);
    } else {
      return this.extractSinglePass(chunks, schema, profile, startTime);
    }
  }

  /**
   * Single-pass extraction (original behavior)
   */
  private async extractSinglePass(
    chunks: Chunk[],
    schema: EntitySchema,
    profile: ExtractionProfile,
    startTime: number
  ): Promise<ExtractionResult> {
    const allEntities: Entity[] = [];
    const allStatements: Statement[] = [];
    const allEvidence: Evidence[] = [];
    let totalTokens = 0;
    
    // Process chunks in parallel batches
    const concurrency = this.config.parallelChunks;
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(chunk => this.extractFromChunk(chunk, schema, profile, 'single-pass'))
      );
      
      for (const result of results) {
        allEntities.push(...result.entities);
        allStatements.push(...result.statements);
        allEvidence.push(...result.evidence);
        totalTokens += result.tokensUsed;
      }
    }
    
    // Deduplicate entities by name+kind
    const deduplicatedEntities = this.deduplicateEntities(allEntities);
    
    return {
      entities: deduplicatedEntities,
      statements: allStatements,
      evidence: allEvidence,
      meta: {
        provider: this.name,
        llmProvider: this.llmProvider.name,
        model: undefined, // Set by LLM response
        latencyMs: Date.now() - startTime,
        tokensUsed: totalTokens,
        chunksProcessed: chunks.length,
      },
    };
  }

  /**
   * Two-pass extraction (Pass 1: entities, Pass 2: statements)
   */
  private async extractTwoPass(
    chunks: Chunk[],
    schema: EntitySchema,
    profile: ExtractionProfile,
    startTime: number
  ): Promise<ExtractionResult> {
    const allEntities: Entity[] = [];
    const allStatements: Statement[] = [];
    const allEvidence: Evidence[] = [];
    let totalTokens = 0;
    const concurrency = this.config.parallelChunks;
    
    // Pass 1: Extract entities only from each chunk (parallel)
    debugLog('[TwoPass] Pass 1: Extracting entities...');
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(chunk => this.extractFromChunk(chunk, schema, profile, 'entities-only'))
      );
      
      for (const result of results) {
        allEntities.push(...result.entities);
        allEvidence.push(...result.evidence);
        totalTokens += result.tokensUsed;
      }
    }
    
    // Deduplicate entities by name+kind before Pass 2
    const deduplicatedEntities = this.deduplicateEntities(allEntities);
    debugLog(`[TwoPass] Pass 1 complete: ${deduplicatedEntities.length} unique entities extracted`);
    
    // Pass 2: Extract statements given the entities (parallel)
    if (deduplicatedEntities.length > 0) {
      debugLog('[TwoPass] Pass 2: Extracting statements...');
      for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map(chunk => this.extractStatementsFromChunk(
            chunk,
            schema,
            profile,
            deduplicatedEntities
          ))
        );
        
        for (const result of results) {
          allStatements.push(...result.statements);
          totalTokens += result.tokensUsed;
        }
      }
      debugLog(`[TwoPass] Pass 2 complete: ${allStatements.length} statements extracted`);
    } else {
      debugLog('[TwoPass] No entities found, skipping Pass 2');
    }
    
    return {
      entities: deduplicatedEntities,
      statements: allStatements,
      evidence: allEvidence,
      meta: {
        provider: this.name,
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
    profile: ExtractionProfile,
    mode: ExtractionMode
  ): Promise<{
    entities: Entity[];
    statements: Statement[];
    evidence: Evidence[];
    tokensUsed: number;
  }> {
    // Build prompt based on mode
    const userPrompt = this.buildExtractionPrompt(chunk, schema, profile, mode);
    
    // Select system prompt and response schema based on mode
    let systemPrompt: string;
    let responseSchema: any;
    
    if (mode === 'entities-only') {
      systemPrompt = ENTITIES_ONLY_SYSTEM_PROMPT;
      responseSchema = ENTITIES_ONLY_SCHEMA;
    } else if (mode === 'statements-only') {
      systemPrompt = STATEMENTS_ONLY_SYSTEM_PROMPT;
      responseSchema = STATEMENTS_ONLY_SCHEMA;
    } else {
      systemPrompt = this.config.systemPrompt;
      responseSchema = EXTRACTION_RESPONSE_SCHEMA;
    }
    
    // Call LLM
    const response = await this.llmProvider.complete({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      responseSchema,
      temperature: this.config.temperature,
    });
    
    if (response.finishReason === 'error') {
      console.error(`Extraction error for chunk ${chunk.id}:`, response.error);
      return {
        entities: [],
        statements: [],
        evidence: [],
        tokensUsed: 0,
      };
    }
    
    // Parse response
    const parsed = response.parsed as ExtractedData | undefined;
    
    if (!parsed) {
      // Try parsing content directly
      try {
        const data = JSON.parse(response.content) as ExtractedData;
        return this.convertToResult(data, chunk, schema);
      } catch {
        console.error(`Failed to parse extraction response for chunk ${chunk.id}`);
        return {
          entities: [],
          statements: [],
          evidence: [],
          tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
        };
      }
    }
    
    const result = this.convertToResult(parsed, chunk, schema);
    result.tokensUsed = response.tokensUsed.prompt + response.tokensUsed.completion;
    
    return result;
  }
  
  /**
   * Extract statements from a chunk given known entities (Pass 2 of 2-pass mode)
   */
  private async extractStatementsFromChunk(
    chunk: Chunk,
    schema: EntitySchema,
    profile: ExtractionProfile,
    knownEntities: Entity[]
  ): Promise<{
    statements: Statement[];
    tokensUsed: number;
  }> {
    // Build prompt with known entities
    const userPrompt = this.buildStatementsPrompt(chunk, schema, profile, knownEntities);
    
    // Call LLM
    const response = await this.llmProvider.complete({
      system: STATEMENTS_ONLY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      responseSchema: STATEMENTS_ONLY_SCHEMA,
      temperature: this.config.temperature,
    });
    
    if (response.finishReason === 'error') {
      console.error(`Statement extraction error for chunk ${chunk.id}:`, response.error);
      return {
        statements: [],
        tokensUsed: 0,
      };
    }
    
    // Parse response
    const parsed = response.parsed as ExtractedData | undefined;
    
    if (!parsed) {
      try {
        const data = JSON.parse(response.content) as ExtractedData;
        const result = this.convertToResult(data, chunk, schema);
        return {
          statements: result.statements,
          tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
        };
      } catch {
        console.error(`Failed to parse statement extraction response for chunk ${chunk.id}`);
        return {
          statements: [],
          tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
        };
      }
    }
    
    const result = this.convertToResult(parsed, chunk, schema);
    return {
      statements: result.statements,
      tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
    };
  }
  
  /**
   * Build extraction prompt for a chunk
   */
  private buildExtractionPrompt(
    chunk: Chunk,
    schema: EntitySchema,
    profile: ExtractionProfile,
    mode: ExtractionMode
  ): string {
    const parts: string[] = [];
    
    // Add allowed entity kinds (profile-constrained)
    if (schema.kinds.length > 0) {
      parts.push(`ALLOWED ENTITY KINDS (extract ONLY these):`);
      parts.push(schema.kinds.map(k => `- ${k}`).join('\n'));
      parts.push('');
    }
    
    // Add allowed predicates (if extracting statements)
    if (mode === 'single-pass' && schema.predicates.length > 0) {
      parts.push(`ALLOWED RELATIONSHIP PREDICATES (use ONLY these):`);
      parts.push(schema.predicates.map(p => `- ${p}`).join('\n'));
      parts.push('');
    }
    
    // Add schema hints
    if (schema.hints?.length) {
      parts.push(`Additional guidance: ${schema.hints.join('; ')}`);
      parts.push('');
    }
    
    // Add profile context
    if (profile.artifactRole) {
      parts.push(`This is a ${profile.artifactRole} document.`);
      parts.push('');
    }
    
    // Mode-specific instructions
    if (mode === 'entities-only') {
      parts.push('TASK: Extract ONLY entities. Do NOT extract relationships.');
      parts.push('Remember: Entity names must preserve natural spacing (NOT concatenated).');
      parts.push('For states, use format "Resource: Status" (e.g., "Document: Approved").');
    } else if (mode === 'single-pass') {
      parts.push('TASK: Extract both entities and their relationships.');
    }
    
    // Add the content
    parts.push('---');
    parts.push('TEXT TO ANALYZE:');
    parts.push('');
    parts.push(chunk.content);
    
    if (chunk.filePath) {
      parts.push('');
      parts.push(`(Source: ${chunk.filePath}${chunk.startLine ? `:${chunk.startLine}` : ''})`);
    }
    
    return parts.join('\n');
  }
  
  /**
   * Build statements-only prompt (Pass 2 of 2-pass mode)
   */
  private buildStatementsPrompt(
    chunk: Chunk,
    schema: EntitySchema,
    profile: ExtractionProfile,
    knownEntities: Entity[]
  ): string {
    const parts: string[] = [];
    
    // Add known entities
    parts.push('KNOWN ENTITIES (use ONLY these in subject/object):');
    for (const entity of knownEntities) {
      parts.push(`- ${entity.name} (${entity.type})`);
    }
    parts.push('');
    
    // Add allowed predicates (profile-constrained)
    if (schema.predicates.length > 0) {
      parts.push(`ALLOWED PREDICATES (use ONLY these):`);
      parts.push(schema.predicates.map(p => `- ${p}`).join('\n'));
      parts.push('');
    }
    
    // Add schema hints
    if (schema.hints?.length) {
      parts.push(`Additional guidance: ${schema.hints.join('; ')}`);
      parts.push('');
    }
    
    // Add profile context
    if (profile.artifactRole) {
      parts.push(`This is a ${profile.artifactRole} document.`);
      parts.push('');
    }
    
    parts.push('TASK: Extract relationships (statements) between the entities listed above.');
    parts.push('Remember: Subject and object MUST exactly match entity names from the list.');
    parts.push('');
    
    // Add the content
    parts.push('---');
    parts.push('TEXT TO ANALYZE:');
    parts.push('');
    parts.push(chunk.content);
    
    if (chunk.filePath) {
      parts.push('');
      parts.push(`(Source: ${chunk.filePath}${chunk.startLine ? `:${chunk.startLine}` : ''})`);
    }
    
    return parts.join('\n');
  }
  
  /**
   * Convert extracted data to result format
   */
  private convertToResult(
    data: ExtractedData,
    chunk: Chunk,
    schema?: EntitySchema
  ): {
    entities: Entity[];
    statements: Statement[];
    evidence: Evidence[];
    tokensUsed: number;
  } {
    const entities: Entity[] = [];
    const statements: Statement[] = [];
    const evidenceList: Evidence[] = [];
    
    // Convert extracted entities
    for (const extracted of data.entities ?? []) {
      try {
        // Map LLM-extracted kind to valid EntityType
        const entityType = this.mapToEntityType(extracted.kind);
        
        debugLog(`[DefaultExtraction] About to build cgId:`, {
          entityType, entityTypeType: typeof entityType,
          extractedName: extracted.name, extractedNameType: typeof extracted.name,
          extractedKind: extracted.kind
        });
        
        // Build evidence for this entity
        const entityEvidence: Evidence = {
          turnIndex: chunk.turnIndex ?? 0,
          text: chunk.content.substring(0, 200),
          chunk_id: chunk.id,
          chunk_index: chunk.index ?? 0,
          confidence: extracted.confidence ?? 0.8,
          source_stage: 'RX',
        };
        
        const entity: Entity = {
          cgId: buildCgId(entityType, extracted.name, { root: this.config.workspaceKey }),
          name: extracted.name,
          type: entityType,
        labels: ['Staging'],
        evidence: [entityEvidence],
        confidence: this.config.enableConfidence ? (extracted.confidence ?? 0.8) : 0.8,
        source: 'llm',
        origin: 'llm',
        state: 'new',
        props: extracted.description ? { description: extracted.description } : undefined,
      };
      
      entities.push(entity);
      evidenceList.push(entityEvidence);
      } catch (error) {
        console.error(`[DefaultExtraction] Error processing entity:`, {
          extracted,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }
    
    // Track resolution statistics
    let resolvedCount = 0;
    let ambiguousCount = 0;
    let unresolvedCount = 0;
    
    // Convert extracted statements
    for (const extracted of data.statements ?? []) {
      try {
        debugLog(`[DefaultExtraction] Processing statement:`, {
          subject: extracted.subject, subjectType: typeof extracted.subject,
          object: extracted.object, objectType: typeof extracted.object,
          predicate: extracted.predicate,
          sourceCgId: (extracted as any).sourceCgId,
          targetCgId: (extracted as any).targetCgId
        });
        
        // Resolve subject and object references using predicate signature
        const subjectRef = this.resolveStatementReference(
          extracted.subject,
          extracted.predicate,
          'subject',
          entities
        );
        const objectRef = this.resolveStatementReference(
          extracted.object,
          extracted.predicate,
          'object',
          entities
        );
        
        // Track resolution stats
        if (subjectRef.resolved) resolvedCount++; else unresolvedCount++;
        if (objectRef.resolved) resolvedCount++; else unresolvedCount++;
        if (subjectRef.ambiguous) ambiguousCount++;
        if (objectRef.ambiguous) ambiguousCount++;
        
        // Build evidence for this statement
        const stmtEvidence: Evidence = {
          turnIndex: chunk.turnIndex ?? 0,
          text: chunk.content.substring(0, 200),
          chunk_id: chunk.id,
          chunk_index: chunk.index ?? 0,
          confidence: extracted.confidence ?? 0.8,
          source_stage: 'RX',
        };
        
        // Build statement with resolved cgIds
        const statement: Statement = {
          subjectCgId: subjectRef.cgId,
          predicate: extracted.predicate as Predicate,
          objectCgId: objectRef.cgId,
          confidence: this.config.enableConfidence ? (extracted.confidence ?? 0.8) : 0.8,
          evidence: [stmtEvidence],
          labels: ['Staging'],
          state: 'new',
          origin: 'llm',
          chunk_id: chunk.id,
          chunk_index: chunk.index ?? 0,
        };
        
        // Mark unresolved statements with metadata (don't drop them silently)
        if (!subjectRef.resolved || !objectRef.resolved) {
          (statement as any)._unresolvedRef = true;
          (statement as any)._refResolution = {
            subject: { name: extracted.subject, resolved: subjectRef.resolved, type: subjectRef.type },
            object: { name: extracted.object, resolved: objectRef.resolved, type: objectRef.type },
          };
        }
        
        statements.push(statement);
      } catch (error) {
        // Log but don't throw - skip invalid statements instead of crashing pipeline
        console.warn(`[DefaultExtraction] Skipping invalid statement:`, {
          extracted,
          error: error instanceof Error ? error.message : String(error)
        });
        // Continue to next statement
      }
    }
    
    // Log resolution statistics
    if (data.statements?.length) {
      debugLog(`[DefaultExtraction] Statement reference resolution:`, {
        totalRefs: (data.statements?.length ?? 0) * 2,
        resolved: resolvedCount,
        ambiguous: ambiguousCount,
        unresolved: unresolvedCount,
      });
    }
    
    // Validate entity names are exact substrings (Priority 2)
    if (entities.length > 0) {
      this.validateEntityNames(entities, chunk.content, chunk.id);
    }
    
    // Validate against profile schema (Priority 3)
    if (schema && (entities.length > 0 || statements.length > 0)) {
      this.validateAgainstProfile(entities, statements, schema, chunk.id);
    }
    
    return { entities, statements, evidence: evidenceList, tokensUsed: 0 };
  }
  
  /**
   * Map LLM-extracted kind to valid EntityType
   */
  private mapToEntityType(kind: string): EntityType {
    const kindLower = kind.toLowerCase();
    
    // Direct mappings to EntityType values
    const mappings: Record<string, EntityType> = {
      'role': 'role',
      'actor': 'role',
      'user': 'role',
      'action': 'action',
      'operation': 'action',
      'resource': 'resource',
      'entity': 'resource',
      'object': 'resource',
      'state': 'state',
      'status': 'state',
      'condition': 'condition',
      'rule': 'rule',
      'requirement': 'rule',
      'transition': 'transition',
      'service': 'service',
      'frontend': 'frontend',
      'ui': 'frontend',
      'endpoint': 'endpoint',
      'api': 'endpoint',
      'event': 'event',
      'page': 'page',
      'queue': 'queue',
      'database': 'database',
      'db': 'database',
      'component': 'resource',
      'concept': 'concept',
    };
    
    return mappings[kindLower] ?? 'resource';
  }
  
  /**
   * Resolve a statement subject/object reference to its correct cgId
   * 
   * Resolution strategy (with normalization):
   * 1. Normalize reference name (casefold, camelCase split, slugify)
   * 2. Build entity index with normalized names
   * 3. TYPED LOOKUP FIRST: Match by normalized name + allowed type from predicate signature
   * 4. FALLBACK: If no typed match, try unique match across all kinds
   * 5. KEEP UNRESOLVED: Don't drop, mark with metadata and carry forward
   */
  private resolveStatementReference(
    name: string,
    predicate: string,
    role: 'subject' | 'object',
    entities: Entity[]
  ): { cgId: string; resolved: boolean; type: EntityType; ambiguous?: boolean; matchedEntity?: Entity; normalizedName?: string } {
    // Get expected types from predicate shape constraints
    const allowedTypes = role === 'subject'
      ? getAllowedSubjectTypes(predicate)
      : getAllowedObjectTypes(predicate).filter((t: string) => t !== 'null') as EntityType[];
    
    // Normalize the reference name
    const normalizedRef = normalizeReference(name);
    
    // Build entity index with normalized names
    const entityIndex = new Map<string, Entity[]>();
    for (const entity of entities) {
      const normalizedEntityName = normalizeReference(entity.name);
      const existing = entityIndex.get(normalizedEntityName) ?? [];
      existing.push(entity);
      entityIndex.set(normalizedEntityName, existing);
    }
    
    // Step 1: Exact normalized match
    const matchingEntities = entityIndex.get(normalizedRef) ?? [];
    
    // Step 2: TYPED LOOKUP FIRST - filter to allowed types
    const typedMatches = matchingEntities.filter(
      e => allowedTypes.includes(e.type as EntityType)
    );
    
    if (typedMatches.length === 1) {
      // Perfect typed match
      const entity = typedMatches[0];
      return {
        cgId: entity.cgId,
        resolved: true,
        type: entity.type as EntityType,
        matchedEntity: entity,
        normalizedName: normalizedRef,
      };
    }
    
    if (typedMatches.length > 1) {
      // Multiple typed matches - pick highest confidence
      const sorted = typedMatches.sort((a, b) => {
        const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
        if (confDiff !== 0) return confDiff;
        const aIdx = allowedTypes.indexOf(a.type as EntityType);
        const bIdx = allowedTypes.indexOf(b.type as EntityType);
        return aIdx - bIdx;
      });
      const entity = sorted[0];
      return {
        cgId: entity.cgId,
        resolved: true,
        type: entity.type as EntityType,
        matchedEntity: entity,
        ambiguous: true,
        normalizedName: normalizedRef,
      };
    }
    
    // Step 3: FALLBACK - if we have ANY match (wrong type), use it
    if (matchingEntities.length === 1) {
      const entity = matchingEntities[0];
      // Type mismatch but name matches - use found entity
      return {
        cgId: entity.cgId,
        resolved: true,
        type: entity.type as EntityType,
        matchedEntity: entity,
        normalizedName: normalizedRef,
      };
    }
    
    if (matchingEntities.length > 1) {
      // Multiple type-mismatched entities - pick by confidence
      const sorted = matchingEntities.sort((a, b) => 
        (b.confidence ?? 0) - (a.confidence ?? 0)
      );
      const entity = sorted[0];
      return {
        cgId: entity.cgId,
        resolved: true,
        type: entity.type as EntityType,
        matchedEntity: entity,
        ambiguous: true,
        normalizedName: normalizedRef,
      };
    }
    
    // Step 4: UNIQUE MATCH ACROSS ALL KINDS - look for unique normalized match
    // This handles cases where the name exists but with different casing/format
    let uniqueMatch: Entity | undefined;
    let matchCount = 0;
    
    for (const [, ents] of entityIndex) {
      for (const ent of ents) {
        // Check if entity name contains the reference or vice versa (substring match)
        const entNorm = normalizeReference(ent.name);
        if (entNorm.includes(normalizedRef) || normalizedRef.includes(entNorm)) {
          if (allowedTypes.includes(ent.type as EntityType)) {
            matchCount++;
            uniqueMatch = ent;
          }
        }
      }
    }
    
    if (matchCount === 1 && uniqueMatch) {
      return {
        cgId: uniqueMatch.cgId,
        resolved: true,
        type: uniqueMatch.type as EntityType,
        matchedEntity: uniqueMatch,
        normalizedName: normalizedRef,
      };
    }
    
    // Step 5: UNRESOLVED - don't drop, keep with metadata
    const firstType = allowedTypes[0] ?? 'resource';
    debugWarn(
      `[RefResolution] Unresolved "${name}" → "${normalizedRef}" (predicate: ${predicate}, role: ${role})`
    );
    return {
      cgId: buildCgId(firstType, normalizedRef, { root: this.config.workspaceKey }),  // Use normalized name in cgId with workspace
      resolved: false,
      type: firstType,
      normalizedName: normalizedRef,
    };
  }
  
  /**
   * Deduplicate entities by name+type
   */
  private deduplicateEntities(entities: Entity[]): Entity[] {
    const seen = new Map<string, Entity>();
    
    for (const entity of entities) {
      const key = `${entity.type}:${entity.name.toLowerCase()}`;
      const existing = seen.get(key);
      
      if (!existing || (entity.confidence ?? 0) > (existing.confidence ?? 0)) {
        seen.set(key, entity);
      }
    }
    
    return Array.from(seen.values());
  }
  
  /**
   * Validate that entity names are exact substrings from source text (Priority 2)
   */
  private validateEntityNames(
    entities: Entity[],
    sourceText: string,
    chunkId: string
  ): void {
    let violationCount = 0;
    
    for (const entity of entities) {
      // Check if entity name is an exact substring (case-sensitive)
      if (!sourceText.includes(entity.name)) {
        debugWarn(
          `[ExtractionValidation] Entity name not found in source text:`,
          `\n  Entity: "${entity.name}" (${entity.type})`,
          `\n  Chunk: ${chunkId}`,
          `\n  This violates the exact-surface-form naming rule.`
        );
        violationCount++;
      }
    }
    
    if (violationCount > 0) {
      debugWarn(
        `[ExtractionValidation] ${violationCount} entities in chunk ${chunkId} have names that are not exact substrings. Entity overlap may be affected.`
      );
    }
  }
  
  /**
   * Validate extraction output against profile schema (Priority 3)
   */
  private validateAgainstProfile(
    entities: Entity[],
    statements: Statement[],
    schema: EntitySchema,
    chunkId: string
  ): void {
    let entityViolations = 0;
    let statementViolations = 0;
    
    // Validate entity kinds against allowed kinds
    if (schema.kinds.length > 0) {
      const allowedKinds = new Set(schema.kinds);
      
      for (const entity of entities) {
        if (!allowedKinds.has(entity.type)) {
          debugWarn(
            `[ProfileValidation] Entity kind not in allowed list:`,
            `\n  Entity: "${entity.name}" has kind "${entity.type}"`,
            `\n  Allowed kinds: ${schema.kinds.join(', ')}`,
            `\n  Chunk: ${chunkId}`
          );
          entityViolations++;
        }
      }
    }
    
    // Validate predicates against allowed predicates
    if (schema.predicates.length > 0) {
      const allowedPredicates = new Set(schema.predicates);
      
      for (const statement of statements) {
        if (!allowedPredicates.has(statement.predicate)) {
          debugWarn(
            `[ProfileValidation] Predicate not in allowed list:`,
            `\n  Predicate: "${statement.predicate}"`,
            `\n  Allowed predicates: ${schema.predicates.join(', ')}`,
            `\n  Chunk: ${chunkId}`
          );
          statementViolations++;
        }
      }
    }
    
    if (entityViolations > 0 || statementViolations > 0) {
      debugWarn(
        `[ProfileValidation] Chunk ${chunkId}: ${entityViolations} entity kind violations, ${statementViolations} predicate violations`
      );
    }
  }
}

/**
 * Extracted data structure (from LLM response)
 */
interface ExtractedData {
  entities?: Array<{
    name: string;
    kind: string;
    description?: string;
    confidence?: number;
  }>;
  statements?: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence?: number;
  }>;
}

/**
 * Create a default extraction provider
 */
export function createDefaultExtractionProvider(
  llmProvider: LLMProvider,
  config?: DefaultExtractionConfig
): DefaultExtractionProvider {
  return new DefaultExtractionProvider(llmProvider, config);
}
