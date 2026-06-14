// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: deadFeatures
 *
 * Dead Feature Detection (Backlog 5.3)
 *
 * Combines three independent signals to identify likely dead code:
 *   (a) Code symbols never imported by any other file (unused export)
 *   (b) Code symbols with zero documentation references (undocumented)
 *   (c) File not modified in 6+ months (stale)
 *
 * When all three align, the symbol is very likely dead. Two signals = suspect.
 */

import type Database from "@intentweave/sqlite-compat";
import type { DeadFeatureResult, DeadFeatureCandidate } from "../types.js";
import { openIndex } from "./shared.js";

/** Options for dead feature detection. */
export interface DeadFeatureOptions {
  /** Minimum number of signals required to report (1–3). Default: 2. */
  minSignals?: number;
  /** Months without commits to count as stale. Default: 6. */
  stalenessMonths?: number;
  /** Maximum results. Default: 100. */
  limit?: number;
}

/**
 * Detect likely dead features from the index.
 */
export function deadFeatures(
  dbPath: string,
  opts?: DeadFeatureOptions,
): DeadFeatureResult {
  const db = openIndex(dbPath);
  try {
    return deadFeaturesFromDb(db, opts);
  } finally {
    db.close();
  }
}

/**
 * Core dead feature detection logic against an open database.
 */
export function deadFeaturesFromDb(
  db: Database.Database,
  opts?: DeadFeatureOptions,
): DeadFeatureResult {
  const minSignals = opts?.minSignals ?? 2;
  const stalenessMonths = opts?.stalenessMonths ?? 6;
  const limit = opts?.limit ?? 100;

  // Compute staleness cutoff date
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - stalenessMonths);
  const cutoffIso = cutoff.toISOString();

  // ─── Signal (a): Unused exports ────────────────────────────────────────────
  // Exported symbols whose file is never imported, or whose name is never
  // listed in any import of that file.
  const exported = db
    .prepare(
      `SELECT id, name, kind, file_path, line
       FROM symbols
       WHERE export = 'exported'
         AND kind IN ('function', 'class', 'method', 'variable', 'type', 'interface')`,
    )
    .all() as Array<{
    id: string;
    name: string;
    kind: string;
    file_path: string;
    line: number;
  }>;

  // Build imported-names-per-file lookup (same approach as imports.ts)
  const importRows = db
    .prepare(
      `SELECT target_file, imported_names
       FROM imports
       WHERE target_file IS NOT NULL`,
    )
    .all() as Array<{ target_file: string; imported_names: string }>;

  const importedNamesMap = new Map<string, Set<string>>();
  const filesImported = new Set<string>();
  for (const row of importRows) {
    filesImported.add(row.target_file);
    if (!importedNamesMap.has(row.target_file)) {
      importedNamesMap.set(row.target_file, new Set());
    }
    const names: string[] = JSON.parse(row.imported_names);
    const set = importedNamesMap.get(row.target_file)!;
    for (const n of names) set.add(n);
  }

  const unusedExportIds = new Set<string>();
  for (const sym of exported) {
    if (!filesImported.has(sym.file_path)) {
      unusedExportIds.add(sym.id);
      continue;
    }
    const names = importedNamesMap.get(sym.file_path);
    if (!names) {
      unusedExportIds.add(sym.id);
      continue;
    }
    // Wildcard / default imports conservatively assume used
    if (names.has("*") || names.has("default")) continue;
    if (!names.has(sym.name)) unusedExportIds.add(sym.id);
  }

  // ─── Signal (b): Undocumented symbols ──────────────────────────────────────
  // Symbols with zero grounded annotations (no doc reference at all).
  const documentedIds = new Set<string>();
  const docRows = db
    .prepare(
      `SELECT DISTINCT symbol_id
       FROM annotations
       WHERE symbol_id IS NOT NULL AND confidence >= 0.5`,
    )
    .all() as Array<{ symbol_id: string }>;
  for (const row of docRows) documentedIds.add(row.symbol_id);

  // ─── Signal (c): Stale files ───────────────────────────────────────────────
  // Files with last_modified before the cutoff.
  const staleFiles = new Set<string>();
  const fileRows = db
    .prepare(
      `SELECT path, last_modified
       FROM files
       WHERE is_doc = 0 AND last_modified IS NOT NULL`,
    )
    .all() as Array<{ path: string; last_modified: string }>;

  // Build last_modified lookup for all code files
  const fileLastModified = new Map<string, string>();
  for (const row of fileRows) {
    fileLastModified.set(row.path, row.last_modified);
    if (row.last_modified < cutoffIso) {
      staleFiles.add(row.path);
    }
  }

  // ─── Combine signals ──────────────────────────────────────────────────────
  const candidates: DeadFeatureCandidate[] = [];

  for (const sym of exported) {
    const unusedExport = unusedExportIds.has(sym.id);
    const undocumented = !documentedIds.has(sym.id);
    const stale = staleFiles.has(sym.file_path);

    const signalCount =
      (unusedExport ? 1 : 0) + (undocumented ? 1 : 0) + (stale ? 1 : 0);

    if (signalCount < minSignals) continue;

    candidates.push({
      name: sym.name,
      kind: sym.kind,
      filePath: sym.file_path,
      line: sym.line,
      unusedExport,
      undocumented,
      stale,
      lastModified: fileLastModified.get(sym.file_path) ?? null,
      signalCount,
    });
  }

  // Sort: signal count desc, then name asc
  candidates.sort(
    (a, b) => b.signalCount - a.signalCount || a.name.localeCompare(b.name),
  );

  const limited = candidates.slice(0, limit);

  return {
    candidates: limited,
    totalCandidates: candidates.length,
    bySignalCount: {
      three: candidates.filter((c) => c.signalCount === 3).length,
      two: candidates.filter((c) => c.signalCount === 2).length,
      one: candidates.filter((c) => c.signalCount === 1).length,
    },
    stalenessMonths,
  };
}
