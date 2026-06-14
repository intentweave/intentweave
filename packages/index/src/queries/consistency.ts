// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: Constraint Consistency Check (12.2)
 *
 * Detects contradictions between KG relationships across different source
 * documents. For each entity pair (A→B), checks whether predicates from
 * different source files contradict each other.
 *
 * Contradiction rules:
 *   REQUIRES    ↔ DECIDED_AGAINST   (hard)
 *   ENABLES     ↔ BLOCKS            (hard)
 *   DECIDED_FOR ↔ DECIDED_AGAINST   (hard)
 *   IMPLEMENTS  ↔ DECIDED_AGAINST   (hard)
 *   USES        ↔ DECIDED_AGAINST   (hard)
 *   REQUIRES    ↔ BLOCKS            (warning)
 *   ALTERNATIVE_TO with both DECIDED_FOR (warning)
 *
 * Also detects same-predicate conflicts: when the same entity has the same
 * outgoing predicate pointing to semantically opposed targets from different
 * source files (e.g., AuthService USES "JWT" in doc1 vs USES "sessions" in doc2).
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  ConsistencyParams,
  ConsistencyResult,
  ConstraintConflict,
  ConflictSeverity,
} from "../types.js";
import { openIndex } from "./shared.js";

// =============================================================================
// Contradiction Rules
// =============================================================================

/** Predicate pairs that are hard contradictions (errors). */
const ERROR_PAIRS: Array<[string, string]> = [
  ["REQUIRES", "DECIDED_AGAINST"],
  ["ENABLES", "BLOCKS"],
  ["DECIDED_FOR", "DECIDED_AGAINST"],
  ["IMPLEMENTS", "DECIDED_AGAINST"],
  ["USES", "DECIDED_AGAINST"],
];

/** Predicate pairs that are potential conflicts (warnings). */
const WARNING_PAIRS: Array<[string, string]> = [
  ["REQUIRES", "BLOCKS"],
  ["ENABLES", "DECIDED_AGAINST"],
];

/** Build a lookup map from predicate → contradicting predicates + severity. */
function buildContradictionMap(): Map<
  string,
  Array<{ contra: string; severity: ConflictSeverity }>
> {
  const map = new Map<
    string,
    Array<{ contra: string; severity: ConflictSeverity }>
  >();

  function add(a: string, b: string, severity: ConflictSeverity) {
    if (!map.has(a)) map.set(a, []);
    map.get(a)!.push({ contra: b, severity });
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push({ contra: a, severity });
  }

  for (const [a, b] of ERROR_PAIRS) add(a, b, "error");
  for (const [a, b] of WARNING_PAIRS) add(a, b, "warning");

  return map;
}

const CONTRADICTION_MAP = buildContradictionMap();

// =============================================================================
// Public API — dual signature
// =============================================================================

/**
 * Check consistency of KG relationships across documents.
 * Opens and closes the database.
 */
export function consistency(
  dbPath: string,
  params?: ConsistencyParams,
): ConsistencyResult {
  const db = openIndex(dbPath);
  try {
    return consistencyFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core consistency check logic against an open database.
 */
export function consistencyFromDb(
  db: Database.Database,
  params?: ConsistencyParams,
): ConsistencyResult {
  const minConfidence = params?.minConfidence ?? 0.5;

  // ── 0. Check tables exist ───────────────────────────────────────────────
  const kgEntitiesExist = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'`,
    )
    .get();
  const kgRelsExist = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kg_relationships'`,
    )
    .get();

  if (!kgEntitiesExist || !kgRelsExist) {
    return emptyResult();
  }

  // ── 1. Load relationships with entity names ─────────────────────────────
  let relQuery = `
    SELECT
      r.id,
      r.from_id,
      r.to_id,
      r.predicate,
      r.confidence,
      r.source_file,
      ef.canon_id  AS from_canon_id,
      ef.name      AS from_name,
      ef.type      AS from_type,
      et.canon_id  AS to_canon_id,
      et.name      AS to_name,
      et.type      AS to_type
    FROM kg_relationships r
    JOIN kg_entities ef ON r.from_id = ef.id
    JOIN kg_entities et ON r.to_id = et.id
    WHERE r.confidence >= ?
  `;
  const queryParams: unknown[] = [minConfidence];

  if (params?.files && params.files.length > 0) {
    relQuery += ` AND r.source_file IN (${params.files.map(() => "?").join(", ")})`;
    queryParams.push(...params.files);
  }

  if (params?.types && params.types.length > 0) {
    const typeCondition = params.types.map(() => "?").join(", ");
    relQuery += ` AND (ef.type IN (${typeCondition}) OR et.type IN (${typeCondition}))`;
    queryParams.push(...params.types, ...params.types);
  }

  relQuery += ` ORDER BY ef.canon_id, et.canon_id, r.predicate`;

  const relationships = db.prepare(relQuery).all(...queryParams) as Array<{
    id: number;
    from_id: number;
    to_id: number;
    predicate: string;
    confidence: number;
    source_file: string;
    from_canon_id: string;
    from_name: string;
    from_type: string;
    to_canon_id: string;
    to_name: string;
    to_type: string;
  }>;

  if (relationships.length === 0) {
    return emptyResult();
  }

  // ── 2. Detect contradictions ────────────────────────────────────────────
  const conflicts: ConstraintConflict[] = [];
  const seen = new Set<string>();

  // 2a. Same entity pair with opposing predicates from different source files
  // Group relationships by entity pair (from_canon_id, to_canon_id)
  const pairMap = new Map<string, typeof relationships>();
  for (const rel of relationships) {
    const key = `${rel.from_canon_id}::${rel.to_canon_id}`;
    if (!pairMap.has(key)) pairMap.set(key, []);
    pairMap.get(key)!.push(rel);
  }

  for (const [, rels] of pairMap) {
    if (rels.length < 2) continue;

    // Check all pairs of relationships for this entity pair
    for (let i = 0; i < rels.length; i++) {
      for (let j = i + 1; j < rels.length; j++) {
        const a = rels[i];
        const b = rels[j];

        // Only flag cross-document contradictions
        if (a.source_file === b.source_file) continue;

        const contraEntries = CONTRADICTION_MAP.get(a.predicate);
        if (!contraEntries) continue;

        const match = contraEntries.find((c) => c.contra === b.predicate);
        if (!match) continue;

        // Deduplicate (A→B is same conflict as B→A)
        const dedupeKey = [
          a.from_canon_id,
          a.to_canon_id,
          a.predicate,
          b.predicate,
          a.source_file,
          b.source_file,
        ]
          .sort()
          .join("|");
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        conflicts.push({
          entityA: { canonId: a.from_canon_id, name: a.from_name },
          entityB: { canonId: a.to_canon_id, name: a.to_name },
          predicateA: a.predicate,
          predicateB: b.predicate,
          sourceFileA: a.source_file,
          sourceFileB: b.source_file,
          severity: match.severity,
          message: buildMessage(a, b, match.severity),
        });
      }
    }
  }

  // 2b. Same entity with same predicate pointing to different targets
  // from different source files (e.g., "AuthService USES JWT" vs "AuthService USES sessions")
  const fromPredicateMap = new Map<string, typeof relationships>();
  for (const rel of relationships) {
    const key = `${rel.from_canon_id}::${rel.predicate}`;
    if (!fromPredicateMap.has(key)) fromPredicateMap.set(key, []);
    fromPredicateMap.get(key)!.push(rel);
  }

  // Only flag when predicate implies exclusivity
  const EXCLUSIVE_PREDICATES = new Set([
    "DECIDED_FOR",
    "DECIDED_AGAINST",
    "IMPLEMENTS",
    "SUPERSEDES",
    "REPLACES",
  ]);

  for (const [, rels] of fromPredicateMap) {
    if (rels.length < 2) continue;

    const predicate = rels[0].predicate;
    if (!EXCLUSIVE_PREDICATES.has(predicate)) continue;

    for (let i = 0; i < rels.length; i++) {
      for (let j = i + 1; j < rels.length; j++) {
        const a = rels[i];
        const b = rels[j];

        // Same target → not a conflict (redundant, not contradictory)
        if (a.to_canon_id === b.to_canon_id) continue;

        // Only flag cross-document
        if (a.source_file === b.source_file) continue;

        const dedupeKey = [
          a.from_canon_id,
          a.to_canon_id,
          b.to_canon_id,
          predicate,
          a.source_file,
          b.source_file,
        ]
          .sort()
          .join("|");
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        conflicts.push({
          entityA: { canonId: a.from_canon_id, name: a.from_name },
          entityB: { canonId: a.to_canon_id, name: a.to_name },
          predicateA: `${predicate} → ${a.to_name}`,
          predicateB: `${predicate} → ${b.to_name}`,
          sourceFileA: a.source_file,
          sourceFileB: b.source_file,
          severity: "warning",
          message:
            `${a.from_name} ${predicate} "${a.to_name}" in ${a.source_file}, ` +
            `but ${predicate} "${b.to_name}" in ${b.source_file}`,
        });
      }
    }
  }

  // ── 3. Sort: errors first, then warnings ────────────────────────────────
  conflicts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.entityA.name.localeCompare(b.entityA.name);
  });

  // ── 4. Summary ──────────────────────────────────────────────────────────
  const totalRelationships = relationships.length;
  const totalConflicts = conflicts.length;
  const errors = conflicts.filter((c) => c.severity === "error").length;
  const warnings = totalConflicts - errors;

  // Consistency = relationships NOT involved in any conflict / total
  const conflictRelIds = new Set<string>();
  for (const c of conflicts) {
    conflictRelIds.add(`${c.entityA.canonId}::${c.entityB.canonId}`);
  }
  const involvedPairs = conflictRelIds.size;
  const consistencyPercent =
    totalRelationships > 0
      ? Math.round(
          ((totalRelationships - involvedPairs) / totalRelationships) * 100,
        )
      : 100;

  return {
    conflicts,
    summary: {
      totalRelationships,
      totalConflicts,
      errors,
      warnings,
      consistencyPercent,
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

function emptyResult(): ConsistencyResult {
  return {
    conflicts: [],
    summary: {
      totalRelationships: 0,
      totalConflicts: 0,
      errors: 0,
      warnings: 0,
      consistencyPercent: 100,
    },
  };
}

function buildMessage(
  a: {
    from_name: string;
    to_name: string;
    predicate: string;
    source_file: string;
  },
  b: { predicate: string; source_file: string },
  severity: ConflictSeverity,
): string {
  const icon = severity === "error" ? "✗" : "⚠";
  return (
    `${icon} ${a.source_file} says "${a.from_name}" ${a.predicate} "${a.to_name}", ` +
    `but ${b.source_file} says ${b.predicate}`
  );
}
