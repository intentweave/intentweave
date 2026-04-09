// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for CARI query modules.
 */

import Database from "better-sqlite3";
import * as fs from "fs";

/**
 * Open the index database in read-only mode.
 * Throws if the file doesn't exist.
 */
export function openIndex(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Index not found at ${dbPath}. Run \`iw index build\` first.`,
    );
  }
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
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
