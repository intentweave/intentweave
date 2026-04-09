// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: boundaryViolations (3.4)
 *
 * Detect when a file imports from another package's internal modules
 * (not the package's public API). In monorepos, packages typically expose
 * a public API via their index/barrel file — importing from internal paths
 * creates tight coupling and breaks encapsulation.
 *
 * Detection heuristic:
 * A cross-package import is a violation when:
 * 1. source and target are in different packages (e.g., packages/analyzer vs packages/cli)
 * 2. the target path goes deeper than the package root (e.g., packages/cli/src/internal.ts)
 * 3. the import doesn't go through the package's barrel/index (e.g., @pkg/cli)
 */

import type Database from "better-sqlite3";
import type { BoundaryViolationsResult, BoundaryViolation } from "../types.js";
import { openIndex, resolveModuleSpecifier } from "./shared.js";

/**
 * Detect package boundary violations in the import graph.
 */
export function boundaryViolations(dbPath: string): BoundaryViolationsResult {
  const db = openIndex(dbPath);
  try {
    return boundaryViolationsFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Extract the package name from a file path.
 * Recognises patterns like:
 * - `packages/<name>/...`
 * - `apps/<name>/...`
 * - `libs/<name>/...`
 * - `modules/<name>/...`
 *
 * Returns null if the file is not inside a known package directory.
 */
function extractPackage(filePath: string): string | null {
  const match = filePath.match(/^(packages|apps|libs|modules)\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Check if a target file is an internal module (not the public API).
 * The public API is typically the barrel file at the package root:
 * - `packages/<name>/src/index.ts`
 * - `packages/<name>/index.ts`
 *
 * Everything else is considered internal.
 */
function isInternalModule(targetFile: string, targetPackage: string): boolean {
  // Strip the package prefix to get the relative path within the package
  const relativeInPackage = targetFile.slice(targetPackage.length + 1);

  // Public API patterns: index.ts, src/index.ts
  const publicPatterns = [
    /^index\.[jt]sx?$/,
    /^src\/index\.[jt]sx?$/,
    /^dist\/index\.[jt]sx?$/,
  ];

  return !publicPatterns.some((p) => p.test(relativeInPackage));
}

/**
 * Core boundary violation detection logic against an open database.
 */
export function boundaryViolationsFromDb(
  db: Database.Database,
): BoundaryViolationsResult {
  // Get all relative imports (resolve target_file if NULL)
  const edges = db
    .prepare(
      `
      SELECT source_file, target_file, module_specifier
      FROM imports
      WHERE is_relative = 1
    `,
    )
    .all() as Array<{
    source_file: string;
    target_file: string | null;
    module_specifier: string;
  }>;

  // Build a set of known file paths for resolution
  const knownFiles = new Set(
    (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  );

  const violations: BoundaryViolation[] = [];

  for (const edge of edges) {
    const target =
      edge.target_file ||
      resolveModuleSpecifier(
        edge.source_file,
        edge.module_specifier,
        knownFiles,
      );
    if (!target) continue;

    const sourcePackage = extractPackage(edge.source_file);
    const targetPackage = extractPackage(target);

    // Skip if either file is not in a package, or same package
    if (!sourcePackage || !targetPackage) continue;
    if (sourcePackage === targetPackage) continue;

    // Cross-package import — check if it targets an internal module
    if (isInternalModule(target, targetPackage)) {
      violations.push({
        sourceFile: edge.source_file,
        sourcePackage,
        targetFile: target,
        targetPackage,
        moduleSpecifier: edge.module_specifier,
        reason: `${edge.source_file} imports internal module ${target} — should go through ${targetPackage} public exports`,
      });
    }
  }

  // Sort by source package, then target package, then source file
  violations.sort(
    (a, b) =>
      a.sourcePackage.localeCompare(b.sourcePackage) ||
      a.targetPackage.localeCompare(b.targetPackage) ||
      a.sourceFile.localeCompare(b.sourceFile),
  );

  // Group by package pair
  const pairMap = new Map<
    string,
    { sourcePackage: string; targetPackage: string; count: number }
  >();
  for (const v of violations) {
    const key = `${v.sourcePackage} → ${v.targetPackage}`;
    const existing = pairMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      pairMap.set(key, {
        sourcePackage: v.sourcePackage,
        targetPackage: v.targetPackage,
        count: 1,
      });
    }
  }

  const byPackagePair = [...pairMap.values()].sort((a, b) => b.count - a.count);

  return {
    violations,
    totalViolations: violations.length,
    byPackagePair,
  };
}
