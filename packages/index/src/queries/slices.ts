// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 5.7 Vertical Slice Detection
 *
 * Cross-references communities (9.1) with layers (5.1a) to identify vertical
 * slices — communities whose members span ≥3 layers, indicating end-to-end
 * feature cohorts that cut through the architecture horizontally.
 *
 * Communities spanning only 1–2 layers are classified as horizontal modules.
 */

import type Database from "better-sqlite3";
import type { SlicesOptions, SlicesResult, VerticalSlice } from "../types.js";
import { openIndex } from "./shared.js";
import { communitiesFromDb } from "./communities.js";
import { layersInferFromDb } from "./layersInfer.js";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Detect vertical slices by cross-referencing communities with layers.
 * @param dbPath Path to the CARI index database.
 */
export function slices(dbPath: string, options?: SlicesOptions): SlicesResult {
  const db = openIndex(dbPath);
  try {
    return slicesFromDb(db, options);
  } finally {
    db.close();
  }
}

/**
 * Detect vertical slices from an already-open database handle.
 */
export function slicesFromDb(
  db: Database.Database,
  options?: SlicesOptions,
): SlicesResult {
  const minLayers = options?.minLayers ?? 3;

  // 1. Get communities and layers
  const comms = communitiesFromDb(db);
  const layers = layersInferFromDb(db);

  if (comms.communities.length === 0 || layers.layers.length === 0) {
    return {
      slices: [],
      horizontal: [],
      totalLayers: layers.layers.length,
      totalCommunities: comms.communities.length,
    };
  }

  // 2. Build file → layer lookup
  const fileToLayer = new Map<string, number>();
  for (const layer of layers.layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.index);
    }
  }

  // 3. For each community, determine which layers its members span
  const allSlices: VerticalSlice[] = [];

  for (const comm of comms.communities) {
    const filesByLayer: Record<number, string[]> = {};
    let totalFiles = 0;

    for (const member of comm.members) {
      // Match member to file — community members can be symbols or files
      const filePath = member.filePath ?? member.name;
      const layerIdx = fileToLayer.get(filePath);
      if (layerIdx === undefined) continue;

      if (!filesByLayer[layerIdx]) filesByLayer[layerIdx] = [];
      // Avoid duplicate file entries within the same layer
      if (!filesByLayer[layerIdx].includes(filePath)) {
        filesByLayer[layerIdx].push(filePath);
        totalFiles++;
      }
    }

    const layerIndices = Object.keys(filesByLayer)
      .map(Number)
      .sort((a, b) => a - b);
    const layerSpan = layerIndices.length;

    if (layerSpan === 0) continue;

    allSlices.push({
      communityId: comm.id,
      label: comm.label,
      layerSpan,
      layers: layerIndices,
      filesByLayer,
      totalFiles,
      orientation: layerSpan >= minLayers ? "vertical" : "horizontal",
    });
  }

  // 4. Split into vertical slices and horizontal modules
  const vertical = allSlices
    .filter((s) => s.orientation === "vertical")
    .sort((a, b) => b.layerSpan - a.layerSpan || b.totalFiles - a.totalFiles);

  const horizontal = allSlices
    .filter((s) => s.orientation === "horizontal")
    .sort((a, b) => b.totalFiles - a.totalFiles);

  // 5. Apply limit if requested
  const limited = options?.limit ? vertical.slice(0, options.limit) : vertical;

  return {
    slices: limited,
    horizontal,
    totalLayers: layers.layers.length,
    totalCommunities: comms.communities.length,
  };
}
