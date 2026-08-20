// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for CARI query modules.
 */

import Database from "@intentweave/sqlite-compat";
import * as fs from "fs";
import { openMigratedDatabase } from "../schema.js";

/**
 * Open the index database in read-only mode.
 * Throws if the file doesn't exist.
 */
const EXPECTED_SCHEMA_VERSION = "17";

export function openIndex(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Index not found at ${dbPath}. Run \`iw index build\` first.`,
    );
  }
  let db: Database.Database;
  try {
    db = openMigratedDatabase(dbPath);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes("_meta"))) {
      throw error;
    }
    db = new Database(dbPath, { readonly: false });
  }
  db.pragma("journal_mode = WAL");

  // Ensure performance indexes exist (one-time cost, idempotent IF NOT EXISTS).
  // These are not in the base schema so that the Rust native builder doesn't need
  // to be updated; they are created on first read and instant on subsequent reads.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_annotations_text
      ON annotations(text);
    CREATE INDEX IF NOT EXISTS idx_co_occ_a_lower
      ON co_occurrences(LOWER(entity_a));
    CREATE INDEX IF NOT EXISTS idx_co_occ_b_lower
      ON co_occurrences(LOWER(entity_b));
  `);

  // Validate schema version — catches indexes built by an incompatible version
  // of cari-native or a very old `iw index build` run.
  try {
    const row = db
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    if (row && row.value !== EXPECTED_SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `Index at ${dbPath} has schema version ${row.value} but this version of ` +
          `@intentweave/index requires version ${EXPECTED_SCHEMA_VERSION}. ` +
          `Run \`iw index build\` to rebuild.`,
      );
    }
  } catch (e) {
    // If the _meta table doesn't exist yet (very old index), continue — the
    // caller will see missing tables and surface its own errors.
    if (e instanceof Error && e.message.includes("schema version")) throw e;
  }

  return db;
}

/**
 * Resolve a relative module_specifier to a known file path.
 * Tries the specifier as-is and with common extensions.
 *
 * Used by dependencyDepth, boundaryViolations, layersInfer, and layersCheck.
 */
export function resolveModuleSpecifier(
  sourceFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  const lastSlash = sourceFile.lastIndexOf("/");
  const dir = lastSlash >= 0 ? sourceFile.slice(0, lastSlash) : ".";

  let resolved =
    specifier.startsWith("./") || specifier.startsWith("../")
      ? `${dir}/${specifier}`
      : specifier;

  // Collapse . and .. segments
  const parts = resolved.split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") {
      stack.pop();
    } else {
      stack.push(p);
    }
  }
  resolved = stack.join("/");

  if (knownFiles.has(resolved)) return resolved;

  // Strip existing extension (e.g. .js) before trying alternatives
  const stripped = resolved.replace(/\.[jt]sx?$|\.[mc][jt]s$/, "");

  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
  for (const ext of extensions) {
    if (knownFiles.has(stripped + ext)) return stripped + ext;
  }
  for (const ext of extensions) {
    if (knownFiles.has(`${stripped}/index${ext}`))
      return `${stripped}/index${ext}`;
  }
  if (stripped !== resolved) {
    for (const ext of extensions) {
      if (knownFiles.has(resolved + ext)) return resolved + ext;
    }
  }

  return null;
}

/**
 * Build a directed import graph from the imports table.
 * Resolves `target_file` from `module_specifier` when NULL.
 * Returns forward (file→dependencies) and reverse (file→dependents) maps,
 * plus the set of all file nodes.
 */
export function buildImportGraph(db: Database.Database): {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  allFiles: Set<string>;
} {
  const edges = db
    .prepare(
      `SELECT DISTINCT source_file, target_file, module_specifier
       FROM imports WHERE is_relative = 1`,
    )
    .all() as Array<{
    source_file: string;
    target_file: string | null;
    module_specifier: string;
  }>;

  const knownFiles = new Set(
    (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  );

  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of edges) {
    const target =
      edge.target_file ||
      resolveModuleSpecifier(
        edge.source_file,
        edge.module_specifier,
        knownFiles,
      );
    if (!target) continue;

    allFiles.add(edge.source_file);
    allFiles.add(target);

    if (!forward.has(edge.source_file))
      forward.set(edge.source_file, new Set());
    forward.get(edge.source_file)!.add(target);

    if (!reverse.has(target)) reverse.set(target, new Set());
    reverse.get(target)!.add(edge.source_file);
  }

  return { forward, reverse, allFiles };
}
