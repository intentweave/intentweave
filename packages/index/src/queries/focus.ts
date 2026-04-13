// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused Architecture View
 *
 * Given a target entity (file path, symbol name, or topic), extract a scoped
 * subgraph of the N-hop import neighborhood, annotated with layer assignments,
 * community membership, and co-change / doc-mention edges.
 *
 * This is the "show me the architecture around X" query — it returns a small,
 * renderer-ready subgraph that agents can turn into Mermaid diagrams, ASCII
 * trees, or focused HTML reports.
 */

import type Database from "better-sqlite3";
import type {
  FocusParams,
  FocusResult,
  FocusNode,
  FocusEdge,
} from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";
import { layersInferFromDb } from "./layersInfer.js";
import { communitiesFromDb } from "./communities.js";
import { retrieveFromDb } from "./retrieve.js";

/**
 * Extract a focused architecture subgraph from a database file path.
 */
export function focus(dbPath: string, params: FocusParams): FocusResult {
  const db = openIndex(dbPath);
  try {
    return focusFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Extract a focused architecture subgraph from an open database handle.
 */
export function focusFromDb(
  db: Database.Database,
  params: FocusParams,
): FocusResult {
  const hops = params.hops ?? 2;
  const maxNodes = params.maxNodes ?? 25;
  const target = params.target.trim();

  // ── Step 1: Resolve target to file path(s) ───────────────────
  const seedFiles = resolveTarget(db, target);
  if (seedFiles.length === 0) {
    return { target, nodes: [], edges: [], totalNeighborhood: 0, hops };
  }

  // ── Step 2: Expand N-hop import neighborhood ─────────────────
  const { forward, reverse } = buildImportGraph(db);
  const hopMap = new Map<string, number>(); // filePath → hop distance

  for (const seed of seedFiles) {
    hopMap.set(seed, 0);
  }

  let frontier = new Set(seedFiles);
  for (let hop = 1; hop <= hops; hop++) {
    const nextFrontier = new Set<string>();
    for (const file of frontier) {
      // Dependencies (forward)
      for (const dep of forward.get(file) ?? []) {
        if (!hopMap.has(dep)) {
          hopMap.set(dep, hop);
          nextFrontier.add(dep);
        }
      }
      // Dependents (reverse)
      for (const dep of reverse.get(file) ?? []) {
        if (!hopMap.has(dep)) {
          hopMap.set(dep, hop);
          nextFrontier.add(dep);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  const totalNeighborhood = hopMap.size;

  // ── Step 3: Truncate to maxNodes by hop distance + degree ────
  const neighborhoodFiles = truncateByRelevance(
    hopMap,
    seedFiles,
    forward,
    reverse,
    maxNodes,
  );

  // ── Step 4: Get layer & community context ────────────────────
  const layers = layersInferFromDb(db);
  const layerMap = new Map<string, { index: number; label: string }>();
  for (const layer of layers.layers) {
    for (const file of layer.files) {
      layerMap.set(file, {
        index: layer.index,
        label: layer.label ?? `layer-${layer.index}`,
      });
    }
  }

  const comms = communitiesFromDb(db);
  const commMap = new Map<string, { id: number; label: string }>();
  for (const comm of comms.communities) {
    for (const member of comm.members) {
      if (member.filePath) {
        commMap.set(member.filePath, { id: comm.id, label: comm.label });
      }
    }
  }

  // ── Step 5: Compute dependents count from reverse graph ──────
  // Transitive dependents count (cached BFS)
  const dependentsCache = new Map<string, number>();
  function countDependents(file: string): number {
    if (dependentsCache.has(file)) return dependentsCache.get(file)!;
    const visited = new Set<string>();
    const queue = [file];
    while (queue.length > 0) {
      const f = queue.pop()!;
      for (const dep of reverse.get(f) ?? []) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }
    dependentsCache.set(file, visited.size);
    return visited.size;
  }

  // ── Step 6: Build nodes ──────────────────────────────────────
  const seedSet = new Set(seedFiles);
  const nodes: FocusNode[] = [];
  for (const filePath of neighborhoodFiles) {
    const layer = layerMap.get(filePath);
    const comm = commMap.get(filePath);
    const name = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? filePath;

    nodes.push({
      filePath,
      name,
      layerIndex: layer?.index ?? -1,
      layerLabel: layer?.label ?? "unknown",
      communityId: comm?.id ?? -1,
      communityLabel: comm?.label ?? "ungrouped",
      dependents: countDependents(filePath),
      isTarget: seedSet.has(filePath),
      hopDistance: hopMap.get(filePath) ?? -1,
    });
  }

  // ── Step 7: Build edges ──────────────────────────────────────
  const fileSet = new Set(neighborhoodFiles);
  const edges: FocusEdge[] = [];

  // Import edges
  for (const source of neighborhoodFiles) {
    for (const dep of forward.get(source) ?? []) {
      if (fileSet.has(dep)) {
        edges.push({ source, target: dep, type: "import", weight: 1 });
      }
    }
  }

  // Co-change edges
  const coChangeRows = db
    .prepare(
      `SELECT file_a, file_b, jaccard FROM co_changes
       WHERE jaccard > 0`,
    )
    .all() as Array<{ file_a: string; file_b: string; jaccard: number }>;

  for (const row of coChangeRows) {
    if (fileSet.has(row.file_a) && fileSet.has(row.file_b)) {
      // Avoid duplicate with import edges — only add if no import exists
      const hasImport =
        edges.some(
          (e) =>
            e.type === "import" &&
            ((e.source === row.file_a && e.target === row.file_b) ||
              (e.source === row.file_b && e.target === row.file_a)),
        );
      if (!hasImport) {
        edges.push({
          source: row.file_a,
          target: row.file_b,
          type: "co_change",
          weight: row.jaccard,
        });
      }
    }
  }

  // Doc co-occurrence edges (file-level only)
  const coocRows = db
    .prepare(
      `SELECT entity_a, entity_b, score FROM co_occurrences
       WHERE source = 'doc_cooc'
         AND entity_a LIKE '%.%' AND entity_b LIKE '%.%'
       ORDER BY score DESC`,
    )
    .all() as Array<{ entity_a: string; entity_b: string; score: number }>;

  for (const row of coocRows) {
    if (fileSet.has(row.entity_a) && fileSet.has(row.entity_b)) {
      const hasExisting = edges.some(
        (e) =>
          (e.source === row.entity_a && e.target === row.entity_b) ||
          (e.source === row.entity_b && e.target === row.entity_a),
      );
      if (!hasExisting) {
        edges.push({
          source: row.entity_a,
          target: row.entity_b,
          type: "doc_cooc",
          weight: row.score,
        });
      }
    }
  }

  return { target, nodes, edges, totalNeighborhood, hops };
}

// ── Internal helpers ──────────────────────────────────────────────

/**
 * Resolve a target string to one or more file paths.
 * Tries (in order):
 *   1. Exact file path
 *   2. Partial file path (filename match)
 *   3. Symbol name (exact, case-insensitive)
 *   4. Annotation text (LIKE match)
 *   5. Ranked retrieval (TF-IDF via CARI retrieve) — handles natural language
 */
function resolveTarget(db: Database.Database, target: string): string[] {
  // 1. Exact file path match
  const exactFile = db
    .prepare(`SELECT path FROM files WHERE path = ? OR path LIKE ?`)
    .get(target, `%/${target}`) as { path: string } | undefined;
  if (exactFile) return [exactFile.path];

  // 2. File path partial match (filename without extension)
  const partialFiles = db
    .prepare(
      `SELECT path FROM files
       WHERE path LIKE ? OR path LIKE ?
       ORDER BY length(path) ASC
       LIMIT 3`,
    )
    .all(`%/${target}.%`, `%/${target}/%`) as Array<{ path: string }>;
  if (partialFiles.length > 0) return partialFiles.map((r) => r.path);

  // 3. Symbol name → file path (exact match, case-insensitive)
  const symbolFiles = db
    .prepare(
      `SELECT DISTINCT file_path FROM symbols
       WHERE LOWER(name) = LOWER(?)
       LIMIT 3`,
    )
    .all(target) as Array<{ file_path: string }>;
  if (symbolFiles.length > 0) return symbolFiles.map((r) => r.file_path);

  // 4. Keyword-based: find files with annotations matching the target
  const annotationFiles = db
    .prepare(
      `SELECT DISTINCT s.file_path FROM annotations a
       JOIN symbols s ON a.symbol_id = s.id
       WHERE LOWER(a.text) LIKE ?
       ORDER BY a.confidence DESC
       LIMIT 5`,
    )
    .all(`%${target.toLowerCase()}%`) as Array<{ file_path: string }>;
  if (annotationFiles.length > 0) return annotationFiles.map((r) => r.file_path);

  // 5. Ranked retrieval — handles natural language queries like "Analysis Pipeline"
  // Uses CARI's TF-IDF scoring across annotations + symbol FTS
  try {
    const retrieved = retrieveFromDb(db, { query: target, limit: 5 });
    if (retrieved.files.length > 0) {
      return retrieved.files.map((f) => f.path);
    }
  } catch {
    // FTS5 tables may not exist in minimal databases — skip gracefully
  }

  return [];
}

/**
 * Truncate the neighborhood to maxNodes, prioritising:
 * 1. Seed files (always kept)
 * 2. Closer hop distance
 * 3. Higher import degree (more connections = more important)
 */
function truncateByRelevance(
  hopMap: Map<string, number>,
  seeds: string[],
  forward: Map<string, Set<string>>,
  reverse: Map<string, Set<string>>,
  maxNodes: number,
): string[] {
  if (hopMap.size <= maxNodes) return [...hopMap.keys()];

  const seedSet = new Set(seeds);
  const nonSeeds = [...hopMap.entries()]
    .filter(([f]) => !seedSet.has(f))
    .sort(([aFile, aHop], [bFile, bHop]) => {
      // Sort by hop distance (closer first), then by degree (higher first)
      if (aHop !== bHop) return aHop - bHop;
      const aDegree =
        (forward.get(aFile)?.size ?? 0) + (reverse.get(aFile)?.size ?? 0);
      const bDegree =
        (forward.get(bFile)?.size ?? 0) + (reverse.get(bFile)?.size ?? 0);
      return bDegree - aDegree;
    })
    .map(([f]) => f);

  return [...seeds, ...nonSeeds.slice(0, maxNodes - seeds.length)];
}
