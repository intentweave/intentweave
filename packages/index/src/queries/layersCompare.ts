// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: layersCompare (5.6)
 *
 * As-Is vs. As-Should layer comparison.
 * Runs layer inference to get actual (as-is) assignments, then
 * compares against a committed LayerConfig (as-should).
 * Outputs per-file delta with OK / DRIFT / UNASSIGNED status.
 *
 * $0 / no LLM — pure graph analysis on SQLite data.
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  LayerConfig,
  LayersCompareResult,
  LayersCompareEntry,
} from "../types.js";
import { openIndex } from "./shared.js";
import { layersInferFromDb } from "./layersInfer.js";
import { minimatch } from "minimatch";

/**
 * Compare inferred vs. configured layers from a database file path.
 */
export function layersCompare(
  dbPath: string,
  config: LayerConfig,
): LayersCompareResult {
  const db = openIndex(dbPath);
  try {
    return layersCompareFromDb(db, config);
  } finally {
    db.close();
  }
}

/**
 * Core comparison logic against an open database.
 */
export function layersCompareFromDb(
  db: Database.Database,
  config: LayerConfig,
): LayersCompareResult {
  // 1. Run inference to get as-is layer assignments
  const inferred = layersInferFromDb(db);

  // Build file → inferred layer name map
  const inferredMap = new Map<string, string>();
  for (const layer of inferred.layers) {
    for (const file of layer.files) {
      inferredMap.set(file, layer.label);
    }
  }

  // 2. Build file → configured layer name map using glob patterns
  const configuredMap = new Map<string, string>();
  const allKnownFiles = (
    db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>
  ).map((r) => r.path);

  for (const filePath of allKnownFiles) {
    for (const layer of config.layers) {
      for (const pattern of layer.patterns) {
        if (minimatch(filePath, pattern, { dot: true })) {
          configuredMap.set(filePath, layer.name);
          break;
        }
      }
      if (configuredMap.has(filePath)) break;
    }
  }

  // 3. Collect all files from both sides
  const allFiles = new Set([...inferredMap.keys(), ...configuredMap.keys()]);

  // 4. Build per-file comparison entries
  const entries: LayersCompareEntry[] = [];
  let matchCount = 0;
  let driftCount = 0;
  let unassignedCount = 0;

  for (const file of allFiles) {
    const inferredLayer = inferredMap.get(file) ?? null;
    const configuredLayer = configuredMap.get(file) ?? null;

    let status: LayersCompareEntry["status"];

    if (inferredLayer === null || configuredLayer === null) {
      status = "unassigned";
      unassignedCount++;
    } else if (inferredLayer.toLowerCase() === configuredLayer.toLowerCase()) {
      status = "ok";
      matchCount++;
    } else {
      status = "drift";
      driftCount++;
    }

    entries.push({ file, inferredLayer, configuredLayer, status });
  }

  // Sort: drift first, then unassigned, then ok; within same status by file path
  const statusOrder = { drift: 0, unassigned: 1, ok: 2 };
  entries.sort((a, b) => {
    const so = statusOrder[a.status] - statusOrder[b.status];
    if (so !== 0) return so;
    return a.file.localeCompare(b.file);
  });

  return {
    entries,
    matchCount,
    driftCount,
    unassignedCount,
    totalFiles: allFiles.size,
  };
}
