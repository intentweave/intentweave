/**
 * GX Stage — Global Merge (cross-document entity unification)
 *
 * After per-artifact KX canonicalization, entities from different documents
 * may refer to the same real-world concept with slightly different slugs.
 *
 * GX merges them into a single unified graph:
 *   1. Exact-slug merge:  canonId "rust" from doc A ∪ "rust" from doc B
 *   2. Fuzzy merge:       "rust-core" ≈ "core-rust" via alias overlap + name similarity
 *   3. Triple dedup:      (s, p, o) duplicates → keep highest confidence
 *
 * Pipeline position:  [per-artifact IN → FX → KX]  → GX → persist
 *
 * No LLM calls — purely algorithmic merge.
 */

import type { KxStageOutput, CanonEntity, CanonTriple } from './kx.js';

// =============================================================================
// GX Types
// =============================================================================

/**
 * A merge record — tracks which entities were unified
 */
export interface EntityMerge {
  /** Surviving (canonical) entity ID */
  survivorId: string;
  /** Entity IDs that were merged into the survivor */
  mergedIds: string[];
  /** Merge method: 'exact' (same slug) | 'fuzzy' (name/alias similarity) */
  method: 'exact' | 'fuzzy';
  /** Similarity score for fuzzy merges (0–1) */
  similarity?: number;
}

/**
 * GX stage output — unified cross-document graph
 */
export interface GxStageOutput {
  /** All entities, deduplicated across documents */
  entities: CanonEntity[];
  /** All triples, with entity IDs remapped to survivors */
  triples: CanonTriple[];
  /** Merge log for provenance/debugging */
  merges: EntityMerge[];
  /** Metadata */
  meta: {
    /** Number of input artifacts */
    inputArtifactCount: number;
    /** Total entities before merge */
    inputEntityCount: number;
    /** Total entities after merge */
    outputEntityCount: number;
    /** Number of exact-slug merges */
    exactMerges: number;
    /** Number of fuzzy merges */
    fuzzyMerges: number;
    /** Total triples before dedup */
    inputTripleCount: number;
    /** Total triples after dedup */
    outputTripleCount: number;
    /** Processing time */
    latencyMs: number;
  };
}

export interface GxOptions {
  /** Minimum similarity threshold for fuzzy merges (0–1, default 0.8) */
  fuzzyThreshold?: number;
  /** Logger */
  logger?: { info: (msg: string, meta?: any) => void; debug: (msg: string, meta?: any) => void };
}

// =============================================================================
// GX Implementation
// =============================================================================

/**
 * Merge KX outputs from multiple artifacts into a unified graph.
 *
 * @param kxOutputs  - Per-artifact KX results
 * @param options    - Merge options
 */
export function runGxStage(
  kxOutputs: KxStageOutput[],
  options: GxOptions = {},
): GxStageOutput {
  const startTime = Date.now();
  const threshold = options.fuzzyThreshold ?? 0.8;
  const logger = options.logger;

  // ─── Phase 1: Collect all entities and triples ───
  const allEntities: CanonEntity[] = [];
  const allTriples: CanonTriple[] = [];
  let inputTripleCount = 0;

  for (const kx of kxOutputs) {
    allEntities.push(...kx.canonEntities);
    // Tag triples with artifact provenance
    for (const t of kx.canonTriples) {
      allTriples.push({ ...t });
    }
    inputTripleCount += kx.canonTriples.length;
  }

  const inputEntityCount = allEntities.length;
  logger?.info(`[GX] Starting merge: ${inputEntityCount} entities, ${inputTripleCount} triples from ${kxOutputs.length} artifacts`);

  // ─── Phase 2: Exact-slug merge ───
  // Group entities by canonId — identical slugs get unified
  const entityMap = new Map<string, CanonEntity>();
  const exactMerges: EntityMerge[] = [];

  for (const e of allEntities) {
    const existing = entityMap.get(e.canonId);
    if (!existing) {
      entityMap.set(e.canonId, { ...e, aliases: [...e.aliases] });
    } else {
      // Merge: combine aliases, keep max confidence, prefer more specific type
      for (const alias of e.aliases) {
        if (!existing.aliases.includes(alias)) {
          existing.aliases.push(alias);
        }
      }
      // Also add the name as an alias if it differs
      if (e.name !== existing.name && !existing.aliases.includes(e.name)) {
        existing.aliases.push(e.name);
      }
      existing.confidence = Math.max(existing.confidence, e.confidence);
      // Prefer non-'concept' type (more specific)
      if (existing.type === 'concept' && e.type !== 'concept') {
        existing.type = e.type;
      }
    }
  }

  // Track which entities were merged (those that appeared more than once)
  const seenIds = new Map<string, number>();  // canonId → count
  for (const e of allEntities) {
    seenIds.set(e.canonId, (seenIds.get(e.canonId) ?? 0) + 1);
  }
  for (const [id, count] of seenIds) {
    if (count > 1) {
      exactMerges.push({
        survivorId: id,
        mergedIds: [],  // exact merge — same ID
        method: 'exact',
      });
    }
  }

  logger?.debug(`[GX] After exact merge: ${entityMap.size} entities (${inputEntityCount - entityMap.size} merged)`);

  // ─── Phase 3: Fuzzy merge ───
  // Find near-duplicate entities via alias overlap + name similarity
  const fuzzyMerges: EntityMerge[] = [];
  const remapTable = new Map<string, string>();  // oldId → survivorId

  const entityList = [...entityMap.values()];
  const consumed = new Set<string>();

  for (let i = 0; i < entityList.length; i++) {
    const a = entityList[i];
    if (consumed.has(a.canonId)) continue;

    for (let j = i + 1; j < entityList.length; j++) {
      const b = entityList[j];
      if (consumed.has(b.canonId)) continue;

      // Skip if types are incompatible (unless one is 'concept')
      if (a.type !== b.type && a.type !== 'concept' && b.type !== 'concept') continue;

      // Guard: prevent merging entities that differ only by a numeric suffix
      // e.g. "option-a" vs "option-b", "phase-1" vs "phase-2", "section-4-3" vs "section-4-5"
      if (differsOnlyByNumber(a.canonId, b.canonId)) continue;

      // Guard: skip fuzzy merge when one slug is a short substring of the other
      // e.g. "core" vs "rust-core" — too ambiguous
      const minLen = Math.min(a.canonId.length, b.canonId.length);
      if (minLen <= 5) continue;

      const sim = entitySimilarity(a, b);
      if (sim >= threshold) {
        // Merge b into a (a survives)
        for (const alias of b.aliases) {
          if (!a.aliases.includes(alias)) a.aliases.push(alias);
        }
        if (b.name !== a.name && !a.aliases.includes(b.name)) {
          a.aliases.push(b.name);
        }
        a.confidence = Math.max(a.confidence, b.confidence);
        if (a.type === 'concept' && b.type !== 'concept') {
          a.type = b.type;
        }

        remapTable.set(b.canonId, a.canonId);
        consumed.add(b.canonId);
        entityMap.delete(b.canonId);

        fuzzyMerges.push({
          survivorId: a.canonId,
          mergedIds: [b.canonId],
          method: 'fuzzy',
          similarity: sim,
        });
      }
    }
  }

  logger?.debug(`[GX] After fuzzy merge: ${entityMap.size} entities (${fuzzyMerges.length} fuzzy merges)`);

  // ─── Phase 4: Remap triples ───
  const remappedTriples: CanonTriple[] = allTriples.map(t => ({
    ...t,
    subjectCanonId: remapTable.get(t.subjectCanonId) ?? t.subjectCanonId,
    objectCanonId: remapTable.get(t.objectCanonId) ?? t.objectCanonId,
  }));

  // ─── Phase 5: Deduplicate triples ───
  const tripleMap = new Map<string, CanonTriple>();
  for (const t of remappedTriples) {
    const key = `${t.subjectCanonId}|${t.predicate}|${t.objectCanonId}`;
    const existing = tripleMap.get(key);
    if (!existing || t.confidence > existing.confidence) {
      tripleMap.set(key, t);
    }
  }

  // Remove self-referential triples that might have been created by merge
  const dedupedTriples = [...tripleMap.values()].filter(
    t => t.subjectCanonId !== t.objectCanonId,
  );

  const latencyMs = Date.now() - startTime;
  const entities = [...entityMap.values()];

  logger?.info(`[GX] Completed: ${entities.length} entities, ${dedupedTriples.length} triples ` +
    `(${exactMerges.length} exact, ${fuzzyMerges.length} fuzzy merges, ` +
    `${inputTripleCount - dedupedTriples.length} triples deduped) [${latencyMs}ms]`);

  return {
    entities,
    triples: dedupedTriples,
    merges: [...exactMerges, ...fuzzyMerges],
    meta: {
      inputArtifactCount: kxOutputs.length,
      inputEntityCount,
      outputEntityCount: entities.length,
      exactMerges: exactMerges.length,
      fuzzyMerges: fuzzyMerges.length,
      inputTripleCount,
      outputTripleCount: dedupedTriples.length,
      latencyMs,
    },
  };
}

// =============================================================================
// Similarity Functions
// =============================================================================

/**
 * Compute similarity between two entities based on:
 *   - Slug edit distance (normalized)
 *   - Name similarity
 *   - Alias overlap
 */
function entitySimilarity(a: CanonEntity, b: CanonEntity): number {
  // 1. Slug similarity (Levenshtein-based)
  const slugSim = 1 - normalizedLevenshtein(a.canonId, b.canonId);

  // 2. Name similarity (case-insensitive)
  const nameSim = 1 - normalizedLevenshtein(
    a.name.toLowerCase(),
    b.name.toLowerCase(),
  );

  // 3. Alias overlap (Jaccard-ish)
  const aAll = new Set([a.name.toLowerCase(), ...a.aliases.map(s => s.toLowerCase())]);
  const bAll = new Set([b.name.toLowerCase(), ...b.aliases.map(s => s.toLowerCase())]);
  let overlap = 0;
  for (const x of aAll) {
    if (bAll.has(x)) overlap++;
  }
  const aliasSim = overlap > 0
    ? overlap / Math.min(aAll.size, bAll.size)
    : 0;

  // Weighted combination
  // If any alias overlaps, that's a very strong signal
  if (aliasSim >= 1.0) return 1.0;  // Exact alias match
  if (overlap > 0) return Math.max(0.85, (slugSim * 0.3 + nameSim * 0.3 + aliasSim * 0.4));

  // Otherwise rely on name/slug similarity
  return slugSim * 0.5 + nameSim * 0.5;
}

/**
 * Normalized Levenshtein distance (0 = identical, 1 = completely different)
 */
function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return levenshtein(a, b) / maxLen;
}

/**
 * Standard Levenshtein distance (DP)
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array(n + 1);

  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = temp;
    }
  }

  return dp[n];
}

/**
 * Check if two slugs differ only by numeric portions.
 *
 * Protects numbered entities from false fuzzy merges:
 *   "option-a" vs "option-b"         → true (differ by letter suffix)
 *   "phase-1" vs "phase-2"           → true
 *   "section-4-3" vs "section-4-5"   → true
 *   "migration-001" vs "migration-002" → true
 *   "15ms" vs "150ms"                → true
 *   "rust-core" vs "rust"            → false (structural difference)
 */
function differsOnlyByNumber(a: string, b: string): boolean {
  // Strip all numeric characters and single-letter suffixes at segment boundaries
  const normalize = (s: string) => s.replace(/[\d]+/g, '#').replace(/-[a-z]$/i, '-#');
  const na = normalize(a);
  const nb = normalize(b);

  // If the non-numeric skeletons are identical but the originals differ,
  // they differ only by numbers
  return na === nb && a !== b;
}
