// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: clones
 *
 * Exact clone detection via body_hash (Type 1).
 * Structural clone detection via structure_hash (Type 2).
 *
 * 5.9: Optional --layer-analysis mode annotates each clone group with layer
 * context, distinguishing DRY violations (same layer) from architectural
 * violations (cross-layer reimplementations).
 */

import type Database from "@intentweave/sqlite-compat";
import type { ClonesResult, StructuralClonesResult } from "../types.js";
import { openIndex } from "./shared.js";

// ── Layer annotation helpers (5.9) ───────────────────────────────────────────

/**
 * Build a file→layer index map from the import graph.
 * Uses topological depth from sinks (same algorithm as layersInfer).
 * Returns null when there is no import data to avoid penalising small indexes.
 */
function buildFileLayerMap(db: Database.Database): Map<string, number> | null {
  const imports = db
    .prepare(
      `SELECT source_file, target_file FROM imports WHERE source_file IS NOT NULL AND target_file IS NOT NULL`,
    )
    .all() as Array<{ source_file: string; target_file: string }>;

  if (imports.length === 0) return null;

  // Build forward adjacency (file → files it imports)
  const forward = new Map<string, Set<string>>();
  const allFiles = new Set<string>();
  for (const { source_file, target_file } of imports) {
    allFiles.add(source_file);
    allFiles.add(target_file);
    if (!forward.has(source_file)) forward.set(source_file, new Set());
    forward.get(source_file)!.add(target_file);
  }

  // BFS depth from sinks (files with no outgoing imports = depth 0)
  const depth = new Map<string, number>();
  const queue: string[] = [];

  for (const f of allFiles) {
    if (!forward.has(f) || forward.get(f)!.size === 0) {
      depth.set(f, 0);
      queue.push(f);
    }
  }

  // Reverse adjacency for BFS propagation
  const reverse = new Map<string, Set<string>>();
  for (const [src, targets] of forward) {
    for (const t of targets) {
      if (!reverse.has(t)) reverse.set(t, new Set());
      reverse.get(t)!.add(src);
    }
  }

  let i = 0;
  while (i < queue.length) {
    const file = queue[i++];
    const d = depth.get(file)!;
    for (const importer of reverse.get(file) ?? []) {
      const next = d + 1;
      if (!depth.has(importer) || depth.get(importer)! < next) {
        depth.set(importer, next);
        queue.push(importer);
      }
    }
  }

  return depth;
}

/** Bucket a topological depth value into a layer index (0 = foundation). */
function depthToLayer(depth: number, maxDepth: number): number {
  if (maxDepth === 0) return 0;
  // 4 buckets: 0-25%→0, 26-50%→1, 51-75%→2, 76-100%→3
  return Math.min(3, Math.floor((depth / maxDepth) * 4));
}

export interface CloneLayerAnalysis {
  /**
   * "architectural" — clones span ≥2 different layers.
   * "dry" — all clones reside in the same layer.
   * "unknown" — no layer data available.
   */
  kind: "architectural" | "dry" | "unknown";
  /** Layer index per symbol (parallel to the symbols array) */
  layers: number[];
  /** Unique layer indices represented in this group */
  uniqueLayers: number[];
  /** Human-readable suggestion */
  suggestion: string;
}

// ── Exact Clones ─────────────────────────────────────────────────────────────

export interface ClonesOptions {
  /** Annotate each clone group with layer context (5.9). Default: false. */
  layerAnalysis?: boolean;
}

/**
 * Detect exact code clones from the index.
 */
export function clones(dbPath: string, opts: ClonesOptions = {}): ClonesResult {
  const db = openIndex(dbPath);
  try {
    return clonesFromDb(db, opts);
  } finally {
    db.close();
  }
}

/**
 * Core clone detection logic against an open database.
 */
export function clonesFromDb(
  db: Database.Database,
  opts: ClonesOptions = {},
): ClonesResult {
  // Find body hashes shared by more than one symbol
  const groups = db
    .prepare(
      `
      SELECT body_hash, body_lines, COUNT(*) AS cnt
      FROM symbols
      WHERE body_hash IS NOT NULL
      GROUP BY body_hash
      HAVING COUNT(*) > 1
      ORDER BY body_lines DESC, cnt DESC
    `,
    )
    .all() as Array<{ body_hash: string; body_lines: number; cnt: number }>;

  // Build layer map once if requested
  const layerMap = opts.layerAnalysis ? buildFileLayerMap(db) : null;
  const maxDepth = layerMap ? Math.max(0, ...Array.from(layerMap.values())) : 0;

  let totalClonedSymbols = 0;

  const cloneGroups = groups.map((g) => {
    const symbols = db
      .prepare(
        `
        SELECT name, file_path, line, kind
        FROM symbols
        WHERE body_hash = ?
      `,
      )
      .all(g.body_hash) as Array<{
      name: string;
      file_path: string;
      line: number;
      kind: string;
    }>;

    totalClonedSymbols += symbols.length;

    const mappedSymbols = symbols.map((s) => ({
      name: s.name,
      filePath: s.file_path,
      line: s.line,
      kind: s.kind,
    }));

    const layerAnalysis: CloneLayerAnalysis | undefined = layerMap
      ? annotateCloneGroup(mappedSymbols, layerMap, maxDepth)
      : undefined;

    return {
      bodyHash: g.body_hash,
      bodyLines: g.body_lines,
      symbols: mappedSymbols,
      layerAnalysis,
    };
  });

  return {
    cloneGroups,
    totalCloneGroups: cloneGroups.length,
    totalClonedSymbols,
  };
}

// =============================================================================
// Structural Clones (Type 2)
// =============================================================================

export interface StructuralClonesOptions {
  /** Annotate each clone group with layer context (5.9). Default: false. */
  layerAnalysis?: boolean;
}

/**
 * Detect structural code clones (same control flow, different identifiers).
 */
export function structuralClones(
  dbPath: string,
  opts: StructuralClonesOptions = {},
): StructuralClonesResult {
  const db = openIndex(dbPath);
  try {
    return structuralClonesFromDb(db, opts);
  } finally {
    db.close();
  }
}

/**
 * Core structural clone detection logic against an open database.
 * Excludes groups that are already exact clones (same body_hash).
 */
export function structuralClonesFromDb(
  db: Database.Database,
  opts: StructuralClonesOptions = {},
): StructuralClonesResult {
  // Find structure hashes shared by more than one symbol,
  // but ONLY where body_hash differs (otherwise it's an exact clone, not structural)
  const groups = db
    .prepare(
      `
      SELECT structure_hash, MAX(body_lines) AS body_lines, COUNT(*) AS cnt,
             COUNT(DISTINCT body_hash) AS distinct_bodies
      FROM symbols
      WHERE structure_hash IS NOT NULL
      GROUP BY structure_hash
      HAVING COUNT(*) > 1 AND COUNT(DISTINCT body_hash) > 1
      ORDER BY body_lines DESC, cnt DESC
    `,
    )
    .all() as Array<{
    structure_hash: string;
    body_lines: number;
    cnt: number;
    distinct_bodies: number;
  }>;

  const layerMap = opts.layerAnalysis ? buildFileLayerMap(db) : null;
  const maxDepth = layerMap ? Math.max(0, ...Array.from(layerMap.values())) : 0;

  let totalClonedSymbols = 0;

  const cloneGroups = groups.map((g) => {
    const symbols = db
      .prepare(
        `
        SELECT name, file_path, line, kind
        FROM symbols
        WHERE structure_hash = ?
      `,
      )
      .all(g.structure_hash) as Array<{
      name: string;
      file_path: string;
      line: number;
      kind: string;
    }>;

    totalClonedSymbols += symbols.length;

    const mappedSymbols = symbols.map((s) => ({
      name: s.name,
      filePath: s.file_path,
      line: s.line,
      kind: s.kind,
    }));

    const layerAnalysis: CloneLayerAnalysis | undefined = layerMap
      ? annotateCloneGroup(mappedSymbols, layerMap, maxDepth)
      : undefined;

    return {
      structureHash: g.structure_hash,
      bodyLines: g.body_lines,
      symbols: mappedSymbols,
      layerAnalysis,
    };
  });

  return {
    cloneGroups,
    totalCloneGroups: cloneGroups.length,
    totalClonedSymbols,
  };
}

// ── Layer annotation logic ────────────────────────────────────────────────────

function annotateCloneGroup(
  symbols: Array<{
    name: string;
    filePath: string;
    line: number;
    kind: string;
  }>,
  layerMap: Map<string, number>,
  maxDepth: number,
): CloneLayerAnalysis {
  if (layerMap.size === 0) {
    return {
      kind: "unknown",
      layers: [],
      uniqueLayers: [],
      suggestion: "No layer data available.",
    };
  }

  const layers = symbols.map((s) => {
    const depth = layerMap.get(s.filePath);
    return depth !== undefined ? depthToLayer(depth, maxDepth) : -1;
  });

  const knownLayers = layers.filter((l) => l >= 0);
  const uniqueLayers = [...new Set(knownLayers)].sort((a, b) => a - b);

  if (uniqueLayers.length === 0) {
    return {
      kind: "unknown",
      layers,
      uniqueLayers,
      suggestion: "Files not in import graph.",
    };
  }

  if (uniqueLayers.length === 1) {
    return {
      kind: "dry",
      layers,
      uniqueLayers,
      suggestion: `All copies in Layer ${uniqueLayers[0]}. Extract to a shared utility in the same layer.`,
    };
  }

  // Find the lowest layer (canonical home) and higher-layer copies
  const minLayer = uniqueLayers[0];
  const canonicalFile = symbols[layers.indexOf(minLayer)]?.filePath ?? "?";
  return {
    kind: "architectural",
    layers,
    uniqueLayers,
    suggestion:
      `Copies span layers ${uniqueLayers.join(", ")}. ` +
      `The canonical implementation should live at Layer ${minLayer} (${canonicalFile}). ` +
      `Higher-layer copies are unauthorized reimplementations.`,
  };
}
