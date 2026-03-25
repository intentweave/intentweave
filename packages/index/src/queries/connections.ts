// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: connections
 *
 * Given an entity name, discovers connections across three evidence layers:
 * 1. Doc co-occurrence — entities mentioned together in documents
 * 2. Git co-change — files that change together in commits
 * 3. Code structure — annotations linking doc mentions to code symbols
 *
 * The unique value is in the **gaps**: pairs present in one source
 * but absent in another, revealing hidden couplings.
 */

import type Database from "better-sqlite3";
import type {
  ConnectionsParams,
  ConnectionsResult,
  Connection,
  ConnectionGap,
  ConnectionSourceType,
} from "../types.js";
import { openIndex } from "./shared.js";

/**
 * Discover connections for an entity across all evidence sources.
 */
export function connections(
  dbPath: string,
  params: ConnectionsParams,
): ConnectionsResult {
  const db = openIndex(dbPath);
  try {
    return connectionsFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core connections logic against an open database.
 */
export function connectionsFromDb(
  db: Database.Database,
  params: ConnectionsParams,
): ConnectionsResult {
  const limit = params.limit ?? 10;
  const entity = params.entity.trim().toLowerCase();
  const include = params.include ?? ["doc_cooc", "co_change", "code_import"];

  // Collect connections from each source
  const connMap = new Map<
    string,
    { sources: Map<ConnectionSourceType, { score: number; detail: string }> }
  >();

  const addConn = (
    name: string,
    type: ConnectionSourceType,
    score: number,
    detail: string,
  ) => {
    const existing = connMap.get(name) ?? { sources: new Map() };
    existing.sources.set(type, { score, detail });
    connMap.set(name, existing);
  };

  // ── 1. Doc co-occurrence ────────────────────────────────────
  if (include.includes("doc_cooc")) {
    const coocs = db
      .prepare(
        `
        SELECT entity_a, entity_b, count, score, file_paths
        FROM co_occurrences
        WHERE (LOWER(entity_a) = ? OR LOWER(entity_b) = ?)
          AND source = 'doc_cooc'
        ORDER BY score DESC
        LIMIT ?
      `,
      )
      .all(entity, entity, limit * 2) as Array<{
      entity_a: string;
      entity_b: string;
      count: number;
      score: number;
      file_paths: string | null;
    }>;

    for (const row of coocs) {
      const other =
        row.entity_a.toLowerCase() === entity ? row.entity_b : row.entity_a;
      const docCount = row.file_paths ? JSON.parse(row.file_paths).length : 0;
      addConn(
        other,
        "doc_cooc",
        row.score,
        `${docCount} doc(s), count=${row.count}`,
      );
    }
  }

  // ── 2. Git co-change ────────────────────────────────────────
  if (include.includes("co_change")) {
    // Find files containing annotations for this entity
    const entityFiles = db
      .prepare(
        `
        SELECT DISTINCT s.file_path
        FROM annotations a
        JOIN symbols s ON s.id = a.symbol_id
        WHERE LOWER(a.text) = ?
      `,
      )
      .all(entity) as Array<{ file_path: string }>;

    const entityFilePaths = entityFiles.map((f) => f.file_path);

    for (const fp of entityFilePaths) {
      const cochanges = db
        .prepare(
          `
          SELECT file_a, file_b, count, jaccard, recency
          FROM co_changes
          WHERE file_a = ? OR file_b = ?
          ORDER BY jaccard DESC
          LIMIT ?
        `,
        )
        .all(fp, fp, limit) as Array<{
        file_a: string;
        file_b: string;
        count: number;
        jaccard: number;
        recency: number;
      }>;

      for (const row of cochanges) {
        const other = row.file_a === fp ? row.file_b : row.file_a;
        addConn(
          other,
          "co_change",
          row.jaccard,
          `jaccard=${row.jaccard.toFixed(2)}, ${row.count} commits`,
        );
      }
    }
  }

  // ── 3. Code structure (annotation → symbol file) ────────────
  if (include.includes("code_import")) {
    // Find symbols matching this entity name
    const symbols = db
      .prepare(
        `
        SELECT DISTINCT s.file_path, s.name
        FROM symbols s
        WHERE LOWER(s.name) = ?
      `,
      )
      .all(entity) as Array<{ file_path: string; name: string }>;

    for (const sym of symbols) {
      // Find other symbols in the same file (structural proximity)
      const sameFile = db
        .prepare(
          `
          SELECT DISTINCT name FROM symbols
          WHERE file_path = ? AND LOWER(name) != ?
          LIMIT ?
        `,
        )
        .all(sym.file_path, entity, limit) as Array<{ name: string }>;

      for (const other of sameFile) {
        addConn(other.name, "code_import", 0.6, `same file: ${sym.file_path}`);
      }
    }

    // Find doc files that reference this entity (annotation links)
    const docRefs = db
      .prepare(
        `
        SELECT DISTINCT a.doc_path, COUNT(*) as cnt
        FROM annotations a
        WHERE LOWER(a.text) = ?
        GROUP BY a.doc_path
        ORDER BY cnt DESC
        LIMIT ?
      `,
      )
      .all(entity, limit) as Array<{ doc_path: string; cnt: number }>;

    for (const ref of docRefs) {
      addConn(ref.doc_path, "code_import", 0.5, `${ref.cnt} annotation(s)`);
    }
  }

  // ── Build connections list ──────────────────────────────────
  const connectionsList: Connection[] = [];
  for (const [name, data] of connMap) {
    connectionsList.push({
      name,
      sources: [...data.sources.entries()].map(([type, info]) => ({
        type,
        score: Math.round(info.score * 100) / 100,
        detail: info.detail,
      })),
    });
  }

  // Sort by max score across sources
  connectionsList.sort((a, b) => {
    const maxA = Math.max(...a.sources.map((s) => s.score));
    const maxB = Math.max(...b.sources.map((s) => s.score));
    return maxB - maxA;
  });

  // ── Detect gaps ─────────────────────────────────────────────
  const gaps: ConnectionGap[] = [];

  for (const conn of connectionsList) {
    const sourceTypes = new Set(conn.sources.map((s) => s.type));

    // Gap: co-mentioned in docs but no code dependency
    if (sourceTypes.has("doc_cooc") && !sourceTypes.has("code_import")) {
      const docSource = conn.sources.find((s) => s.type === "doc_cooc")!;
      conn.gap = `Co-mentioned in docs (${docSource.detail}) but no code dependency`;
      gaps.push({
        description: `${conn.name} co-mentioned in docs but no code dependency → hidden coupling?`,
        severity: "warning",
        entities: [params.entity, conn.name],
      });
    }

    // Gap: code dependency but zero doc mentions
    if (sourceTypes.has("code_import") && !sourceTypes.has("doc_cooc")) {
      conn.gap = `Code dependency but not co-mentioned in any docs`;
      gaps.push({
        description: `${conn.name} has code dependency but zero doc co-mentions → undocumented dependency`,
        severity: "info",
        entities: [params.entity, conn.name],
      });
    }
  }

  return {
    entity: params.entity,
    connections: connectionsList.slice(0, limit),
    gaps,
  };
}
