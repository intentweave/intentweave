// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 9.1 Community Detection
 *
 * Run label propagation community detection on the combined co-occurrence +
 * import + co-change graph. Automatically discover natural module clusters
 * without user-defined layers. $0/no-LLM — pure graph algorithm on SQLite data.
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  CommunityDetectionResult,
  Community,
  CommunityMember,
  CommunityOptions,
  CommunityMode,
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
 * Used by communityLabelsFromDb (for surprises) which needs all entities.
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

/**
 * Build a file-level graph using only structural edges (imports + co-changes).
 * Produces meaningful communities based on actual code architecture rather than
 * document co-occurrence, which creates dense, unsplittable mega-communities.
 */
function buildFileGraph(db: Database.Database): {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, Map<string, number>>;
} {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, Map<string, number>>();

  function ensureNode(name: string, kind?: string, filePath?: string): void {
    if (!nodes.has(name)) {
      nodes.set(name, { name, kind: kind ?? "file", filePath });
    }
  }

  function addEdge(a: string, b: string, weight: number): void {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Map());
    if (!adjacency.has(b)) adjacency.set(b, new Map());
    adjacency.get(a)!.set(b, (adjacency.get(a)!.get(b) ?? 0) + weight);
    adjacency.get(b)!.set(a, (adjacency.get(b)!.get(a) ?? 0) + weight);
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

  // ── Co-occurrences between known file nodes only ──
  // Include co-occurrence edges that connect files already in the graph,
  // but skip generic terms (e.g. "build", "code") that create mega-communities.
  const coOccRows = db
    .prepare(`SELECT entity_a, entity_b, score FROM co_occurrences`)
    .all() as Array<{ entity_a: string; entity_b: string; score: number }>;

  for (const row of coOccRows) {
    if (nodes.has(row.entity_a) && nodes.has(row.entity_b)) {
      addEdge(row.entity_a, row.entity_b, row.score);
    }
  }

  return { nodes, adjacency };
}

/**
 * Build a temporal-only graph using co-change edges.
 * Reveals implicit coupling: files that evolve together regardless of imports.
 */
function buildTemporalGraph(db: Database.Database): {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, Map<string, number>>;
} {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, Map<string, number>>();

  function ensureNode(name: string): void {
    if (!nodes.has(name)) {
      nodes.set(name, { name, kind: "file", filePath: name });
    }
  }

  function addEdge(a: string, b: string, weight: number): void {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Map());
    if (!adjacency.has(b)) adjacency.set(b, new Map());
    adjacency.get(a)!.set(b, (adjacency.get(a)!.get(b) ?? 0) + weight);
    adjacency.get(b)!.set(a, (adjacency.get(b)!.get(a) ?? 0) + weight);
  }

  const coChangeRows = db
    .prepare(`SELECT file_a, file_b, jaccard FROM co_changes`)
    .all() as Array<{ file_a: string; file_b: string; jaccard: number }>;

  for (const row of coChangeRows) {
    ensureNode(row.file_a);
    ensureNode(row.file_b);
    addEdge(row.file_a, row.file_b, row.jaccard);
  }

  return { nodes, adjacency };
}

/**
 * Select the correct graph builder for the given community mode.
 */
function buildGraphForMode(
  db: Database.Database,
  mode: CommunityMode,
): {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, Map<string, number>>;
} {
  switch (mode) {
    case "semantic":
      return buildGraph(db);
    case "temporal":
      return buildTemporalGraph(db);
    case "structural":
    default:
      return buildFileGraph(db);
  }
}

// ─── Label Propagation ─────────────────────────────────────────────────────

const MAX_ITERATIONS = 50;

/** Simple seeded PRNG (mulberry32) for deterministic shuffles. */
function seededRng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard label propagation community detection.
 *
 * Each node starts with a unique label. At each iteration, every node adopts
 * the label most common among its weighted neighbours. Converges when no label
 * changes or MAX_ITERATIONS is reached.
 */
function labelPropagation(
  nodes: Map<string, GraphNode>,
  adjacency: Map<string, Map<string, number>>,
): Map<string, number> {
  const labels = new Map<string, number>();
  const nodeNames = Array.from(nodes.keys());
  const rng = seededRng(42);

  // Initialize: each node gets a unique label
  for (let i = 0; i < nodeNames.length; i++) {
    labels.set(nodeNames[i], i);
  }

  // Iteratively propagate labels
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;

    // Deterministic shuffle to avoid oscillation
    const shuffled = [...nodeNames];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
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
export function communities(
  dbPath: string,
  options?: CommunityOptions,
): CommunityDetectionResult {
  const db = openIndex(dbPath);
  try {
    return communitiesFromDb(db, options);
  } finally {
    db.close();
  }
}

/**
 * Detect communities from an open database handle.
 */
export function communitiesFromDb(
  db: Database.Database,
  options?: CommunityOptions,
): CommunityDetectionResult {
  const resolution = options?.resolution ?? 1.0;
  const maxSize = options?.maxSize ?? 100;
  const minSize = options?.minSize ?? 2;
  const mode = options?.mode ?? "structural";

  // Resolution scales maxSize: resolution=2 → half the max, resolution=3 → third
  const effectiveMaxSize =
    resolution > 1.0
      ? Math.max(minSize, Math.round(maxSize / resolution))
      : maxSize;

  // Select graph based on mode
  const { nodes, adjacency } = buildGraphForMode(db, mode);

  if (nodes.size === 0) {
    return { communities: [], totalCommunities: 0, totalNodes: 0 };
  }

  // Always run standard LPA for stable base communities
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

  // Build initial community list
  let rawCommunities: CommunityMember[][] = [];
  for (const [, members] of communityMap) {
    if (members.length < minSize) continue;
    rawCommunities.push(members);
  }

  // ── Recursive sub-splitting of oversized communities ──
  if (effectiveMaxSize !== Infinity && effectiveMaxSize > 0) {
    rawCommunities = recursiveSplit(
      rawCommunities,
      nodes,
      adjacency,
      effectiveMaxSize,
      minSize,
    );
  }

  // Sort by size descending and assign IDs
  rawCommunities.sort((a, b) => b.length - a.length);

  const communityList: Community[] = rawCommunities.map((members, idx) => ({
    id: idx,
    label: members[0].name,
    members,
    size: members.length,
  }));

  return {
    communities: communityList,
    totalCommunities: communityList.length,
    totalNodes: nodes.size,
  };
}

/**
 * Recursively split communities that exceed maxSize.
 *
 * Strategy:
 * 1. Re-run LPA on the community's subgraph — if it naturally splits, use that.
 * 2. Fallback: remove weak edges and find connected components. This handles
 *    tightly-connected communities where LPA converges to a single group.
 */
function recursiveSplit(
  initial: CommunityMember[][],
  nodes: Map<string, GraphNode>,
  adjacency: Map<string, Map<string, number>>,
  maxSize: number,
  minSize: number,
  depth: number = 0,
): CommunityMember[][] {
  const MAX_DEPTH = 5;
  const result: CommunityMember[][] = [];

  for (const members of initial) {
    if (members.length <= maxSize || depth >= MAX_DEPTH) {
      result.push(members);
      continue;
    }

    // Build subgraph for this community's members
    const memberNames = new Set(members.map((m) => m.name));
    const subNodes = new Map<string, GraphNode>();
    const subAdj = new Map<string, Map<string, number>>();

    for (const name of memberNames) {
      const node = nodes.get(name);
      if (node) subNodes.set(name, node);

      const neighbors = adjacency.get(name);
      if (!neighbors) continue;

      const filtered = new Map<string, number>();
      for (const [neighbor, weight] of neighbors) {
        if (memberNames.has(neighbor)) {
          filtered.set(neighbor, weight);
        }
      }
      if (filtered.size > 0) subAdj.set(name, filtered);
    }

    if (subNodes.size < 2) {
      result.push(members);
      continue;
    }

    // Strategy 1: re-run LPA on the subgraph
    const subLabels = labelPropagation(subNodes, subAdj);

    const subMap = new Map<number, CommunityMember[]>();
    for (const [name, label] of subLabels) {
      if (!subMap.has(label)) subMap.set(label, []);
      const node = subNodes.get(name)!;
      subMap.get(label)!.push({
        name: node.name,
        kind: node.kind,
        filePath: node.filePath,
      });
    }

    let subCommunities: CommunityMember[][] = [];
    for (const [, subMembers] of subMap) {
      if (subMembers.length >= minSize) {
        subCommunities.push(subMembers);
      }
    }

    // Strategy 2: if LPA didn't split, remove hub nodes and find components
    if (subCommunities.length <= 1) {
      subCommunities = splitByHubRemoval(members, subAdj, minSize);
    }

    // Strategy 3: remove weak edges and find connected components
    if (subCommunities.length <= 1) {
      subCommunities = splitByEdgeRemoval(members, subAdj, minSize);
    }

    // Strategy 4: group by file path directory (always works for file-based entities)
    if (subCommunities.length <= 1) {
      subCommunities = splitByFilePath(members, maxSize, minSize);
    }

    if (subCommunities.length <= 1) {
      // Truly unsplittable — keep as-is
      result.push(members);
      continue;
    }

    // Recursively check if sub-communities are still too large
    const further = recursiveSplit(
      subCommunities,
      nodes,
      adjacency,
      maxSize,
      minSize,
      depth + 1,
    );
    result.push(...further);
  }

  return result;
}

/**
 * Split by hub removal: identify high-degree nodes that connect everything,
 * temporarily remove them, find connected components, then re-assign hubs
 * to their most-connected component. This handles dense graphs where a few
 * super-connectors (e.g. generic terms like "code", "file", "build") mask
 * the underlying community structure.
 */
function splitByHubRemoval(
  members: CommunityMember[],
  adjacency: Map<string, Map<string, number>>,
  minSize: number,
): CommunityMember[][] {
  const memberNames = new Set(members.map((m) => m.name));
  const memberMap = new Map(members.map((m) => [m.name, m]));

  // Compute internal degree for each member
  const degrees = new Map<string, number>();
  for (const name of memberNames) {
    const neighbors = adjacency.get(name);
    let degree = 0;
    if (neighbors) {
      for (const [n] of neighbors) {
        if (memberNames.has(n)) degree++;
      }
    }
    degrees.set(name, degree);
  }

  // Hub threshold: mean + 1 standard deviation
  const degreeValues = [...degrees.values()];
  const meanDeg = degreeValues.reduce((a, b) => a + b, 0) / degreeValues.length;
  const stdDeg = Math.sqrt(
    degreeValues.reduce((a, b) => a + (b - meanDeg) ** 2, 0) /
      degreeValues.length,
  );
  const hubThreshold = meanDeg + stdDeg;

  const hubNames = new Set<string>();
  for (const [name, degree] of degrees) {
    if (degree > hubThreshold) hubNames.add(name);
  }

  // Need some hubs but not too many (< 50% of members)
  if (hubNames.size === 0 || hubNames.size >= memberNames.size * 0.5) {
    return [members];
  }

  // Find connected components among non-hub members
  const nonHubs = new Set([...memberNames].filter((n) => !hubNames.has(n)));
  const visited = new Set<string>();
  const components: CommunityMember[][] = [];

  for (const name of nonHubs) {
    if (visited.has(name)) continue;

    const component: CommunityMember[] = [];
    const queue = [name];
    visited.add(name);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const member = memberMap.get(current);
      if (member) component.push(member);

      const neighbors = adjacency.get(current);
      if (!neighbors) continue;

      for (const [neighbor] of neighbors) {
        if (nonHubs.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  // Merge tiny fragments into the nearest qualifying component
  const qualifying = components.filter((c) => c.length >= minSize);
  if (qualifying.length <= 1) return [members]; // Hub removal didn't help

  // Build component index for hub assignment
  const compIndex = new Map<string, number>();
  for (let i = 0; i < qualifying.length; i++) {
    for (const m of qualifying[i]) compIndex.set(m.name, i);
  }

  // Merge tiny components into their most-connected qualifying component
  const tinyMembers = components.filter((c) => c.length < minSize).flat();
  for (const m of tinyMembers) {
    const neighbors = adjacency.get(m.name);
    const votes = new Map<number, number>();
    if (neighbors) {
      for (const [neighbor, weight] of neighbors) {
        const ci = compIndex.get(neighbor);
        if (ci !== undefined) votes.set(ci, (votes.get(ci) ?? 0) + weight);
      }
    }
    let bestComp = 0;
    let bestWeight = -1;
    for (const [ci, weight] of votes) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestComp = ci;
      }
    }
    qualifying[bestComp].push(m);
    compIndex.set(m.name, bestComp);
  }

  // Assign hub nodes to their most-connected component
  for (const hubName of hubNames) {
    const member = memberMap.get(hubName);
    if (!member) continue;

    const neighbors = adjacency.get(hubName);
    const votes = new Map<number, number>();
    if (neighbors) {
      for (const [neighbor, weight] of neighbors) {
        const ci = compIndex.get(neighbor);
        if (ci !== undefined) votes.set(ci, (votes.get(ci) ?? 0) + weight);
      }
    }
    let bestComp = 0;
    let bestWeight = -1;
    for (const [ci, weight] of votes) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestComp = ci;
      }
    }
    qualifying[bestComp].push(member);
    compIndex.set(hubName, bestComp);
  }

  return qualifying;
}

/**
 * Fallback splitting: progressively remove weak edges and find connected
 * components. Tries the median weight threshold first, then 75th and 90th
 * percentiles until multiple components emerge.
 */
function splitByEdgeRemoval(
  members: CommunityMember[],
  adjacency: Map<string, Map<string, number>>,
  minSize: number,
): CommunityMember[][] {
  const memberNames = new Set(members.map((m) => m.name));
  const memberMap = new Map(members.map((m) => [m.name, m]));

  // Collect internal edge weights (each undirected edge counted once)
  const weights: number[] = [];
  for (const name of memberNames) {
    const neighbors = adjacency.get(name);
    if (!neighbors) continue;
    for (const [neighbor, weight] of neighbors) {
      if (memberNames.has(neighbor) && neighbor > name) {
        weights.push(weight);
      }
    }
  }

  if (weights.length === 0) return [members];
  weights.sort((a, b) => a - b);

  // Try increasing thresholds until multiple components appear
  for (const percentile of [0.5, 0.75, 0.9]) {
    const threshold = weights[Math.floor(weights.length * percentile)];

    // BFS to find connected components above threshold
    const visited = new Set<string>();
    const components: CommunityMember[][] = [];

    for (const name of memberNames) {
      if (visited.has(name)) continue;

      const component: CommunityMember[] = [];
      const queue = [name];
      visited.add(name);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const member = memberMap.get(current);
        if (member) component.push(member);

        const neighbors = adjacency.get(current);
        if (!neighbors) continue;

        for (const [neighbor, weight] of neighbors) {
          if (
            memberNames.has(neighbor) &&
            !visited.has(neighbor) &&
            weight >= threshold
          ) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      components.push(component);
    }

    // Keep only components meeting minSize; merge remainder into largest
    const qualifying = components.filter((c) => c.length >= minSize);
    const remainder = components.filter((c) => c.length < minSize).flat();

    if (qualifying.length > 1) {
      if (remainder.length > 0) {
        // Attach remainder to the largest qualifying group
        qualifying.sort((a, b) => b.length - a.length);
        qualifying[0].push(...remainder);
      }
      return qualifying;
    }
  }

  return [members]; // Truly unsplittable
}

/**
 * Split by file path: group members by directory prefix at increasing depth
 * until enough groups exist to bring community sizes below maxSize.
 * Members without filePath are distributed among the closest group.
 */
function splitByFilePath(
  members: CommunityMember[],
  maxSize: number,
  minSize: number,
): CommunityMember[][] {
  const withPaths = members.filter((m) => m.filePath);
  const withoutPaths = members.filter((m) => !m.filePath);

  if (withPaths.length < minSize * 2) return [members]; // Not enough path-based members

  const targetGroups = Math.max(2, Math.ceil(members.length / maxSize));

  // Try increasing directory depth until enough groups appear
  for (let depth = 1; depth <= 10; depth++) {
    const groups = new Map<string, CommunityMember[]>();

    for (const m of withPaths) {
      const parts = m.filePath!.split("/");
      const key = parts.slice(0, depth).join("/") || "/";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }

    if (groups.size >= targetGroups || depth === 10) {
      // Distribute pathless members to smallest groups for balance
      if (withoutPaths.length > 0) {
        const groupArr = [...groups.values()];
        for (const m of withoutPaths) {
          const smallest = groupArr.reduce((a, b) =>
            a.length < b.length ? a : b,
          );
          smallest.push(m);
        }
      }

      // Filter by minSize; merge tiny groups into smallest qualifying
      const qualifying: CommunityMember[][] = [];
      const tooSmall: CommunityMember[] = [];
      for (const g of groups.values()) {
        if (g.length >= minSize) qualifying.push(g);
        else tooSmall.push(...g);
      }
      if (tooSmall.length > 0 && qualifying.length > 0) {
        qualifying.sort((a, b) => a.length - b.length);
        qualifying[0].push(...tooSmall);
      } else if (tooSmall.length > 0) {
        qualifying.push(tooSmall);
      }

      if (qualifying.length > 1) return qualifying;
    }
  }

  return [members];
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
