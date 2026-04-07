// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: report
 *
 * Corpus-wide aggregation:
 * - Documentation coverage (annotated symbols / total exported)
 * - Staleness top-N (docs behind their referenced code)
 * - Hidden couplings (co-mentioned in docs but no code dependency)
 * - Undocumented dependencies (co-change but zero doc mentions)
 */

import type Database from "better-sqlite3";
import type { ReportResult } from "../types.js";
import { openIndex } from "./shared.js";

/** Options for report generation. */
export interface ReportOptions {
  /** Minimum co-occurrence score to count as "documented" (default: 0.3) */
  coocThreshold?: number;
  /** Minimum co-change jaccard to surface (default: 0.3) */
  cochangeThreshold?: number;
}

/**
 * Generate a corpus-wide report from the index.
 */
export function report(dbPath: string, opts?: ReportOptions): ReportResult {
  const db = openIndex(dbPath);
  try {
    return reportFromDb(db, opts);
  } finally {
    db.close();
  }
}

/**
 * Core report logic against an open database.
 */
export function reportFromDb(db: Database.Database, opts?: ReportOptions): ReportResult {
  const coocThreshold = opts?.coocThreshold ?? 0.3;
  const cochangeThreshold = opts?.cochangeThreshold ?? 0.3;
  return {
    coverage: computeCoverage(db),
    staleness: computeStaleness(db),
    hiddenCouplings: computeHiddenCouplings(db, coocThreshold),
    undocumentedDeps: computeUndocumentedDeps(db, cochangeThreshold),
  };
}

// =============================================================================
// Coverage
// =============================================================================

function computeCoverage(db: Database.Database): ReportResult["coverage"] {
  // Total exported symbols
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM symbols WHERE export = 'exported'`)
    .get() as { cnt: number };

  // Exported symbols that have at least one annotation pointing to them
  const documentedRow = db
    .prepare(
      `
      SELECT COUNT(DISTINCT s.id) AS cnt
      FROM symbols s
      JOIN annotations a ON a.symbol_id = s.id
      WHERE s.export = 'exported'
        AND a.confidence >= 0.5
    `,
    )
    .get() as { cnt: number };

  const total = totalRow.cnt;
  const documented = documentedRow.cnt;
  const percentage =
    total > 0 ? Math.round((documented / total) * 1000) / 10 : 0;

  // Top undocumented exported symbols
  const topUndocumented = db
    .prepare(
      `
      SELECT s.name, s.file_path, s.kind
      FROM symbols s
      WHERE s.export = 'exported'
        AND NOT EXISTS (
          SELECT 1 FROM annotations a
          WHERE a.symbol_id = s.id AND a.confidence >= 0.5
        )
      ORDER BY s.name
      LIMIT 20
    `,
    )
    .all() as Array<{ name: string; file_path: string; kind: string }>;

  return {
    documented,
    total,
    percentage,
    topUndocumented: topUndocumented.map((r) => ({
      name: r.name,
      filePath: r.file_path,
      kind: r.kind,
    })),
  };
}

// =============================================================================
// Staleness
// =============================================================================

function computeStaleness(db: Database.Database): ReportResult["staleness"] {
  // Find doc files that reference code files where the code was modified
  // more recently than the doc
  const staleRows = db
    .prepare(
      `
      SELECT
        a.doc_path,
        f_doc.last_modified AS doc_modified,
        s.file_path AS code_file,
        f_code.last_modified AS code_modified
      FROM annotations a
      JOIN symbols s ON s.id = a.symbol_id
      JOIN files f_doc ON f_doc.path = a.doc_path
      JOIN files f_code ON f_code.path = s.file_path
      WHERE a.confidence >= 0.5
        AND f_doc.last_modified IS NOT NULL
        AND f_code.last_modified IS NOT NULL
        AND f_code.last_modified > f_doc.last_modified
      GROUP BY a.doc_path, s.file_path
      ORDER BY f_code.last_modified DESC
    `,
    )
    .all() as Array<{
    doc_path: string;
    doc_modified: string;
    code_file: string;
    code_modified: string;
  }>;

  // Deduplicate by doc_path, keeping the worst case
  const byDoc = new Map<
    string,
    { daysBehind: number; newerCodeFile: string }
  >();

  for (const row of staleRows) {
    const docDate = new Date(row.doc_modified).getTime();
    const codeDate = new Date(row.code_modified).getTime();
    const daysBehind = Math.round((codeDate - docDate) / (1000 * 60 * 60 * 24));

    const existing = byDoc.get(row.doc_path);
    if (!existing || daysBehind > existing.daysBehind) {
      byDoc.set(row.doc_path, {
        daysBehind,
        newerCodeFile: row.code_file,
      });
    }
  }

  const topStale = [...byDoc.entries()]
    .sort((a, b) => b[1].daysBehind - a[1].daysBehind)
    .slice(0, 20)
    .map(([docPath, data]) => ({
      docPath,
      daysBehind: data.daysBehind,
      newerCodeFile: data.newerCodeFile,
    }));

  return {
    staleDocCount: byDoc.size,
    topStale,
  };
}

// =============================================================================
// Hidden couplings
// =============================================================================

function computeHiddenCouplings(
  db: Database.Database,
  coocThreshold: number,
): ReportResult["hiddenCouplings"] {
  // Entities that co-occur in docs but have no symbols in the same code files
  // (a proxy for "no code dependency")
  const coocs = db
    .prepare(
      `
      SELECT entity_a, entity_b, score
      FROM co_occurrences
      WHERE source = 'doc_cooc'
        AND score >= ?
      ORDER BY score DESC
      LIMIT 100
    `,
    )
    .all(coocThreshold) as Array<{
    entity_a: string;
    entity_b: string;
    score: number;
  }>;

  const results: ReportResult["hiddenCouplings"] = [];

  for (const cooc of coocs) {
    // Check if both entities map to symbols in code
    const symsA = db
      .prepare(
        `SELECT file_path FROM symbols WHERE LOWER(name) = LOWER(?) LIMIT 5`,
      )
      .all(cooc.entity_a) as Array<{ file_path: string }>;
    const symsB = db
      .prepare(
        `SELECT file_path FROM symbols WHERE LOWER(name) = LOWER(?) LIMIT 5`,
      )
      .all(cooc.entity_b) as Array<{ file_path: string }>;

    const filesA = new Set(symsA.map((s) => s.file_path));
    const filesB = new Set(symsB.map((s) => s.file_path));

    // Check if any file of A co-changes with any file of B
    let hasCodeDependency = false;
    if (filesA.size > 0 && filesB.size > 0) {
      // Check if they share a file (structural dependency)
      for (const f of filesA) {
        if (filesB.has(f)) {
          hasCodeDependency = true;
          break;
        }
      }

      // Check co-changes between their files
      if (!hasCodeDependency) {
        for (const fA of filesA) {
          for (const fB of filesB) {
            const cochange = db
              .prepare(
                `
                SELECT 1 FROM co_changes
                WHERE (file_a = ? AND file_b = ?) OR (file_a = ? AND file_b = ?)
                LIMIT 1
              `,
              )
              .get(fA, fB, fB, fA);
            if (cochange) {
              hasCodeDependency = true;
              break;
            }
          }
          if (hasCodeDependency) break;
        }
      }
    }

    results.push({
      entityA: cooc.entity_a,
      entityB: cooc.entity_b,
      docCoocScore: Math.round(cooc.score * 100) / 100,
      hasCodeDependency,
    });
  }

  return results;
}

// =============================================================================
// Undocumented dependencies
// =============================================================================

function computeUndocumentedDeps(
  db: Database.Database,
  cochangeThreshold: number,
): ReportResult["undocumentedDeps"] {
  // Files with high co-change but no doc co-mentions for their entities
  const cochanges = db
    .prepare(
      `
      SELECT file_a, file_b, count, jaccard
      FROM co_changes
      WHERE jaccard >= ?
      ORDER BY jaccard DESC
      LIMIT 100
    `,
    )
    .all(cochangeThreshold) as Array<{
    file_a: string;
    file_b: string;
    count: number;
    jaccard: number;
  }>;

  const results: ReportResult["undocumentedDeps"] = [];

  for (const cc of cochanges) {
    // Get primary symbol names from each file
    const symsA = db
      .prepare(
        `SELECT name FROM symbols WHERE file_path = ? AND export = 'exported' LIMIT 3`,
      )
      .all(cc.file_a) as Array<{ name: string }>;
    const symsB = db
      .prepare(
        `SELECT name FROM symbols WHERE file_path = ? AND export = 'exported' LIMIT 3`,
      )
      .all(cc.file_b) as Array<{ name: string }>;

    if (symsA.length === 0 || symsB.length === 0) continue;

    // Check if any of these symbol pairs co-occur in docs
    let docMentions = 0;
    for (const sA of symsA) {
      for (const sB of symsB) {
        const cooc = db
          .prepare(
            `
            SELECT count FROM co_occurrences
            WHERE ((LOWER(entity_a) = LOWER(?) AND LOWER(entity_b) = LOWER(?))
               OR (LOWER(entity_a) = LOWER(?) AND LOWER(entity_b) = LOWER(?)))
              AND source = 'doc_cooc'
            LIMIT 1
          `,
          )
          .get(sA.name, sB.name, sB.name, sA.name) as
          | { count: number }
          | undefined;
        if (cooc) docMentions += cooc.count;
      }
    }

    if (docMentions === 0) {
      results.push({
        entityA: symsA[0].name,
        entityB: symsB[0].name,
        coChangeCount: cc.count,
        docMentions: 0,
      });
    }
  }

  return results.slice(0, 20);
}
