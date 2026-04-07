// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: orphanedSections
 *
 * Detect heading sections in docs where none of the mentioned entities
 * resolve to code symbols. Likely: outdated descriptions, removed API docs.
 */

import type Database from "better-sqlite3";
import type { OrphanedSectionsResult } from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Find orphaned documentation sections from the index.
 */
export function orphanedSections(dbPath: string): OrphanedSectionsResult {
  const db = openIndex(dbPath);
  try {
    return orphanedSectionsFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core orphaned sections logic against an open database.
 */
export function orphanedSectionsFromDb(
  db: Database.Database,
): OrphanedSectionsResult {
  // Get all heading annotations (these mark section boundaries)
  const headings = db
    .prepare(
      `
      SELECT doc_path, line, text, symbol_id
      FROM annotations
      WHERE source = 'heading'
      ORDER BY doc_path, line
    `,
    )
    .all() as Array<{
    doc_path: string;
    line: number;
    text: string;
    symbol_id: string | null;
  }>;

  // Get all annotations ordered by doc + line
  const allAnnotations = db
    .prepare(
      `
      SELECT doc_path, line, symbol_id
      FROM annotations
      ORDER BY doc_path, line
    `,
    )
    .all() as Array<{
    doc_path: string;
    line: number;
    symbol_id: string | null;
  }>;

  // Group annotations by doc_path
  const annotationsByDoc = new Map<
    string,
    Array<{ line: number; symbol_id: string | null }>
  >();
  for (const a of allAnnotations) {
    if (!annotationsByDoc.has(a.doc_path)) {
      annotationsByDoc.set(a.doc_path, []);
    }
    annotationsByDoc.get(a.doc_path)!.push({
      line: a.line,
      symbol_id: a.symbol_id,
    });
  }

  // Group headings by doc_path
  const headingsByDoc = new Map<
    string,
    Array<{ line: number; text: string; symbol_id: string | null }>
  >();
  for (const h of headings) {
    if (!headingsByDoc.has(h.doc_path)) {
      headingsByDoc.set(h.doc_path, []);
    }
    headingsByDoc.get(h.doc_path)!.push({
      line: h.line,
      text: h.text,
      symbol_id: h.symbol_id,
    });
  }

  const orphaned: OrphanedSectionsResult["sections"] = [];

  for (const [docPath, docHeadings] of headingsByDoc) {
    const docAnnotations = annotationsByDoc.get(docPath) ?? [];

    for (let i = 0; i < docHeadings.length; i++) {
      const heading = docHeadings[i];
      const nextHeadingLine =
        i + 1 < docHeadings.length ? docHeadings[i + 1].line : Infinity;

      // Find annotations in this section (between this heading and the next)
      const sectionAnnotations = docAnnotations.filter(
        (a) => a.line >= heading.line && a.line < nextHeadingLine,
      );

      if (sectionAnnotations.length === 0) continue;

      // Check if ALL annotations in this section are ungrounded
      const allUngrounded = sectionAnnotations.every(
        (a) => a.symbol_id === null,
      );

      if (allUngrounded) {
        orphaned.push({
          docPath,
          heading: heading.text,
          line: heading.line,
          ungroundedMentions: sectionAnnotations.length,
        });
      }
    }
  }

  return {
    sections: orphaned,
    totalOrphaned: orphaned.length,
  };
}
