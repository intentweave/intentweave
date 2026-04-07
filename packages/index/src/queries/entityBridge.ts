// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Queries: Entity Bridge
 *
 * mentionsOf — find all doc mentions that reference an entity (symbol or external).
 * annotationsForFile — list all annotations for a given document, with entity resolution.
 */

import type Database from "better-sqlite3";
import type {
  MentionsOfParams,
  MentionsOfResult,
  AnnotationsForFileParams,
  AnnotationsForFileResult,
  ExternalEntity,
} from "../types.js";
import { openIndex } from "./shared.js";

// =============================================================================
// mentionsOf
// =============================================================================

/**
 * Find all document mentions that reference a given entity.
 * Works for both code symbols (from AX) and external entities (from Entity Bridge).
 */
export function mentionsOf(
  dbPath: string,
  params: MentionsOfParams,
): MentionsOfResult {
  const db = openIndex(dbPath);
  try {
    return mentionsOfFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core mentionsOf logic against an open database.
 */
export function mentionsOfFromDb(
  db: Database.Database,
  params: MentionsOfParams,
): MentionsOfResult {
  const { entityId, minConfidence = 0, limit = 100 } = params;

  // Direct annotations referencing this entity ID
  const directRows = db
    .prepare(
      `SELECT doc_path, line, text, confidence, source, qualifier
       FROM annotations
       WHERE symbol_id = ?
         AND confidence >= ?
       ORDER BY confidence DESC, doc_path, line
       LIMIT ?`,
    )
    .all(entityId, minConfidence, limit) as Array<{
    doc_path: string;
    line: number;
    text: string;
    confidence: number;
    source: string;
    qualifier: string | null;
  }>;

  // For external entities, also match by name/aliases in ungrounded annotations
  let aliasRows: typeof directRows = [];
  const extEntity = getExternalEntity(db, entityId);
  if (extEntity) {
    const names = [extEntity.name, ...(extEntity.aliases ?? [])].map((n) =>
      n.toLowerCase(),
    );
    const placeholders = names.map(() => "LOWER(text) = ?").join(" OR ");
    aliasRows = db
      .prepare(
        `SELECT doc_path, line, text, confidence, source, qualifier
         FROM annotations
         WHERE symbol_id IS NULL
           AND (${placeholders})
           AND confidence >= ?
         ORDER BY confidence DESC, doc_path, line
         LIMIT ?`,
      )
      .all(...names, minConfidence, limit) as typeof directRows;
  }

  // Merge and deduplicate by (docPath, line, text)
  const seen = new Set<string>();
  const mentions: MentionsOfResult["mentions"] = [];

  for (const row of [...directRows, ...aliasRows]) {
    const key = `${row.doc_path}:${row.line}:${row.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({
      docPath: row.doc_path,
      line: row.line,
      text: row.text,
      confidence: row.confidence,
      source: row.source,
      qualifier: row.qualifier ?? undefined,
    });
  }

  // Sort by confidence descending, then path/line
  mentions.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.docPath.localeCompare(b.docPath) ||
      a.line - b.line,
  );

  return {
    entityId,
    mentions: mentions.slice(0, limit),
    totalCount: mentions.length,
  };
}

// =============================================================================
// annotationsForFile
// =============================================================================

/**
 * List all annotations for a given document file, resolving entity names
 * from both the symbols and external_entities tables.
 */
export function annotationsForFile(
  dbPath: string,
  params: AnnotationsForFileParams,
): AnnotationsForFileResult {
  const db = openIndex(dbPath);
  try {
    return annotationsForFileFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core annotationsForFile logic against an open database.
 */
export function annotationsForFileFromDb(
  db: Database.Database,
  params: AnnotationsForFileParams,
): AnnotationsForFileResult {
  const { filePath, minConfidence = 0, limit = 500 } = params;

  const rows = db
    .prepare(
      `SELECT a.text, a.symbol_id, a.line, a.confidence, a.source, a.qualifier,
              s.name AS symbol_name,
              e.name AS external_name, e.type AS external_type
       FROM annotations a
       LEFT JOIN symbols s ON a.symbol_id = s.id
       LEFT JOIN external_entities e ON a.symbol_id = e.id
       WHERE a.doc_path = ?
         AND a.confidence >= ?
       ORDER BY a.line, a.confidence DESC
       LIMIT ?`,
    )
    .all(filePath, minConfidence, limit) as Array<{
    text: string;
    symbol_id: string | null;
    line: number;
    confidence: number;
    source: string;
    qualifier: string | null;
    symbol_name: string | null;
    external_name: string | null;
    external_type: string | null;
  }>;

  const annotations: AnnotationsForFileResult["annotations"] = rows.map(
    (r) => ({
      text: r.text,
      entityId: r.symbol_id,
      entityName: r.external_name ?? r.symbol_name ?? undefined,
      entitySource: r.external_name
        ? ("external" as const)
        : r.symbol_name
          ? ("symbol" as const)
          : undefined,
      line: r.line,
      confidence: r.confidence,
      source: r.source,
      qualifier: r.qualifier ?? undefined,
    }),
  );

  return {
    filePath,
    annotations,
    totalCount: annotations.length,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function getExternalEntity(
  db: Database.Database,
  entityId: string,
): ExternalEntity | null {
  try {
    const row = db
      .prepare(
        `SELECT id, name, type, aliases, metadata FROM external_entities WHERE id = ?`,
      )
      .get(entityId) as
      | {
          id: string;
          name: string;
          type: string;
          aliases: string | null;
          metadata: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      aliases: row.aliases ? JSON.parse(row.aliases) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  } catch {
    // Table might not exist in older indexes
    return null;
  }
}
