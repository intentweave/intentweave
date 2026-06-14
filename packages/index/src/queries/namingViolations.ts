// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: namingViolations (6.1)
 *
 * Scans all extracted code symbols and flags those that violate standard
 * naming conventions:
 *   - functions / methods → camelCase
 *   - classes / interfaces / types / enums → PascalCase
 *   - UPPER_SNAKE constants (all-caps names) → UPPER_SNAKE_CASE
 *
 * No LLM or Neo4j needed — queries the local SQLite index.
 */

import type Database from "@intentweave/sqlite-compat";
import type { NamingViolationsResult, NamingViolation } from "../types.js";
import { openIndex } from "./shared.js";

// ---------------------------------------------------------------------------
// Naming patterns
// ---------------------------------------------------------------------------

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/; // external/DB/wire snake_case
// Names like _internal, __proto__ are intentional — skip them
const PRIVATE_PREFIX = /^_/;
// $schema, $ref etc. are JSON Schema / framework conventions — skip them
const DOLLAR_PREFIX = /^\$/;
// Quoted property names like "in.json" are structural — skip them
const QUOTED_NAME = /[^a-zA-Z0-9_$]/;

function checkName(name: string, kind: string): string | null {
  // Skip private-prefixed names
  if (PRIVATE_PREFIX.test(name)) return null;
  // Skip $-prefixed names (JSON Schema convention: $schema, $ref, $id, etc.)
  if (DOLLAR_PREFIX.test(name)) return null;
  // Skip quoted / special-character names ("in.json", computed keys, etc.)
  if (QUOTED_NAME.test(name)) return null;
  // Skip very short names (single-char type params, etc.)
  if (name.length <= 1) return null;

  switch (kind) {
    case "function":
    case "method":
      if (!CAMEL_CASE.test(name) && !PASCAL_CASE.test(name)) {
        return "camelCase (e.g. myFunction)";
      }
      return null;

    case "class":
    case "interface":
    case "type":
    case "enum":
    case "protocol":
    case "struct":
      if (!PASCAL_CASE.test(name)) {
        return "PascalCase (e.g. MyClass)";
      }
      return null;

    case "property":
    case "variable": {
      // UPPER_SNAKE constants are fine; camelCase variables are fine
      if (UPPER_SNAKE.test(name)) return null;
      if (CAMEL_CASE.test(name)) return null;
      if (PASCAL_CASE.test(name)) return null; // allow PascalCase (enum members, etc.)
      // snake_case is a recognised external-data/DB convention — allow it
      if (SNAKE_CASE.test(name)) return null;
      return "camelCase or UPPER_SNAKE_CASE";
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NamingViolationsOptions {
  /** Only flag exported symbols (default: false — checks all) */
  exportedOnly?: boolean;
}

export function namingViolations(
  dbPath: string,
  opts: NamingViolationsOptions = {},
): NamingViolationsResult {
  const db = openIndex(dbPath);
  try {
    return namingViolationsFromDb(db, opts);
  } finally {
    db.close();
  }
}

export function namingViolationsFromDb(
  db: Database.Database,
  opts: NamingViolationsOptions = {},
): NamingViolationsResult {
  const { exportedOnly = false } = opts;

  const sql = exportedOnly
    ? `SELECT name, kind, file_path, line, export FROM symbols WHERE export = 'exported' ORDER BY file_path, line`
    : `SELECT name, kind, file_path, line, export FROM symbols ORDER BY file_path, line`;

  const rows = db.prepare(sql).all() as Array<{
    name: string;
    kind: string;
    file_path: string;
    line: number;
    export: string;
  }>;

  const violations: NamingViolation[] = [];
  const byKind: Record<string, number> = {};

  for (const row of rows) {
    const expected = checkName(row.name, row.kind);
    if (expected !== null) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      violations.push({
        name: row.name,
        kind: row.kind,
        filePath: row.file_path,
        line: row.line,
        expected,
        export: row.export,
      });
    }
  }

  return {
    violations,
    totalViolations: violations.length,
    byKind,
  };
}
