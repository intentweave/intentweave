// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: layersInfer (5.1a)
 *
 * Auto-infer architectural layers from the import graph.
 * Uses topological depth ranking to cluster files into tiers,
 * then labels each tier from the most common directory prefix.
 *
 * $0 / no LLM — pure graph algorithm on SQLite data.
 */

import type Database from "better-sqlite3";
import type { LayersInferResult, InferredLayer } from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";

/**
 * Infer architectural layers from a database file path.
 */
export function layersInfer(dbPath: string): LayersInferResult {
  const db = openIndex(dbPath);
  try {
    return layersInferFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core layer inference logic against an open database.
 */
export function layersInferFromDb(db: Database.Database): LayersInferResult {
  const { forward, reverse, allFiles } = buildImportGraph(db);

  if (allFiles.size === 0) {
    return {
      layers: [],
      totalFiles: 0,
      isolatedFiles: [],
      yaml: "# No import graph data — run `iw index build` first\nlayers: []\n",
    };
  }

  // Find all files known to the DB (including ones not in import graph)
  const knownFiles = new Set(
    (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  );

  // 1. Compute topological depth via reverse BFS from leaf nodes
  //    Leaf nodes = files with no outgoing imports (forward edges)
  //    Depth 0 = leaf/foundation files that nothing depends on (fan-out = 0)
  //    Actually, we want foundation = files imported by many but importing few.
  //    Better approach: depth = longest path from any root to this file,
  //    where root = file with no incoming imports (entry points).
  //    But this gives depth 0 = entry points, which is the opposite of what we want.
  //
  //    Use REVERSE depth: depth = longest path in REVERSE graph from sinks.
  //    Sinks = files with no outgoing imports (they import nothing).
  //    Depth 0 = sinks (foundation), higher depth = entrypoints/UI.

  const depth = computeDepthFromSinks(allFiles, forward);

  // Identify isolated files (in knownFiles but not in import graph)
  const isolatedFiles: string[] = [];
  for (const f of knownFiles) {
    if (!allFiles.has(f)) {
      isolatedFiles.push(f);
    }
  }
  isolatedFiles.sort();

  // 2. Determine layer count and boundaries
  const maxDepth = Math.max(...depth.values(), 0);
  const layerCount = Math.min(Math.max(Math.ceil((maxDepth + 1) / 2), 2), 7);
  const bucketSize = (maxDepth + 1) / layerCount;

  // 3. Bucket files into layers by depth
  const layerBuckets = new Map<number, string[]>();
  for (let i = 0; i < layerCount; i++) {
    layerBuckets.set(i, []);
  }

  for (const [file, d] of depth) {
    const bucket = Math.min(Math.floor(d / bucketSize), layerCount - 1);
    layerBuckets.get(bucket)!.push(file);
  }

  // 4. Build InferredLayer objects with auto-generated labels
  const layers: InferredLayer[] = [];

  for (let i = 0; i < layerCount; i++) {
    const files = layerBuckets.get(i)!;
    if (files.length === 0) continue;

    files.sort();

    // Compute actual depth range for this bucket
    const depths = files.map((f) => depth.get(f)!);
    const depthRange: [number, number] = [
      Math.min(...depths),
      Math.max(...depths),
    ];

    // Generate label from most common directory prefix
    const label = generateLayerLabel(files, i, layerCount);

    layers.push({
      index: i,
      label,
      files,
      depthRange,
    });
  }

  // 5. Generate YAML
  const yaml = generateYaml(layers);

  return {
    layers,
    totalFiles: allFiles.size,
    isolatedFiles,
    yaml,
  };
}

/**
 * Compute depth of each file from sink nodes (files with no outgoing imports).
 * Sinks get depth 0 (foundation). Files importing only sinks get depth 1, etc.
 *
 * Handles import cycles by first detecting strongly connected components (SCCs)
 * via Tarjan's algorithm, collapsing each SCC into a single supernode, then
 * computing depth on the resulting DAG.
 */
function computeDepthFromSinks(
  allFiles: Set<string>,
  forward: Map<string, Set<string>>,
): Map<string, number> {
  // ── Tarjan's SCC detection ──────────────────────────────────────
  const fileList = Array.from(allFiles);
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccOf = new Map<string, number>(); // file → SCC id
  let idx = 0;
  let sccId = 0;

  function strongconnect(v: string): void {
    indexMap.set(v, idx);
    lowlink.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    const deps = forward.get(v);
    if (deps) {
      for (const w of deps) {
        if (!allFiles.has(w)) continue;
        if (!indexMap.has(w)) {
          strongconnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indexMap.get(w)!));
        }
      }
    }

    if (lowlink.get(v) === indexMap.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        sccOf.set(w, sccId);
      } while (w !== v);
      sccId++;
    }
  }

  // Use iterative Tarjan to avoid stack overflow on large graphs
  for (const v of fileList) {
    if (!indexMap.has(v)) strongconnect(v);
  }

  // ── Build DAG of SCCs ───────────────────────────────────────────
  const sccForward = new Map<number, Set<number>>();
  for (const [file, deps] of forward) {
    const src = sccOf.get(file);
    if (src == null) continue;
    for (const dep of deps) {
      const tgt = sccOf.get(dep);
      if (tgt == null || tgt === src) continue; // skip self-loops within SCC
      if (!sccForward.has(src)) sccForward.set(src, new Set());
      sccForward.get(src)!.add(tgt);
    }
  }

  // ── Compute depth on the SCC DAG ────────────────────────────────
  const sccDepth = new Map<number, number>();
  const allSccs = new Set<number>();
  for (const id of sccOf.values()) allSccs.add(id);

  // Iterative relaxation (now cycle-free, converges in O(V+E))
  for (const s of allSccs) sccDepth.set(s, 0);

  let changed = true;
  while (changed) {
    changed = false;
    for (const s of allSccs) {
      const deps = sccForward.get(s);
      if (!deps || deps.size === 0) continue;
      let maxDep = -1;
      for (const d of deps) {
        const dd = sccDepth.get(d) ?? 0;
        if (dd > maxDep) maxDep = dd;
      }
      const newD = maxDep + 1;
      if (newD > (sccDepth.get(s) ?? 0)) {
        sccDepth.set(s, newD);
        changed = true;
      }
    }
  }

  // ── Map SCC depth back to files ─────────────────────────────────
  const depth = new Map<string, number>();
  for (const file of allFiles) {
    const s = sccOf.get(file);
    depth.set(file, s != null ? (sccDepth.get(s) ?? 0) : 0);
  }

  return depth;
}

/**
 * Generate a human-readable label for a layer based on common directory prefixes.
 */
function generateLayerLabel(
  files: string[],
  layerIndex: number,
  totalLayers: number,
): string {
  // Count occurrences of each top-level directory
  const dirCounts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split("/");
    // Use up to 2 levels of directories for grouping
    const key =
      parts.length >= 3
        ? `${parts[0]}/${parts[1]}`
        : parts.length >= 2
          ? parts[0]
          : "root";
    dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
  }

  // Sort by count descending
  const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);

  // If one directory dominates (>50% of files), use its name
  if (sorted.length > 0 && sorted[0][1] > files.length * 0.5) {
    return sorted[0][0];
  }

  // If top 2–3 directories cover most files, join them
  if (sorted.length >= 2) {
    const top = sorted.slice(0, 2).map(([dir]) => dir);
    return top.join(" + ");
  }

  // Fallback: positional labels
  if (layerIndex === 0) return "foundation";
  if (layerIndex === totalLayers - 1) return "entrypoints";
  return `layer-${layerIndex}`;
}

/**
 * Generate YAML config from inferred layers.
 */
function generateYaml(layers: InferredLayer[]): string {
  const lines: string[] = [
    "# Auto-inferred layer architecture",
    "# Review and edit before committing as the 'as-should' definition.",
    "# Lower layers (index 0) are foundation; higher layers are entrypoints/UI.",
    "#",
    "# Run `iw index layers-check` to validate imports against this config.",
    "",
    "layers:",
  ];

  for (const layer of layers) {
    lines.push(`  - name: "${layer.label}"`);
    lines.push(
      `    # depth range: ${layer.depthRange[0]}–${layer.depthRange[1]}, ${layer.files.length} files`,
    );
    lines.push(`    patterns:`);

    // Generate glob patterns from common directory prefixes
    const prefixCounts = new Map<string, number>();
    for (const file of layer.files) {
      const parts = file.split("/");
      // Try progressively shorter prefixes
      if (parts.length >= 3) {
        const prefix = parts.slice(0, 2).join("/");
        prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      } else if (parts.length >= 2) {
        const prefix = parts[0];
        prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      } else {
        prefixCounts.set("root", (prefixCounts.get("root") ?? 0) + 1);
      }
    }

    // Use prefixes covering ≥ 2 files as patterns; list remaining individually
    const usedFiles = new Set<string>();
    const sortedPrefixes = [...prefixCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    );

    for (const [prefix, count] of sortedPrefixes) {
      if (count >= 2 && prefix !== "root") {
        lines.push(`      - "${prefix}/**"`);
        for (const f of layer.files) {
          if (f.startsWith(prefix + "/")) usedFiles.add(f);
        }
      }
    }

    // Add remaining files not covered by glob patterns
    const remaining = layer.files.filter((f) => !usedFiles.has(f));
    if (remaining.length > 0 && remaining.length <= 10) {
      for (const f of remaining) {
        lines.push(`      - "${f}"`);
      }
    } else if (remaining.length > 10) {
      // Too many individual files — add a comment
      lines.push(
        `      # ${remaining.length} additional files — consider grouping`,
      );
    }
  }

  return lines.join("\n") + "\n";
}
