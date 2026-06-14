// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 9.3 Surprising Connection Ranking
 *
 * Extend the existing hidden-couplings analysis with a composite surprise score.
 * Rank by: (a) cross-layer weight (code↔doc edges score higher),
 * (b) community distance (connections spanning different communities rank higher),
 * (c) inverse frequency (rare co-occurrences are more surprising).
 * Each result includes a plain-English "why" explanation.
 *
 * Builds on: 9.1 (communities), existing co_occurrences + co_changes data.
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  SurprisingConnectionsResult,
  SurprisingConnection,
} from "../types.js";
import { openIndex } from "./shared.js";
import { communityLabelsFromDb } from "./communities.js";

// ─── Edge source classification ─────────────────────────────────────────────

type EdgeLayer = "code" | "doc" | "temporal";

interface RawEdge {
  entityA: string;
  entityB: string;
  weight: number;
  layer: EdgeLayer;
  source: string;
}

/**
 * Load all edges from the database, classified by layer.
 */
function loadEdges(db: Database.Database): RawEdge[] {
  const edges: RawEdge[] = [];

  // Co-occurrences: doc layer (entities co-mentioned in documentation)
  const coOccRows = db
    .prepare(`SELECT entity_a, entity_b, score, source FROM co_occurrences`)
    .all() as Array<{
    entity_a: string;
    entity_b: string;
    score: number;
    source: string;
  }>;

  for (const row of coOccRows) {
    // Source "code-import" = code layer, otherwise doc layer
    const layer: EdgeLayer = row.source === "code-import" ? "code" : "doc";
    edges.push({
      entityA: row.entity_a,
      entityB: row.entity_b,
      weight: row.score,
      layer,
      source: `co_occurrence:${row.source}`,
    });
  }

  // Co-changes: temporal layer
  const coChangeRows = db
    .prepare(`SELECT file_a, file_b, jaccard FROM co_changes`)
    .all() as Array<{ file_a: string; file_b: string; jaccard: number }>;

  for (const row of coChangeRows) {
    edges.push({
      entityA: row.file_a,
      entityB: row.file_b,
      weight: row.jaccard,
      layer: "temporal",
      source: "co_change",
    });
  }

  return edges;
}

/**
 * Determine if a name represents a file path (contains / or \).
 */
function isFilePath(name: string): boolean {
  return name.includes("/") || name.includes("\\") || name.includes(".");
}

// ─── Surprise scoring ───────────────────────────────────────────────────────

function computeSurprises(
  edges: RawEdge[],
  communityLabels: Map<string, number>,
): SurprisingConnection[] {
  if (edges.length === 0) return [];

  // ── Frequency map: how often each entity appears in any edge ──
  const entityFrequency = new Map<string, number>();
  for (const edge of edges) {
    entityFrequency.set(
      edge.entityA,
      (entityFrequency.get(edge.entityA) ?? 0) + 1,
    );
    entityFrequency.set(
      edge.entityB,
      (entityFrequency.get(edge.entityB) ?? 0) + 1,
    );
  }
  const maxFreq = Math.max(...entityFrequency.values(), 1);

  const results: SurprisingConnection[] = [];

  for (const edge of edges) {
    // ── (a) Cross-layer weight ──
    // Connections between different entity types (file vs symbol) score higher
    const aIsFile = isFilePath(edge.entityA);
    const bIsFile = isFilePath(edge.entityB);
    const isCrossType = aIsFile !== bIsFile;
    const crossLayerWeight = isCrossType
      ? 1.0
      : edge.layer === "doc"
        ? 0.6
        : 0.3;

    // ── (b) Community distance ──
    const commA = communityLabels.get(edge.entityA);
    const commB = communityLabels.get(edge.entityB);
    let communityDistance = 0;
    if (commA !== undefined && commB !== undefined && commA !== commB) {
      communityDistance = 1.0;
    } else if (commA === undefined || commB === undefined) {
      // Node not in any community (isolated) — mildly surprising
      communityDistance = 0.3;
    }

    // ── (c) Inverse frequency ──
    const freqA = entityFrequency.get(edge.entityA) ?? 1;
    const freqB = entityFrequency.get(edge.entityB) ?? 1;
    const avgFreq = (freqA + freqB) / 2;
    const inverseFrequency = 1 - avgFreq / (maxFreq + 1);

    // ── Composite score ──
    const score =
      0.35 * crossLayerWeight +
      0.4 * communityDistance +
      0.25 * inverseFrequency;

    // ── Plain-English reason ──
    const reasons: string[] = [];
    if (communityDistance > 0.5) {
      reasons.push("spans different communities");
    }
    if (isCrossType) {
      reasons.push("connects code and documentation layers");
    }
    if (inverseFrequency > 0.7) {
      reasons.push("rarely co-occurs elsewhere");
    }
    if (edge.layer === "temporal") {
      reasons.push("linked by git co-change history");
    }
    const reason =
      reasons.length > 0
        ? reasons.join("; ")
        : "moderate cross-reference detected";

    results.push({
      entityA: edge.entityA,
      entityB: edge.entityB,
      score: Math.round(score * 1000) / 1000,
      crossLayerWeight: Math.round(crossLayerWeight * 1000) / 1000,
      communityDistance: Math.round(communityDistance * 1000) / 1000,
      inverseFrequency: Math.round(inverseFrequency * 1000) / 1000,
      reason,
    });
  }

  // Sort by surprise score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Find surprising connections from a database file path.
 */
export function surprises(dbPath: string): SurprisingConnectionsResult {
  const db = openIndex(dbPath);
  try {
    return surprisesFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Find surprising connections from an open database handle.
 */
export function surprisesFromDb(
  db: Database.Database,
): SurprisingConnectionsResult {
  const edges = loadEdges(db);
  const communityLabels = communityLabelsFromDb(db);
  const surpriseList = computeSurprises(edges, communityLabels);

  return {
    surprises: surpriseList,
    totalEvaluated: edges.length,
  };
}
