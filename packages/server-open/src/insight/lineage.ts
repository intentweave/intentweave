// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Lineage builder — traces a Canon:Entity back through RawTriples
 * to its original source documents.
 *
 * Two hops:
 *   1. Entity → RawTriple (via CANONICALIZED_FROM)
 *   2. RawTriple → Source Document (via sourceFile / artifactId property)
 */

import type { Neo4jRunner } from "../helpers/neo4j-runner.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** A raw triple that mentions the entity, plus its provenance. */
export interface LineageTriple {
  /** The full raw triple text. */
  subject: string;
  predicate: string;
  object: string;
  /** Which role the target entity played in this triple. */
  role: "subject" | "object";
  /** LLM-provided confidence for this extraction. */
  confidence: number | null;
  /** LLM-provided rationale for non-obvious extractions. */
  rationale: string | null;
  /** Kind hint from the LLM (e.g. "technology", "decision"). */
  subjectKind: string | null;
  objectKind: string | null;
  /** Source file path (original document). */
  sourceFile: string | null;
  /** Artifact identifier (sanitized relative path). */
  artifactId: string | null;
  /** Run that produced this triple. */
  runId: string | null;
}

/** A unique source document contributing knowledge about this entity. */
export interface LineageSource {
  /** Original file path. */
  sourceFile: string;
  /** Artifact identifier. */
  artifactId: string;
  /** How many raw triples reference this entity from this source. */
  tripleCount: number;
  /** Distinct predicates used in triples from this source. */
  predicates: string[];
}

/** Full lineage response for a single entity. */
export interface LineageResponse {
  /** The canonical entity ID. */
  canonId: string;
  /** The entity display name. */
  name: string;
  /** The entity type. */
  type: string;
  /** Session scoping. */
  sessionId: string;
  /** Hop 1: Raw triples mentioning this entity. */
  triples: LineageTriple[];
  /** Hop 2: Source documents grouped and aggregated. */
  sources: LineageSource[];
  /** Canonical relationships (from CANON_REL) with raw predicate provenance. */
  canonRelations: LineageRelation[];
  /** Query timing in ms. */
  queryTimeMs: number;
}

/** A canonical relationship with provenance back to its raw origin. */
export interface LineageRelation {
  /** Direction from the target entity's perspective. */
  direction: "outgoing" | "incoming";
  /** Canonical predicate (e.g. DEPENDS_ON). */
  predicate: string;
  /** Original natural-language predicate from FX. */
  rawPredicate: string | null;
  /** The other entity in this relationship. */
  otherName: string;
  otherCanonId: string;
  otherType: string | null;
  /** Source artifact where this relation was found. */
  artifactId: string | null;
  /** Confidence inherited from the raw triple. */
  confidence: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Builder
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuildLineageOpts {
  runner: Neo4jRunner;
  sessionId: string;
  canonId: string;
}

/** Escape double quotes for Cypher string embedding. */
function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build the full lineage chain for a single Canon:Entity.
 *
 * 1. Fetch the Canon:Entity itself
 * 2. Fetch all RawTriple → CANONICALIZED_FROM → Canon:Entity with role
 * 3. Aggregate source documents
 * 4. Fetch CANON_REL with rawPredicate provenance
 */
export async function buildLineage(
  opts: BuildLineageOpts,
): Promise<LineageResponse> {
  const { runner, sessionId, canonId } = opts;
  const t0 = Date.now();
  const sid = escapeStr(sessionId);
  const cid = escapeStr(canonId);

  // ── Step 1: Fetch the Canon entity ─────────────────────────────────────
  const entityRows = await runner.run(`
    MATCH (c:Canon:Entity {session_id: "${sid}", canonId: "${cid}"})
    RETURN c.canonId AS canonId, c.name AS name, c.type AS type
    LIMIT 1
  `);

  if (entityRows.length === 0) {
    return {
      canonId,
      name: canonId,
      type: "unknown",
      sessionId,
      triples: [],
      sources: [],
      canonRelations: [],
      queryTimeMs: Date.now() - t0,
    };
  }

  const entity = entityRows[0];

  // ── Step 2: Fetch raw triples with provenance ──────────────────────────
  const tripleRows = await runner.run(`
    MATCH (rt:RawTriple)-[cf:CANONICALIZED_FROM]->(c:Canon:Entity {session_id: "${sid}", canonId: "${cid}"})
    RETURN rt.subject AS subject,
           rt.predicate AS predicate,
           rt.object AS object,
           cf.role AS role,
           rt.confidence AS confidence,
           rt.rationale AS rationale,
           rt.subjectKind AS subjectKind,
           rt.objectKind AS objectKind,
           rt.sourceFile AS sourceFile,
           rt.artifactId AS artifactId,
           rt.run_id AS runId
    ORDER BY rt.artifactId, rt.tripleIndex
    LIMIT 200
  `);

  const triples: LineageTriple[] = tripleRows.map((row) => ({
    subject: row.subject as string,
    predicate: row.predicate as string,
    object: row.object as string,
    role: (row.role as "subject" | "object") ?? "subject",
    confidence: row.confidence as number | null,
    rationale: row.rationale as string | null,
    subjectKind: row.subjectKind as string | null,
    objectKind: row.objectKind as string | null,
    sourceFile: row.sourceFile as string | null,
    artifactId: row.artifactId as string | null,
    runId: row.runId as string | null,
  }));

  // ── Step 3: Aggregate source documents ─────────────────────────────────
  const sourceMap = new Map<
    string,
    { artifactId: string; predicates: Set<string>; count: number }
  >();
  for (const t of triples) {
    const key = t.sourceFile ?? t.artifactId ?? "unknown";
    let entry = sourceMap.get(key);
    if (!entry) {
      entry = {
        artifactId: t.artifactId ?? key,
        predicates: new Set(),
        count: 0,
      };
      sourceMap.set(key, entry);
    }
    entry.predicates.add(t.predicate);
    entry.count++;
  }

  const sources: LineageSource[] = Array.from(sourceMap.entries())
    .map(([sourceFile, entry]) => ({
      sourceFile,
      artifactId: entry.artifactId,
      tripleCount: entry.count,
      predicates: Array.from(entry.predicates),
    }))
    .sort((a, b) => b.tripleCount - a.tripleCount);

  // ── Step 4: Fetch CANON_REL with raw predicate provenance ──────────────
  const relRows = await runner.run(`
    MATCH (c:Canon:Entity {session_id: "${sid}", canonId: "${cid}"})-[r:CANON_REL]->(other:Canon:Entity)
    RETURN "outgoing" AS direction,
           r.predicate AS predicate,
           r.rawPredicate AS rawPredicate,
           other.name AS otherName,
           other.canonId AS otherCanonId,
           other.type AS otherType,
           r.artifactId AS artifactId,
           r.confidence AS confidence
    UNION ALL
    MATCH (other:Canon:Entity)-[r:CANON_REL]->(c:Canon:Entity {session_id: "${sid}", canonId: "${cid}"})
    RETURN "incoming" AS direction,
           r.predicate AS predicate,
           r.rawPredicate AS rawPredicate,
           other.name AS otherName,
           other.canonId AS otherCanonId,
           other.type AS otherType,
           r.artifactId AS artifactId,
           r.confidence AS confidence
  `);

  const canonRelations: LineageRelation[] = relRows.map((row) => ({
    direction: row.direction as "outgoing" | "incoming",
    predicate: row.predicate as string,
    rawPredicate: row.rawPredicate as string | null,
    otherName: row.otherName as string,
    otherCanonId: row.otherCanonId as string,
    otherType: row.otherType as string | null,
    artifactId: row.artifactId as string | null,
    confidence: row.confidence as number | null,
  }));

  return {
    canonId: entity.canonId as string,
    name: entity.name as string,
    type: entity.type as string,
    sessionId,
    triples,
    sources,
    canonRelations,
    queryTimeMs: Date.now() - t0,
  };
}
