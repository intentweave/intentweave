// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Index Writer
 *
 * Consumes stage outputs (AX, KWX, COX, TCG) and writes them
 * into the SQLite index. Batch inserts (500/tx) for performance.
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

import { initSchema } from "./schema.js";
import type {
  IndexBuildOptions,
  IndexBuildResult,
  Annotation,
  IndexCoOccurrence,
  IndexCoChange,
  IndexFile,
  IndexSymbol,
} from "./types.js";
import type { AxOutput, AxSymbol, AxFileResult } from "@intentweave/analyzer";
import type {
  KwxStageOutput,
  CoxStageOutput,
  CoOccurrenceEdge,
} from "@intentweave/core";
import type {
  TcgPipelineOutput,
  HotspotSignal,
  OwnershipRecord,
  CoChangeEdge,
} from "@intentweave/core";

const BATCH_SIZE = 500;

// =============================================================================
// Public API
// =============================================================================

/**
 * Build the CARI index from stage outputs and write to SQLite.
 */
export function buildIndex(
  ax: AxOutput,
  kwxOutputs: KwxStageOutput[],
  cox: CoxStageOutput,
  tcg: TcgPipelineOutput,
  annotations: Annotation[],
  opts: IndexBuildOptions,
): IndexBuildResult {
  const start = Date.now();
  const dbPath =
    opts.outputPath ?? path.join(opts.workspaceRoot, ".iw", "index.db");

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Remove existing database for clean rebuild
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  const db = new Database(dbPath);
  try {
    initSchema(db);

    const counts = {
      symbols: writeSymbols(db, ax),
      annotations: writeAnnotations(db, annotations),
      coOccurrences: writeCoOccurrences(db, cox),
      coChanges: writeCoChanges(db, tcg),
      files: writeFiles(db, ax, tcg),
    };

    // Populate FTS indexes
    rebuildFts(db);

    // Store build metadata
    const meta = db.prepare(
      `INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`,
    );
    meta.run("session", opts.session);
    meta.run("built_at", new Date().toISOString());
    meta.run("depth", opts.depth);
    meta.run("workspace_root", opts.workspaceRoot);

    const durationMs = Date.now() - start;
    opts.log?.(`Index built in ${durationMs}ms → ${dbPath}`);
    opts.log?.(
      `  symbols=${counts.symbols} annotations=${counts.annotations} ` +
        `co_occurrences=${counts.coOccurrences} co_changes=${counts.coChanges} files=${counts.files}`,
    );

    return { dbPath, counts, durationMs };
  } finally {
    db.close();
  }
}

// =============================================================================
// Symbols
// =============================================================================

function writeSymbols(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO symbols (id, name, kind, container, signature, file_path, line, end_line, export, doc_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const symbols = ax.files.flatMap((f) => f.symbols);
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const sym of batch) {
        stmt.run(
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
        count++;
      }
    });
    tx();
  }
  return count;
}

// =============================================================================
// Annotations
// =============================================================================

function writeAnnotations(
  db: Database.Database,
  annotations: Annotation[],
): number {
  const stmt = db.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (let i = 0; i < annotations.length; i += BATCH_SIZE) {
    const batch = annotations.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const ann of batch) {
        stmt.run(
          ann.docPath,
          ann.line,
          ann.text,
          ann.symbolId ?? null,
          ann.confidence,
          ann.source,
          ann.qualifier ?? null,
          ann.idfScore ?? null,
        );
        count++;
      }
    });
    tx();
  }
  return count;
}

// =============================================================================
// Co-occurrences
// =============================================================================

function writeCoOccurrences(
  db: Database.Database,
  cox: CoxStageOutput,
): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO co_occurrences (entity_a, entity_b, count, score, source, file_paths)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const edges = cox.edges;
  for (let i = 0; i < edges.length; i += BATCH_SIZE) {
    const batch = edges.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const edge of batch) {
        stmt.run(
          edge.entityA,
          edge.entityB,
          edge.count,
          edge.score,
          "doc_cooc",
          JSON.stringify(edge.filePaths),
        );
        count++;
      }
    });
    tx();
  }
  return count;
}

// =============================================================================
// Co-changes
// =============================================================================

function writeCoChanges(db: Database.Database, tcg: TcgPipelineOutput): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO co_changes (file_a, file_b, count, jaccard, recency, commit_hashes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const edges = tcg.coc.edges;
  for (let i = 0; i < edges.length; i += BATCH_SIZE) {
    const batch = edges.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const edge of batch) {
        // Compute recency from the most recent commit timestamp
        const recency = computeRecency(edge, tcg);
        stmt.run(
          edge.fileA,
          edge.fileB,
          edge.coChangeCount,
          edge.jaccardScore,
          recency,
          JSON.stringify(edge.commitHashes),
        );
        count++;
      }
    });
    tx();
  }
  return count;
}

/**
 * Compute exponential-decay recency score for a co-change edge.
 * More recent co-changes score higher (closer to 1).
 */
function computeRecency(edge: CoChangeEdge, tcg: TcgPipelineOutput): number {
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

// =============================================================================
// Files
// =============================================================================

function writeFiles(
  db: Database.Database,
  ax: AxOutput,
  tcg: TcgPipelineOutput,
): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO files (path, last_modified, churn, is_hotspot, primary_owner, bus_factor, is_doc, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Build lookup maps from TCG data
  const hotspotMap = new Map<string, HotspotSignal>();
  for (const h of tcg.hot.hotspots) {
    hotspotMap.set(h.filePath, h);
  }

  const ownerMap = new Map<string, OwnershipRecord>();
  for (const o of tcg.own.ownership) {
    ownerMap.set(o.filePath, o);
  }

  // Collect all known file paths
  const allPaths = new Set<string>();
  for (const f of ax.files) allPaths.add(f.filePath);
  for (const fp of tcg.tcx.filePaths) allPaths.add(fp);

  let count = 0;
  const paths = [...allPaths];
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const fp of batch) {
        const hot = hotspotMap.get(fp);
        const own = ownerMap.get(fp);
        const axFile = ax.files.find((f) => f.filePath === fp);
        const isDoc = isDocFile(fp);

        stmt.run(
          fp,
          hot?.lastModified ?? null,
          hot?.churn ?? null,
          hot ? 1 : 0,
          own?.primaryOwner ?? null,
          own ? countBusFactor(own) : null,
          isDoc ? 1 : 0,
          axFile?.contentHash ?? null,
        );
        count++;
      }
    });
    tx();
  }
  return count;
}

function isDocFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".md", ".mdx", ".rst", ".txt", ".adoc"].includes(ext);
}

function countBusFactor(own: OwnershipRecord): number {
  // Bus factor: number of authors contributing ≥10% of commits
  return own.authors.filter((a) => a.percentage >= 10).length;
}

// =============================================================================
// FTS rebuild
// =============================================================================

function rebuildFts(db: Database.Database): void {
  // Rebuild the content-synced FTS indexes
  db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);
}
