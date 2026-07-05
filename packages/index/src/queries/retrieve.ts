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

import type Database from "@intentweave/sqlite-compat";
import path from "node:path";
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
  // No ORDER BY rank — we aggregate + rank at the file level in JS below.
  // ORDER BY rank on large corpora (2M+ rows) forces full BM25 computation on
  // all matching rows before the LIMIT, causing multi-minute latency.
  const annotationHits = db
    .prepare(
      `
      SELECT a.doc_path, a.line, a.text, a.confidence, a.symbol_id, a.idf_score
      FROM annotations a
      JOIN annotations_fts fts ON fts.rowid = a.rowid
      WHERE annotations_fts MATCH ?
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

  // Strategy 3: Exact annotation text match — only for single-word queries.
  // Multi-word queries will never match a single-keyword annotation row, so
  // skip this on large corpora to avoid a 2M-row LOWER() full-table scan.
  const isSingleToken = !query.includes(" ");
  const exactHits = isSingleToken
    ? (db
        .prepare(
          `
      SELECT doc_path, line, text, confidence, symbol_id, idf_score
      FROM annotations
      WHERE LOWER(text) = LOWER(?)
      LIMIT 200
    `,
        )
        .all(query) as typeof annotationHits)
    : [];

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

  // Bulk-fetch symbols for all annotation hits that have a symbol_id
  // (replaces N+1 individual queries that caused severe latency on large corpora)
  const symbolIdSet = new Set(
    [...annotationHits, ...exactHits]
      .map((h) => h.symbol_id)
      .filter((id): id is string => id != null),
  );
  const symbolMap = new Map<
    string,
    { file_path: string; line: number; name: string }
  >();
  if (symbolIdSet.size > 0) {
    const placeholders = Array.from(symbolIdSet)
      .map(() => "?")
      .join(",");
    const symRows = db
      .prepare(
        `SELECT id, file_path, line, name FROM symbols WHERE id IN (${placeholders})`,
      )
      .all(...Array.from(symbolIdSet)) as Array<{
      id: string;
      file_path: string;
      line: number;
      name: string;
    }>;
    for (const row of symRows) symbolMap.set(row.id, row);
  }

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
      const sym = symbolMap.get(hit.symbol_id);
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
  // Cap to top-5 highest-scoring entities to avoid O(n) LOWER scans on large corpora
  const matchedEntities = new Set<string>();
  for (const hit of annotationHits) matchedEntities.add(hit.text.toLowerCase());
  for (const hit of symbolHits) matchedEntities.add(hit.name.toLowerCase());

  if (matchedEntities.size > 0) {
    // Limit to top-5 entities by their current file score contribution
    const topEntities = [...matchedEntities]
      .filter((e) => e.length > 2) // skip trivial tokens
      .slice(0, 5);

    for (const entity of topEntities) {
      const coocs = db
        .prepare(
          `
          SELECT entity_a, entity_b, score FROM co_occurrences
          WHERE LOWER(entity_a) = ? OR LOWER(entity_b) = ?
          ORDER BY score DESC LIMIT 10
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
        // Use case-sensitive match so SQLite can use an index on annotations.text
        const relatedFiles = db
          .prepare(
            `SELECT DISTINCT doc_path FROM annotations WHERE text = ? LIMIT 5`,
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

  // Phase C: anchor-aware neighborhood boost — surfaces files that are
  // 1-hop import-neighbors of an anchor, or live in the same folder, even
  // when they don't match the FTS query terms directly.
  if (params.anchorFiles && params.anchorFiles.length > 0) {
    applyAnchorNeighborhoodBoost(
      db,
      fileScores,
      params.anchorFiles,
      params.explainScoring,
    );
  }

  // Apply scope filter
  let entries = [...fileScores.entries()];
  if (params.scope === "docs") {
    entries = entries.filter(([p]) => isDocFile(p));
  } else if (params.scope === "code") {
    entries = entries.filter(([p]) => !isDocFile(p));
  }

  // Phase B: apply per-path-prefix score multipliers (repo-shape adaptation)
  if (params.pathPriors && params.pathPriors.size > 0) {
    for (const [filePath, data] of entries) {
      const mult = resolvePathMultiplier(filePath, params.pathPriors);
      if (mult !== 1.0) {
        data.score *= mult;
        if (params.explainScoring) {
          data.reasons.push(`path-prior ×${mult}`);
        }
      }
    }
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
 * Phase C: boost (or inject) files that are 1-hop import-neighbors of an
 * anchor file, or that live directly in the same folder as an anchor.
 *
 * Import-neighbors are a verified relational signal (real edges in the
 * `imports` table); same-folder is a weaker, path-based signal capped to a
 * handful of files per anchor so it can't flood results in large folders.
 * Files already present in `fileScores` (from FTS matches) get their score
 * multiplied; files with no FTS match are injected with a base score
 * *relative to the current top score* (rather than a fixed constant) so the
 * boost stays competitive regardless of corpus size — a flat constant like
 * "1.2" is invisible on a large corpus where FTS content scores commonly
 * reach 20-40+, but would dominate on a small corpus where scores are ~1-3.
 */
function applyAnchorNeighborhoodBoost(
  db: Database.Database,
  fileScores: Map<
    string,
    {
      score: number;
      reasons: string[];
      spans: Array<{ line: number; text: string }>;
    }
  >,
  anchorFiles: string[],
  explain?: boolean,
): void {
  const anchorSet = new Set(anchorFiles);
  const currentMax = Math.max(
    1,
    ...[...fileScores.values()].map((v) => v.score),
  );
  const IMPORT_NEIGHBOR_MULT = 1.3;
  const IMPORT_NEIGHBOR_BASE = currentMax * 0.5;
  const SAME_FOLDER_MULT = 1.15;
  const SAME_FOLDER_BASE = currentMax * 0.35;
  const SAME_FOLDER_LIMIT_PER_ANCHOR = 8;

  // Tracks which files already received a neighbor-tier boost, independent of
  // `explain` — the reasons array is only populated when explainScoring is on,
  // so it can't be used as the "already boosted" marker (that would let a file
  // matching both tiers get double-multiplied whenever explain is off).
  const boostedFiles = new Set<string>();

  const boost = (
    filePath: string,
    mult: number,
    base: number,
    reason: string,
  ) => {
    if (anchorSet.has(filePath) || boostedFiles.has(filePath)) return;
    boostedFiles.add(filePath);
    const existing = fileScores.get(filePath);
    if (existing) {
      existing.score *= mult;
      if (explain) existing.reasons.push(reason);
    } else {
      fileScores.set(filePath, { score: base, reasons: [reason], spans: [] });
    }
  };

  // 1-hop import-neighbors (either direction), a real verified relationship.
  // The second half is restricted to is_relative=1 because non-relative
  // imports store the raw package specifier (e.g. "@backstage/types") as
  // target_file, which is not a real file path.
  const placeholders = anchorFiles.map(() => "?").join(",");
  const neighborRows = db
    .prepare(
      `SELECT DISTINCT source_file AS f FROM imports WHERE target_file IN (${placeholders})
       UNION
       SELECT DISTINCT target_file AS f FROM imports WHERE source_file IN (${placeholders}) AND is_relative = 1`,
    )
    .all(...anchorFiles, ...anchorFiles) as Array<{ f: string | null }>;
  for (const row of neighborRows) {
    if (row.f && !anchorSet.has(row.f)) {
      boost(
        row.f,
        IMPORT_NEIGHBOR_MULT,
        IMPORT_NEIGHBOR_BASE,
        "anchor-neighbor: import",
      );
    }
  }

  // Same-folder files (one level deep only), capped per anchor.
  for (const anchor of anchorFiles) {
    const dir = path.dirname(anchor);
    if (!dir || dir === ".") continue;
    const rows = db
      .prepare(
        `SELECT path FROM files WHERE path LIKE ? AND path NOT LIKE ? AND path != ? LIMIT ?`,
      )
      .all(
        `${dir}/%`,
        `${dir}/%/%`,
        anchor,
        SAME_FOLDER_LIMIT_PER_ANCHOR,
      ) as Array<{
      path: string;
    }>;
    for (const row of rows) {
      boost(
        row.path,
        SAME_FOLDER_MULT,
        SAME_FOLDER_BASE,
        "anchor-neighbor: same folder",
      );
    }
  }
}

/**
 * Resolve the multiplier for a given file path by finding the longest matching
 * prefix in the priors map.  Most-specific (longest) prefix wins.
 * Returns 1.0 if no prefix matches.
 */
function resolvePathMultiplier(
  filePath: string,
  priors: Map<string, number>,
): number {
  let best = 1.0;
  let bestLen = -1;
  for (const [prefix, mult] of priors) {
    if (
      (filePath === prefix || filePath.startsWith(prefix + "/")) &&
      prefix.length > bestLen
    ) {
      best = mult;
      bestLen = prefix.length;
    }
  }
  return best;
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
  // Annotations are single keywords — use OR so any matching term scores the file
  return tokens.join(" OR ");
}
