// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Incremental Update
 *
 * Surgically updates the SQLite index for changed files only.
 * Compares content hashes to skip unchanged files, then:
 *   - Code files: re-extract symbols → delete old → insert new → re-annotate
 *   - Doc files: re-extract KWX mentions → delete old annotations → re-annotate
 *   - Both: update file metadata, recompute affected co-occurrences
 *
 * Target: <2 seconds for a single-file change.
 */

import Database from "@intentweave/sqlite-compat";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Annotation } from "./types.js";
import type { AxOutput } from "@intentweave/analyzer";
import type {
  KwxStageOutput,
  CoxStageOutput,
  TcgPipelineOutput,
  OwnershipRecord,
} from "@intentweave/core";

// =============================================================================
// Types
// =============================================================================

export interface IncrementalUpdateOptions {
  /** Path to the existing index.db */
  dbPath: string;

  /** Workspace root directory */
  workspaceRoot: string;

  /** Logging callback */
  log?: (msg: string) => void;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  isDoc: boolean;
}

export interface IncrementalUpdateResult {
  changes: FileChange[];
  updated: {
    symbols: number;
    annotations: number;
    coOccurrences: number;
    files: number;
  };
  skipped: number;
  durationMs: number;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Detect which files changed since the last index build.
 * Compares content_hash in the index against current file content.
 */
export function detectChanges(
  dbPath: string,
  workspaceRoot: string,
  currentFiles: string[],
): FileChange[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const indexed = new Map<string, string | null>();
    const rows = db
      .prepare("SELECT path, content_hash FROM files")
      .all() as Array<{ path: string; content_hash: string | null }>;

    for (const row of rows) {
      indexed.set(row.path, row.content_hash);
    }

    const changes: FileChange[] = [];
    const seen = new Set<string>();

    for (const filePath of currentFiles) {
      const rel = path.relative(workspaceRoot, filePath);
      seen.add(rel);

      const currentHash = hashFile(filePath);
      const storedHash = indexed.get(rel);

      if (storedHash === undefined) {
        changes.push({ path: rel, status: "added", isDoc: isDocFile(rel) });
      } else if (storedHash !== null && storedHash !== currentHash) {
        // storedHash === null means the file is tracked via git history only
        // (not a doc or code file we hash), so we can't detect changes — skip it.
        changes.push({ path: rel, status: "modified", isDoc: isDocFile(rel) });
      }
      // else: unchanged (or null hash / no content tracking) → skip
    }

    // Detect deleted files — only for entries that had a content hash
    // (null-hash entries are git-tracked files we don't hash; they are never
    // reported as deleted since we never had a meaningful hash to compare against)
    for (const [indexedPath, storedHash] of indexed) {
      if (storedHash !== null && !seen.has(indexedPath)) {
        changes.push({
          path: indexedPath,
          status: "deleted",
          isDoc: isDocFile(indexedPath),
        });
      }
    }

    return changes;
  } finally {
    db.close();
  }
}

/**
 * Apply incremental updates to the index for the given changes.
 *
 * Caller is responsible for running the appropriate extraction stages
 * (AX for code files, KWX for doc files, etc.) and passing their outputs.
 */
export function applyChanges(
  dbPath: string,
  changes: FileChange[],
  data: {
    /** AX output for changed code files (partial — only changed files) */
    ax?: AxOutput;
    /** KWX outputs for changed doc files (partial — only changed files) */
    kwxOutputs?: KwxStageOutput[];
    /** Recomputed COX output (only for changed doc files) */
    cox?: CoxStageOutput;
    /** Fresh annotations for all changed files */
    annotations?: Annotation[];
    /** Updated TCG pipeline output (optional — if git data changed) */
    tcg?: TcgPipelineOutput;
  },
  opts: IncrementalUpdateOptions,
): IncrementalUpdateResult {
  const start = Date.now();
  const log = opts.log ?? (() => {});

  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    const counts = { symbols: 0, annotations: 0, coOccurrences: 0, files: 0 };

    const tx = db.transaction(() => {
      // ── 1. Process deletions ────────────────────────────────
      const deleted = changes.filter((c) => c.status === "deleted");
      for (const del of deleted) {
        log(`  DELETE: ${del.path}`);
        deleteFileData(db, del.path);
        counts.files++;
      }

      // ── 2. Process code file changes (added + modified) ────
      const codeChanges = changes.filter(
        (c) => !c.isDoc && c.status !== "deleted",
      );
      if (codeChanges.length > 0 && data.ax) {
        for (const change of codeChanges) {
          log(`  CODE ${change.status}: ${change.path}`);
          // Delete old symbols and calls for this file
          deleteSymbolsForFile(db, change.path);
          deleteCallsForFile(db, change.path);
          counts.files++;
        }

        // Insert new symbols from AX
        const symbolStmt = db.prepare(`
          INSERT OR REPLACE INTO symbols (id, name, kind, container, signature, file_path, line, end_line, export, doc_summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const file of data.ax.files) {
          for (const sym of file.symbols) {
            symbolStmt.run(
              sym.id,
              sym.name,
              sym.kind,
              sym.container ?? null,
              sym.signature ?? null,
              sym.filePath,
              sym.span.startLine,
              sym.span.endLine ?? null,
              sym.export,
              sym.docSummary ?? null,
            );
            counts.symbols++;
          }
        }

        // Insert new calls from AX (Phase 4: symbol_calls incremental)
        const callStmt = db.prepare(`
          INSERT INTO symbol_calls (caller_file, caller_name, caller_line, callee_name, callee_id, is_method)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const file of data.ax.files) {
          if (!file.calls || file.calls.length === 0) continue;
          for (const call of file.calls) {
            if (!call.callerName) continue; // skip top-level calls with no named caller
            callStmt.run(
              file.filePath,
              call.callerName,
              call.callerLine,
              call.calleeName,
              call.calleeId ?? null,
              call.isMethod ? 1 : 0,
            );
          }
        }
      }

      // ── 3. Process doc file changes (added + modified) ─────
      const docChanges = changes.filter(
        (c) => c.isDoc && c.status !== "deleted",
      );
      if (docChanges.length > 0) {
        for (const change of docChanges) {
          log(`  DOC ${change.status}: ${change.path}`);
          deleteAnnotationsForDoc(db, change.path);
          counts.files++;
        }
      }

      // ── 4. Insert new annotations ──────────────────────────
      if (data.annotations && data.annotations.length > 0) {
        const annStmt = db.prepare(`
          INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const ann of data.annotations) {
          annStmt.run(
            ann.docPath,
            ann.line,
            ann.text,
            ann.symbolId ?? null,
            ann.confidence,
            ann.source,
            ann.qualifier ?? null,
            ann.idfScore ?? 1.0,
          );
          counts.annotations++;
        }
      }

      // ── 5. Update co-occurrences for changed docs ──────────
      if (docChanges.length > 0 && data.cox) {
        // Delete co-occurrence edges involving changed docs
        const changedDocPaths = new Set(docChanges.map((c) => c.path));
        deleteCoOccurrencesForFiles(db, changedDocPaths);

        // Insert new edges
        const coocStmt = db.prepare(`
          INSERT OR REPLACE INTO co_occurrences (entity_a, entity_b, count, score, source, file_paths)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const edge of data.cox.edges) {
          coocStmt.run(
            edge.entityA,
            edge.entityB,
            edge.count,
            edge.score,
            "doc_cooc",
            JSON.stringify(edge.filePaths),
          );
          counts.coOccurrences++;
        }
      }

      // ── 6. Update file metadata ────────────────────────────
      const fileStmt = db.prepare(`
        INSERT OR REPLACE INTO files (path, last_modified, churn, is_hotspot, primary_owner, bus_factor, is_doc, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Update from AX (code files with content hashes)
      if (data.ax) {
        for (const axFile of data.ax.files) {
          const hot = data.tcg?.hot.hotspots.find(
            (h) => h.filePath === axFile.filePath,
          );
          const own = data.tcg?.own.ownership.find(
            (o) => o.filePath === axFile.filePath,
          );
          fileStmt.run(
            axFile.filePath,
            hot?.lastModified ?? null,
            hot?.churn ?? null,
            hot ? 1 : 0,
            own?.primaryOwner ?? null,
            own ? countBusFactor(own) : null,
            0,
            axFile.contentHash,
          );
        }
      }

      // Update doc files with fresh content hashes
      for (const change of docChanges) {
        const abs = path.join(opts.workspaceRoot, change.path);
        const hash = fs.existsSync(abs) ? hashFile(abs) : null;
        const hot = data.tcg?.hot.hotspots.find(
          (h) => h.filePath === change.path,
        );
        const own = data.tcg?.own.ownership.find(
          (o) => o.filePath === change.path,
        );
        fileStmt.run(
          change.path,
          hot?.lastModified ?? null,
          hot?.churn ?? null,
          hot ? 1 : 0,
          own?.primaryOwner ?? null,
          own ? countBusFactor(own) : null,
          1,
          hash,
        );
      }

      // ── 7. Update co-changes (if TCG provided) ────────────
      if (data.tcg) {
        // For simplicity, replace all co-change data when TCG is refreshed
        db.exec("DELETE FROM co_changes");
        const cocStmt = db.prepare(`
          INSERT OR REPLACE INTO co_changes (file_a, file_b, count, jaccard, recency, commit_hashes)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const edge of data.tcg.coc.edges) {
          const recency = computeRecency(edge, data.tcg);
          cocStmt.run(
            edge.fileA,
            edge.fileB,
            edge.coChangeCount,
            edge.jaccardScore,
            recency,
            JSON.stringify(edge.commitHashes),
          );
        }
      }

      // ── 8. Rebuild FTS indexes ─────────────────────────────
      db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
      db.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);

      // ── 9. Update metadata ─────────────────────────────────
      db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`).run(
        "last_updated",
        new Date().toISOString(),
      );

      // ── 10. Mark stale capsules ──────────────────────────────
      // Any symbol_summary capsule whose source_revision no longer matches the
      // current body_hash is marked possibly_stale so the next cari_capsule call
      // will regenerate it.
      try {
        const staleCount = db
          .prepare(
            `
          UPDATE semantic_capsules
          SET status = 'possibly_stale', updated_at = ?
          WHERE capsule_kind = 'symbol_summary'
            AND status = 'fresh'
            AND target_id LIKE 'symbol:%'
            AND source_revision != (
              SELECT COALESCE(body_hash, '') FROM symbols
              WHERE 'symbol:' || id = semantic_capsules.target_id
              LIMIT 1
            )
            AND EXISTS (
              SELECT 1 FROM symbols WHERE 'symbol:' || id = semantic_capsules.target_id
            )
        `,
          )
          .run(new Date().toISOString()).changes;
        if (staleCount > 0)
          log(`  Marked ${staleCount} capsule(s) as possibly_stale`);
      } catch {
        // semantic_capsules may not exist on older indexes — non-fatal
      }
    });

    tx();

    const durationMs = Date.now() - start;
    log(`Incremental update: ${durationMs}ms`);

    return {
      changes,
      updated: counts,
      skipped:
        changes.length -
        changes.filter((c) => c.status === "deleted").length -
        changes.filter((c) => !c.isDoc && c.status !== "deleted").length -
        changes.filter((c) => c.isDoc && c.status !== "deleted").length,
      durationMs,
    };
  } finally {
    db.close();
  }
}

// =============================================================================
// Deletion helpers
// =============================================================================

/** Delete all index data associated with a file path. */
function deleteFileData(db: Database.Database, filePath: string): void {
  // Delete symbols in this file
  deleteSymbolsForFile(db, filePath);
  // Delete annotations referencing this doc
  deleteAnnotationsForDoc(db, filePath);
  // Delete co-occurrences mentioning this file
  deleteCoOccurrencesForFiles(db, new Set([filePath]));
  // Delete file metadata
  db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
}

/** Delete call edges from symbol_calls for a code file (Phase 4). */
function deleteCallsForFile(db: Database.Database, filePath: string): void {
  db.prepare("DELETE FROM symbol_calls WHERE caller_file = ?").run(filePath);
}

/** Delete symbols (and annotations referencing them) for a code file. */
function deleteSymbolsForFile(db: Database.Database, filePath: string): void {
  // Delete annotations that reference symbols in this file
  db.prepare(
    `
    DELETE FROM annotations WHERE symbol_id IN (
      SELECT id FROM symbols WHERE file_path = ?
    )
  `,
  ).run(filePath);

  // Delete the symbols themselves
  db.prepare("DELETE FROM symbols WHERE file_path = ?").run(filePath);
}

/** Delete annotations from a specific doc file. */
function deleteAnnotationsForDoc(db: Database.Database, docPath: string): void {
  db.prepare("DELETE FROM annotations WHERE doc_path = ?").run(docPath);
}

/** Delete co-occurrence edges that involve any of the given file paths. */
function deleteCoOccurrencesForFiles(
  db: Database.Database,
  filePaths: Set<string>,
): void {
  // co_occurrences.file_paths is a JSON array — scan and delete edges
  // that include any of the changed files
  const allEdges = db
    .prepare(
      "SELECT rowid, file_paths FROM co_occurrences WHERE source = 'doc_cooc'",
    )
    .all() as Array<{ rowid: number; file_paths: string }>;

  const toDelete: number[] = [];
  for (const edge of allEdges) {
    try {
      const paths: string[] = JSON.parse(edge.file_paths);
      if (paths.some((p) => filePaths.has(p))) {
        toDelete.push(edge.rowid);
      }
    } catch {
      // Malformed JSON — skip
    }
  }

  if (toDelete.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = toDelete.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM co_occurrences WHERE rowid IN (${placeholders})`,
      ).run(...batch);
    }
  }
}

// =============================================================================
// Utilities
// =============================================================================

/** Hash file content with SHA-256 (truncated to 16 hex chars, matching AX). */
export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function isDocFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".md", ".mdx", ".rst", ".txt", ".adoc"].includes(ext);
}

function countBusFactor(own: OwnershipRecord): number {
  return own.authors.filter((a) => a.percentage >= 10).length;
}

/** Compute exponential-decay recency score for a co-change edge. */
function computeRecency(
  edge: { commitHashes: string[] },
  tcg: TcgPipelineOutput,
): number {
  if (edge.commitHashes.length === 0) return 0;

  const commitsByHash = new Map(tcg.tcx.commits.map((c) => [c.hash, c]));
  const now = Date.now();
  const HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

  let maxRecency = 0;
  for (const hash of edge.commitHashes) {
    const commit = commitsByHash.get(hash);
    if (!commit) continue;
    const ageMs = now - new Date(commit.date).getTime();
    const decay = Math.exp((-Math.LN2 * ageMs) / HALF_LIFE_MS);
    if (decay > maxRecency) maxRecency = decay;
  }
  return maxRecency;
}
