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
import type {
  LayersInferResult,
  InferredLayer,
  InferredSubLayer,
  LayersInferOptions,
} from "../types.js";
import { openIndex, buildImportGraph } from "./shared.js";

/**
 * Infer architectural layers from a database file path.
 */
export function layersInfer(
  dbPath: string,
  options?: LayersInferOptions,
): LayersInferResult {
  const db = openIndex(dbPath);
  try {
    return layersInferFromDb(db, options);
  } finally {
    db.close();
  }
}

/**
 * Core layer inference logic against an open database.
 *
 * Supports three modes via options:
 * - **Flat** (default): single-level depth bucketing across all files
 * - **Scoped** (`scope`): flat inference restricted to one package
 * - **Hierarchical** (`hierarchical`): macro layers at package boundary,
 *   sub-layers within large packages
 */
export function layersInferFromDb(
  db: Database.Database,
  options?: LayersInferOptions,
): LayersInferResult {
  const { forward, reverse, allFiles } = buildImportGraph(db);

  if (allFiles.size === 0) {
    return {
      layers: [],
      totalFiles: 0,
      isolatedFiles: [],
      yaml: "# No import graph data — run `iw index build` first\nlayers: []\n",
    };
  }

  // ── Scoped mode: filter graph to one package ────────────────────
  if (options?.scope) {
    return scopedInfer(db, forward, allFiles, options.scope);
  }

  // ── Hierarchical mode: macro layers + sub-layers ────────────────
  if (options?.hierarchical) {
    return hierarchicalInfer(
      db,
      forward,
      allFiles,
      options.minFilesForSubLayers ?? 10,
    );
  }

  // ── Flat mode (original algorithm) ──────────────────────────────
  return flatInfer(db, forward, allFiles);
}

// ─── Flat inference (original algorithm) ───────────────────────────────────

function flatInfer(
  db: Database.Database,
  forward: Map<string, Set<string>>,
  allFiles: Set<string>,
): LayersInferResult {
  const knownFiles = new Set(
    (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  );

  const depth = computeDepthFromSinks(allFiles, forward);

  const isolatedFiles: string[] = [];
  for (const f of knownFiles) {
    if (!allFiles.has(f)) {
      isolatedFiles.push(f);
    }
  }
  isolatedFiles.sort();

  const layers = bucketIntoLayers(depth, allFiles);
  const yaml = generateYaml(layers);

  return {
    layers,
    totalFiles: allFiles.size,
    isolatedFiles,
    yaml,
  };
}

// ─── Scoped inference (filter to one package) ──────────────────────────────

function scopedInfer(
  db: Database.Database,
  forward: Map<string, Set<string>>,
  allFiles: Set<string>,
  scope: string,
): LayersInferResult {
  // Normalise scope (strip trailing slash)
  const prefix = scope.endsWith("/") ? scope : scope + "/";

  // Filter to files within the scope
  const scopedFiles = new Set<string>();
  for (const f of allFiles) {
    if (f.startsWith(prefix)) scopedFiles.add(f);
  }

  if (scopedFiles.size === 0) {
    return {
      layers: [],
      totalFiles: 0,
      isolatedFiles: [],
      yaml: `# No files found in scope "${scope}"\nlayers: []\n`,
    };
  }

  // Build scoped forward graph (only edges within scope)
  const scopedForward = new Map<string, Set<string>>();
  for (const [src, targets] of forward) {
    if (!scopedFiles.has(src)) continue;
    const filtered = new Set<string>();
    for (const t of targets) {
      if (scopedFiles.has(t)) filtered.add(t);
    }
    if (filtered.size > 0) scopedForward.set(src, filtered);
  }

  const depth = computeDepthFromSinks(scopedFiles, scopedForward);

  // Identify isolated files within scope
  const knownFiles = new Set(
    (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  );
  const isolatedFiles: string[] = [];
  for (const f of knownFiles) {
    if (f.startsWith(prefix) && !scopedFiles.has(f)) {
      isolatedFiles.push(f);
    }
  }
  isolatedFiles.sort();

  const layers = bucketIntoLayers(depth, scopedFiles);
  const yaml = generateYaml(layers);

  return {
    layers,
    totalFiles: scopedFiles.size,
    isolatedFiles,
    yaml,
  };
}

// ─── Hierarchical inference (macro layers + sub-layers) ────────────────────

/**
 * Extract the package directory from a file path.
 * Recognises: packages/<name>/..., apps/<name>/..., libs/<name>/..., modules/<name>/...
 * Returns null for files not inside a known package directory.
 */
function extractPackage(filePath: string): string | null {
  const match = filePath.match(/^(packages|apps|libs|modules)\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Resolve a non-relative module specifier (e.g. "@intentweave/core") to a known
 * package directory (e.g. "packages/core"). Tries multiple directory prefixes
 * (packages/, apps/, libs/, modules/) and matches against known packages.
 */
function resolveNonRelativePackage(
  specifier: string,
  knownPackages: Set<string>,
): string | null {
  // Handle scoped packages: @scope/name → name, @scope/name/sub → name
  const scopedMatch = specifier.match(/^@[^/]+\/([^/]+)/);
  const bareName = scopedMatch ? scopedMatch[1] : specifier.split("/")[0];

  // Try each directory prefix
  for (const prefix of ["packages", "apps", "libs", "modules"]) {
    const candidate = `${prefix}/${bareName}`;
    if (knownPackages.has(candidate)) return candidate;
  }

  return null;
}

function hierarchicalInfer(
  db: Database.Database,
  forward: Map<string, Set<string>>,
  allFiles: Set<string>,
  minFilesForSubLayers: number,
): LayersInferResult {
  // 1. Group files by package
  const packageFiles = new Map<string, Set<string>>(); // package → files
  const rootFiles = new Set<string>(); // files not in any package
  for (const f of allFiles) {
    const pkg = extractPackage(f);
    if (pkg) {
      if (!packageFiles.has(pkg)) packageFiles.set(pkg, new Set());
      packageFiles.get(pkg)!.add(f);
    } else {
      rootFiles.add(f);
    }
  }

  // If no package structure detected, fall back to flat inference
  if (packageFiles.size <= 1 && rootFiles.size === 0) {
    return flatInfer(db, forward, allFiles);
  }

  // 2. Build package-level (supernode) import graph
  //    Edge between packages A→B if any file in A imports any file in B
  const allPackages = new Set(packageFiles.keys());
  // Include root as a pseudo-package if it has files
  if (rootFiles.size > 0) allPackages.add("__root__");

  const pkgForward = new Map<string, Set<string>>();

  // 2a. Cross-package edges from relative imports (already in the forward graph)
  for (const [src, targets] of forward) {
    const srcPkg =
      extractPackage(src) ?? (rootFiles.has(src) ? "__root__" : null);
    if (!srcPkg) continue;
    for (const tgt of targets) {
      const tgtPkg =
        extractPackage(tgt) ?? (rootFiles.has(tgt) ? "__root__" : null);
      if (!tgtPkg || tgtPkg === srcPkg) continue;
      if (!pkgForward.has(srcPkg)) pkgForward.set(srcPkg, new Set());
      pkgForward.get(srcPkg)!.add(tgtPkg);
    }
  }

  // 2b. Cross-package edges from non-relative imports (e.g., @intentweave/core → packages/core)
  //     These are absent from the forward graph because buildImportGraph only resolves relative imports.
  const nonRelEdges = db
    .prepare(
      `SELECT DISTINCT source_file, module_specifier
       FROM imports WHERE is_relative = 0`,
    )
    .all() as Array<{ source_file: string; module_specifier: string }>;

  for (const { source_file, module_specifier } of nonRelEdges) {
    const srcPkg =
      extractPackage(source_file) ??
      (rootFiles.has(source_file) ? "__root__" : null);
    if (!srcPkg) continue;

    // Map scoped packages: @scope/name → packages/name (or apps/name)
    const tgtPkg = resolveNonRelativePackage(module_specifier, allPackages);
    if (!tgtPkg || tgtPkg === srcPkg) continue;

    if (!pkgForward.has(srcPkg)) pkgForward.set(srcPkg, new Set());
    pkgForward.get(srcPkg)!.add(tgtPkg);
  }

  // 3. Compute macro layer depth from package graph
  const pkgDepth = computeDepthFromSinks(allPackages, pkgForward);

  // 4. Bucket packages into macro layers
  //    Use depth as primary signal, but when packages outnumber depth levels,
  //    split same-depth tiers by dependency fan-out to increase granularity.
  const maxPkgDepth = Math.max(...pkgDepth.values(), 0);
  const depthBasedCount = maxPkgDepth + 1;
  // Allow up to one layer per package, capped at 7
  const macroLayerCount = Math.min(
    Math.max(depthBasedCount, Math.min(allPackages.size, 4)),
    7,
  );

  // If macroLayerCount > depthBasedCount, we need to split same-depth tiers.
  // Group packages by depth first.
  const depthGroups = new Map<number, string[]>();
  for (const [pkg, d] of pkgDepth) {
    if (!depthGroups.has(d)) depthGroups.set(d, []);
    depthGroups.get(d)!.push(pkg);
  }
  const sortedDepths = [...depthGroups.keys()].sort((a, b) => a - b);

  // Split large depth groups by fan-out (number of outgoing imports)
  const macroBuckets = new Map<number, string[]>();
  let bucketIdx = 0;

  for (const d of sortedDepths) {
    const pkgsAtDepth = depthGroups.get(d)!;

    // How many layers should this depth group get?
    const remainingLayers = macroLayerCount - bucketIdx;
    const remainingDepths = sortedDepths.length - sortedDepths.indexOf(d);
    const layersForThisDepth = Math.max(
      1,
      Math.round(remainingLayers / remainingDepths),
    );

    if (layersForThisDepth <= 1 || pkgsAtDepth.length <= 1) {
      // Single layer for this depth
      macroBuckets.set(bucketIdx, pkgsAtDepth);
      bucketIdx++;
    } else {
      // Split by fan-out (dependency count)
      const withFanOut = pkgsAtDepth.map((pkg) => ({
        pkg,
        fanOut: pkgForward.get(pkg)?.size ?? 0,
      }));
      withFanOut.sort((a, b) => a.fanOut - b.fanOut);

      // Divide into sub-buckets
      const perBucket = Math.ceil(withFanOut.length / layersForThisDepth);
      for (let i = 0; i < layersForThisDepth && i * perBucket < withFanOut.length; i++) {
        const slice = withFanOut.slice(i * perBucket, (i + 1) * perBucket);
        if (slice.length > 0) {
          macroBuckets.set(bucketIdx, slice.map((s) => s.pkg));
          bucketIdx++;
        }
      }
    }
  }

  // Adjust macroLayerCount to actual bucket count
  const actualLayerCount = bucketIdx;

  // 5. Build macro layers with sub-layers
  const knownFiles = new Set(
    (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  );

  const isolatedFiles: string[] = [];
  for (const f of knownFiles) {
    if (!allFiles.has(f)) isolatedFiles.push(f);
  }
  isolatedFiles.sort();

  const layers: InferredLayer[] = [];

  for (let i = 0; i < actualLayerCount; i++) {
    const packages = macroBuckets.get(i);
    if (!packages || packages.length === 0) continue;

    packages.sort();

    // Collect all files in this macro layer
    const layerFiles: string[] = [];
    for (const pkg of packages) {
      const files =
        pkg === "__root__" ? rootFiles : (packageFiles.get(pkg) ?? new Set());
      for (const f of files) layerFiles.push(f);
    }
    layerFiles.sort();

    if (layerFiles.length === 0) continue;

    // Compute depth range from per-file depths (across all packages in this layer)
    const fileDepths = layerFiles.map((f) => {
      // Use the package depth for the macro range
      const pkg = extractPackage(f) ?? (rootFiles.has(f) ? "__root__" : null);
      return pkgDepth.get(pkg ?? "") ?? 0;
    });
    const depthRange: [number, number] = [
      Math.min(...fileDepths),
      Math.max(...fileDepths),
    ];

    const label = generateLayerLabel(layerFiles, i, actualLayerCount);

    // 6. Compute sub-layers for qualifying packages
    const subLayers: InferredSubLayer[] = [];
    for (const pkg of packages) {
      if (pkg === "__root__") continue;
      const pkgFileSet = packageFiles.get(pkg);
      if (!pkgFileSet || pkgFileSet.size < minFilesForSubLayers) continue;

      // Build internal subgraph (only edges within this package)
      const internalForward = new Map<string, Set<string>>();
      for (const [src, targets] of forward) {
        if (!pkgFileSet.has(src)) continue;
        const filtered = new Set<string>();
        for (const t of targets) {
          if (pkgFileSet.has(t)) filtered.add(t);
        }
        if (filtered.size > 0) internalForward.set(src, filtered);
      }

      const internalDepth = computeDepthFromSinks(pkgFileSet, internalForward);
      const internalLayers = bucketIntoLayers(internalDepth, pkgFileSet);

      for (const sub of internalLayers) {
        subLayers.push({
          index: sub.index,
          label: sub.label,
          files: sub.files,
          depthRange: sub.depthRange,
          package: pkg,
        });
      }
    }

    const displayPackages = packages.filter((p) => p !== "__root__");

    layers.push({
      index: i,
      label,
      files: layerFiles,
      depthRange,
      ...(displayPackages.length > 0 ? { packages: displayPackages } : {}),
      ...(subLayers.length > 0 ? { subLayers } : {}),
    });
  }

  const yaml = generateHierarchicalYaml(layers);

  return {
    layers,
    totalFiles: allFiles.size,
    isolatedFiles,
    yaml,
  };
}

// ─── Shared bucketing helper ───────────────────────────────────────────────

/**
 * Bucket files into layers by their computed depth.
 * Used by both flat and scoped inference, and for sub-layers within packages.
 */
function bucketIntoLayers(
  depth: Map<string, number>,
  allFiles: Set<string>,
): InferredLayer[] {
  const maxDepth = Math.max(...depth.values(), 0);
  const layerCount = Math.min(Math.max(Math.ceil((maxDepth + 1) / 2), 2), 7);
  const bucketSize = (maxDepth + 1) / layerCount;

  const layerBuckets = new Map<number, string[]>();
  for (let i = 0; i < layerCount; i++) layerBuckets.set(i, []);

  for (const [file, d] of depth) {
    const bucket = Math.min(Math.floor(d / bucketSize), layerCount - 1);
    layerBuckets.get(bucket)!.push(file);
  }

  const layers: InferredLayer[] = [];
  for (let i = 0; i < layerCount; i++) {
    const files = layerBuckets.get(i)!;
    if (files.length === 0) continue;
    files.sort();

    const depths = files.map((f) => depth.get(f)!);
    const depthRange: [number, number] = [
      Math.min(...depths),
      Math.max(...depths),
    ];

    const label = generateLayerLabel(files, i, layerCount);
    layers.push({ index: i, label, files, depthRange });
  }

  return layers;
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

/**
 * Generate YAML config from hierarchical layers (with sub-layers).
 */
function generateHierarchicalYaml(layers: InferredLayer[]): string {
  const lines: string[] = [
    "# Auto-inferred hierarchical layer architecture",
    "# Macro layers at package boundary, sub-layers within large packages.",
    "# Lower layers (index 0) are foundation; higher layers are entrypoints/UI.",
    "#",
    "# Run `iw index layers-check` to validate imports against this config.",
    "",
    "layers:",
  ];

  for (const layer of layers) {
    lines.push(`  - name: "${layer.label}"`);
    const pkgs = layer.packages?.join(", ") ?? "";
    lines.push(
      `    # packages: ${pkgs || "mixed"}, ${layer.files.length} files`,
    );
    lines.push(`    patterns:`);

    // Use package-level globs
    if (layer.packages && layer.packages.length > 0) {
      for (const pkg of layer.packages) {
        lines.push(`      - "${pkg}/**"`);
      }
    } else {
      // Root files — list individually or use short patterns
      const sample = layer.files.slice(0, 10);
      for (const f of sample) {
        lines.push(`      - "${f}"`);
      }
      if (layer.files.length > 10) {
        lines.push(
          `      # ${layer.files.length - 10} additional files — consider grouping`,
        );
      }
    }

    // Output sub-layers as comments for reference
    if (layer.subLayers && layer.subLayers.length > 0) {
      // Group sub-layers by package
      const byPkg = new Map<string, InferredSubLayer[]>();
      for (const sub of layer.subLayers) {
        if (!byPkg.has(sub.package)) byPkg.set(sub.package, []);
        byPkg.get(sub.package)!.push(sub);
      }

      for (const [pkg, subs] of byPkg) {
        lines.push(`    # sub-layers in ${pkg}:`);
        for (const sub of subs) {
          lines.push(
            `    #   ${sub.index}: ${sub.label} (${sub.files.length} files, depth ${sub.depthRange[0]}–${sub.depthRange[1]})`,
          );
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}
