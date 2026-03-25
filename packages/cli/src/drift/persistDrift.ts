// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift Signal Neo4j Persistence
 *
 * Persists `:DriftSignal` nodes to Neo4j with `ABOUT` (→ KWEntity) and
 * `AFFECTS` (→ KWDoc | TCGFile) edges. Uses full session rewrite strategy
 * (drift signals are cheap to re-derive, so no delta logic needed).
 *
 * @see PHASE-C-SPEC.md §11
 * @version 0.1
 */

import type { UnifiedDriftReport, DriftSignal } from "@intentweave/core";

// =============================================================================
// Schema
// =============================================================================

const DRIFT_SCHEMA_CYPHER = `
CREATE INDEX drift_signal_session IF NOT EXISTS FOR (d:DriftSignal) ON (d.session_id);
CREATE INDEX drift_signal_category IF NOT EXISTS FOR (d:DriftSignal) ON (d.category, d.session_id);
CREATE INDEX drift_signal_severity IF NOT EXISTS FOR (d:DriftSignal) ON (d.severity, d.session_id);
`.trim();

// =============================================================================
// Types
// =============================================================================

export interface PersistDriftOptions {
  /** Log callback */
  log?: (msg: string) => void;
}

export interface PersistDriftResult {
  nodesCreated: number;
  nodesDeleted: number;
  relsCreated: number;
  durationMs: number;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Persist unified drift report to Neo4j.
 *
 * Strategy: full session rewrite.
 *   1. Delete all existing `:DriftSignal` nodes for the session
 *   2. Create new `:DriftSignal` nodes
 *   3. Link to Session via `:CONTAINS`
 *   4. Link to KWEntity via `:ABOUT` (where entity exists)
 *   5. Link to KWDoc / TCGFile via `:AFFECTS` (where file node exists)
 *
 * @param report   Unified drift report
 * @param session  Session name for graph isolation
 * @param driver   Neo4j driver instance (caller manages lifecycle)
 * @param options  Persist options
 */
export async function persistDrift(
  report: UnifiedDriftReport,
  session: string,
  driver: import("neo4j-driver").Driver,
  options?: PersistDriftOptions,
): Promise<PersistDriftResult> {
  const startTime = performance.now();
  const log = options?.log ?? (() => {});
  let nodesCreated = 0;
  let nodesDeleted = 0;
  let relsCreated = 0;

  const neo4jSession = driver.session();

  try {
    // ── Ensure schema indexes ──────────────────────────────────────
    log("Drift persist: ensuring schema indexes...");
    for (const stmt of DRIFT_SCHEMA_CYPHER.split("\n").filter((l) =>
      l.trim(),
    )) {
      try {
        await neo4jSession.run(stmt);
      } catch {
        // Index may already exist
      }
    }

    // ── Ensure Session node ────────────────────────────────────────
    await neo4jSession.run("MERGE (s:Session {name: $session})", { session });

    // ── Step 1: Delete existing drift signals for session ──────────
    log("Drift persist: deleting existing drift signals...");
    const deleteResult = await neo4jSession.run(
      `MATCH (d:DriftSignal {session_id: $session}) DETACH DELETE d`,
      { session },
    );
    nodesDeleted = deleteResult.summary.counters.updates().nodesDeleted ?? 0;
    log(`Drift persist: deleted ${nodesDeleted} existing signals`);

    // ── Step 2: Create new drift signal nodes ──────────────────────
    if (report.signals.length === 0) {
      log("Drift persist: no signals to persist");
      return {
        nodesCreated: 0,
        nodesDeleted,
        relsCreated: 0,
        durationMs: performance.now() - startTime,
      };
    }

    log(`Drift persist: creating ${report.signals.length} signal nodes...`);

    // Batch create signals in chunks of 50
    const BATCH_SIZE = 50;
    for (let i = 0; i < report.signals.length; i += BATCH_SIZE) {
      const batch = report.signals.slice(i, i + BATCH_SIZE);
      const params = batch.map((s, idx) =>
        serializeSignal(s, session, i + idx),
      );

      await neo4jSession.run(
        `UNWIND $signals AS sig
         CREATE (d:DriftSignal {
           id: sig.id,
           category: sig.category,
           severity: sig.severity,
           detector: sig.detector,
           name: sig.name,
           message: sig.message,
           files: sig.files,
           session_id: sig.session_id,
           createdAt: datetime()
         })
         WITH d, sig
         // Link to Session
         MATCH (s:Session {name: sig.session_id})
         MERGE (s)-[:CONTAINS]->(d)
         WITH d, sig
         // Link to KWEntity if entity name matches
         OPTIONAL MATCH (e:KWEntity {name: sig.name, session_id: sig.session_id})
         FOREACH (_ IN CASE WHEN e IS NOT NULL THEN [1] ELSE [] END |
           MERGE (d)-[:ABOUT]->(e)
         )`,
        { signals: params },
      );

      nodesCreated += batch.length;
      relsCreated += batch.length; // At least Session-CONTAINS edges
    }

    // ── Step 3: Create AFFECTS edges to file nodes ─────────────────
    log("Drift persist: creating AFFECTS edges...");
    let affectsCreated = 0;

    // Collect all unique file paths across signals
    const fileSignals: Array<{ signalId: string; filePath: string }> = [];
    for (let i = 0; i < report.signals.length; i++) {
      const s = report.signals[i];
      for (const fp of s.files) {
        fileSignals.push({
          signalId: `drift-${session}-${i}`,
          filePath: fp,
        });
      }
    }

    if (fileSignals.length > 0) {
      // Batch link to KWDoc or TCGFile nodes
      for (let i = 0; i < fileSignals.length; i += BATCH_SIZE) {
        const batch = fileSignals.slice(i, i + BATCH_SIZE);

        const result = await neo4jSession.run(
          `UNWIND $links AS link
           MATCH (d:DriftSignal {id: link.signalId, session_id: $session})
           OPTIONAL MATCH (doc:KWDoc {filePath: link.filePath, session_id: $session})
           OPTIONAL MATCH (tcgFile:TCGFile {filePath: link.filePath, session_id: $session})
           WITH d, doc, tcgFile
           WHERE doc IS NOT NULL OR tcgFile IS NOT NULL
           WITH d, COALESCE(doc, tcgFile) AS target
           MERGE (d)-[:AFFECTS]->(target)`,
          { links: batch, session },
        );

        affectsCreated +=
          result.summary.counters.updates().relationshipsCreated ?? 0;
      }
    }

    relsCreated += affectsCreated;
    log(`Drift persist: created ${affectsCreated} AFFECTS edges`);

    const durationMs = performance.now() - startTime;
    log(
      `Drift persist: done — ${nodesCreated} signals, ${relsCreated} relationships (${(durationMs / 1000).toFixed(1)}s)`,
    );

    return {
      nodesCreated,
      nodesDeleted,
      relsCreated,
      durationMs,
    };
  } finally {
    await neo4jSession.close();
  }
}

// =============================================================================
// Helpers
// =============================================================================

function serializeSignal(
  signal: DriftSignal,
  session: string,
  index: number,
): Record<string, unknown> {
  return {
    id: `drift-${session}-${index}`,
    category: signal.category,
    severity: signal.severity,
    detector: signal.detector,
    name: signal.name,
    message: signal.message,
    files: signal.files,
    session_id: session,
  };
}
