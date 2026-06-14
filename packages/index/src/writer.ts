// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Index Writer
 *
 * Consumes stage outputs (AX, KWX, COX, TCG) and writes them
 * into the SQLite index. Batch inserts (500/tx) for performance.
 */

import Database from "@intentweave/sqlite-compat";
import * as path from "path";
import * as fs from "fs";

import { initSchema } from "./schema.js";
import { rulesCheckFromDb } from "./queries/rulesCheck.js";
import type {
  IndexBuildOptions,
  IndexBuildResult,
  Annotation,
  IndexCoOccurrence,
  IndexCoChange,
  IndexFile,
  IndexSymbol,
  ExternalEntity,
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
      files: writeFiles(db, ax, tcg, opts.docGroupOverride),
      imports: writeImports(db, ax),
      todos: writeTodos(db, ax),
      rationale: writeRationale(db, ax),
      calls: writeCalls(db, ax),
      propertyAccesses: writePropertyAccesses(db, ax),
      typeAssertions: writeTypeAssertions(db, ax),
      testDescriptions: writeTestDescriptions(db, ax),
      variableAssignments: writeVariableAssignments(db, ax),
      defUseChains: writeDefUseChains(db, ax),
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
        `co_occurrences=${counts.coOccurrences} co_changes=${counts.coChanges} ` +
        `files=${counts.files} imports=${counts.imports} todos=${counts.todos} rationale=${counts.rationale} ` +
        `calls=${counts.calls} property_accesses=${counts.propertyAccesses} ` +
        `type_assertions=${counts.typeAssertions} test_descriptions=${counts.testDescriptions} ` +
        `variable_assignments=${counts.variableAssignments} def_use_chains=${counts.defUseChains}`,
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
    INSERT OR REPLACE INTO symbols
      (id, name, kind, container, signature, file_path, line, end_line, export, doc_summary, body_hash, body_lines, structure_hash, implements, deprecated, deprecated_note, is_internal, decorators)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          sym.bodyHash ?? null,
          sym.bodyLines ?? null,
          sym.structureHash ?? null,
          sym.implements ? JSON.stringify(sym.implements) : null,
          sym.deprecated ? 1 : 0,
          sym.deprecatedNote ?? null,
          sym.isInternal ? 1 : 0,
          sym.decorators ? JSON.stringify(sym.decorators) : null,
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
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score, char_start, char_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          ann.charStart ?? null,
          ann.charEnd ?? null,
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
  docGroupOverride?: Map<string, string>,
): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO files (path, last_modified, churn, is_hotspot, primary_owner, bus_factor, is_doc, content_hash, doc_group, indexed, skip_reason, comment_lines, code_lines)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  // Build lookup map for AX file results
  const axFileMap = new Map<string, AxFileResult>();
  for (const f of ax.files) axFileMap.set(f.filePath, f);

  let count = 0;
  const paths = [...allPaths];
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const fp of batch) {
        const hot = hotspotMap.get(fp);
        const own = ownerMap.get(fp);
        const axFile = axFileMap.get(fp);
        const isDoc = isDocFile(fp);
        const indexed = axFile?.skipped ? 0 : 1;

        stmt.run(
          fp,
          hot?.lastModified ?? null,
          hot?.churn ?? null,
          hot ? 1 : 0,
          own?.primaryOwner ?? null,
          own ? countBusFactor(own) : null,
          isDoc ? 1 : 0,
          axFile?.contentHash ?? null,
          isDoc ? (docGroupOverride?.get(fp) ?? classifyDocGroup(fp)) : null,
          indexed,
          axFile?.skipReason ?? null,
          axFile?.commentLines ?? 0,
          axFile?.codeLines ?? 0,
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
// Imports
// =============================================================================

function writeImports(db: Database.Database, ax: AxOutput): number {
  const importCols = db.prepare(`PRAGMA table_info(imports)`).all() as Array<{
    name: string;
  }>;
  const hasLine = importCols.some((c) => c.name === "line");

  const stmt = hasLine
    ? db.prepare(`
        INSERT INTO imports (source_file, target_file, module_specifier, line, is_relative, imported_names)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
    : db.prepare(`
        INSERT INTO imports (source_file, target_file, module_specifier, is_relative, imported_names)
        VALUES (?, ?, ?, ?, ?)
      `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.imports || file.imports.length === 0) continue;
    for (let i = 0; i < file.imports.length; i += BATCH_SIZE) {
      const batch = file.imports.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const imp of batch) {
          if (hasLine) {
            stmt.run(
              file.filePath,
              imp.resolvedPath ?? null,
              imp.moduleSpecifier,
              imp.line ?? null,
              imp.isRelative ? 1 : 0,
              JSON.stringify(imp.importedNames),
            );
          } else {
            stmt.run(
              file.filePath,
              imp.resolvedPath ?? null,
              imp.moduleSpecifier,
              imp.isRelative ? 1 : 0,
              JSON.stringify(imp.importedNames),
            );
          }
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// TODOs
// =============================================================================

function writeTodos(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO todos (file_path, line, kind, text)
    VALUES (?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.todos || file.todos.length === 0) continue;
    for (let i = 0; i < file.todos.length; i += BATCH_SIZE) {
      const batch = file.todos.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const todo of batch) {
          stmt.run(file.filePath, todo.line, todo.kind, todo.text);
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// Rationale
// =============================================================================

function writeRationale(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO rationale (file_path, line, kind, text, symbol)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.rationale || file.rationale.length === 0) continue;
    for (let i = 0; i < file.rationale.length; i += BATCH_SIZE) {
      const batch = file.rationale.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const item of batch) {
          stmt.run(file.filePath, item.line, item.kind, item.text, null);
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// Calls (13.1)
// =============================================================================

function writeCalls(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO symbol_calls (caller_file, caller_name, caller_line, callee_name, callee_id, is_method)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.calls || file.calls.length === 0) continue;
    for (let i = 0; i < file.calls.length; i += BATCH_SIZE) {
      const batch = file.calls.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const call of batch) {
          stmt.run(
            file.filePath,
            call.callerName ?? null,
            call.callerLine,
            call.calleeName,
            call.calleeId ?? null,
            call.isMethod ? 1 : 0,
          );
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// Property Accesses (13.1)
// =============================================================================

function writePropertyAccesses(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO property_accesses (file, symbol_name, line, chain, root, depth)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.propertyAccesses || file.propertyAccesses.length === 0) continue;
    for (let i = 0; i < file.propertyAccesses.length; i += BATCH_SIZE) {
      const batch = file.propertyAccesses.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const pa of batch) {
          stmt.run(
            file.filePath,
            pa.symbolName ?? null,
            pa.line,
            pa.chain,
            pa.root,
            pa.depth,
          );
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// Type Assertions (14.3)
// =============================================================================

function writeTypeAssertions(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO type_assertions (file, line, kind, context, target_type)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.typeAssertions || file.typeAssertions.length === 0) continue;
    for (let i = 0; i < file.typeAssertions.length; i += BATCH_SIZE) {
      const batch = file.typeAssertions.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const ta of batch) {
          stmt.run(
            file.filePath,
            ta.line,
            ta.kind,
            ta.context ?? null,
            ta.targetType ?? null,
          );
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

function writeTestDescriptions(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO test_descriptions (file, line, kind, description)
    VALUES (?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.testDescriptions || file.testDescriptions.length === 0) continue;
    for (let i = 0; i < file.testDescriptions.length; i += BATCH_SIZE) {
      const batch = file.testDescriptions.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const td of batch) {
          stmt.run(file.filePath, td.line, td.kind, td.description);
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// Variable Assignments (13.10)
// =============================================================================

function writeVariableAssignments(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO variable_assignments (file, line, symbol_name, value_text, context)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.variableAssignments || file.variableAssignments.length === 0)
      continue;
    for (let i = 0; i < file.variableAssignments.length; i += BATCH_SIZE) {
      const batch = file.variableAssignments.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const va of batch) {
          stmt.run(
            file.filePath,
            va.line,
            va.symbolName,
            va.valueText,
            va.context ?? null,
          );
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// Def-Use Chains (16.1)
// =============================================================================

function writeDefUseChains(db: Database.Database, ax: AxOutput): number {
  const stmt = db.prepare(`
    INSERT INTO def_use_chains (file, function, def_line, var_name, use_line, use_context)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const file of ax.files) {
    if (!file.defUseChains || file.defUseChains.length === 0) continue;
    for (let i = 0; i < file.defUseChains.length; i += BATCH_SIZE) {
      const batch = file.defUseChains.slice(i, i + BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const c of batch) {
          stmt.run(
            file.filePath,
            c.functionName ?? null,
            c.defLine,
            c.varName,
            c.useLine,
            c.useContext,
          );
          count++;
        }
      });
      tx();
    }
  }
  return count;
}

// =============================================================================
// Doc-Group Classification
// =============================================================================

/**
 * Classify a document file into a semantic group based on its path.
 */
function classifyDocGroup(filePath: string): string {
  const lower = filePath.toLowerCase();
  const base = path.basename(lower);

  // README files
  if (base.startsWith("readme")) return "readme";

  // Changelog / release notes
  if (base.startsWith("changelog") || base.startsWith("release"))
    return "changelog";

  // Contributing / code of conduct
  if (base.startsWith("contributing") || base.startsWith("code_of_conduct"))
    return "contributing";

  // License
  if (base.startsWith("license") || base.startsWith("licence"))
    return "license";

  // API / reference docs
  if (lower.includes("/api/") || lower.includes("/reference/"))
    return "api-reference";

  // Architecture / design decisions
  if (
    lower.includes("/architecture") ||
    lower.includes("/design") ||
    lower.includes("/decisions") ||
    lower.includes("/adr")
  )
    return "architecture";

  // Specs / requirements
  if (lower.includes("/spec") || lower.includes("/requirement"))
    return "specification";

  // Guides / tutorials
  if (lower.includes("/guide") || lower.includes("/tutorial")) return "guide";

  // General docs
  if (lower.includes("/docs/") || lower.includes("/doc/"))
    return "project-docs";

  return "other";
}

// =============================================================================
// External Entities (Entity Bridge)
// =============================================================================

/**
 * Register external entities into the index and create annotations from
 * matching doc mentions.
 *
 * Opens the DB in read-write mode, writes entities + derived annotations,
 * then closes.
 */
export function registerExternalEntities(
  dbPath: string,
  entities: ExternalEntity[],
  opts?: { log?: (msg: string) => void },
): { entitiesWritten: number; annotationsCreated: number } {
  if (entities.length === 0) {
    return { entitiesWritten: 0, annotationsCreated: 0 };
  }

  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    // Disable FK checks — external entity IDs are not in the symbols table
    db.pragma("foreign_keys = OFF");

    // Ensure the external_entities table exists (for indexes upgraded from v3)
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        aliases TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_external_entities_name ON external_entities(name);
      CREATE INDEX IF NOT EXISTS idx_external_entities_type ON external_entities(type);
    `);

    const entitiesWritten = writeExternalEntities(db, entities);
    const annotationsCreated = annotateExternalEntities(db, entities);

    // Rebuild FTS to include new annotations
    rebuildFts(db);

    opts?.log?.(
      `Entity bridge: ${entitiesWritten} entities, ${annotationsCreated} annotations`,
    );

    return { entitiesWritten, annotationsCreated };
  } finally {
    db.close();
  }
}

function writeExternalEntities(
  db: Database.Database,
  entities: ExternalEntity[],
): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO external_entities (id, name, type, aliases, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);
    const tx = db.transaction(() => {
      for (const ent of batch) {
        stmt.run(
          ent.id,
          ent.name,
          ent.type,
          ent.aliases ? JSON.stringify(ent.aliases) : null,
          ent.metadata ? JSON.stringify(ent.metadata) : null,
        );
        count++;
      }
    });
    tx();
  }
  return count;
}

/**
 * Scan existing annotations for mentions that match external entity names
 * or aliases, and insert new annotations linking them.
 */
function annotateExternalEntities(
  db: Database.Database,
  entities: ExternalEntity[],
): number {
  // Build name → entity lookup (lowercased)
  const nameToEntity = new Map<string, ExternalEntity>();
  for (const ent of entities) {
    nameToEntity.set(ent.name.toLowerCase(), ent);
    if (ent.aliases) {
      for (const alias of ent.aliases) {
        nameToEntity.set(alias.toLowerCase(), ent);
      }
    }
  }

  // Find ungrounded annotations whose text matches an external entity
  const ungrounded = db
    .prepare(
      `SELECT id, doc_path, line, text, confidence, source, qualifier, idf_score
       FROM annotations
       WHERE symbol_id IS NULL`,
    )
    .all() as Array<{
    id: number;
    doc_path: string;
    line: number;
    text: string;
    confidence: number;
    source: string;
    qualifier: string | null;
    idf_score: number | null;
  }>;

  const insertStmt = db.prepare(`
    INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source, qualifier, idf_score, char_start, char_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of ungrounded) {
      const textLower = row.text.toLowerCase().trim();
      const match = nameToEntity.get(textLower);
      if (match) {
        // Insert a new annotation linked to the external entity
        insertStmt.run(
          row.doc_path,
          row.line,
          row.text,
          match.id,
          Math.max(row.confidence, 0.8), // external match gets at least 0.8
          "external",
          row.qualifier,
          row.idf_score,
          null,
          null,
        );
        count++;
      }
    }
  });
  tx();

  return count;
}

// =============================================================================
// FTS rebuild
// =============================================================================

function rebuildFts(db: Database.Database): void {
  // Rebuild the content-synced FTS indexes
  db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild')`);
}

// =============================================================================
// ADR Conformance Snapshot (14.5)
// =============================================================================

/**
 * Run rulesCheck for each rule in the config and persist a snapshot to the
 * conformance_snapshots table. Called automatically after `iw index build`
 * when .iw/rules.yaml is present.
 */
export function snapshotConformance(
  dbPath: string,
  config: import("./types.js").RulesConfig,
  snapshotId: string,
  timestamp: number,
): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    const stmt = db.prepare(`
      INSERT INTO conformance_snapshots
        (snapshot_id, timestamp, rule_id, adr, files_in_scope, files_clean, violation_count, conformance_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const totalFiles = (
      db.prepare(`SELECT COUNT(*) AS n FROM files WHERE indexed = 1`).get() as {
        n: number;
      }
    ).n;

    for (const rule of config.rules) {
      const result = rulesCheckFromDb(
        db,
        { version: 1, rules: [rule] },
        { ruleId: rule.id },
      );
      const violationCount = result.totalViolations;
      // files_clean = total indexed files minus files that have violations for this rule
      const violatingFiles = new Set(result.violations.map((v) => v.filePath));
      const filesClean = totalFiles - violatingFiles.size;
      const conformancePct =
        totalFiles > 0 ? (filesClean / totalFiles) * 100 : 100;

      stmt.run(
        snapshotId,
        timestamp,
        rule.id,
        rule.adr ?? null,
        totalFiles,
        filesClean,
        violationCount,
        conformancePct,
      );
    }
  } finally {
    db.close();
  }
}
