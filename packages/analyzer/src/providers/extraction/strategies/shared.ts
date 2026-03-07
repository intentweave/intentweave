// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Strategy Utilities
 * 
 * Common types, prompts, and helper functions for extraction strategies.
 */

import type {
  Entity,
  Statement,
  Evidence,
  Chunk,
  EntitySchema,
  ExtractionProfile,
} from '@intentweave/core';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Strategy configuration options
 */
export interface StrategyConfig {
  /** Temperature for LLM calls (default: 0.1) */
  temperature: number;
  /** Enable confidence scoring (default: true) */
  enableConfidence: boolean;
  /** Enable evidence span tracking (default: true) */
  enableEvidenceSpans: boolean;
  /** Number of parallel API calls (default: 5) */
  concurrency: number;
}

/**
 * Create default strategy configuration
 */
export function createDefaultStrategyConfig(overrides?: Partial<StrategyConfig>): StrategyConfig {
  return {
    temperature: overrides?.temperature ?? 0.1,
    enableConfidence: overrides?.enableConfidence ?? true,
    enableEvidenceSpans: overrides?.enableEvidenceSpans ?? true,
    concurrency: overrides?.concurrency ?? 5,
  };
}

// =============================================================================
// System Prompts - Layered Architecture
// =============================================================================

/**
 * Layer 1: Core Semantic Frame
 * 
 * General knowledge graph modeling mindset. Never changes.
 */
const CORE_SEMANTIC_FRAME = `You are modeling the intent of a document as a Knowledge Graph.

Your task: Extract semantic objects (entities) and relationships (statements) that capture
what this content MEANS, not just what it SAYS.

Output format: JSON with entities[] and statements[] arrays.

Each entity needs: {name, kind, description, confidence}
Each statement needs: {subject, predicate, object, confidence}

CRITICAL RULES:
1. Entity names MUST be exact substrings from the source text (no paraphrasing)
2. Subject/object in statements MUST match entity names exactly
3. Confidence: 0.5-0.7 for implied, 0.8-1.0 for explicit`;

/**
 * Layer 2: Schema Hints (generated from profile)
 * 
 * Lists allowed kinds and predicates.
 */
function buildSchemaHints(
  allowedKinds: string[],
  allowedPredicates: string[]
): string {
  return `
## Entity Kinds (what to extract)
${allowedKinds.map(k => `- ${k}`).join('\n')}

## Relationship Predicates (how to connect them)
${allowedPredicates.map(p => `- ${p}`).join('\n')}`;
}

/**
 * Layer 3: Chunk-Type Specific Instructions
 * 
 * Different extraction strategies based on content structure.
 */
function buildChunkTypeInstructions(chunkType: string | undefined): string {
  switch (chunkType) {
    case 'table':
      return `
## TABLE EXTRACTION (Structured Data)

This chunk contains a markdown table with structured data.
Tables often encode relationships directly:

1. Each ROW typically represents an entity or relationship
2. HEADERS define the semantic roles (e.g., "Actor", "Action", "Resource")
3. Look for columns like:
   - "Actor", "User", "Role" → These indicate WHO can do something
   - "Action", "Operation", "Method" → These indicate WHAT can be done
   - "Permission", "Allowed" → These indicate authorization (→ ROLE_CAN)
   - "From", "To" → These indicate state transitions (→ TRANSITIONS_TO)

EXTRACTION PATTERN for Permission Tables:
| Method | Action | Actor |
|--------|--------|-------|
| POST | Create task | user, admin |

→ Extract: admin ROLE_CAN "Create task"
→ Extract: user ROLE_CAN "Create task"

EXTRACTION PATTERN for State Transition Tables:
| From | To | Action |
|------|-----|--------|
| open | done | complete |

→ Extract: "open" TRANSITIONS_TO "done"
→ Extract: "complete" FROM_STATE "open"
→ Extract: "complete" TO_STATE "done"

Parse the JSON data if present (look for <!-- [STRUCTURED_TABLE_DATA] -->).`;

    case 'code':
      return `
## CODE EXTRACTION (TypeScript/JavaScript)

This chunk contains code. Focus on:
1. Interface/type definitions → Extract as resources with their properties
2. Enum values → Extract as states (if they represent lifecycle stages)
3. Function signatures → Extract as actions
4. Class names → Extract as components

Skip implementation details, focus on declarations and contracts.`;

    case 'list':
      return `
## LIST EXTRACTION

This chunk contains a list. Lists often enumerate:
1. States or status values (extract as states)
2. Actions or operations (extract as actions)
3. Roles or actors (extract as roles)

Look for patterns like "can X", "must X", "may X" to identify permissions.`;

    default:
      return `
## TEXT EXTRACTION (General)

Extract entities and relationships from natural language.
Look for:
- Roles: "user", "admin", "system" - actors who take actions
- Actions: verbs describing what can be done
- Resources: nouns that are acted upon
- States: status values that resources can be in
- Constraints: limitations or rules ("must", "within X days")

Key patterns:
- "X can Y" → X ROLE_CAN Y
- "X has states: A, B, C" → X HAS_STATE A, X HAS_STATE B, etc.
- "from A to B" → A TRANSITIONS_TO B`;
  }
}

/**
 * Layer 4: Semantic Issue Detection
 * 
 * Guidance for detecting problems in specifications.
 */
const SEMANTIC_ISSUE_DETECTION = `
## Issue Detection (extract as kind: "issue")

Flag these problems if you detect them:
1. CONTRADICTION: Same thing with opposite rules (e.g., "MUST delete" vs "MUST NOT delete")
2. AMBIGUITY: Vague language ("maybe", "possibly", "see spec")
3. TENSION: Conflicting constraints (e.g., "within 30 days" vs "after 30 days")

When extracting an issue, describe what conflicts and why.`;

/**
 * Domain-specific pattern hints based on common spec structures
 */
const DOMAIN_PATTERNS = `
## Domain Patterns

State vs Event distinction:
- STATES (current status): open, closed, pending, archived → kind: "state"
- EVENTS (what happened): created, edited, deleted → kind: "event"  
- Test: Is it describing WHERE something IS (state) or WHAT HAPPENED (event)?

Skip attribute values that don't transition:
- priority: low/medium/high → Skip (not a lifecycle state)
- HTTP codes: 200, 400, 404 → Skip (response codes, not states)

Always extract the RESOURCE that owns states:
- If you see states like "open, done, archived", there must be a resource (task, order, etc.)`;

// =============================================================================
// Combined Prompts (Built from Layers)
// =============================================================================

export const SINGLE_PASS_SYSTEM_PROMPT = CORE_SEMANTIC_FRAME + SEMANTIC_ISSUE_DETECTION + DOMAIN_PATTERNS;

export const ENTITIES_ONLY_SYSTEM_PROMPT = CORE_SEMANTIC_FRAME + `

You are extracting ENTITIES ONLY in this pass. Do not extract relationships.
Focus on identifying all meaningful objects mentioned in the text.` + DOMAIN_PATTERNS;

export const STATEMENTS_ONLY_SYSTEM_PROMPT = CORE_SEMANTIC_FRAME + `

You are extracting RELATIONSHIPS ONLY in this pass.
You will be given a list of entities that were already extracted.
Find connections ONLY between entities in that list.

IMPORTANT: Generate HAS_STATE statements linking resources to their states!`;

// =============================================================================
// Response Schemas
// =============================================================================

/**
 * JSON Schema for extraction response (single-pass: entities + statements)
 */
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Entity name' },
          kind: { type: 'string', description: 'Entity kind (role, action, resource, state, etc.)' },
          description: { type: 'string', description: 'Brief description' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['name', 'kind', 'description', 'confidence'],
        additionalProperties: false,
      },
    },
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Subject entity name' },
          predicate: { type: 'string', description: 'Relationship type (ROLE_CAN, HAS_STATE, etc.)' },
          object: { type: 'string', description: 'Object entity name' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['subject', 'predicate', 'object', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'statements'],
  additionalProperties: false,
} as const;

/**
 * JSON Schema for entities-only extraction (Pass 1 of 2-pass mode)
 */
export const ENTITIES_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Entity name (MUST be exact substring from source text)' },
          kind: { type: 'string', description: 'Entity kind from allowed list' },
          description: { type: 'string', description: 'Brief description' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['name', 'kind', 'description', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities'],
  additionalProperties: false,
} as const;

/**
 * JSON Schema for statements-only extraction (Pass 2 of 2-pass mode)
 */
export const STATEMENTS_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Subject entity name (must match entity from list)' },
          predicate: { type: 'string', description: 'Relationship type from allowed list' },
          object: { type: 'string', description: 'Object entity name (must match entity from list)' },
          confidence: { type: 'number', description: 'Confidence score 0-1' },
        },
        required: ['subject', 'predicate', 'object', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['statements'],
  additionalProperties: false,
} as const;

// =============================================================================
// Helper Types
// =============================================================================

/**
 * Raw extracted entity from LLM
 */
export interface ExtractedEntity {
  name: string;
  kind: string;
  description: string;
  confidence: number;
}

/**
 * Raw extracted statement from LLM
 */
export interface ExtractedStatement {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

/**
 * Parsed extraction data from LLM response
 */
export interface ExtractedData {
  entities?: ExtractedEntity[];
  statements?: ExtractedStatement[];
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Build extraction prompt for a chunk
 * 
 * Uses the layered prompt architecture:
 * - Layer 1: Core semantic frame (in system prompt)
 * - Layer 2: Schema hints (kinds + predicates)
 * - Layer 3: Chunk-type specific instructions
 * - Layer 4: Document context and content
 */
export function buildExtractionPrompt(
  chunk: Chunk,
  schema: EntitySchema,
  profile: ExtractionProfile,
  mode: 'single-pass' | 'entities-only' | 'statements-only',
  existingEntities?: Entity[]
): string {
  const allowedKinds = schema.kinds.length > 0
    ? schema.kinds
    : ['role', 'action', 'resource', 'state', 'event', 'requirement', 'component', 'constraint', 'policy', 'issue'];
  
  // NOTE: TRIGGERED_BY is required for state machine extraction
  // The LLM extracts "transition TRIGGERED_BY action" which MX inverts to "action TRIGGERS transition"
  const allowedPredicates = schema.predicates.length > 0
    ? schema.predicates
    : ['ROLE_CAN', 'HAS_STATE', 'TRANSITIONS_TO', 'TRIGGERED_BY', 'FROM_STATE', 'TO_STATE', 'REQUIRES', 'CONTAINS', 'IMPLEMENTS', 'CONFLICTS_WITH', 'AFFECTS'];
  
  // Determine chunk type from metadata or infer from content
  const metadataChunkType = chunk.metadata?.chunkType;
  const chunkType: string | undefined = typeof metadataChunkType === 'string' 
    ? metadataChunkType 
    : inferChunkType(chunk.content);
  
  // Build the prompt using layers
  let prompt = '';
  
  // Layer 2: Schema hints
  prompt += buildSchemaHints(allowedKinds, allowedPredicates);
  
  // Layer 3: Chunk-type specific instructions
  prompt += buildChunkTypeInstructions(chunkType);
  
  // Layer 4: Document context
  prompt += `

## Document Context
- Profile: ${profile.name}
- Artifact role: ${profile.artifactRole ?? 'general'}
- Chunk type: ${chunkType ?? 'text'}
- File: ${chunk.metadata?.sourceFile ?? 'unknown'}

## Content to Extract From
\`\`\`
${chunk.content}
\`\`\``;

  // For statements-only mode, include existing entities
  if (mode === 'statements-only' && existingEntities && existingEntities.length > 0) {
    const entityList = existingEntities
      .map(e => `- "${e.name}" (${e.type})`)
      .join('\n');
    prompt += `

## Entities Already Extracted
Find relationships ONLY between these entities:
${entityList}`;
  }

  return prompt;
}

/**
 * Infer chunk type from content patterns
 */
function inferChunkType(content: string): string | undefined {
  // Check for table patterns
  if (content.includes('| ') && content.includes(' |') && content.includes('---')) {
    return 'table';
  }
  // Check for code patterns
  if (content.startsWith('```') || /^\s*(function|class|interface|type|const|let|var|export|import)\s/.test(content)) {
    return 'code';
  }
  // Check for list patterns
  if (/^(\s*[-*]\s|\s*\d+\.\s)/m.test(content)) {
    return 'list';
  }
  return undefined;
}

/**
 * Convert extracted entity to core Entity type
 */
export function convertToEntity(
  extracted: ExtractedEntity,
  chunk: Chunk,
  _schema: EntitySchema
): Entity {
  const kind = normalizeKind(extracted.kind);
  
  // Build cgId from entity kind and normalized name
  // Use simple format: kind:name (normalized)
  const normalizedName = extracted.name.toLowerCase().replace(/\s+/g, '_');
  const cgId = `${kind}:${normalizedName}`;
  
  // Get turnIndex from chunk or default to 0
  const turnIndex = chunk.turnIndex ?? 0;
  
  return {
    cgId,
    name: extracted.name,
    type: kind as Entity['type'],
    confidence: extracted.confidence,
    labels: ['Staging'],
    evidence: [{
      turnIndex,
      text: chunk.content.slice(0, 200),
      chunk_id: chunk.id,
      confidence: extracted.confidence,
      source_stage: 'RX',
    }],
    source: 'llm',
    state: 'new',
    aliases: [],
  };
}

/**
 * Convert extracted statement to core Statement type
 */
export function convertToStatement(
  extracted: ExtractedStatement,
  chunk: Chunk,
  entities: Entity[]
): Statement {
  // Find matching subject and object entities
  const subjectEntity = entities.find(e => 
    e.name.toLowerCase() === extracted.subject.toLowerCase()
  );
  const objectEntity = entities.find(e => 
    e.name.toLowerCase() === extracted.object.toLowerCase()
  );
  
  // Get turnIndex from chunk or default to 0
  const turnIndex = chunk.turnIndex ?? 0;
  
  return {
    subjectCgId: subjectEntity?.cgId ?? `unknown:${extracted.subject}`,
    predicate: extracted.predicate,
    objectCgId: objectEntity?.cgId ?? `unknown:${extracted.object}`,
    confidence: extracted.confidence,
    labels: ['Staging'],
    evidence: [{
      turnIndex,
      text: chunk.content.slice(0, 200),
      chunk_id: chunk.id,
      confidence: extracted.confidence,
      source_stage: 'RX',
    }],
    state: 'new',
    chunk_id: chunk.id,
  };
}

/**
 * Normalize entity kind to standard format
 */
export function normalizeKind(kind: string): string {
  const normalized = kind.toLowerCase().trim();
  
  // Map common variations
  const kindMap: Record<string, string> = {
    'roles': 'role',
    'actions': 'action',
    'resources': 'resource',
    'states': 'state',
    'requirements': 'requirement',
    'components': 'component',
    'actor': 'role',
    'actors': 'role',
    'entity': 'resource',
    'entities': 'resource',
    'object': 'resource',
    'objects': 'resource',
    'status': 'state',
    'condition': 'state',
    'conditions': 'state',
    'activity': 'action',
    'activities': 'action',
    'operation': 'action',
    'operations': 'action',
    'service': 'component',
    'services': 'component',
    'module': 'component',
    'modules': 'component',
  };
  
  return kindMap[normalized] ?? normalized;
}

/**
 * Deduplicate entities by name+kind
 */
export function deduplicateEntities(entities: Entity[]): Entity[] {
  const seen = new Map<string, Entity>();
  
  for (const entity of entities) {
    const key = `${entity.name.toLowerCase()}:${entity.type}`;
    if (!seen.has(key)) {
      seen.set(key, entity);
    } else {
      // Keep the one with higher confidence
      const existing = seen.get(key)!;
      if (entity.confidence > existing.confidence) {
        seen.set(key, entity);
      }
    }
  }
  
  return Array.from(seen.values());
}

/**
 * Create evidence reference from chunk
 */
export function createEvidence(
  chunk: Chunk,
  entities: Entity[],
  _statements: Statement[]
): Evidence[] {
  const evidence: Evidence[] = [];
  
  // Get turnIndex from chunk or default to 0
  const turnIndex = chunk.turnIndex ?? 0;
  
  // Create evidence for each entity found
  for (const entity of entities) {
    evidence.push({
      turnIndex,
      text: chunk.content.slice(0, 200), // First 200 chars as context
      chunk_id: chunk.id,
      confidence: entity.confidence,
      source_stage: 'RX',
    });
  }
  
  return evidence;
}
