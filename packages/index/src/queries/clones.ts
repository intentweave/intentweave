// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: clones
 *
 * Exact clone detection via body_hash (Type 1).
 * Structural clone detection via structure_hash (Type 2).
 */

import type Database from "better-sqlite3";
import type { ClonesResult, StructuralClonesResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Detect exact code clones from the index.
 */
export function clones(dbPath: string): ClonesResult {
  const db = openIndex(dbPath);
  try {
    return clonesFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core clone detection logic against an open database.
 */
export function clonesFromDb(db: Database.Database): ClonesResult {
  // Find body hashes shared by more than one symbol
  const groups = db
    .prepare(
      `
      SELECT body_hash, body_lines, COUNT(*) AS cnt
      FROM symbols
      WHERE body_hash IS NOT NULL
      GROUP BY body_hash
      HAVING COUNT(*) > 1
      ORDER BY body_lines DESC, cnt DESC
    `,
    )
    .all() as Array<{ body_hash: string; body_lines: number; cnt: number }>;

  let totalClonedSymbols = 0;

  const cloneGroups = groups.map((g) => {
    const symbols = db
      .prepare(
        `
        SELECT name, file_path, line, kind
        FROM symbols
        WHERE body_hash = ?
      `,
      )
      .all(g.body_hash) as Array<{
      name: string;
      file_path: string;
      line: number;
      kind: string;
    }>;

    totalClonedSymbols += symbols.length;

    return {
      bodyHash: g.body_hash,
      bodyLines: g.body_lines,
      symbols: symbols.map((s) => ({
        name: s.name,
        filePath: s.file_path,
        line: s.line,
        kind: s.kind,
      })),
    };
  });

  return {
    cloneGroups,
    totalCloneGroups: cloneGroups.length,
    totalClonedSymbols,
  };
}

// =============================================================================
// Structural Clones (Type 2)
// =============================================================================

/**
 * Detect structural code clones (same control flow, different identifiers).
 */
export function structuralClones(dbPath: string): StructuralClonesResult {
  const db = openIndex(dbPath);
  try {
    return structuralClonesFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core structural clone detection logic against an open database.
 * Excludes groups that are already exact clones (same body_hash).
 */
export function structuralClonesFromDb(
  db: Database.Database,
): StructuralClonesResult {
  // Find structure hashes shared by more than one symbol,
  // but ONLY where body_hash differs (otherwise it's an exact clone, not structural)
  const groups = db
    .prepare(
      `
      SELECT structure_hash, MAX(body_lines) AS body_lines, COUNT(*) AS cnt,
             COUNT(DISTINCT body_hash) AS distinct_bodies
      FROM symbols
      WHERE structure_hash IS NOT NULL
      GROUP BY structure_hash
      HAVING COUNT(*) > 1 AND COUNT(DISTINCT body_hash) > 1
      ORDER BY body_lines DESC, cnt DESC
    `,
    )
    .all() as Array<{
    structure_hash: string;
    body_lines: number;
    cnt: number;
    distinct_bodies: number;
  }>;

  let totalClonedSymbols = 0;

  const cloneGroups = groups.map((g) => {
    const symbols = db
      .prepare(
        `
        SELECT name, file_path, line, kind
        FROM symbols
        WHERE structure_hash = ?
      `,
      )
      .all(g.structure_hash) as Array<{
      name: string;
      file_path: string;
      line: number;
      kind: string;
    }>;

    totalClonedSymbols += symbols.length;

    return {
      structureHash: g.structure_hash,
      bodyLines: g.body_lines,
      symbols: symbols.map((s) => ({
        name: s.name,
        filePath: s.file_path,
        line: s.line,
        kind: s.kind,
      })),
    };
  });

  return {
    cloneGroups,
    totalCloneGroups: cloneGroups.length,
    totalClonedSymbols,
  };
}
