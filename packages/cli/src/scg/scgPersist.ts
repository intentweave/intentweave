// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * SCG (Static Code Graph) Neo4j Persistence
 *
 * Persists the AX-stage output to Neo4j, creating the structural code layer:
 *   :SCG:Dir      { filePath, session_id }
 *   :SCG:File     { filePath, language, contentHash, symbolCount, session_id }
 *   :SCG:Symbol   { symbolId, name, kind, container, export, filePath, session_id, ... }
 *   (:SCG:Dir)    -[:SCG_CONTAINS]-> (:SCG:Dir)
 *   (:SCG:Dir)    -[:SCG_CONTAINS]-> (:SCG:File)
 *   (:SCG:File)   -[:SCG_CONTAINS]-> (:SCG:Symbol)
 *   (:SCG:Symbol) -[:SCG_CONTAINS]-> (:SCG:Symbol)   — class contains method
 *
 * Session-scoped, idempotent (MERGE), batched writes.
 * Cleans up stale nodes from previous runs.
 *
 * @version 0.1
 */

import type { AxOutput, AxSymbol } from "@intentweave/analyzer";

// =============================================================================
// Types
// =============================================================================

export interface ScgPersistOptions {
  /** Log callback */
  log?: (msg: string) => void;
}

export interface ScgPersistResult {
  dirsWritten: number;
  filesWritten: number;
  symbolsWritten: number;
  containsEdges: number;
  staleRemoved: number;
  durationMs: number;
}

// =============================================================================
// Schema
// =============================================================================

const SCG_SCHEMA_STATEMENTS = [
  `CREATE CONSTRAINT scg_file_unique IF NOT EXISTS FOR (n:SCG:File) REQUIRE (n.filePath, n.session_id) IS UNIQUE`,
  `CREATE CONSTRAINT scg_dir_unique IF NOT EXISTS FOR (n:SCG:Dir) REQUIRE (n.filePath, n.session_id) IS UNIQUE`,
  `CREATE CONSTRAINT scg_symbol_unique IF NOT EXISTS FOR (n:SCG:Symbol) REQUIRE (n.symbolId, n.session_id) IS UNIQUE`,
  `CREATE INDEX scg_symbol_name IF NOT EXISTS FOR (n:SCG:Symbol) ON (n.name)`,
  `CREATE INDEX scg_symbol_kind IF NOT EXISTS FOR (n:SCG:Symbol) ON (n.kind)`,
  `CREATE INDEX scg_symbol_filepath IF NOT EXISTS FOR (n:SCG:Symbol) ON (n.filePath)`,
  `CREATE INDEX scg_file_session IF NOT EXISTS FOR (n:SCG:File) ON (n.session_id)`,
];

// =============================================================================
// Helpers
// =============================================================================

/** Extract all unique directory paths from file paths. */
function extractDirectories(filePaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return [...dirs].sort();
}

/** Get parent directory of a path. */
function getParentDir(p: string): string | null {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.substring(0, i) : null;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Persist AX output (Static Code Graph) to Neo4j.
 *
 * Creates :SCG:Dir, :SCG:File, :SCG:Symbol nodes and SCG_CONTAINS edges.
 * Cleans up stale nodes from previous runs. Idempotent via MERGE.
 *
 * @param axOutput  Result from runAxStage()
 * @param session   Session name for isolation
 * @param driver    Neo4j driver (caller manages lifecycle)
 * @param options   Optional log callback
 */
export async function persistScg(
  axOutput: AxOutput,
  session: string,
  driver: import("../persistence/graphRunner.js").GraphDriver,
  options?: ScgPersistOptions,
): Promise<ScgPersistResult> {
  const startTime = performance.now();
  const log = options?.log ?? (() => {});
  const sid = session;

  let dirsWritten = 0;
  let filesWritten = 0;
  let symbolsWritten = 0;
  let containsEdges = 0;
  let staleRemoved = 0;

  // ── Ensure schema ─────────────────────────────────────────────────
  const schemaSession = driver.session();
  try {
    for (const stmt of SCG_SCHEMA_STATEMENTS) {
      try {
        await schemaSession.run(stmt);
      } catch {
        // Constraint/index may already exist
      }
    }
    log("SCG persist: schema ensured");
  } finally {
    await schemaSession.close();
  }

  // ── Collect data ──────────────────────────────────────────────────
  const filePaths = axOutput.files.map((f) => f.filePath);
  const directories = extractDirectories(filePaths);

  // Flatten all symbols with session tag
  const allSymbols: Array<{
    symbolId: string;
    name: string;
    kind: string;
    container: string | null;
    signature: string | null;
    filePath: string;
    exportStatus: string;
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    parameters: string | null;
    docSummary: string | null;
  }> = [];

  for (const file of axOutput.files) {
    for (const sym of file.symbols) {
      allSymbols.push({
        symbolId: sym.id,
        name: sym.name,
        kind: sym.kind,
        container: sym.container ?? null,
        signature: sym.signature ?? null,
        filePath: sym.filePath,
        exportStatus: sym.export,
        startLine: sym.span.startLine,
        startCol: sym.span.startCol,
        endLine: sym.span.endLine,
        endCol: sym.span.endCol,
        parameters: sym.parameters ? JSON.stringify(sym.parameters) : null,
        docSummary: sym.docSummary ?? null,
      });
    }
  }

  // ── Phase 1: :SCG:Dir nodes ───────────────────────────────────────
  if (directories.length > 0) {
    const s1 = driver.session();
    try {
      const batch = directories.map((d) => ({ filePath: d, session_id: sid }));
      const res = await s1.run(
        `UNWIND $batch AS d
         MERGE (n:SCG:Dir {filePath: d.filePath, session_id: d.session_id})
         ON CREATE SET n.createdAt = datetime()
         ON MATCH SET n.updatedAt = datetime()
         RETURN count(n) AS cnt`,
        { batch },
      );
      dirsWritten =
        res.records[0]?.get("cnt")?.toNumber?.() ?? directories.length;
      log(`SCG persist: ${dirsWritten} :SCG:Dir nodes`);
    } finally {
      await s1.close();
    }
  }

  // ── Phase 2: :SCG:File nodes ──────────────────────────────────────
  if (filePaths.length > 0) {
    const s2 = driver.session();
    try {
      const batch = axOutput.files.map((f) => ({
        filePath: f.filePath,
        language: f.language,
        contentHash: f.contentHash,
        symbolCount: f.symbols.length,
        session_id: sid,
      }));
      const res = await s2.run(
        `UNWIND $batch AS f
         MERGE (n:SCG:File {filePath: f.filePath, session_id: f.session_id})
         ON CREATE SET n.language = f.language, n.contentHash = f.contentHash,
                       n.symbolCount = f.symbolCount, n.createdAt = datetime()
         ON MATCH SET n.language = f.language, n.contentHash = f.contentHash,
                      n.symbolCount = f.symbolCount, n.updatedAt = datetime()
         RETURN count(n) AS cnt`,
        { batch },
      );
      filesWritten =
        res.records[0]?.get("cnt")?.toNumber?.() ?? filePaths.length;
      log(`SCG persist: ${filesWritten} :SCG:File nodes`);
    } finally {
      await s2.close();
    }
  }

  // ── Phase 3: :SCG:Symbol nodes (batched) ──────────────────────────
  if (allSymbols.length > 0) {
    const s3 = driver.session();
    try {
      const CHUNK = 500;
      let total = 0;
      for (let i = 0; i < allSymbols.length; i += CHUNK) {
        const chunk = allSymbols.slice(i, i + CHUNK).map((s) => ({
          ...s,
          session_id: sid,
        }));
        const res = await s3.run(
          `UNWIND $batch AS s
           MERGE (n:SCG:Symbol {symbolId: s.symbolId, session_id: s.session_id})
           ON CREATE SET n.name = s.name, n.kind = s.kind, n.container = s.container,
                         n.signature = s.signature, n.filePath = s.filePath,
                         n.export = s.exportStatus, n.startLine = s.startLine,
                         n.startCol = s.startCol, n.endLine = s.endLine,
                         n.endCol = s.endCol, n.parameters = s.parameters,
                         n.docSummary = s.docSummary, n.createdAt = datetime()
           ON MATCH SET n.name = s.name, n.kind = s.kind, n.container = s.container,
                        n.signature = s.signature, n.filePath = s.filePath,
                        n.export = s.exportStatus, n.startLine = s.startLine,
                        n.startCol = s.startCol, n.endLine = s.endLine,
                        n.endCol = s.endCol, n.parameters = s.parameters,
                        n.docSummary = s.docSummary, n.updatedAt = datetime()
           RETURN count(n) AS cnt`,
          { batch: chunk },
        );
        total += res.records[0]?.get("cnt")?.toNumber?.() ?? chunk.length;
      }
      symbolsWritten = total;
      log(`SCG persist: ${symbolsWritten} :SCG:Symbol nodes`);
    } finally {
      await s3.close();
    }
  }

  // ── Phase 4: SCG_CONTAINS edges ───────────────────────────────────
  const s4 = driver.session();
  try {
    // Dir → Dir
    const dirDirBatch = directories
      .map((d) => ({ parent: getParentDir(d), child: d }))
      .filter((e) => e.parent !== null);

    if (dirDirBatch.length > 0) {
      const res = await s4.run(
        `UNWIND $batch AS e
         MATCH (p:SCG:Dir {filePath: e.parent, session_id: $sid})
         MATCH (c:SCG:Dir {filePath: e.child, session_id: $sid})
         MERGE (p)-[r:SCG_CONTAINS]->(c)
         RETURN count(r) AS cnt`,
        { batch: dirDirBatch, sid },
      );
      containsEdges += res.records[0]?.get("cnt")?.toNumber?.() ?? 0;
    }

    // Dir → File
    const dirFileBatch = filePaths
      .map((fp) => ({ parent: getParentDir(fp), child: fp }))
      .filter((e) => e.parent !== null);

    if (dirFileBatch.length > 0) {
      const res = await s4.run(
        `UNWIND $batch AS e
         MATCH (p:SCG:Dir {filePath: e.parent, session_id: $sid})
         MATCH (c:SCG:File {filePath: e.child, session_id: $sid})
         MERGE (p)-[r:SCG_CONTAINS]->(c)
         RETURN count(r) AS cnt`,
        { batch: dirFileBatch, sid },
      );
      containsEdges += res.records[0]?.get("cnt")?.toNumber?.() ?? 0;
    }

    // File → Symbol (top-level: no container)
    const fileSymBatch: Array<{ filePath: string; childId: string }> = [];
    for (const file of axOutput.files) {
      for (const sym of file.symbols) {
        if (!sym.container) {
          fileSymBatch.push({ filePath: file.filePath, childId: sym.id });
        }
      }
    }

    if (fileSymBatch.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < fileSymBatch.length; i += CHUNK) {
        const chunk = fileSymBatch.slice(i, i + CHUNK);
        const res = await s4.run(
          `UNWIND $batch AS e
           MATCH (p:SCG:File {filePath: e.filePath, session_id: $sid})
           MATCH (c:SCG:Symbol {symbolId: e.childId, session_id: $sid})
           MERGE (p)-[r:SCG_CONTAINS]->(c)
           RETURN count(r) AS cnt`,
          { batch: chunk, sid },
        );
        containsEdges += res.records[0]?.get("cnt")?.toNumber?.() ?? 0;
      }
    }

    // Symbol → Symbol (container class/interface → method/property)
    const symSymBatch: Array<{ parentId: string; childId: string }> = [];
    for (const file of axOutput.files) {
      const nested = file.symbols.filter((s) => s.container);
      for (const sym of nested) {
        const parent = file.symbols.find(
          (s) =>
            s.name === sym.container &&
            (s.kind === "class" ||
              s.kind === "interface" ||
              s.kind === "enum" ||
              s.kind === "struct" ||
              s.kind === "protocol"),
        );
        if (parent) {
          symSymBatch.push({ parentId: parent.id, childId: sym.id });
        }
      }
    }

    if (symSymBatch.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < symSymBatch.length; i += CHUNK) {
        const chunk = symSymBatch.slice(i, i + CHUNK);
        const res = await s4.run(
          `UNWIND $batch AS e
           MATCH (p:SCG:Symbol {symbolId: e.parentId, session_id: $sid})
           MATCH (c:SCG:Symbol {symbolId: e.childId, session_id: $sid})
           MERGE (p)-[r:SCG_CONTAINS]->(c)
           RETURN count(r) AS cnt`,
          { batch: chunk, sid },
        );
        containsEdges += res.records[0]?.get("cnt")?.toNumber?.() ?? 0;
      }
    }

    log(`SCG persist: ${containsEdges} SCG_CONTAINS edges`);
  } finally {
    await s4.close();
  }

  // ── Phase 5: Clean up stale nodes ─────────────────────────────────
  const s5 = driver.session();
  try {
    const currentSymbolIds = allSymbols.map((s) => s.symbolId);

    // Stale symbols
    const symDel = await s5.run(
      `MATCH (n:SCG:Symbol {session_id: $sid})
       WHERE NOT n.symbolId IN $ids
       DETACH DELETE n
       RETURN count(n) AS cnt`,
      { sid, ids: currentSymbolIds },
    );
    staleRemoved += symDel.records[0]?.get("cnt")?.toNumber?.() ?? 0;

    // Stale files
    const fileDel = await s5.run(
      `MATCH (n:SCG:File {session_id: $sid})
       WHERE NOT n.filePath IN $paths
       DETACH DELETE n
       RETURN count(n) AS cnt`,
      { sid, paths: filePaths },
    );
    staleRemoved += fileDel.records[0]?.get("cnt")?.toNumber?.() ?? 0;

    // Stale dirs
    const dirDel = await s5.run(
      `MATCH (n:SCG:Dir {session_id: $sid})
       WHERE NOT n.filePath IN $paths
       DETACH DELETE n
       RETURN count(n) AS cnt`,
      { sid, paths: directories },
    );
    staleRemoved += dirDel.records[0]?.get("cnt")?.toNumber?.() ?? 0;

    if (staleRemoved > 0) {
      log(`SCG persist: removed ${staleRemoved} stale nodes`);
    }
  } finally {
    await s5.close();
  }

  const durationMs = Math.round(performance.now() - startTime);
  log(`SCG persist: done in ${durationMs}ms`);

  return {
    dirsWritten,
    filesWritten,
    symbolsWritten,
    containsEdges,
    staleRemoved,
    durationMs,
  };
}
