// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: docCompleteness
 *
 * Per-document completeness score: does the doc cover all exported symbols
 * from the code files it references?
 */

import type Database from "better-sqlite3";
import type { DocCompletenessResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Compute documentation completeness per doc file.
 */
export function docCompleteness(dbPath: string): DocCompletenessResult {
  const db = openIndex(dbPath);
  try {
    return docCompletenessFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core doc completeness logic against an open database.
 */
export function docCompletenessFromDb(
  db: Database.Database,
): DocCompletenessResult {
  // Find which code files each doc references (via grounded annotations)
  const docToCodeFiles = db
    .prepare(
      `
      SELECT DISTINCT a.doc_path, s.file_path AS code_file
      FROM annotations a
      JOIN symbols s ON a.symbol_id = s.id
      WHERE a.confidence >= 0.5
    `,
    )
    .all() as Array<{ doc_path: string; code_file: string }>;

  // Group code files by doc
  const codeFilesByDoc = new Map<string, Set<string>>();
  for (const row of docToCodeFiles) {
    if (!codeFilesByDoc.has(row.doc_path)) {
      codeFilesByDoc.set(row.doc_path, new Set());
    }
    codeFilesByDoc.get(row.doc_path)!.add(row.code_file);
  }

  // Get grounded symbol IDs per doc
  const coveredByDoc = new Map<string, Set<string>>();
  const coveredRows = db
    .prepare(
      `
      SELECT DISTINCT a.doc_path, a.symbol_id
      FROM annotations a
      WHERE a.symbol_id IS NOT NULL AND a.confidence >= 0.5
    `,
    )
    .all() as Array<{ doc_path: string; symbol_id: string }>;
  for (const r of coveredRows) {
    if (!coveredByDoc.has(r.doc_path)) {
      coveredByDoc.set(r.doc_path, new Set());
    }
    coveredByDoc.get(r.doc_path)!.add(r.symbol_id);
  }

  // For each doc, find all exported symbols from referenced code files
  const exportedSymStmt = db.prepare(
    `SELECT id, name, file_path, kind FROM symbols WHERE file_path = ? AND export = 'exported'`,
  );

  const docs: DocCompletenessResult["docs"] = [];

  for (const [docPath, codeFiles] of codeFilesByDoc) {
    const relevantExports: Array<{
      id: string;
      name: string;
      filePath: string;
      kind: string;
    }> = [];
    for (const cf of codeFiles) {
      const syms = exportedSymStmt.all(cf) as Array<{
        id: string;
        name: string;
        file_path: string;
        kind: string;
      }>;
      for (const s of syms) {
        relevantExports.push({
          id: s.id,
          name: s.name,
          filePath: s.file_path,
          kind: s.kind,
        });
      }
    }

    if (relevantExports.length === 0) continue;

    const covered = coveredByDoc.get(docPath) ?? new Set();
    const coveredCount = relevantExports.filter((e) =>
      covered.has(e.id),
    ).length;
    const missing = relevantExports
      .filter((e) => !covered.has(e.id))
      .map((e) => ({ name: e.name, filePath: e.filePath, kind: e.kind }));

    docs.push({
      docPath,
      totalRelevantExports: relevantExports.length,
      coveredExports: coveredCount,
      completenessPercent:
        Math.round((coveredCount / relevantExports.length) * 1000) / 10,
      missing,
    });
  }

  // Sort by completeness ascending (least complete first)
  docs.sort((a, b) => a.completenessPercent - b.completenessPercent);

  return { docs };
}
