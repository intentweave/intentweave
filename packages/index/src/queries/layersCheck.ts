// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: layersCheck (5.1b)
 *
 * Validate all imports against a committed `.iw/layers.yaml` config.
 * Detects reverse imports (lower layer importing from higher layer) and
 * skip-layer imports (layer N importing from layer N+2, skipping N+1).
 *
 * $0 / no LLM — pure graph validation on SQLite data.
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  LayerConfig,
  LayersCheckResult,
  LayerViolation,
} from "../types.js";
import {
  openIndex,
  buildImportGraph,
  resolveModuleSpecifier,
} from "./shared.js";
import { minimatch } from "minimatch";

/**
 * Check layer violations from a database file path + config.
 */
export function layersCheck(
  dbPath: string,
  config: LayerConfig,
): LayersCheckResult {
  const db = openIndex(dbPath);
  try {
    return layersCheckFromDb(db, config);
  } finally {
    db.close();
  }
}

/**
 * Core layer check logic against an open database.
 */
export function layersCheckFromDb(
  db: Database.Database,
  config: LayerConfig,
): LayersCheckResult {
  // Validate config
  if (!config.layers || config.layers.length === 0) {
    return {
      violations: [],
      totalViolations: 0,
      byType: { reverse: 0, skipLayer: 0 },
      layerSummary: [],
    };
  }

  // Build file → layer assignment using glob patterns
  const fileToLayer = new Map<string, { name: string; index: number }>();

  // Collect all known files from the DB
  const allKnownFiles = (
    db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>
  ).map((r) => r.path);

  for (const filePath of allKnownFiles) {
    for (let i = 0; i < config.layers.length; i++) {
      const layer = config.layers[i];
      for (const pattern of layer.patterns) {
        if (minimatch(filePath, pattern, { dot: true })) {
          fileToLayer.set(filePath, { name: layer.name, index: i });
          break;
        }
      }
      if (fileToLayer.has(filePath)) break;
    }
  }

  // Build the import graph
  const { forward } = buildImportGraph(db);

  // Check each import edge for layer violations
  const violations: LayerViolation[] = [];

  for (const [source, targets] of forward) {
    const sourceLayer = fileToLayer.get(source);
    if (!sourceLayer) continue; // file not assigned to any layer

    for (const target of targets) {
      const targetLayer = fileToLayer.get(target);
      if (!targetLayer) continue; // target not assigned to any layer

      // Same layer — always OK
      if (sourceLayer.index === targetLayer.index) continue;

      // Higher layer importing from lower layer — allowed
      if (sourceLayer.index > targetLayer.index) {
        // Check for skip-layer violation
        if (
          !config.allowSkipLayer &&
          sourceLayer.index - targetLayer.index > 1
        ) {
          violations.push({
            sourceFile: source,
            sourceLayer: sourceLayer.name,
            sourceLayerIndex: sourceLayer.index,
            targetFile: target,
            targetLayer: targetLayer.name,
            targetLayerIndex: targetLayer.index,
            type: "skip-layer",
            reason: `${source} (${sourceLayer.name}, layer ${sourceLayer.index}) imports ${target} (${targetLayer.name}, layer ${targetLayer.index}) — skips ${sourceLayer.index - targetLayer.index - 1} layer(s)`,
          });
        }
        continue;
      }

      // Lower layer importing from higher layer — REVERSE VIOLATION
      violations.push({
        sourceFile: source,
        sourceLayer: sourceLayer.name,
        sourceLayerIndex: sourceLayer.index,
        targetFile: target,
        targetLayer: targetLayer.name,
        targetLayerIndex: targetLayer.index,
        type: "reverse",
        reason: `${source} (${sourceLayer.name}, layer ${sourceLayer.index}) imports from higher layer: ${target} (${targetLayer.name}, layer ${targetLayer.index})`,
      });
    }
  }

  // Sort: reverse violations first, then skip-layer; within same type by source file
  violations.sort((a, b) => {
    if (a.type !== b.type) return a.type === "reverse" ? -1 : 1;
    return a.sourceFile.localeCompare(b.sourceFile);
  });

  // Count by type
  const reverse = violations.filter((v) => v.type === "reverse").length;
  const skipLayer = violations.filter((v) => v.type === "skip-layer").length;

  // Build layer summary
  const layerSummary = config.layers.map((layer, index) => {
    const files = [...fileToLayer.entries()].filter(
      ([, l]) => l.index === index,
    );
    return { name: layer.name, index, fileCount: files.length };
  });

  // Aggregate layer-to-layer import flows for Sankey visualization
  const flowMap = new Map<
    string,
    {
      fromLayer: string;
      toLayer: string;
      fromLayerIndex: number;
      toLayerIndex: number;
      importCount: number;
      violationCount: number;
    }
  >();
  for (const [source, targets] of forward) {
    const sourceLayer = fileToLayer.get(source);
    if (!sourceLayer) continue;
    for (const target of targets) {
      const targetLayer = fileToLayer.get(target);
      if (!targetLayer || sourceLayer.index === targetLayer.index) continue;
      const key = `${sourceLayer.name}\u2192${targetLayer.name}`;
      const existing = flowMap.get(key);
      if (existing) {
        existing.importCount++;
      } else {
        flowMap.set(key, {
          fromLayer: sourceLayer.name,
          toLayer: targetLayer.name,
          fromLayerIndex: sourceLayer.index,
          toLayerIndex: targetLayer.index,
          importCount: 1,
          violationCount: 0,
        });
      }
    }
  }
  // Tally violation counts per layer pair
  for (const v of violations) {
    const key = `${v.sourceLayer}\u2192${v.targetLayer}`;
    const flow = flowMap.get(key);
    if (flow) flow.violationCount++;
  }
  const layerFlows = [...flowMap.values()]
    .map((f) => ({ ...f, isViolation: f.violationCount > 0 }))
    .sort((a, b) => b.importCount - a.importCount);

  return {
    violations,
    totalViolations: violations.length,
    byType: { reverse, skipLayer },
    layerSummary,
    layerFlows,
  };
}
