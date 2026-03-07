/**
 * FX Stage — Free Extraction (Schema-Free)
 *
 * Parallel pipeline track that extracts entities and relationships from text
 * WITHOUT imposing a predefined schema. The LLM uses its internal knowledge
 * to identify what matters.
 *
 * Design Philosophy:
 * - Zero schema in prompt → zero information loss
 * - LLM chooses natural predicates and entity kinds
 * - Output is "raw triples" — not yet canonical
 * - Downstream KX stage handles canonicalization
 *
 * Pipeline position:  IN → FX → KX  (parallel to IN → RX → CX → MX → PX)
 *
 * Input:  in.json  (same IN stage output as RX)
 * Output: fx.json  (raw triples with evidence)
 */

import type { Chunk, LLMProvider, Evidence, TokenUsage } from '@intentweave/core';
import { buildTokenUsage, zeroTokenUsage, sumTokenUsage, AbortThresholdError } from '@intentweave/core';
import type { PipelineContext } from '../pipeline/context.js';
import { hashContent } from '../cache/registry.js';
import { completeWithRetry } from '../providers/llm/completeWithRetry.js';

// =============================================================================
// FX Stage Types
// =============================================================================

/**
 * A raw triple extracted without schema constraints.
 * Subject/predicate/object are natural-language strings.
 */
export interface RawTriple {
  /** Subject entity name (as the LLM expressed it) */
  subject: string;
  /** Relationship predicate (natural language, e.g. "enables", "decided for") */
  predicate: string;
  /** Object entity name (as the LLM expressed it) */
  object: string;
  /** Optional entity kind hint for subject (LLM's best guess) */
  subjectKind?: string;
  /** Optional entity kind hint for object (LLM's best guess) */
  objectKind?: string;
  /** Confidence score (0–1) */
  confidence: number;
  /** Short rationale for why this triple was extracted */
  rationale?: string;
}

/**
 * Per-chunk extraction result
 */
export interface FxChunkResult {
  /** Chunk ID */
  chunkId: string;
  /** Extracted raw triples */
  triples: RawTriple[];
  /** Evidence spans linking triples to source text */
  evidence: Evidence[];
  /** Token usage for this chunk's LLM call */
  tokenUsage?: TokenUsage;
}

/**
 * FX Stage Input (same shape as RX input — reuses IN output)
 */
export interface FxStageInput {
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Chunks from IN stage */
  chunks: Chunk[];
  /** Artifact metadata */
  meta?: {
    artifactRole?: string;
    artifactFormat?: string;
  };
}

/**
 * FX Stage Output
 */
export interface FxStageOutput {
  /** JSON Schema reference */
  $schema: string;
  /** Schema version */
  schemaVersion: '0.1';
  /** Stage identifier */
  stage: 'FX';
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** All extracted raw triples (flattened across chunks) */
  triples: RawTriple[];
  /** Evidence records */
  evidence: Evidence[];
  /** Per-chunk results (for provenance) */
  chunkResults: FxChunkResult[];
  /** Extraction metadata */
  meta: {
    provider: string;
    model?: string;
    latencyMs: number;
    tokensUsed?: number;
    chunksProcessed: number;
    totalTriples: number;
  };
  /** Aggregated token usage (prompt + completion + cost) */
  tokenUsage?: TokenUsage;
}

/**
 * FX Stage Options
 */
export interface FxStageOptions {
  /** LLM provider for extraction */
  llmProvider: LLMProvider;
  /** Optional context hint (e.g. "this is a concept conversation") */
  documentContext?: string;
  /** Max triples per chunk (to prevent runaway extraction) */
  maxTriplesPerChunk?: number;
  /** Number of chunks to process in parallel (default: 5) */
  concurrency?: number;
}

// =============================================================================
// System Prompt — deliberately minimal, no schema constraints
// =============================================================================

const FX_SYSTEM_PROMPT = `You are an expert knowledge engineer. Your task is to extract ALL meaningful relationships from the given text as (subject, predicate, object) triples.

RULES:
1. Use the most NATURAL predicate for each relationship. Do not force formal vocabulary.
   Good: "enables", "decided for", "risks", "alternative to", "depends on"
   Bad:  "HAS_STATE", "ROLE_CAN" (too formal — let the text speak)

2. Extract EVERYTHING that expresses a relationship, decision, dependency, or constraint.
   Include: technical choices, design decisions, motivations, risks, tradeoffs, requirements,
   component relationships, feature dependencies, open questions, deferred items.

3. For each entity, provide a KIND hint — your best guess at what type it is.
   Common kinds: concept, decision, option, requirement, component, technology,
   resource, role, risk, phase, constraint, feature, tradeoff, question.
   Use whatever kind feels most natural.

4. Assign a confidence score (0.0–1.0) based on how explicitly the relationship is stated.
   - 0.9–1.0: Explicitly stated ("We decided to use React")
   - 0.7–0.8: Strongly implied ("React enables Tauri reuse" — implies dependency)
   - 0.5–0.6: Inferred ("mentioned alongside" — weaker connection)

5. Provide a brief rationale for non-obvious extractions.

6. Do NOT skip relationships just because they seem informal, speculative, or conversational.
   "Maybe we should use Rust" → (Rust, proposed for, core-engine) confidence: 0.5

7. SKIP triples that are pure metadata or properties rather than relationships:
   - File paths, dates, version numbers, IDs as objects
   - "X has title Y", "X was created on Y", "X estimated time Y"
   - Self-referential: "X is X"
   Instead, focus on relationships BETWEEN distinct entities.

ENTITY NAMING:
- Use short descriptive names: "React", "user-authentication", "deployment-pipeline"
- Prefer the most common/recognizable form used in the text
- Do NOT include articles ("the") or qualifiers unless essential to identity
- Compound concepts are fine: "real-time-sync", "state-management"

COMPLETENESS:
- Extract at least one triple per significant paragraph or section
- When text describes a list of items, extract relationships for each item
- Do not summarize — extract specific relationships even if they seem minor
- If a passage describes 5 technologies and their roles, extract 5+ triples (not one summary)
- Aim for thorough coverage: missing a real relationship is worse than including a weak one

EXTRACTION EXAMPLES:
- "React was chosen for the UI because it supports SSR" →
  (React, chosen for, UI) kind: technology/component, conf: 0.95
  (React, enables, SSR) kind: technology/feature, conf: 0.85
- "Phase 2 depends on completing the API refactor" →
  (Phase 2, depends on, API refactor) kind: phase/feature, conf: 0.9
- "We considered PostgreSQL and MongoDB" →
  (PostgreSQL, alternative to, MongoDB) kind: technology/technology, conf: 0.8

HANDLING SPECIAL PATTERNS:
- Decision records: Extract the decision, alternatives, rationale, and outcome as separate triples.
  "We decided on React over Vue because of ecosystem size" → 3 triples minimum.
- Requirements: "The system must support 1000 concurrent users" → (system, requires, concurrent-user-support)
- Risks and tradeoffs: "Using microservices adds complexity but improves scalability" →
  (microservices, risks, added-complexity) + (microservices, enables, scalability)
- Open questions: "Should we use REST or GraphQL?" → (REST, alternative to, GraphQL) kind: question
- Temporal/phase relationships: "Authentication must be completed before authorization" →
  (authentication, precedes, authorization)
- Cross-references: "As discussed in Section 3" — extract the referenced concept, not the section number.

OUTPUT QUALITY:
- Prefer atomic triples — one relationship per triple.
- Avoid vague entities: "it", "the system", "the solution" — use the specific name from context.
- Each triple should be independently meaningful without needing other triples to interpret it.
- When the text uses pronouns or references, resolve them to the actual entity name.

Respond with a JSON array of triples.`;

/**
 * Hash of the FX system prompt — used by the cache to detect prompt changes.
 * When this value changes (i.e. the prompt is edited), cached FX outputs are
 * automatically invalidated on the next run.
 */
export const FX_PROMPT_VERSION = hashContent(FX_SYSTEM_PROMPT);

/**
 * JSON Schema for FX response — deliberately loose
 */
const FX_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    triples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Subject entity name' },
          predicate: { type: 'string', description: 'Relationship (natural language)' },
          object: { type: 'string', description: 'Object entity name' },
          subjectKind: { type: 'string', description: 'Entity kind hint for subject (e.g. concept, decision, component)' },
          objectKind: { type: 'string', description: 'Entity kind hint for object (e.g. concept, decision, component)' },
          confidence: { type: 'number', description: 'Confidence 0.0–1.0' },
          rationale: { type: 'string', description: 'Brief extraction rationale' },
        },
        required: ['subject', 'predicate', 'object', 'subjectKind', 'objectKind', 'confidence', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['triples'],
  additionalProperties: false,
};

// =============================================================================
// FX Stage Implementation
// =============================================================================

/**
 * Build the user prompt for a chunk
 */
function buildFxUserPrompt(chunk: Chunk, documentContext?: string): string {
  const parts: string[] = [];

  if (documentContext) {
    parts.push(`DOCUMENT CONTEXT: ${documentContext}\n`);
  }

  parts.push('TEXT TO ANALYZE:\n');
  parts.push('```');
  parts.push(chunk.content);
  parts.push('```');

  if (chunk.filePath) {
    parts.push(`\n(Source: ${chunk.filePath}${chunk.startLine ? `:${chunk.startLine}` : ''})`);
  }

  return parts.join('\n');
}

/**
 * Parse the LLM response into raw triples
 */
function parseFxResponse(response: unknown, maxTriples: number): RawTriple[] {
  if (!response || typeof response !== 'object') return [];

  const data = response as Record<string, unknown>;
  const triples = data.triples;
  if (!Array.isArray(triples)) return [];

  return triples
    .slice(0, maxTriples)
    .filter((t): t is Record<string, unknown> =>
      t != null &&
      typeof t === 'object' &&
      typeof (t as Record<string, unknown>).subject === 'string' &&
      typeof (t as Record<string, unknown>).predicate === 'string' &&
      typeof (t as Record<string, unknown>).object === 'string'
    )
    .map(t => ({
      subject: String(t.subject).trim(),
      predicate: String(t.predicate).trim(),
      object: String(t.object).trim(),
      subjectKind: typeof t.subjectKind === 'string' ? t.subjectKind.trim() : undefined,
      objectKind: typeof t.objectKind === 'string' ? t.objectKind.trim() : undefined,
      confidence: typeof t.confidence === 'number' ? Math.max(0, Math.min(1, t.confidence)) : 0.5,
      rationale: typeof t.rationale === 'string' ? t.rationale.trim() : undefined,
    }));
}

/**
 * Run FX stage on a single chunk
 */
async function extractChunk(
  chunk: Chunk,
  llmProvider: LLMProvider,
  options: FxStageOptions,
  logger?: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
): Promise<FxChunkResult> {
  const maxTriples = options.maxTriplesPerChunk ?? 50;

  const response = await completeWithRetry(llmProvider, {
    system: FX_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildFxUserPrompt(chunk, options.documentContext) },
    ],
    responseSchema: FX_RESPONSE_SCHEMA,
    temperature: 0.1, // Low temperature for consistent extraction
  }, { logger });

  const parsed = response.parsed ?? tryParseJson(response.content);
  const triples = parseFxResponse(parsed, maxTriples);

  // Build evidence linking triples back to the source chunk
  const evidence: Evidence[] = triples.map((t, i) => ({
    turnIndex: chunk.turnIndex ?? 0,
    text: `${t.subject} → ${t.predicate} → ${t.object}`,
    chunk_id: chunk.id,
    chunk_index: chunk.index,
    confidence: t.confidence,
    source_stage: 'RX' as const, // Use RX for compat, will be re-tagged as FX downstream
  }));

  // Track token usage from the LLM response
  const tokenUsage = buildTokenUsage(
    response.tokensUsed.prompt,
    response.tokensUsed.completion,
    response.model,
  );

  return {
    chunkId: chunk.id,
    triples,
    evidence,
    tokenUsage,
  };
}

/**
 * Safe JSON parse fallback
 */
function tryParseJson(content: string): unknown {
  try {
    // Try to find JSON in the response (LLMs sometimes wrap in markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Run the FX stage on an artifact's chunks
 *
 * @param input  - Artifact chunks (from IN stage)
 * @param options - LLM provider and configuration
 * @param ctx     - Pipeline context (for logging)
 * @returns FxStageOutput with all raw triples
 */
export async function runFxStage(
  input: FxStageInput,
  options: FxStageOptions,
  ctx?: Pick<PipelineContext, 'logger'>,
): Promise<FxStageOutput> {
  const startTime = Date.now();
  const logger = ctx?.logger;

  logger?.info(`[FX] Starting free extraction for ${input.artifactId}`, {
    chunks: input.chunks.length,
    artifactRole: input.meta?.artifactRole,
  });

  // Process chunks in parallel with concurrency limit
  const CONCURRENCY = options.concurrency ?? 5;
  const chunkResults: FxChunkResult[] = new Array(input.chunks.length);

  for (let start = 0; start < input.chunks.length; start += CONCURRENCY) {
    const end = Math.min(start + CONCURRENCY, input.chunks.length);
    const slice = input.chunks.slice(start, end);

    logger?.debug(`[FX] Launching chunks ${start + 1}–${end} of ${input.chunks.length}…`);

    const settled = await Promise.allSettled(
      slice.map(async (chunk, i) => {
        const result = await extractChunk(chunk, options.llmProvider, options, logger);
        logger?.debug(`[FX] Chunk ${chunk.id}: ${result.triples.length} triples extracted`);
        return { index: start + i, result };
      }),
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        chunkResults[outcome.value.index] = outcome.value.result;
      } else {
        const idx = settled.indexOf(outcome);
        const chunk = slice[idx];
        logger?.warn(`[FX] Chunk ${chunk.id} failed, skipping`, { error: String(outcome.reason) });
        chunkResults[start + idx] = { chunkId: chunk.id, triples: [], evidence: [] };
      }
    }
  }

  // Flatten results
  const allTriples = chunkResults.flatMap(r => r.triples);
  const allEvidence = chunkResults.flatMap(r => r.evidence);
  const latencyMs = Date.now() - startTime;

  // Abort if too many chunks failed (> 50%)
  // A chunk is "failed" if it has 0 triples AND either no tokenUsage or 0 tokens
  // (the API returned an error — e.g. quota exhausted, rate limit, timeout)
  const failedChunks = chunkResults.filter(r =>
    r.triples.length === 0 &&
    (!r.tokenUsage || r.tokenUsage.totalTokens === 0)
  ).length;
  if (input.chunks.length > 0 && failedChunks / input.chunks.length > 0.5) {
    throw new AbortThresholdError('FX', failedChunks, input.chunks.length, {
      artifactId: input.artifactId,
    });
  }

  // Aggregate token usage across all chunks
  const chunkUsages = chunkResults
    .map(r => r.tokenUsage)
    .filter((u): u is TokenUsage => u != null);
  const tokenUsage = chunkUsages.length > 0
    ? sumTokenUsage(...chunkUsages)
    : zeroTokenUsage(options.llmProvider.name);

  logger?.info(`[FX] Completed ${input.artifactId}: ${allTriples.length} raw triples in ${latencyMs}ms (${tokenUsage.totalTokens} tokens)`);

  return {
    $schema: 'intentweave://schemas/fx/v0.1',
    schemaVersion: '0.1',
    stage: 'FX',
    artifactId: input.artifactId,
    filePath: input.filePath,
    triples: allTriples,
    evidence: allEvidence,
    chunkResults,
    meta: {
      provider: options.llmProvider.name,
      latencyMs,
      tokensUsed: tokenUsage.totalTokens,
      chunksProcessed: input.chunks.length,
      totalTriples: allTriples.length,
    },
    tokenUsage,
  };
}
