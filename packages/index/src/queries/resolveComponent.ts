// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: resolveComponent
 *
 * Maps an architecture diagram component name to concrete index entries
 * (code symbols, annotation text, co-occurrence partners) without any LLM.
 *
 * Three evidence layers queried in order of confidence:
 *   1. Exact symbol name match  (confidence 0.85–1.0)
 *   2. FTS symbol match         (confidence 0.5–0.8)
 *   3. Annotation exact match   (grounded: 0.6–0.8 / ungrounded: 0.3–0.5)
 *   4. Co-occurrence signal     (confidence 0.1–0.3 — confirms the name exists)
 *
 * The `terms` field in the result contains the resolved lookup strings.
 * `diagramEntityCheck` can use them directly in place of LLM-guessed aliases.
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  ResolveComponentParams,
  ResolveComponentResult,
  ResolvedComponent,
  ResolvedSymbol,
} from "../types.js";
import { openIndex } from "./shared.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function resolveComponent(
  dbPath: string,
  params: ResolveComponentParams,
): ResolveComponentResult {
  const db = openIndex(dbPath);
  try {
    return resolveComponentFromDb(db, params);
  } finally {
    db.close();
  }
}

export function resolveComponentFromDb(
  db: Database.Database,
  params: ResolveComponentParams,
): ResolveComponentResult {
  const limitSymbols = params.limitSymbols ?? 10;
  const limitDocs = params.limitDocs ?? 5;
  const name = params.name.trim();
  const nameLower = name.toLowerCase();

  const terms = new Set<string>([nameLower]);
  const symbols: ResolvedSymbol[] = [];
  const docFileScores = new Map<string, number>();
  const evidence: string[] = [];
  let confidence = 0;

  // ── Layer 1: Exact symbol name match ─────────────────────────────────────
  const exactSymbols = db
    .prepare(
      `SELECT id, name, kind, file_path FROM symbols
       WHERE LOWER(name) = ?
       LIMIT ?`,
    )
    .all(nameLower, limitSymbols) as Array<{
    id: string;
    name: string;
    kind: string;
    file_path: string;
  }>;

  for (const s of exactSymbols) {
    symbols.push({
      id: s.id,
      name: s.name,
      kind: s.kind,
      filePath: s.file_path,
    });
    terms.add(s.name.toLowerCase());
  }

  if (exactSymbols.length > 0) {
    confidence = Math.max(
      confidence,
      0.85 + Math.min(exactSymbols.length - 1, 3) * 0.05,
    );
    evidence.push(
      `exact symbol match: ${exactSymbols.map((s) => `${s.kind} "${s.name}"`).join(", ")}`,
    );
  }

  // ── Layer 2: FTS symbol match ─────────────────────────────────────────────
  // Only run if exact match gave < 3 results — avoid flooding with FTS noise
  if (symbols.length < 3) {
    const ftsQuery = sanitizeFts(name);
    if (ftsQuery) {
      const ftsSymbols = db
        .prepare(
          `SELECT s.id, s.name, s.kind, s.file_path
           FROM symbols s
           JOIN symbols_fts fts ON fts.rowid = s.rowid
           WHERE symbols_fts MATCH ?
           LIMIT ?`,
        )
        .all(ftsQuery, limitSymbols) as Array<{
        id: string;
        name: string;
        kind: string;
        file_path: string;
      }>;

      let added = 0;
      for (const s of ftsSymbols) {
        if (symbols.some((e) => e.id === s.id)) continue; // deduplicate
        symbols.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          filePath: s.file_path,
        });
        terms.add(s.name.toLowerCase());
        added++;
      }

      if (added > 0) {
        confidence = Math.max(confidence, 0.55 + Math.min(added - 1, 4) * 0.05);
        evidence.push(`FTS symbol match: ${added} result(s) for "${name}"`);
      }
    }
  }

  // ── Layer 3: Annotation exact match ──────────────────────────────────────
  const annotationRows = db
    .prepare(
      `SELECT a.text, a.symbol_id, a.confidence, a.doc_path,
              s.name AS sym_name, s.kind AS sym_kind, s.file_path AS sym_file
       FROM annotations a
       LEFT JOIN symbols s ON s.id = a.symbol_id
       WHERE LOWER(a.text) = ?
       LIMIT 200`,
    )
    .all(nameLower) as Array<{
    text: string;
    symbol_id: string | null;
    confidence: number;
    doc_path: string;
    sym_name: string | null;
    sym_kind: string | null;
    sym_file: string | null;
  }>;

  let groundedAnnotations = 0;
  let ungroundedAnnotations = 0;
  const annotationDocs = new Set<string>();

  for (const row of annotationRows) {
    annotationDocs.add(row.doc_path);
    docFileScores.set(
      row.doc_path,
      (docFileScores.get(row.doc_path) ?? 0) + row.confidence,
    );

    if (row.sym_name && row.sym_file) {
      groundedAnnotations++;
      // Add the linked symbol if not already present
      if (row.symbol_id && !symbols.some((s) => s.id === row.symbol_id)) {
        symbols.push({
          id: row.symbol_id,
          name: row.sym_name,
          kind: row.sym_kind ?? "symbol",
          filePath: row.sym_file,
        });
        terms.add(row.sym_name.toLowerCase());
      }
    } else {
      ungroundedAnnotations++;
    }
  }

  if (groundedAnnotations > 0) {
    confidence = Math.max(confidence, 0.65);
    evidence.push(
      `${groundedAnnotations} grounded annotation(s) for "${name}" in ${annotationDocs.size} doc(s)`,
    );
  } else if (ungroundedAnnotations > 0) {
    confidence = Math.max(confidence, 0.35);
    evidence.push(
      `${ungroundedAnnotations} ungrounded annotation(s) for "${name}" in ${annotationDocs.size} doc(s)`,
    );
  }

  // ── Layer 4: Co-occurrence signal ─────────────────────────────────────────
  // Confirms the name exists in the index as a known entity;
  // also surfaces related entity names that may be better matches.
  const coocRows = db
    .prepare(
      `SELECT entity_a, entity_b, score FROM co_occurrences
       WHERE (LOWER(entity_a) = ? OR LOWER(entity_b) = ?)
         AND source = 'doc_cooc'
       ORDER BY score DESC
       LIMIT 20`,
    )
    .all(nameLower, nameLower) as Array<{
    entity_a: string;
    entity_b: string;
    score: number;
  }>;

  // Also try each already-resolved term (e.g. symbol name may appear in co_occ)
  const extraCoocTerms = [...terms].filter((t) => t !== nameLower);
  for (const t of extraCoocTerms.slice(0, 3)) {
    const extra = db
      .prepare(
        `SELECT entity_a, entity_b, score FROM co_occurrences
         WHERE (LOWER(entity_a) = ? OR LOWER(entity_b) = ?)
           AND source = 'doc_cooc'
         ORDER BY score DESC LIMIT 10`,
      )
      .all(t, t) as typeof coocRows;
    coocRows.push(...extra);
  }

  if (coocRows.length > 0) {
    confidence = Math.max(confidence, 0.2);
    // Score doc files that contain the entity in co-occurrence pairs
    for (const row of coocRows) {
      const filePaths: string[] = (() => {
        try {
          const r = db
            .prepare(
              `SELECT file_paths FROM co_occurrences
               WHERE (LOWER(entity_a) = ? AND LOWER(entity_b) = ?)
                  OR (LOWER(entity_a) = ? AND LOWER(entity_b) = ?)
               LIMIT 1`,
            )
            .get(
              row.entity_a.toLowerCase(),
              row.entity_b.toLowerCase(),
              row.entity_b.toLowerCase(),
              row.entity_a.toLowerCase(),
            ) as { file_paths: string } | undefined;
          return r ? (JSON.parse(r.file_paths) as string[]) : [];
        } catch {
          return [];
        }
      })();
      for (const fp of filePaths) {
        docFileScores.set(fp, (docFileScores.get(fp) ?? 0) + row.score * 0.5);
      }
    }

    if (coocRows.length >= 3 && confidence < 0.3) {
      evidence.push(
        `co-occurrence signal: ${coocRows.length} pair(s) found for "${name}"`,
      );
    }
  }

  // ── Assemble doc files (ordered by aggregated score) ─────────────────────
  const docFiles = [...docFileScores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limitDocs)
    .map(([path]) => path);

  // If we found doc files via annotations but no symbols, note it in evidence
  if (docFiles.length > 0 && symbols.length === 0 && evidence.length === 0) {
    evidence.push(
      `"${name}" mentioned in ${docFiles.length} doc(s) but no code symbol found`,
    );
    confidence = Math.max(confidence, 0.25);
  }

  // No evidence at all
  if (evidence.length === 0) {
    evidence.push(
      `"${name}" not found in symbols, annotations, or co-occurrences`,
    );
  }

  const resolved: ResolvedComponent = {
    name,
    terms: [...terms].slice(0, 20), // cap to prevent runaway lookups
    symbols: symbols.slice(0, limitSymbols),
    docFiles,
    confidence: Math.round(confidence * 100) / 100,
    evidence,
  };

  return { resolved };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a string for FTS5 MATCH queries.
 * Wraps each token in double-quotes to avoid FTS5 syntax errors.
 */
function sanitizeFts(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}
