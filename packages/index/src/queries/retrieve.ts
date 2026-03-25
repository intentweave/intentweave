// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: retrieve
 *
 * Ranked file retrieval. Uses FTS5 match on symbol names and annotation
 * text, then scores by annotation confidence + co-occurrence weight.
 *
 * Returns the top-K files most relevant to a natural-language query.
 */

import type Database from "better-sqlite3";
import type { RetrieveParams, RetrieveResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Retrieve ranked files matching a query topic or symbol name.
 */
export function retrieve(
  dbPath: string,
  params: RetrieveParams,
): RetrieveResult {
  const db = openIndex(dbPath);
  try {
    return retrieveFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core retrieval logic against an open database.
 */
export function retrieveFromDb(
  db: Database.Database,
  params: RetrieveParams,
): RetrieveResult {
  const limit = params.limit ?? 10;
  const query = params.query.trim();
  if (!query) return { files: [] };

  // Sanitize FTS5 query: escape special chars, wrap tokens in quotes
  const ftsQuery = sanitizeFtsQuery(query);

  // Strategy 1: FTS5 match on annotations text
  const annotationHits = db
    .prepare(
      `
      SELECT a.doc_path, a.line, a.text, a.confidence, a.symbol_id, a.idf_score
      FROM annotations a
      JOIN annotations_fts fts ON fts.rowid = a.id
      WHERE annotations_fts MATCH ?
      ORDER BY rank
      LIMIT 500
    `,
    )
    .all(ftsQuery) as Array<{
    doc_path: string;
    line: number;
    text: string;
    confidence: number;
    symbol_id: string | null;
    idf_score: number | null;
  }>;

  // Strategy 2: FTS5 match on symbol names/signatures
  const symbolHits = db
    .prepare(
      `
      SELECT s.id, s.name, s.file_path, s.line, s.signature, s.doc_summary
      FROM symbols s
      JOIN symbols_fts fts ON fts.rowid = s.rowid
      WHERE symbols_fts MATCH ?
      LIMIT 200
    `,
    )
    .all(ftsQuery) as Array<{
    id: string;
    name: string;
    file_path: string;
    line: number;
    signature: string | null;
    doc_summary: string | null;
  }>;

  // Strategy 3: Exact annotation text match (for short queries FTS may miss)
  const exactHits = db
    .prepare(
      `
      SELECT doc_path, line, text, confidence, symbol_id, idf_score
      FROM annotations
      WHERE LOWER(text) = LOWER(?)
      LIMIT 200
    `,
    )
    .all(query) as typeof annotationHits;

  // Score files by aggregating hits
  const fileScores = new Map<
    string,
    {
      score: number;
      reasons: string[];
      spans: Array<{ line: number; text: string }>;
    }
  >();

  const addFileScore = (
    filePath: string,
    score: number,
    reason: string,
    span?: { line: number; text: string },
  ) => {
    const existing = fileScores.get(filePath) ?? {
      score: 0,
      reasons: [],
      spans: [],
    };
    existing.score += score;
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    if (span) existing.spans.push(span);
    fileScores.set(filePath, existing);
  };

  // Annotations → doc files
  for (const hit of [...annotationHits, ...exactHits]) {
    const boost = hit.idf_score ?? 0.5;
    const score = hit.confidence * (1 + boost);
    addFileScore(hit.doc_path, score, `annotation: "${hit.text}"`, {
      line: hit.line,
      text: hit.text,
    });

    // Also score the code file the annotation points to
    if (hit.symbol_id) {
      const sym = db
        .prepare(`SELECT file_path, line, name FROM symbols WHERE id = ?`)
        .get(hit.symbol_id) as
        | { file_path: string; line: number; name: string }
        | undefined;
      if (sym) {
        addFileScore(
          sym.file_path,
          score * 0.8,
          `annotated symbol: ${sym.name}`,
          {
            line: sym.line,
            text: sym.name,
          },
        );
      }
    }
  }

  // Symbol hits → code files
  for (const hit of symbolHits) {
    addFileScore(hit.file_path, 1.5, `symbol match: ${hit.name}`, {
      line: hit.line,
      text: hit.name,
    });
  }

  // Boost files with co-occurrence connections to matched entities
  const matchedEntities = new Set<string>();
  for (const hit of annotationHits) matchedEntities.add(hit.text.toLowerCase());
  for (const hit of symbolHits) matchedEntities.add(hit.name.toLowerCase());

  if (matchedEntities.size > 0) {
    for (const entity of matchedEntities) {
      const coocs = db
        .prepare(
          `
          SELECT entity_a, entity_b, score FROM co_occurrences
          WHERE LOWER(entity_a) = ? OR LOWER(entity_b) = ?
          ORDER BY score DESC LIMIT 20
        `,
        )
        .all(entity, entity) as Array<{
        entity_a: string;
        entity_b: string;
        score: number;
      }>;

      for (const cooc of coocs) {
        const related =
          cooc.entity_a.toLowerCase() === entity
            ? cooc.entity_b
            : cooc.entity_a;
        // Find files containing the related entity
        const relatedFiles = db
          .prepare(
            `SELECT DISTINCT doc_path FROM annotations WHERE LOWER(text) = LOWER(?) LIMIT 5`,
          )
          .all(related) as Array<{ doc_path: string }>;
        for (const f of relatedFiles) {
          addFileScore(
            f.doc_path,
            cooc.score * 0.3,
            `co-occurs with "${related}"`,
          );
        }
      }
    }
  }

  // Apply scope filter
  let entries = [...fileScores.entries()];
  if (params.scope === "docs") {
    entries = entries.filter(([p]) => isDocFile(p));
  } else if (params.scope === "code") {
    entries = entries.filter(([p]) => !isDocFile(p));
  }

  // Sort by score descending, take top-K
  entries.sort((a, b) => b[1].score - a[1].score);
  const topK = entries.slice(0, limit);

  return {
    files: topK.map(([path, data]) => ({
      path,
      score: Math.round(data.score * 100) / 100,
      reason: data.reasons.slice(0, 3).join("; "),
      spans: data.spans.length > 0 ? data.spans.slice(0, 5) : undefined,
    })),
  };
}

// =============================================================================
// Helpers
// =============================================================================

function isDocFile(filePath: string): boolean {
  return /\.(md|mdx|rst|txt|adoc)$/i.test(filePath);
}

/**
 * Sanitize a query string for FTS5:
 * - Wrap each token in double quotes to avoid syntax errors from special chars
 * - Join with spaces (implicit AND in FTS5)
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(" ");
}
