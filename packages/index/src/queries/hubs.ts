// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * 9.2 God-Node / Hub Analysis
 *
 * Compute degree centrality across all edge types (annotations, imports,
 * co-occurrences, co-changes). Rank entities by total degree. God nodes
 * are the entities everything connects through — highest architectural
 * risk and highest documentation priority.
 */

import type Database from "@intentweave/sqlite-compat";
import type { HubAnalysisResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Compute hub analysis from a database file path.
 */
export function hubs(dbPath: string): HubAnalysisResult {
  const db = openIndex(dbPath);
  try {
    return hubsFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Compute hub analysis from an open database handle.
 */
export function hubsFromDb(db: Database.Database): HubAnalysisResult {
  // ── Annotation degree: how many annotations reference each symbol ──
  const annotationDegrees = new Map<string, number>();
  const symbolMeta = new Map<string, { kind: string; filePath: string }>();

  const annotationRows = db
    .prepare(
      `SELECT s.name, s.kind, s.file_path, COUNT(*) AS cnt
       FROM annotations a
       JOIN symbols s ON a.symbol_id = s.id
       WHERE a.symbol_id IS NOT NULL
       GROUP BY s.id`,
    )
    .all() as Array<{
    name: string;
    kind: string;
    file_path: string;
    cnt: number;
  }>;

  for (const row of annotationRows) {
    annotationDegrees.set(
      row.name,
      (annotationDegrees.get(row.name) ?? 0) + row.cnt,
    );
    if (!symbolMeta.has(row.name)) {
      symbolMeta.set(row.name, { kind: row.kind, filePath: row.file_path });
    }
  }

  // ── Import degree: incoming + outgoing imports per file ──
  const importDegrees = new Map<string, number>();

  const importRows = db
    .prepare(`SELECT source_file, target_file FROM imports`)
    .all() as Array<{ source_file: string; target_file: string }>;

  for (const row of importRows) {
    if (row.source_file != null) {
      importDegrees.set(
        row.source_file,
        (importDegrees.get(row.source_file) ?? 0) + 1,
      );
    }
    if (row.target_file != null) {
      importDegrees.set(
        row.target_file,
        (importDegrees.get(row.target_file) ?? 0) + 1,
      );
    }
  }

  // ── Co-occurrence degree: how many co-occurrence edges per entity ──
  const coOccDegrees = new Map<string, number>();

  const coOccRows = db
    .prepare(`SELECT entity_a, entity_b FROM co_occurrences`)
    .all() as Array<{ entity_a: string; entity_b: string }>;

  for (const row of coOccRows) {
    coOccDegrees.set(row.entity_a, (coOccDegrees.get(row.entity_a) ?? 0) + 1);
    coOccDegrees.set(row.entity_b, (coOccDegrees.get(row.entity_b) ?? 0) + 1);
  }

  // ── Co-change degree: how many co-change edges per file ──
  const coChangeDegrees = new Map<string, number>();

  const coChangeRows = db
    .prepare(`SELECT file_a, file_b FROM co_changes`)
    .all() as Array<{ file_a: string; file_b: string }>;

  for (const row of coChangeRows) {
    coChangeDegrees.set(row.file_a, (coChangeDegrees.get(row.file_a) ?? 0) + 1);
    coChangeDegrees.set(row.file_b, (coChangeDegrees.get(row.file_b) ?? 0) + 1);
  }

  // ── Merge all entities ──
  const allEntities = new Set<string>();

  for (const name of annotationDegrees.keys()) allEntities.add(name);
  for (const name of coOccDegrees.keys()) allEntities.add(name);
  for (const path of importDegrees.keys()) allEntities.add(path);
  for (const path of coChangeDegrees.keys()) allEntities.add(path);

  // Lookup symbols for kind/filePath info
  const symbolLookup = new Map<string, { kind: string; filePath: string }>();
  const allSymbols = db
    .prepare(`SELECT name, kind, file_path FROM symbols`)
    .all() as Array<{ name: string; kind: string; file_path: string }>;

  for (const s of allSymbols) {
    if (!symbolLookup.has(s.name)) {
      symbolLookup.set(s.name, { kind: s.kind, filePath: s.file_path });
    }
  }

  // File entries
  const fileSet = new Set<string>();
  const allFiles = db.prepare(`SELECT path FROM files`).all() as Array<{
    path: string;
  }>;
  for (const f of allFiles) fileSet.add(f.path);

  // ── Build hub entries ──
  const hubEntries: HubAnalysisResult["hubs"] = [];

  for (const entity of allEntities) {
    const annDeg = annotationDegrees.get(entity) ?? 0;
    const impDeg = importDegrees.get(entity) ?? 0;
    const coOccDeg = coOccDegrees.get(entity) ?? 0;
    const coChgDeg = coChangeDegrees.get(entity) ?? 0;
    const totalDeg = annDeg + impDeg + coOccDeg + coChgDeg;

    if (totalDeg === 0) continue;

    const sym = symbolLookup.get(entity) ?? symbolMeta.get(entity);
    const isFile = fileSet.has(entity);

    hubEntries.push({
      name: entity,
      kind: isFile ? "file" : (sym?.kind ?? "unknown"),
      filePath: isFile ? entity : (sym?.filePath ?? ""),
      annotationDegree: annDeg,
      importDegree: impDeg,
      coOccurrenceDegree: coOccDeg,
      coChangeDegree: coChgDeg,
      totalDegree: totalDeg,
    });
  }

  // Sort by total degree descending
  hubEntries.sort((a, b) => b.totalDegree - a.totalDegree);

  return { hubs: hubEntries };
}
