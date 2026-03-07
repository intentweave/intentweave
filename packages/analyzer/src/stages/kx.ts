/**
 * KX Stage — Canonicalization
 *
 * Takes raw triples from FX and normalizes them into a queryable,
 * canonical vocabulary — without losing the original raw data.
 *
 * Two-layer output:
 * 1. `rawTriples`   — preserved verbatim from FX (for RAG / full context)
 * 2. `canonTriples`  — normalized entities + predicates (for Cypher queries)
 * 3. `canonEntities` — deduplicated entity list with canonical IDs and types
 *
 * Pipeline position:  IN → FX → KX  (parallel to IN → RX → CX → MX → PX)
 *
 * The canonicalization is LLM-driven (Pass 2) and operates on the structured
 * triples, NOT on raw text — making it cheaper and more consistent.
 */

import type { LLMProvider, Evidence, TokenUsage } from '@intentweave/core';
import { buildTokenUsage, zeroTokenUsage, sumTokenUsage, AbortThresholdError } from '@intentweave/core';
import type { PipelineContext } from '../pipeline/context.js';
import type { FxStageOutput, RawTriple } from './fx.js';
import { hashContent } from '../cache/registry.js';
import { completeWithRetry } from '../providers/llm/completeWithRetry.js';

// =============================================================================
// Canonical Vocabulary — small, stable, query-friendly
// =============================================================================

/**
 * The canonical predicate set.
 * ~15 predicates covering structural, behavioral, and design relationships.
 *
 * This is the vocabulary that Cypher queries target.
 * Raw predicates map to one of these (or to RELATED_TO as fallback).
 */
export const CANONICAL_PREDICATES = [
  // Structural
  'CONTAINS',          // hierarchy / composition
  'DEPENDS_ON',        // hard dependency
  'ALTERNATIVE_TO',    // choice between options
  'IMPLEMENTS',        // realises a requirement / spec / interface
  'EXTENDS',           // specialisation, inheritance

  // Descriptive
  'IS_A',              // type / classification ("X is a Y")
  'DESCRIBES',         // documentation / provenance ("X documents Y")
  'HAS_PROPERTY',      // attribute-like relationship when no better fit

  // Behavioral
  'HAS_STATE',         // entity has a lifecycle state
  'HAS_PHASE',         // entity belongs to a phase / milestone
  'TRANSITIONS_TO',    // state → state
  'TRIGGERS',          // action triggers transition/event
  'PRECEDES',          // temporal ordering
  'FOLLOWS',           // temporal ordering (inverse)

  // Design / Decision
  'DECIDED_FOR',       // decision selected option
  'DECIDED_AGAINST',   // decision rejected option
  'SUPERSEDES',        // decision replaces earlier decision
  'MOTIVATED_BY',      // choice motivated by constraint/goal
  'ENABLES',           // option/component enables capability
  'BLOCKS',            // constraint/gap blocks capability
  'RISKS',             // option/component has risk
  'DEFERRED_TO',       // requirement/feature pushed to phase
  'PROPOSED_FOR',      // suggestion, proposal
  'REPLACES',          // one thing replaces another
  'REQUIRES',          // prerequisite / must-have

  // Interaction
  'CALLS',             // component calls component
  'USES',              // component/feature uses technology
  'PRODUCES',          // component produces output/event
  'CONSUMES',          // component consumes input/event

  // Fallback
  'RELATED_TO',        // catch-all — use sparingly
] as const;

export type CanonicalPredicate = typeof CANONICAL_PREDICATES[number];

/**
 * Canonical entity types — broad enough to cover most domains.
 */
export const CANONICAL_ENTITY_TYPES = [
  'concept',       // abstract idea or principle
  'decision',      // a choice that was made
  'option',        // an alternative considered
  'requirement',   // a stated need
  'feature',       // a product capability
  'component',     // a system part/module
  'technology',    // a specific tool/framework/library
  'resource',      // a data entity or managed thing
  'role',          // an actor type
  'risk',          // a potential problem
  'phase',         // a timeline period
  'constraint',    // a limitation
  'question',      // an unresolved question
  'tradeoff',      // an explicit tradeoff
] as const;

export type CanonicalEntityType = typeof CANONICAL_ENTITY_TYPES[number];

// =============================================================================
// KX Stage Types
// =============================================================================

/**
 * A canonical entity — deduplicated, typed, with stable ID
 */
export interface CanonEntity {
  /** Canonical ID (slug form, e.g. "react", "rust-core", "backlog-view") */
  canonId: string;
  /** Display name */
  name: string;
  /** Canonical entity type */
  type: CanonicalEntityType;
  /** All aliases that resolved to this entity */
  aliases: string[];
  /** Average confidence across all triples mentioning this entity */
  confidence: number;
}

/**
 * A canonical triple — normalized predicate + resolved entity IDs
 */
export interface CanonTriple {
  /** Subject canonical entity ID */
  subjectCanonId: string;
  /** Canonical predicate */
  predicate: CanonicalPredicate;
  /** Object canonical entity ID */
  objectCanonId: string;
  /** Confidence (inherited from raw triple) */
  confidence: number;
  /** Original raw predicate (for provenance) */
  rawPredicate: string;
  /** Index into rawTriples array (for linking) */
  rawTripleIndex: number;
}

/**
 * KX Stage Input
 */
export interface KxStageInput {
  /** Artifact ID */
  artifactId: string;
  /** FX stage output */
  fxOutput: FxStageOutput;
}

/**
 * KX Stage Output — dual-layer: raw + canonical
 */
export interface KxStageOutput {
  /** JSON Schema reference */
  $schema: string;
  /** Schema version */
  schemaVersion: '0.1';
  /** Stage identifier */
  stage: 'KX';
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;

  // ─── Layer 1: Raw (preserved from FX) ───
  /** All raw triples, unmodified (for RAG context) */
  rawTriples: RawTriple[];

  // ─── Layer 2: Canonical (for Cypher queries) ───
  /** Deduplicated, typed entities */
  canonEntities: CanonEntity[];
  /** Normalized triples with canonical predicates + entity IDs */
  canonTriples: CanonTriple[];

  // ─── Mapping ───
  /** Entity resolution log: raw name → canonId */
  entityResolutions: EntityResolution[];
  /** Predicate mapping log: raw predicate → canonical predicate */
  predicateMappings: PredicateMapping[];

  /** Evidence (passed through from FX) */
  evidence: Evidence[];

  /** Metadata */
  meta: {
    provider: string;
    model?: string;
    latencyMs: number;
    tokensUsed?: number;
    rawTripleCount: number;
    canonTripleCount: number;
    canonEntityCount: number;
    entitiesMerged: number;
    predicatesFallback: number; // count mapped to RELATED_TO
    droppedCount: number; // count of triples intentionally dropped by LLM
  };
  /** Aggregated token usage (prompt + completion + cost) */
  tokenUsage?: TokenUsage;
}

/**
 * Entity resolution record (for transparency / debugging)
 */
export interface EntityResolution {
  /** Raw name from FX */
  rawName: string;
  /** Raw kind hint from FX */
  rawKind?: string;
  /** Resolved canonical ID */
  canonId: string;
  /** Resolved canonical type */
  canonType: CanonicalEntityType;
  /** Resolution method: 'exact' | 'fuzzy' | 'llm' */
  method: 'exact' | 'fuzzy' | 'llm';
}

/**
 * Predicate mapping record
 */
export interface PredicateMapping {
  /** Raw predicate from FX */
  rawPredicate: string;
  /** Canonical predicate */
  canonPredicate: CanonicalPredicate;
  /** Mapping confidence */
  confidence: number;
}

// =============================================================================
// KX System Prompt — canonicalization instructions
// =============================================================================

const KX_SYSTEM_PROMPT = `You are a knowledge graph normalization expert. Given a list of raw (subject, predicate, object) triples, your job is to:

1. CANONICALIZE ENTITIES:
   - Merge duplicates: "React.js", "React", "reactjs" → single entity "React"
   - Assign each unique entity a slug ID (lowercase, hyphens): "react", "rust-core", "backlog-view"
   - Assign each entity a TYPE from this list:
     concept, decision, option, requirement, feature, component, technology,
     resource, role, risk, phase, constraint, question, tradeoff

2. CANONICALIZE PREDICATES:
   Map each raw predicate to ONE of these canonical predicates. Choose the MOST SPECIFIC match — RELATED_TO is the last resort.

   Structural:
   - CONTAINS: hierarchy/composition — "part of", "includes", "has section", "has field"
   - DEPENDS_ON: hard dependency — "requires dependency", "needs", "import"
   - ALTERNATIVE_TO: choices — "or", "instead of", "choice between"
   - IMPLEMENTS: realization — "implements", "realises", "satisfies requirement"
   - EXTENDS: specialization — "extends", "inherits", "subclass of"
   - IS_A: type/classification — "is a", "is an instance of", "is a type of", "represents", "denotes"
   - DESCRIBES: documentation/provenance — "documents", "documented in", "sourced from", "described by", "refers to"
   - HAS_PROPERTY: attribute — "has value", "has title", "has id", "has description", "estimated as"

   Behavioral:
   - HAS_STATE: lifecycle status — "has status", "is in state", "is considered", "is currently"
   - HAS_PHASE: phase membership — "in phase", "belongs to phase", "scheduled for"
   - TRANSITIONS_TO: state change — "transitions to", "becomes"
   - TRIGGERS: cause/effect — "triggers", "causes", "initiates"
   - PRECEDES: temporal sequence — "before", "precedes", "leads to"
   - FOLLOWS: temporal sequence — "after", "follows", "comes after"

   Design:
   - DECIDED_FOR: selection — "chosen", "selected", "we go with", "decided to use"
   - DECIDED_AGAINST: rejection — "rejected", "ruled out"
   - SUPERSEDES: replacement — "replaces", "overrides", "supersedes"
   - REPLACES: one thing takes place of another — "replaces", "swapped for"
   - MOTIVATED_BY: rationale — "because", "reason", "motivated by"
   - ENABLES: capability — "makes possible", "unlocks", "allows"
   - BLOCKS: impediment — "prevents", "blocks", "can't do X without"
   - RISKS: hazard — "risk", "danger", "might cause"
   - DEFERRED_TO: postponement — "later", "phase N", "postponed"
   - PROPOSED_FOR: suggestion — "proposed for", "suggested", "recommended for"
   - REQUIRES: prerequisite — "requires", "prerequisite", "must have", "needs"

   Interaction:
   - CALLS: invocation — "calls", "invokes"
   - USES: usage — "uses", "built with", "powered by", "used for", "utilizes"
   - PRODUCES: output — "produces", "generates", "outputs", "creates"
   - CONSUMES: input — "consumes", "receives", "accepts"

   Fallback:
   - RELATED_TO: ONLY use when no other predicate fits AT ALL. If in doubt, pick the closest semantic match above.

3. DROP LOW-VALUE TRIPLES:
   Some raw triples express metadata rather than knowledge relationships. DROP these — do not include them in the output:
   - Pure attribute triples: "X has id Y", "X has title Y", "X was created on Y", "X estimated time Y"
   - Self-referential: "X is X", "X contains X"
   - File path references: "X is located at /path/to/file"
   - Redundant type assertions already captured by entity type assignment

   Instead, absorb useful metadata into entity aliases or types.

4. OUTPUT FORMAT:
   Return JSON with:
   - entities: array of {canonId, name, type, aliases}
   - triples: array of {subjectCanonId, predicate, objectCanonId, rawIndex}
   - predicateMappings: array of {raw, canon}

Be thorough — every meaningful raw triple should appear in the canonical output.
Merge aggressively — prefer fewer, well-defined entities over duplicates.
Minimize RELATED_TO — aim for < 10% of output triples.

COMMON MISTAKES TO AVOID:
- Mapping "uses" or "built with" to RELATED_TO when USES is available.
- Mapping "part of" or "within" to RELATED_TO instead of CONTAINS.
- Creating separate entities for "the API" vs "REST API" vs "api" — merge them.
- Mapping "before" or "after" to RELATED_TO instead of PRECEDES / FOLLOWS.`;

/**
 * Hash of the KX system prompt + canonical vocabulary — used by the cache to
 * detect prompt/vocabulary changes. When this changes, cached KX outputs are
 * automatically invalidated (FX cache remains valid).
 */
export const KX_PROMPT_VERSION = hashContent(
  KX_SYSTEM_PROMPT + '\n' + CANONICAL_PREDICATES.join(','),
);

/**
 * KX response JSON schema
 */
const KX_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonId: { type: 'string' },
          name: { type: 'string' },
          type: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
        },
        required: ['canonId', 'name', 'type', 'aliases'],
        additionalProperties: false,
      },
    },
    triples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subjectCanonId: { type: 'string' },
          predicate: { type: 'string' },
          objectCanonId: { type: 'string' },
          rawIndex: { type: 'number' },
        },
        required: ['subjectCanonId', 'predicate', 'objectCanonId', 'rawIndex'],
        additionalProperties: false,
      },
    },
    predicateMappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw: { type: 'string' },
          canon: { type: 'string' },
        },
        required: ['raw', 'canon'],
        additionalProperties: false,
      },
    },
    dropped: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rawIndex: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['rawIndex', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'triples', 'predicateMappings', 'dropped'],
  additionalProperties: false,
};

// =============================================================================
// KX Implementation
// =============================================================================

/**
 * Build user prompt with the raw triples for canonicalization
 */
function buildKxUserPrompt(triples: RawTriple[]): string {
  const tripleLines = triples.map((t, i) =>
    `[${i}] (${t.subject}${t.subjectKind ? ` [${t.subjectKind}]` : ''}) ` +
    `—[ ${t.predicate} ]→ ` +
    `(${t.object}${t.objectKind ? ` [${t.objectKind}]` : ''})` +
    `  confidence: ${t.confidence}`
  );

  return [
    `CANONICALIZE THESE ${triples.length} RAW TRIPLES:\n`,
    ...tripleLines,
    '\nReturn the canonical entities, triples, and predicate mappings as JSON.',
  ].join('\n');
}

/**
 * Validate and coerce a canonical predicate
 */
function toCanonicalPredicate(raw: string): CanonicalPredicate {
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if ((CANONICAL_PREDICATES as readonly string[]).includes(upper)) {
    return upper as CanonicalPredicate;
  }
  return 'RELATED_TO';
}

/**
 * Validate and coerce a canonical entity type
 */
function toCanonicalEntityType(raw: string): CanonicalEntityType {
  const lower = raw.toLowerCase().trim();
  if ((CANONICAL_ENTITY_TYPES as readonly string[]).includes(lower)) {
    return lower as CanonicalEntityType;
  }
  return 'concept'; // safe fallback
}

/**
 * Slugify an entity name for use as a canonical ID
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unnamed';
}

/**
 * Parse the KX LLM response
 */
function parseKxResponse(
  response: unknown,
  rawTriples: RawTriple[],
): {
  entities: CanonEntity[];
  triples: CanonTriple[];
  entityResolutions: EntityResolution[];
  predicateMappings: PredicateMapping[];
  fallbackCount: number;
  mergedCount: number;
} {
  const data = (response ?? {}) as Record<string, unknown>;

  // ─── Parse entities ───
  const rawEntities = Array.isArray(data.entities) ? data.entities : [];
  const entityMap = new Map<string, CanonEntity>();
  const entityResolutions: EntityResolution[] = [];

  for (const e of rawEntities) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const canonId = slugify(String(rec.canonId ?? rec.name ?? ''));
    const name = String(rec.name ?? canonId);
    const type = toCanonicalEntityType(String(rec.type ?? 'concept'));
    const aliases = Array.isArray(rec.aliases) ? rec.aliases.map(String) : [];

    if (!entityMap.has(canonId)) {
      entityMap.set(canonId, { canonId, name, type, aliases, confidence: 0 });
    } else {
      // Merge aliases
      const existing = entityMap.get(canonId)!;
      for (const a of aliases) {
        if (!existing.aliases.includes(a)) existing.aliases.push(a);
      }
    }

    // Build resolution records for each alias
    for (const alias of [name, ...aliases]) {
      entityResolutions.push({
        rawName: alias,
        canonId,
        canonType: type,
        method: 'llm',
      });
    }
  }

  // ─── Parse triples ───
  const rawCanonTriples = Array.isArray(data.triples) ? data.triples : [];
  const canonTriples: CanonTriple[] = [];
  let fallbackCount = 0;

  for (const t of rawCanonTriples) {
    if (!t || typeof t !== 'object') continue;
    const rec = t as Record<string, unknown>;

    const subjectCanonId = slugify(String(rec.subjectCanonId ?? ''));
    const objectCanonId = slugify(String(rec.objectCanonId ?? ''));
    const predicate = toCanonicalPredicate(String(rec.predicate ?? 'RELATED_TO'));
    const rawIndex = typeof rec.rawIndex === 'number' ? rec.rawIndex : -1;

    if (predicate === 'RELATED_TO') fallbackCount++;

    // Get raw predicate for provenance
    const rawPredicate = rawIndex >= 0 && rawIndex < rawTriples.length
      ? rawTriples[rawIndex].predicate
      : String(rec.predicate ?? '');

    // Get confidence from raw triple if available
    const confidence = rawIndex >= 0 && rawIndex < rawTriples.length
      ? rawTriples[rawIndex].confidence
      : 0.5;

    canonTriples.push({
      subjectCanonId,
      predicate,
      objectCanonId,
      confidence,
      rawPredicate,
      rawTripleIndex: rawIndex,
    });

    // Update entity confidence (running average approximation)
    for (const id of [subjectCanonId, objectCanonId]) {
      const entity = entityMap.get(id);
      if (entity) {
        entity.confidence = (entity.confidence + confidence) / 2;
      }
    }
  }

  // ─── Parse predicate mappings ───
  const rawMappings = Array.isArray(data.predicateMappings) ? data.predicateMappings : [];
  const predicateMappings: PredicateMapping[] = rawMappings
    .filter((m): m is Record<string, unknown> => m != null && typeof m === 'object')
    .map(m => ({
      rawPredicate: String(m.raw ?? ''),
      canonPredicate: toCanonicalPredicate(String(m.canon ?? 'RELATED_TO')),
      confidence: 0.9,
    }));

  // Count merged entities (aliases > 0)
  const mergedCount = [...entityMap.values()].filter(e => e.aliases.length > 1).length;

  return {
    entities: [...entityMap.values()],
    triples: canonTriples,
    entityResolutions,
    predicateMappings,
    fallbackCount,
    mergedCount,
  };
}

/**
 * Safe JSON parse fallback
 */
function tryParseJson(content: string): unknown {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the KX (Canonicalization) stage
 *
 * @param input   - FX output with raw triples
 * @param llmProvider - LLM for canonicalization
 * @param ctx     - Pipeline context (for logging)
 */
export async function runKxStage(
  input: KxStageInput,
  llmProvider: LLMProvider,
  ctx?: Pick<PipelineContext, 'logger'>,
): Promise<KxStageOutput> {
  const startTime = Date.now();
  const logger = ctx?.logger;
  const { fxOutput } = input;

  logger?.info(`[KX] Starting canonicalization for ${input.artifactId}`, {
    rawTriples: fxOutput.triples.length,
  });

  // If no triples, return empty output
  if (fxOutput.triples.length === 0) {
    logger?.info(`[KX] No triples to canonicalize for ${input.artifactId}`);
    return buildEmptyOutput(input, fxOutput, Date.now() - startTime, llmProvider.name);
  }

  // ─── Batch canonicalization (parallel) ───
  // Process triples in manageable batches to stay within LLM token limits.
  // Each batch gets canonicalized independently, then results are merged.
  // Batches run in parallel with a concurrency limit to avoid rate-limiting.
  const BATCH_SIZE = 40; // ~40 triples per batch — keeps prompt+output within model limits
  const CONCURRENCY = 5; // max parallel LLM requests
  const BATCH_TIMEOUT_MS = 300_000; // 5 minutes per batch — canonicalization is heavy
  const allTriples = fxOutput.triples;
  const batches: RawTriple[][] = [];
  for (let i = 0; i < allTriples.length; i += BATCH_SIZE) {
    batches.push(allTriples.slice(i, i + BATCH_SIZE));
  }

  logger?.info(`[KX] Processing ${allTriples.length} triples in ${batches.length} batches of ≤${BATCH_SIZE} (concurrency: ${CONCURRENCY})`);

  // ─── Process a single batch ───
  interface BatchResult {
    batchIdx: number;
    entities: CanonEntity[];
    triples: CanonTriple[];
    entityResolutions: EntityResolution[];
    predicateMappings: PredicateMapping[];
    fallbackCount: number;
    mergedCount: number;
    droppedCount: number;
    tokensUsed: number;
    tokenUsage: TokenUsage;
    model: string;
  }

  async function processBatch(batchIdx: number): Promise<BatchResult | null> {
    const batch = batches[batchIdx];
    const globalOffset = batchIdx * BATCH_SIZE;

    try {
      const response = await completeWithRetry(llmProvider, {
        system: KX_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildKxUserPrompt(batch) },
        ],
        responseSchema: KX_RESPONSE_SCHEMA,
        temperature: 0.0,
        timeoutMs: BATCH_TIMEOUT_MS,
      }, { logger });

      if (response.finishReason === 'error') {
        logger?.warn(`[KX] Batch ${batchIdx + 1}/${batches.length} failed: ${response.error}`);
        return null;
      }

      const parsed = response.parsed ?? tryParseJson(response.content);
      const result = parseKxResponse(parsed, batch);

      // Remap rawIndex from batch-local to global
      for (const ct of result.triples) {
        if (ct.rawTripleIndex >= 0) {
          ct.rawTripleIndex += globalOffset;
        }
        if (ct.rawTripleIndex >= 0 && ct.rawTripleIndex < allTriples.length) {
          ct.rawPredicate = allTriples[ct.rawTripleIndex].predicate;
        }
      }

      // Count dropped triples reported by LLM
      const rawData = (parsed ?? {}) as Record<string, unknown>;
      const droppedCount = Array.isArray(rawData.dropped) ? rawData.dropped.length : 0;

      logger?.debug(`[KX] Batch ${batchIdx + 1}/${batches.length}: ` +
        `${result.entities.length} entities, ${result.triples.length} triples, ${droppedCount} dropped`);

      return {
        batchIdx,
        entities: result.entities,
        triples: result.triples,
        entityResolutions: result.entityResolutions,
        predicateMappings: result.predicateMappings,
        fallbackCount: result.fallbackCount,
        mergedCount: result.mergedCount,
        droppedCount,
        tokensUsed: response.tokensUsed.prompt + response.tokensUsed.completion,
        tokenUsage: buildTokenUsage(
          response.tokensUsed.prompt,
          response.tokensUsed.completion,
          response.model,
        ),
        model: response.model,
      };
    } catch (error) {
      logger?.warn(`[KX] Batch ${batchIdx + 1}/${batches.length} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // ─── Run batches with concurrency limit ───
  const batchResults: (BatchResult | null)[] = [];

  for (let start = 0; start < batches.length; start += CONCURRENCY) {
    const end = Math.min(start + CONCURRENCY, batches.length);
    const chunk = Array.from({ length: end - start }, (_, i) => start + i);

    logger?.info(`[KX] Launching batches ${start + 1}–${end} of ${batches.length}…`);
    const results = await Promise.allSettled(chunk.map(idx => processBatch(idx)));

    for (const r of results) {
      batchResults.push(r.status === 'fulfilled' ? r.value : null);
    }
  }

  // Accumulated results across batches
  const failedBatchCount = batchResults.filter(r => r === null).length;
  if (batches.length > 0 && failedBatchCount / batches.length > 0.5) {
    throw new AbortThresholdError('KX', failedBatchCount, batches.length, {
      artifactId: input.artifactId,
    });
  }

  const globalEntityMap = new Map<string, CanonEntity>();
  const allCanonTriples: CanonTriple[] = [];
  const allEntityResolutions: EntityResolution[] = [];
  const allPredicateMappings: PredicateMapping[] = [];
  let totalFallbackCount = 0;
  let totalMergedCount = 0;
  let totalDroppedCount = 0;
  let totalTokensUsed = 0;
  let lastModel = '';
  const batchTokenUsages: TokenUsage[] = [];

  for (const result of batchResults) {
    if (!result) continue;

    // Merge entities into global map
    for (const entity of result.entities) {
      const existing = globalEntityMap.get(entity.canonId);
      if (!existing) {
        globalEntityMap.set(entity.canonId, entity);
      } else {
        // Merge aliases
        for (const alias of entity.aliases) {
          if (!existing.aliases.includes(alias)) {
            existing.aliases.push(alias);
          }
        }
        // Keep higher confidence
        existing.confidence = Math.max(existing.confidence, entity.confidence);
      }
    }

    allCanonTriples.push(...result.triples);
    allEntityResolutions.push(...result.entityResolutions);
    allPredicateMappings.push(...result.predicateMappings);
    totalFallbackCount += result.fallbackCount;
    totalMergedCount += result.mergedCount;
    totalDroppedCount += result.droppedCount;
    totalTokensUsed += result.tokensUsed;
    batchTokenUsages.push(result.tokenUsage);
    lastModel = result.model;
  }

  // Deduplicate predicate mappings
  const seenMappings = new Set<string>();
  const dedupedMappings = allPredicateMappings.filter(m => {
    const key = `${m.rawPredicate}→${m.canonPredicate}`;
    if (seenMappings.has(key)) return false;
    seenMappings.add(key);
    return true;
  });

  const latencyMs = Date.now() - startTime;
  const entities = [...globalEntityMap.values()];

  logger?.info(`[KX] Completed ${input.artifactId}: ` +
    `${entities.length} entities, ${allCanonTriples.length} canon triples, ` +
    `${totalMergedCount} merged, ${totalFallbackCount} RELATED_TO fallbacks, ${totalDroppedCount} dropped`, {
    latencyMs,
  });

  return {
    $schema: 'intentweave://schemas/kx/v0.1',
    schemaVersion: '0.1',
    stage: 'KX',
    artifactId: input.artifactId,
    filePath: fxOutput.filePath,

    // Layer 1: Raw
    rawTriples: fxOutput.triples,

    // Layer 2: Canonical
    canonEntities: entities,
    canonTriples: allCanonTriples,

    // Mapping
    entityResolutions: allEntityResolutions,
    predicateMappings: dedupedMappings,

    // Evidence
    evidence: fxOutput.evidence,

    // Meta
    meta: {
      provider: llmProvider.name,
      model: lastModel,
      latencyMs,
      tokensUsed: totalTokensUsed,
      rawTripleCount: fxOutput.triples.length,
      canonTripleCount: allCanonTriples.length,
      canonEntityCount: entities.length,
      entitiesMerged: totalMergedCount,
      predicatesFallback: totalFallbackCount,
      droppedCount: totalDroppedCount,
    },

    // Token usage (aggregated cost)
    tokenUsage: batchTokenUsages.length > 0
      ? sumTokenUsage(...batchTokenUsages)
      : zeroTokenUsage(lastModel),
  };
}

/**
 * Build empty KX output (when FX produces no triples)
 */
function buildEmptyOutput(
  input: KxStageInput,
  fxOutput: FxStageOutput,
  latencyMs: number,
  providerName: string,
): KxStageOutput {
  return {
    $schema: 'intentweave://schemas/kx/v0.1',
    schemaVersion: '0.1',
    stage: 'KX',
    artifactId: input.artifactId,
    filePath: fxOutput.filePath,
    rawTriples: [],
    canonEntities: [],
    canonTriples: [],
    entityResolutions: [],
    predicateMappings: [],
    evidence: [],
    meta: {
      provider: providerName,
      latencyMs,
      rawTripleCount: 0,
      canonTripleCount: 0,
      canonEntityCount: 0,
      entitiesMerged: 0,
      predicatesFallback: 0,
      droppedCount: 0,
    },
  };
}
