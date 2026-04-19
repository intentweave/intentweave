// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence Linker — Link Canon entities to their KWG evidence.
 *
 * Creates `:EVIDENCED_BY` relationships from Canon:Entity → KWEntity
 * based on name matching (exact, slug, alias). This provides:
 *   1. Provenance trail: "Why was this entity extracted?"
 *   2. Confidence boost: entities with many KWG mentions rank higher
 *   3. UI enrichment: cross-layer links in KWG+ visualization
 *
 * Matching strategy (ordered by precision):
 *   1. Exact:  toLower(canon.name) === toLower(kwEntity.name)
 *   2. Alias:  any alias in canon.aliases matches kwEntity.name
 *
 * @see PHASE-D-SPEC.md §4
 * @version 0.1
 */

import type { GraphDriver as Driver } from "../persistence/graphRunner.js";

// =============================================================================
// Types
// =============================================================================

export interface EvidenceLinkResult {
  /** Number of EVIDENCED_BY relationships created/updated */
  linksCreated: number;
  /** Canon entities that got at least one EVIDENCED_BY link */
  canonEntitiesLinked: number;
  /** Canon entities with NO KWG evidence */
  canonEntitiesUnlinked: number;
  /** KWG entities that are now linked to Canon */
  kwEntitiesLinked: number;
  /** Duration in milliseconds */
  durationMs: number;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Link Canon entities to their KWG evidence via EVIDENCED_BY relationships.
 *
 * For each Canon:Entity, finds matching KWEntity nodes by name/alias,
 * counts associated drift signals, and computes a boosted confidence score.
 */
export async function linkEvidencedBy(
  driver: Driver,
  sessionId: string,
  opts?: { verbose?: boolean; log?: (msg: string) => void },
): Promise<EvidenceLinkResult> {
  const log = opts?.log ?? (() => {});
  const start = performance.now();

  const session = driver.session();
  try {
    // ── Step 1: Create EVIDENCED_BY links ───────────────────────────
    // Match Canon → KWEntity by name (exact + alias), then MERGE the link
    const linkResult = await session.run(
      `
      MATCH (c:Canon:Entity {session_id: $sid})
      MATCH (e:KWEntity {session_id: $sid})
      WHERE toLower(c.name) = toLower(e.name)
         OR any(alias IN COALESCE(c.aliases, [])
                WHERE toLower(alias) = toLower(e.name))
      // Count drift signals linked to this KWG entity
      OPTIONAL MATCH (d:DriftSignal {session_id: $sid})-[:ABOUT]->(e)
      WITH c, e, count(d) AS driftCount
      MERGE (c)-[ev:EVIDENCED_BY]->(e)
      SET ev.mentionCount = e.mentionCount,
          ev.driftCount = driftCount,
          ev.confidence = CASE
            WHEN e.mentionCount >= 10 AND driftCount >= 2 THEN 0.95
            WHEN e.mentionCount >= 5  THEN 0.85
            WHEN e.mentionCount >= 2  THEN 0.70
            ELSE 0.50
          END,
          ev.updatedAt = datetime()
      RETURN count(ev) AS linksCreated,
             count(DISTINCT c) AS canonLinked,
             count(DISTINCT e) AS kwLinked
      `,
      { sid: sessionId },
    );

    const rec = linkResult.records[0];
    const linksCreated = toInt(rec.get("linksCreated"));
    const canonLinked = toInt(rec.get("canonLinked"));
    const kwLinked = toInt(rec.get("kwLinked"));

    log(
      `EVIDENCED_BY: ${linksCreated} links (${canonLinked} Canon → ${kwLinked} KWEntity)`,
    );

    // ── Step 2: Count unlinked Canon entities ───────────────────────
    const unlinkedResult = await session.run(
      `
      MATCH (c:Canon:Entity {session_id: $sid})
      WHERE NOT (c)-[:EVIDENCED_BY]->()
      RETURN count(c) AS unlinked
      `,
      { sid: sessionId },
    );
    const canonUnlinked = toInt(unlinkedResult.records[0].get("unlinked"));

    log(`Unlinked Canon entities: ${canonUnlinked}`);

    return {
      linksCreated,
      canonEntitiesLinked: canonLinked,
      canonEntitiesUnlinked: canonUnlinked,
      kwEntitiesLinked: kwLinked,
      durationMs: performance.now() - start,
    };
  } finally {
    await session.close();
  }
}

// =============================================================================
// Helpers
// =============================================================================

function toInt(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "object" && "toInt" in (val as Record<string, unknown>)) {
    return (val as { toInt: () => number }).toInt();
  }
  return Number(val) || 0;
}
