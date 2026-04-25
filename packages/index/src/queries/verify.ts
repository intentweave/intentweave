// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: Spec-to-Code Verification (12.1)
 *
 * Checks whether KG entities (from enrichment) are grounded in code symbols.
 * For each entity in kg_entities, looks up annotations to see if there's a
 * corresponding code symbol. Optionally checks test coverage for grounded symbols.
 *
 * Flow:
 *   kg_entities → external_entities (via bridge) → annotations → symbols
 *   If annotation.symbol_id points to a real code symbol → grounded.
 *   If only external entity matches exist → partial (no code backing).
 *   If no mentions at all → ungrounded.
 *   If grounded but symbol has no test → untested.
 */

import type Database from "better-sqlite3";
import type {
  VerifyParams,
  VerifyResult,
  VerifyEntityResult,
  GroundingStatus,
} from "../types.js";
import { openIndex } from "./shared.js";

// =============================================================================
// Public API — dual signature
// =============================================================================

/**
 * Verify that KG entities are grounded in code.
 * Opens and closes the database.
 */
export function verify(dbPath: string, params?: VerifyParams): VerifyResult {
  const db = openIndex(dbPath);
  try {
    return verifyFromDb(db, params);
  } finally {
    db.close();
  }
}

/**
 * Core verify logic against an open database.
 */
export function verifyFromDb(
  db: Database.Database,
  params?: VerifyParams,
): VerifyResult {
  const minConfidence = params?.minConfidence ?? 0.5;
  const checkTests = params?.checkTests ?? true;

  // ── 1. Load KG entities ─────────────────────────────────────────────────
  let entityQuery = `SELECT id, canon_id, name, type, source_file FROM kg_entities`;
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  if (params?.files && params.files.length > 0) {
    conditions.push(
      `source_file IN (${params.files.map(() => "?").join(", ")})`,
    );
    queryParams.push(...params.files);
  }

  if (params?.types && params.types.length > 0) {
    conditions.push(`type IN (${params.types.map(() => "?").join(", ")})`);
    queryParams.push(...params.types);
  }

  if (conditions.length > 0) {
    entityQuery += ` WHERE ${conditions.join(" AND ")}`;
  }
  entityQuery += ` ORDER BY source_file, name`;

  // Check if kg_entities table exists (enrichment may not have been run)
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'`,
    )
    .get();
  if (!tableExists) {
    return {
      entities: [],
      summary: {
        total: 0,
        grounded: 0,
        ungrounded: 0,
        partial: 0,
        untested: 0,
        coveragePercent: 0,
      },
      byFile: [],
    };
  }

  const kgEntities = db.prepare(entityQuery).all(...queryParams) as Array<{
    id: number;
    canon_id: string;
    name: string;
    type: string;
    source_file: string;
  }>;

  if (kgEntities.length === 0) {
    return {
      entities: [],
      summary: {
        total: 0,
        grounded: 0,
        ungrounded: 0,
        partial: 0,
        untested: 0,
        coveragePercent: 0,
      },
      byFile: [],
    };
  }

  // ── 2. Build test coverage map (if requested) ───────────────────────────
  const testedSymbols = new Set<string>();
  if (checkTests) {
    // Symbols that are imported by at least one test file
    const testRows = db
      .prepare(
        `SELECT DISTINCT i.imported_names
         FROM imports i
         JOIN files f ON f.path = i.source_file
         WHERE f.path LIKE '%.test.%'
            OR f.path LIKE '%.spec.%'
            OR f.path LIKE '%__tests__%'`,
      )
      .all() as Array<{ imported_names: string | null }>;

    for (const row of testRows) {
      if (row.imported_names) {
        for (const name of row.imported_names.split(",")) {
          testedSymbols.add(name.trim());
        }
      }
    }
  }

  // ── 3. Check grounding for each entity ──────────────────────────────────
  // Find annotations that link to code symbols (not external entities)
  // by checking if the bridged entity (kg:<canon_id>) has any annotations
  // whose underlying text also appears as a code symbol annotation.
  const findCodeGrounding = db.prepare(`
    SELECT DISTINCT s.id AS symbol_id, s.name AS symbol_name,
           s.file_path, s.kind, a.confidence
    FROM annotations a
    JOIN symbols s ON a.symbol_id = s.id
    WHERE LOWER(a.text) = LOWER(?)
      AND a.confidence >= ?
    ORDER BY a.confidence DESC
    LIMIT 10
  `);

  // Also check direct bridge annotations (kg: prefixed symbol_id)
  const findBridgeAnnotations = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM annotations
    WHERE symbol_id = ?
      AND confidence >= ?
  `);

  const results: VerifyEntityResult[] = [];

  for (const entity of kgEntities) {
    const kgEntityId = `kg:${entity.canon_id}`;

    // Check for real code symbol grounding by name matching
    const codeGroundings = findCodeGrounding.all(
      entity.name,
      minConfidence,
    ) as Array<{
      symbol_id: string;
      symbol_name: string;
      file_path: string;
      kind: string;
      confidence: number;
    }>;

    // Also try aliases if stored
    const aliasRow = db
      .prepare(`SELECT aliases FROM kg_entities WHERE canon_id = ?`)
      .get(entity.canon_id) as { aliases: string | null } | undefined;
    const aliases: string[] = aliasRow?.aliases
      ? JSON.parse(aliasRow.aliases)
      : [];

    for (const alias of aliases) {
      if (alias.toLowerCase() === entity.name.toLowerCase()) continue;
      const aliasGroundings = findCodeGrounding.all(
        alias,
        minConfidence,
      ) as typeof codeGroundings;
      for (const g of aliasGroundings) {
        if (!codeGroundings.some((cg) => cg.symbol_id === g.symbol_id)) {
          codeGroundings.push(g);
        }
      }
    }

    // Check bridge annotation count
    const bridgeCount = (
      findBridgeAnnotations.get(kgEntityId, minConfidence) as {
        cnt: number;
      }
    ).cnt;

    // Determine status
    let status: GroundingStatus;
    let hasCoverage = false;

    if (codeGroundings.length > 0) {
      // Check test coverage
      hasCoverage = codeGroundings.some((g) =>
        testedSymbols.has(g.symbol_name),
      );

      if (checkTests && !hasCoverage) {
        status = "untested";
      } else {
        status = "grounded";
      }
    } else if (bridgeCount > 0) {
      // Entity is mentioned in docs but has no code symbol backing
      status = "partial";
    } else {
      status = "ungrounded";
    }

    // Build message
    let message: string;
    switch (status) {
      case "grounded":
        message = `"${entity.name}" → found: ${codeGroundings.map((g) => `${g.symbol_name} in ${g.file_path}`).join(", ")}`;
        break;
      case "untested":
        message = `"${entity.name}" → mentioned in ${codeGroundings[0].file_path} but no test coverage`;
        break;
      case "partial":
        message = `"${entity.name}" → mentioned in docs but no code symbol found`;
        break;
      case "ungrounded":
        message = `"${entity.name}" → no code references found (unimplemented?)`;
        break;
    }

    results.push({
      canonId: entity.canon_id,
      name: entity.name,
      entityType: entity.type,
      sourceFile: entity.source_file,
      status,
      groundedIn: codeGroundings.map((g) => ({
        symbolId: g.symbol_id,
        symbolName: g.symbol_name,
        filePath: g.file_path,
        kind: g.kind,
        confidence: g.confidence,
      })),
      hasCoverage,
      message,
    });
  }

  // ── 4. Compute summaries ────────────────────────────────────────────────
  const total = results.length;
  const grounded = results.filter((r) => r.status === "grounded").length;
  const ungrounded = results.filter((r) => r.status === "ungrounded").length;
  const partial = results.filter((r) => r.status === "partial").length;
  const untested = results.filter((r) => r.status === "untested").length;
  const coveragePercent =
    total > 0 ? Math.round(((grounded + untested) / total) * 100) : 0;

  // Per-file breakdown
  const fileMap = new Map<
    string,
    { total: number; grounded: number; ungrounded: number }
  >();
  for (const r of results) {
    const entry = fileMap.get(r.sourceFile) ?? {
      total: 0,
      grounded: 0,
      ungrounded: 0,
    };
    entry.total++;
    if (r.status === "grounded" || r.status === "untested") entry.grounded++;
    if (r.status === "ungrounded") entry.ungrounded++;
    fileMap.set(r.sourceFile, entry);
  }

  const byFile = [...fileMap.entries()].map(([file, stats]) => ({
    file,
    total: stats.total,
    grounded: stats.grounded,
    ungrounded: stats.ungrounded,
    coveragePercent:
      stats.total > 0 ? Math.round((stats.grounded / stats.total) * 100) : 0,
  }));

  return {
    entities: results,
    summary: {
      total,
      grounded,
      ungrounded,
      partial,
      untested,
      coveragePercent,
    },
    byFile,
  };
}
