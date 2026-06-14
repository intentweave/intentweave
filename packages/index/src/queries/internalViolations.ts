// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: internalViolations (14.2)
 *
 * Detects imports of @internal or _prefix symbols across package boundaries.
 *
 * Two detection modes (both active by default):
 *  - "jsdoc" : symbols with is_internal=1 (from @internal JSDoc tag) that are
 *              imported by a file in a different package
 *  - "_prefix": exported symbols whose name starts with "_" that are imported
 *               by a file in a different package
 *
 * "Different package" is determined by the first two path segments, e.g.
 *   packages/resolver  vs  packages/index  — different packages
 *   apps/ui/views      vs  apps/ui/routes  — same package
 *
 * $0 / no LLM — pure SQLite queries after index build.
 */

import type Database from "@intentweave/sqlite-compat";
import type { InternalViolationsResult } from "../types.js";
import { openIndex } from "./shared.js";

// ── Options ───────────────────────────────────────────────────────────────────

export interface InternalViolationsOptions {
  /** Enforce @internal JSDoc tag violations (default: true) */
  checkJsDoc?: boolean;
  /** Enforce _prefix convention violations (default: true) */
  checkUnderscore?: boolean;
  /** Only report violations in these files (incremental CI) */
  changed?: string[];
  /** Maximum violations to return */
  limit?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Return the "package prefix" — the first two directory segments of a path.
 * e.g. "packages/resolver/src/fqn.ts" → "packages/resolver"
 *      "apps/ui/views/View.tsx"         → "apps/ui"
 */
function packageOf(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(0, 2).join("/");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function internalViolations(
  dbPath: string,
  opts: InternalViolationsOptions = {},
): InternalViolationsResult {
  const db = openIndex(dbPath);
  try {
    return internalViolationsFromDb(db, opts);
  } finally {
    db.close();
  }
}

export function internalViolationsFromDb(
  db: Database.Database,
  opts: InternalViolationsOptions = {},
): InternalViolationsResult {
  const checkJsDoc = opts.checkJsDoc ?? true;
  const checkUnderscore = opts.checkUnderscore ?? true;
  const limit = opts.limit ?? 200;
  const changedSet = opts.changed ? new Set(opts.changed) : null;

  // Find all internal symbols (exported so they can be imported)
  const conditions: string[] = [];
  if (checkJsDoc) conditions.push("is_internal = 1");
  if (checkUnderscore)
    conditions.push("(name LIKE '\\_%' ESCAPE '\\' AND export = 'exported')");

  if (conditions.length === 0) {
    return {
      violations: [],
      totalViolations: 0,
      byMarker: { jsdoc: 0, underscore: 0 },
    };
  }

  const internalSymbols = db
    .prepare(
      `SELECT id, name, file_path, line, is_internal, export
       FROM symbols
       WHERE (${conditions.join(" OR ")}) AND export = 'exported'
       ORDER BY name`,
    )
    .all() as Array<{
    id: string;
    name: string;
    file_path: string;
    line: number;
    is_internal: number;
    export: string;
  }>;

  if (internalSymbols.length === 0) {
    return {
      violations: [],
      totalViolations: 0,
      byMarker: { jsdoc: 0, underscore: 0 },
    };
  }

  // Build set of importer files that use each symbol name
  // We join imports.imported_names (JSON array) against the symbol name
  const allImports = db
    .prepare(
      `SELECT source_file, target_file, imported_names FROM imports WHERE target_file IS NOT NULL`,
    )
    .all() as Array<{
    source_file: string;
    target_file: string | null;
    imported_names: string | null;
  }>;

  // Map: targetFile → { sourceFile, importedNames[] }[]
  const importsByTarget = new Map<
    string,
    Array<{ sourceFile: string; importedNames: string[] }>
  >();
  for (const imp of allImports) {
    if (!imp.target_file) continue;
    let names: string[] = [];
    try {
      names = imp.imported_names
        ? (JSON.parse(imp.imported_names) as string[])
        : [];
    } catch {
      names = [];
    }
    if (!importsByTarget.has(imp.target_file))
      importsByTarget.set(imp.target_file, []);
    importsByTarget
      .get(imp.target_file)!
      .push({ sourceFile: imp.source_file, importedNames: names });
  }

  const violations: InternalViolationsResult["violations"] = [];
  const byMarker = { jsdoc: 0, underscore: 0 };

  for (const sym of internalSymbols) {
    const symPkg = packageOf(sym.file_path);
    const importers = importsByTarget.get(sym.file_path) ?? [];

    for (const imp of importers) {
      const importerPkg = packageOf(imp.sourceFile);
      // Same package — allowed
      if (importerPkg === symPkg) continue;

      // Check if this importer actually imports the symbol name
      const importsSymbol =
        imp.importedNames.length === 0 || // namespace import (import * as …) — flag it
        imp.importedNames.includes(sym.name);
      if (!importsSymbol) continue;

      // Apply changed-files filter
      if (changedSet && !changedSet.has(imp.sourceFile)) continue;

      const isJsDoc = sym.is_internal === 1;
      const isUnderscore = sym.name.startsWith("_");
      const marker: "jsdoc" | "_prefix" = isJsDoc ? "jsdoc" : "_prefix";

      if (marker === "jsdoc") byMarker.jsdoc++;
      else byMarker.underscore++;

      violations.push({
        symbolId: sym.id,
        symbolName: sym.name,
        symbolFile: sym.file_path,
        symbolLine: sym.line,
        marker,
        importerFile: imp.sourceFile,
        importerPackage: importerPkg,
        symbolPackage: symPkg,
      });

      if (violations.length >= limit) break;
    }
    if (violations.length >= limit) break;
  }

  return {
    violations,
    totalViolations: violations.length,
    byMarker,
  };
}
