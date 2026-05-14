// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Call-Path Tracer (Phase 4)
 *
 * BFS traversal through the `symbol_calls` call graph starting from an entry
 * point file. Produces a call-path tree for understanding which code paths
 * flow from a given entry point (controller, main, handler, etc.).
 *
 * Resolution strategy: symbol_calls stores callee_name (unqualified). To
 * resolve callee_name → callee_file, we join with the `symbols` table.
 * Ambiguous callees (same name, multiple files) are included as multiple nodes.
 */

import Database from "better-sqlite3";
import { openIndex } from "./shared.js";

// =============================================================================
// Types
// =============================================================================

export interface TraceOptions {
  /**
   * Entry-point file path (relative, or substring match).
   * BFS starts from all files matching this string.
   */
  entry: string;
  /**
   * Maximum BFS depth (default: 6).
   */
  hops?: number;
  /**
   * Maximum total nodes in result (default: 50).
   * BFS stops expanding once this limit is reached.
   */
  maxNodes?: number;
  /**
   * Direction of traversal:
   * - `"forward"` (default): follow outgoing calls (what does this entry call?)
   * - `"backward"`: follow incoming calls (who calls into this entry?)
   */
  direction?: "forward" | "backward";
}

export interface TraceNode {
  /** File containing the symbol. */
  file: string;
  /** Symbols in this file that appear in the trace. */
  symbols: string[];
  /** BFS depth from the entry point (0 = entry). */
  depth: number;
}

export interface TraceEdge {
  fromFile: string;
  fromSymbol: string | null;
  toFile: string;
  toCalleeName: string;
  callerLine: number | null;
}

export interface TraceResult {
  entryFile: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  /** True when maxNodes or hops limit cut the traversal. */
  truncated: boolean;
  /** True when symbol_calls has data for entry files (Phase 4 active). */
  callsTableActive: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

export function traceFromDb(
  db: Database.Database,
  opts: TraceOptions,
): TraceResult {
  const hops = opts.hops ?? 6;
  const maxNodes = opts.maxNodes ?? 50;
  const direction = opts.direction ?? "forward";

  // ── Find entry files ──────────────────────────────────────────────────────
  const entryRows = db
    .prepare<{ pat: string }, { path: string }>(
      `SELECT DISTINCT path FROM files WHERE path LIKE :pat`,
    )
    .all({ pat: `%${opts.entry}%` }) as Array<{ path: string }>;

  if (entryRows.length === 0) {
    return {
      entryFile: opts.entry,
      nodes: [],
      edges: [],
      truncated: false,
      callsTableActive: false,
    };
  }

  const entryFile = entryRows[0].path;
  const entryFiles = new Set(entryRows.map((r) => r.path));

  // Check if calls table has data for entry files
  const ph = [...entryFiles].map(() => "?").join(",");
  const callsCheck = db
    .prepare<unknown[], { cnt: number }>(
      `SELECT COUNT(*) as cnt FROM symbol_calls WHERE caller_file IN (${ph})`,
    )
    .get([...entryFiles]) as { cnt: number } | undefined;
  const callsTableActive = (callsCheck?.cnt ?? 0) > 0;

  // ── BFS ───────────────────────────────────────────────────────────────────
  const visitedFiles = new Set<string>();
  const nodeMap = new Map<string, TraceNode>();
  const edges: TraceEdge[] = [];

  // Queue entries: set of file paths at this depth level
  let frontier = [...entryFiles];
  for (const f of frontier) {
    visitedFiles.add(f);
    nodeMap.set(f, { file: f, symbols: [], depth: 0 });
  }

  let truncated = false;

  for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
    if (visitedFiles.size >= maxNodes) {
      truncated = true;
      break;
    }

    const nextFrontier: string[] = [];

    for (const currentFile of frontier) {
      let callRows: Array<{
        caller_file: string;
        caller_name: string | null;
        caller_line: number | null;
        callee_name: string;
        callee_file: string | null;
      }>;

      if (direction === "forward") {
        // Who does currentFile call? → find callee files via symbols join
        callRows = db
          .prepare<
            { f: string },
            {
              caller_file: string;
              caller_name: string | null;
              caller_line: number | null;
              callee_name: string;
              callee_file: string | null;
            }
          >(
            `SELECT sc.caller_file, sc.caller_name, sc.caller_line, sc.callee_name,
                    s.file_path as callee_file
             FROM symbol_calls sc
             LEFT JOIN symbols s ON s.name = sc.callee_name
             WHERE sc.caller_file = :f
               AND (s.file_path IS NULL OR s.file_path != sc.caller_file)
             LIMIT 200`,
          )
          .all({ f: currentFile }) as Array<{
          caller_file: string;
          caller_name: string | null;
          caller_line: number | null;
          callee_name: string;
          callee_file: string | null;
        }>;
      } else {
        // Who calls currentFile? → find via symbols in currentFile being called
        callRows = db
          .prepare<
            { f: string },
            {
              caller_file: string;
              caller_name: string | null;
              caller_line: number | null;
              callee_name: string;
              callee_file: string | null;
            }
          >(
            `SELECT sc.caller_file, sc.caller_name, sc.caller_line, sc.callee_name,
                    :f as callee_file
             FROM symbol_calls sc
             WHERE sc.callee_name IN (
               SELECT name FROM symbols WHERE file_path = :f
             )
             LIMIT 200`,
          )
          .all({ f: currentFile }) as Array<{
          caller_file: string;
          caller_name: string | null;
          caller_line: number | null;
          callee_name: string;
          callee_file: string | null;
        }>;
      }

      for (const row of callRows) {
        const targetFile =
          direction === "forward" ? row.callee_file : row.caller_file;
        if (!targetFile || targetFile === currentFile) continue;

        // Track edge
        edges.push({
          fromFile:
            direction === "forward" ? row.caller_file : row.caller_file,
          fromSymbol: row.caller_name,
          toFile: targetFile,
          toCalleeName: row.callee_name,
          callerLine: row.caller_line,
        });

        // Track node symbol
        const existing = nodeMap.get(currentFile);
        if (existing && row.caller_name && !existing.symbols.includes(row.caller_name)) {
          existing.symbols.push(row.caller_name);
        }

        if (!visitedFiles.has(targetFile)) {
          visitedFiles.add(targetFile);
          nodeMap.set(targetFile, {
            file: targetFile,
            symbols: [row.callee_name],
            depth: depth + 1,
          });
          nextFrontier.push(targetFile);

          if (visitedFiles.size >= maxNodes) {
            truncated = true;
            break;
          }
        } else {
          // Already visited — add callee symbol if not present
          const node = nodeMap.get(targetFile);
          if (node && !node.symbols.includes(row.callee_name)) {
            node.symbols.push(row.callee_name);
          }
        }
      }

      if (truncated) break;
    }

    frontier = nextFrontier;
    if (truncated) break;
  }

  return {
    entryFile,
    nodes: [...nodeMap.values()],
    edges,
    truncated,
    callsTableActive,
  };
}

export function trace(dbPath: string, opts: TraceOptions): TraceResult {
  const db = openIndex(dbPath);
  try {
    return traceFromDb(db, opts);
  } finally {
    db.close();
  }
}
