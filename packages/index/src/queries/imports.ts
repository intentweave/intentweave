// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: imports
 *
 * Import graph analysis:
 * - Circular import detection (DFS cycle detection)
 * - Unused export detection (exported symbols never imported)
 */

import type Database from "better-sqlite3";
import type { CircularImportsResult, UnusedExportsResult } from "../types.js";
import { openIndex } from "./shared.js";

// =============================================================================
// Circular Imports
// =============================================================================

/**
 * Detect circular import cycles in the codebase.
 */
export function circularImports(dbPath: string): CircularImportsResult {
  const db = openIndex(dbPath);
  try {
    return circularImportsFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core circular import detection logic against an open database.
 */
export function circularImportsFromDb(
  db: Database.Database,
): CircularImportsResult {
  // Build directed graph from resolved relative imports
  const edges = db
    .prepare(
      `
      SELECT DISTINCT source_file, target_file
      FROM imports
      WHERE target_file IS NOT NULL AND is_relative = 1
    `,
    )
    .all() as Array<{ source_file: string; target_file: string }>;

  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!graph.has(edge.source_file)) {
      graph.set(edge.source_file, new Set());
    }
    graph.get(edge.source_file)!.add(edge.target_file);
  }

  // Johnson's simplified cycle detection via DFS
  const cycles: Array<{ files: string[]; length: number }> = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (stack.has(node)) {
      // Found a cycle — extract from the first occurrence of node in path
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        const cycle = path.slice(cycleStart);
        // Normalise: rotate so smallest path is first (deduplicates)
        const minIdx = cycle.indexOf(cycle.reduce((a, b) => (a < b ? a : b)));
        const normalised = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
        const key = normalised.join(" → ");
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push({ files: normalised, length: normalised.length });
        }
      }
      return;
    }
    if (visited.has(node)) return;

    stack.add(node);
    path.push(node);

    const neighbours = graph.get(node);
    if (neighbours) {
      for (const next of neighbours) {
        dfs(next);
      }
    }

    path.pop();
    stack.delete(node);
    visited.add(node);
  }

  const seenCycles = new Set<string>();
  for (const node of graph.keys()) {
    visited.clear();
    stack.clear();
    path.length = 0;
    dfs(node);
  }

  // Sort by length ascending
  cycles.sort((a, b) => a.length - b.length);

  return { cycles, totalCycles: cycles.length };
}

// =============================================================================
// Unused Exports
// =============================================================================

/**
 * Detect exported symbols that are never imported within the workspace.
 */
export function unusedExports(dbPath: string): UnusedExportsResult {
  const db = openIndex(dbPath);
  try {
    return unusedExportsFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core unused export detection logic against an open database.
 */
export function unusedExportsFromDb(
  db: Database.Database,
): UnusedExportsResult {
  // Get all exported symbols
  const exported = db
    .prepare(
      `
      SELECT id, name, file_path, kind, line
      FROM symbols
      WHERE export = 'exported'
    `,
    )
    .all() as Array<{
    id: string;
    name: string;
    file_path: string;
    kind: string;
    line: number;
  }>;

  // Build set of all imported names per file
  // An import like { foo, bar } from './utils' means 'foo' and 'bar' are used from utils
  const importedNamesFromFile = new Map<string, Set<string>>();
  const importRows = db
    .prepare(
      `
      SELECT target_file, imported_names
      FROM imports
      WHERE target_file IS NOT NULL
    `,
    )
    .all() as Array<{ target_file: string; imported_names: string }>;

  for (const row of importRows) {
    if (!importedNamesFromFile.has(row.target_file)) {
      importedNamesFromFile.set(row.target_file, new Set());
    }
    const names: string[] = JSON.parse(row.imported_names);
    const set = importedNamesFromFile.get(row.target_file)!;
    for (const n of names) {
      set.add(n);
    }
  }

  // Check which files are imported at all (even if via namespace / default)
  const filesImported = new Set<string>();
  for (const row of importRows) {
    filesImported.add(row.target_file);
  }

  const unused = exported.filter((sym) => {
    // If the file is never imported at all, the export is unused
    if (!filesImported.has(sym.file_path)) return true;

    const names = importedNamesFromFile.get(sym.file_path);
    if (!names) return true;

    // If someone does `import * from ...` or `import default from ...`, we
    // conservatively assume all exports are used from that file
    if (names.has("*") || names.has("default")) return false;

    return !names.has(sym.name);
  });

  return {
    unused: unused.map((s) => ({
      name: s.name,
      filePath: s.file_path,
      kind: s.kind,
      line: s.line,
    })),
    totalUnused: unused.length,
    totalExported: exported.length,
  };
}
