// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * D1: Evidence-Guided Triage Analyzer
 *
 * Queries the evidence graph (KWG + Drift + SKG) and ranks KWG entities
 * for LLM extraction. Entities with high mention counts, many co-occurrences,
 * drift signals, and NOT already in the SKG score highest.
 *
 * Cost: $0 — pure Cypher query, no LLM calls.
 *
 * @see PHASE-D-SPEC.md §3
 * @version 0.1
 */

import type { Driver } from "neo4j-driver";

// =============================================================================
// Types
// =============================================================================

export interface TriageCandidate {
  /** KWG entity name */
  entityName: string;
  /** Number of mentions in documents */
  mentionCount: number;
  /** Number of CO_OCCURS edges */
  coOccurrenceDegree: number;
  /** Size of the entity's cluster (0 if singleton) */
  clusterSize: number;
  /** Number of DriftSignals that AFFECTS this entity */
  driftSignalCount: number;
  /** Max severity of drift signals affecting this entity */
  driftMaxSeverity: "critical" | "warning" | "info" | "none";
  /** Whether a matching Canon:Entity already exists in SKG */
  isInSkg: boolean;
  /** Weighted evidence score */
  score: number;
  /** 1-based rank (1 = highest priority) */
  rank: number;
}

export interface TriageOptions {
  /** Session to query */
  sessionId: string;
  /** Maximum candidates to return (default: 50) */
  maxCandidates?: number;
  /** Minimum score threshold (default: 5) */
  minScore?: number;
  /** Log callback */
  log?: (msg: string) => void;
}

export interface TriageResult {
  /** Ranked extraction candidates */
  candidates: TriageCandidate[];
  /** Total KWG entities in session */
  totalKwgEntities: number;
  /** Total Canon entities in session (already extracted) */
  totalSkgEntities: number;
  /** Candidates excluded because they're already in SKG */
  skippedAlreadyInSkg: number;
  /** Candidates excluded because score < minScore */
  skippedBelowThreshold: number;
  /** Time to execute the triage query */
  durationMs: number;
}

// =============================================================================
// Scoring weights
// =============================================================================

const WEIGHTS = {
  mentionCount: 1.0,
  coOccurrenceDegree: 2.0,
  clusterSize: 0.5,
  driftSignalCount: 3.0,
  driftCritical: 10,
  driftWarning: 5,
  alreadyInSkg: -20,
} as const;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Query the evidence graph and rank KWG entities for LLM extraction.
 *
 * Runs a single Cypher query that computes all evidence signals per entity,
 * scores them, and returns the top-N candidates.
 */
export async function triageFromEvidence(
  driver: Driver,
  opts: TriageOptions,
): Promise<TriageResult> {
  const maxCandidates = opts.maxCandidates ?? 50;
  const minScore = opts.minScore ?? 5;
  const log = opts.log ?? (() => {});
  const start = performance.now();

  const session = driver.session();
  try {
    // ── Count totals ────────────────────────────────────────────────
    const countResult = await session.run(
      `
      MATCH (e:KWEntity {session_id: $sid})
      WITH count(e) AS kwgTotal
      OPTIONAL MATCH (c:Canon:Entity {session_id: $sid})
      RETURN kwgTotal, count(c) AS skgTotal
      `,
      { sid: opts.sessionId },
    );

    const totals = countResult.records[0];
    const totalKwgEntities = toInt(totals.get("kwgTotal"));
    const totalSkgEntities = toInt(totals.get("skgTotal"));

    log(`KWG entities: ${totalKwgEntities}, SKG entities: ${totalSkgEntities}`);

    if (totalKwgEntities === 0) {
      return {
        candidates: [],
        totalKwgEntities: 0,
        totalSkgEntities,
        skippedAlreadyInSkg: 0,
        skippedBelowThreshold: 0,
        durationMs: performance.now() - start,
      };
    }

    // ── Triage query: score all KWG entities ────────────────────────
    const result = await session.run(
      `
      MATCH (e:KWEntity {session_id: $sid})
      // Co-occurrence degree
      OPTIONAL MATCH (e)-[co:CO_OCCURS]-()
      WITH e, count(DISTINCT co) AS coOccDegree
      // Cluster membership
      OPTIONAL MATCH (cl:KWCluster {session_id: $sid})
        WHERE e.name IN cl.members
      WITH e, coOccDegree, COALESCE(size(cl.members), 0) AS clusterSize
      // Drift signals (linked via ABOUT to KWEntity)
      OPTIONAL MATCH (d:DriftSignal {session_id: $sid})-[:ABOUT]->(e)
      WITH e, coOccDegree, clusterSize,
           count(d) AS driftCount,
           collect(d.severity) AS severities
      WITH e, coOccDegree, clusterSize, driftCount,
           CASE
             WHEN any(s IN severities WHERE s = 'critical') THEN 'critical'
             WHEN any(s IN severities WHERE s = 'warning') THEN 'warning'
             WHEN size(severities) > 0 THEN 'info'
             ELSE 'none'
           END AS maxSeverity
      // SKG match check
      OPTIONAL MATCH (c:Canon:Entity {session_id: $sid})
        WHERE toLower(c.name) = toLower(e.name)
      WITH e, coOccDegree, clusterSize, driftCount, maxSeverity,
           c IS NOT NULL AS isInSkg
      // Score
      WITH e, coOccDegree, clusterSize, driftCount, maxSeverity, isInSkg,
           e.mentionCount * $wMention
           + coOccDegree * $wCoOcc
           + clusterSize * $wCluster
           + driftCount * $wDrift
           + CASE maxSeverity
               WHEN 'critical' THEN $wDriftCritical
               WHEN 'warning' THEN $wDriftWarning
               ELSE 0
             END
           + CASE WHEN isInSkg THEN $wSkg ELSE 0 END AS score
      WHERE score >= $minScore
      RETURN e.name AS entityName,
             e.mentionCount AS mentionCount,
             coOccDegree,
             clusterSize,
             driftCount,
             maxSeverity,
             isInSkg,
             score
      ORDER BY score DESC
      LIMIT toInteger($maxCandidates)
      `,
      {
        sid: opts.sessionId,
        wMention: WEIGHTS.mentionCount,
        wCoOcc: WEIGHTS.coOccurrenceDegree,
        wCluster: WEIGHTS.clusterSize,
        wDrift: WEIGHTS.driftSignalCount,
        wDriftCritical: WEIGHTS.driftCritical,
        wDriftWarning: WEIGHTS.driftWarning,
        wSkg: WEIGHTS.alreadyInSkg,
        minScore,
        maxCandidates,
      },
    );

    const candidates: TriageCandidate[] = result.records.map((r, i) => ({
      entityName: r.get("entityName") as string,
      mentionCount: toInt(r.get("mentionCount")),
      coOccurrenceDegree: toInt(r.get("coOccDegree")),
      clusterSize: toInt(r.get("clusterSize")),
      driftSignalCount: toInt(r.get("driftCount")),
      driftMaxSeverity:
        (r.get("maxSeverity") as TriageCandidate["driftMaxSeverity"]) ?? "none",
      isInSkg: r.get("isInSkg") as boolean,
      score: toFloat(r.get("score")),
      rank: i + 1,
    }));

    // ── Count skipped ───────────────────────────────────────────────
    const skippedResult = await session.run(
      `
      MATCH (e:KWEntity {session_id: $sid})
      OPTIONAL MATCH (c:Canon:Entity {session_id: $sid})
        WHERE toLower(c.name) = toLower(e.name)
      WITH e, c IS NOT NULL AS isInSkg
      RETURN
        count(CASE WHEN isInSkg THEN 1 END) AS skippedSkg,
        count(e) AS total
      `,
      { sid: opts.sessionId },
    );

    const skipped = skippedResult.records[0];
    const skippedAlreadyInSkg = toInt(skipped.get("skippedSkg"));
    const skippedBelowThreshold =
      totalKwgEntities - candidates.length - skippedAlreadyInSkg;

    const durationMs = performance.now() - start;
    log(
      `Triage complete: ${candidates.length} candidates (${durationMs.toFixed(0)}ms)`,
    );

    return {
      candidates,
      totalKwgEntities,
      totalSkgEntities,
      skippedAlreadyInSkg,
      skippedBelowThreshold: Math.max(0, skippedBelowThreshold),
      durationMs,
    };
  } finally {
    await session.close();
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Safely convert Neo4j integer to JS number */
function toInt(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "object" && "toNumber" in (val as any)) {
    return (val as any).toNumber();
  }
  return Number(val) || 0;
}

/** Safely convert Neo4j float to JS number */
function toFloat(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "object" && "toNumber" in (val as any)) {
    return (val as any).toNumber();
  }
  return Number(val) || 0;
}
