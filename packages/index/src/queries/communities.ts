// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 9.1 Community Detection
 *
 * Run label propagation community detection on the combined co-occurrence +
 * import + co-change graph. Automatically discover natural module clusters
 * without user-defined layers. $0/no-LLM — pure graph algorithm on SQLite data.
 */

import type Database from "better-sqlite3";
import type {
  CommunityDetectionResult,
  Community,
  CommunityMember,
} from "../types.js";
import { openIndex } from "./shared.js";

// ─── Graph helpers ──────────────────────────────────────────────────────────

interface GraphNode {
  name: string;
  kind: string;
  filePath?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * Build a combined weighted graph from all edge tables.
 */
function buildGraph(db: Database.Database): {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, Map<string, number>>;
} {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, Map<string, number>>();

  function ensureNode(name: string, kind?: string, filePath?: string): void {
    if (!nodes.has(name)) {
      nodes.set(name, { name, kind: kind ?? "unknown", filePath });
    }
  }

  function addEdge(a: string, b: string, weight: number): void {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Map());
    if (!adjacency.has(b)) adjacency.set(b, new Map());
    adjacency.get(a)!.set(b, (adjacency.get(a)!.get(b) ?? 0) + weight);
    adjacency.get(b)!.set(a, (adjacency.get(b)!.get(a) ?? 0) + weight);
  }

  // ── Co-occurrences (entity pairs co-mentioned in docs) ──
  const coOccRows = db
    .prepare(`SELECT entity_a, entity_b, score FROM co_occurrences`)
    .all() as Array<{ entity_a: string; entity_b: string; score: number }>;

  for (const row of coOccRows) {
    ensureNode(row.entity_a);
    ensureNode(row.entity_b);
    addEdge(row.entity_a, row.entity_b, row.score);
  }

  // ── Imports (file→file structural edges) ──
  const importRows = db
    .prepare(`SELECT source_file, target_file FROM imports`)
    .all() as Array<{ source_file: string; target_file: string }>;

  for (const row of importRows) {
    ensureNode(row.source_file, "file", row.source_file);
    ensureNode(row.target_file, "file", row.target_file);
    addEdge(row.source_file, row.target_file, 1.0);
  }

  // ── Co-changes (temporal coupling from git history) ──
  const coChangeRows = db
    .prepare(`SELECT file_a, file_b, jaccard FROM co_changes`)
    .all() as Array<{ file_a: string; file_b: string; jaccard: number }>;

  for (const row of coChangeRows) {
    ensureNode(row.file_a, "file", row.file_a);
    ensureNode(row.file_b, "file", row.file_b);
    addEdge(row.file_a, row.file_b, row.jaccard);
  }

  // ── Enrich node metadata from symbols table ──
  const allSymbols = db
    .prepare(`SELECT name, kind, file_path FROM symbols`)
    .all() as Array<{ name: string; kind: string; file_path: string }>;

  for (const s of allSymbols) {
    const existing = nodes.get(s.name);
    if (existing && existing.kind === "unknown") {
      existing.kind = s.kind;
      existing.filePath = s.file_path;
    }
  }

  return { nodes, adjacency };
}

// ─── Label Propagation ─────────────────────────────────────────────────────

const MAX_ITERATIONS = 50;

/**
 * Label propagation community detection.
 *
 * Each node starts with a unique label. At each iteration, every node adopts
 * the label most common among its weighted neighbors. Converges when no node
 * changes its label.
 */
function labelPropagation(
  nodes: Map<string, GraphNode>,
  adjacency: Map<string, Map<string, number>>,
): Map<string, number> {
  const labels = new Map<string, number>();
  const nodeNames = Array.from(nodes.keys());

  // Initialize: each node gets a unique label
  for (let i = 0; i < nodeNames.length; i++) {
    labels.set(nodeNames[i], i);
  }

  // Iteratively propagate labels
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;

    // Shuffle node order to avoid oscillation
    const shuffled = [...nodeNames];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const node of shuffled) {
      const neighbors = adjacency.get(node);
      if (!neighbors || neighbors.size === 0) continue;

      // Weighted vote: sum weights per neighbor label
      const labelWeights = new Map<number, number>();
      for (const [neighbor, weight] of neighbors) {
        const nLabel = labels.get(neighbor)!;
        labelWeights.set(nLabel, (labelWeights.get(nLabel) ?? 0) + weight);
      }

      // Pick label with highest weight
      let bestLabel = labels.get(node)!;
      let bestWeight = -1;
      for (const [label, weight] of labelWeights) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect communities from a database file path.
 */
export function communities(dbPath: string): CommunityDetectionResult {
  const db = openIndex(dbPath);
  try {
    return communitiesFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Detect communities from an open database handle.
 */
export function communitiesFromDb(
  db: Database.Database,
): CommunityDetectionResult {
  const { nodes, adjacency } = buildGraph(db);

  if (nodes.size === 0) {
    return { communities: [], totalCommunities: 0, totalNodes: 0 };
  }

  const labels = labelPropagation(nodes, adjacency);

  // Group nodes by community label
  const communityMap = new Map<number, CommunityMember[]>();
  for (const [name, label] of labels) {
    if (!communityMap.has(label)) communityMap.set(label, []);
    const node = nodes.get(name)!;
    communityMap.get(label)!.push({
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
    });
  }

  // Build Community objects, sorted by size descending
  const communityList: Community[] = [];
  let id = 0;
  const sorted = [...communityMap.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  for (const [, members] of sorted) {
    // Filter out singleton communities (isolated nodes)
    if (members.length < 2) continue;

    // Label = name of first member (most central proxy)
    const label = members[0].name;

    communityList.push({
      id: id++,
      label,
      members,
      size: members.length,
    });
  }

  return {
    communities: communityList,
    totalCommunities: communityList.length,
    totalNodes: nodes.size,
  };
}

/**
 * Exported for use by 9.3 Surprising Connections.
 * Returns a map of entity name → community ID.
 */
export function communityLabelsFromDb(
  db: Database.Database,
): Map<string, number> {
  const { nodes, adjacency } = buildGraph(db);
  if (nodes.size === 0) return new Map();
  return labelPropagation(nodes, adjacency);
}
