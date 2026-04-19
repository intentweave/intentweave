// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * TCG Neo4j Persistence — full session rewrite
 *
 * Persists the TCG pipeline output to Neo4j:
 *   - Delete all TCG nodes for the session
 *   - Create TCGCommit, TCGAuthor, TCGFile nodes
 *   - Create MODIFIED, AUTHORED_BY, OWNS, CO_CHANGED_WITH edges
 *   - Cross-layer: link KWEntity → TCGCommit (INTRODUCED_IN, LAST_TOUCHED_IN)
 *   - Hotspot/staleness signals stored as properties on file nodes
 *
 * File node resolution: prefer existing KWDoc nodes, create TCGFile only as fallback.
 *
 * @see PHASE-B-SPEC.md §9
 * @version 0.1
 */

import type { TcgPipelineOutput } from "@intentweave/core";
import type { GraphDriver } from "../persistence/graphRunner.js";

// =============================================================================
// Schema Setup
// =============================================================================

const TCG_SCHEMA_CYPHER = `
CREATE INDEX tcg_commit_hash IF NOT EXISTS FOR (c:TCGCommit) ON (c.hash, c.session_id);
CREATE INDEX tcg_commit_date IF NOT EXISTS FOR (c:TCGCommit) ON (c.date, c.session_id);
CREATE INDEX tcg_author_email IF NOT EXISTS FOR (a:TCGAuthor) ON (a.email, a.session_id);
CREATE INDEX tcg_file_path IF NOT EXISTS FOR (f:TCGFile) ON (f.filePath, f.session_id);
`.trim();

// =============================================================================
// Types
// =============================================================================

export interface PersistTcgOptions {
  /** Log callback */
  log?: (msg: string) => void;
}

export interface PersistTcgResult {
  commitsCreated: number;
  authorsCreated: number;
  filesCreated: number;
  modifiedEdges: number;
  authoredByEdges: number;
  ownsEdges: number;
  coChangeEdges: number;
  crossLayerLinks: number;
  durationMs: number;
}

// =============================================================================
// persistTcg
// =============================================================================

/**
 * Persist TCG pipeline output to Neo4j.
 *
 * Full session rewrite: delete existing TCG nodes, recreate everything.
 * Links to existing KWDoc nodes when available; creates TCGFile otherwise.
 *
 * @param output   Full TCG pipeline output
 * @param session  Session name
 * @param driver   Neo4j driver instance (caller manages lifecycle)
 * @param options  Options
 */
export async function persistTcg(
  output: TcgPipelineOutput,
  session: string,
  driver: GraphDriver,
  options?: PersistTcgOptions,
): Promise<PersistTcgResult> {
  const startTime = performance.now();
  const log = options?.log ?? (() => {});

  const neo4jSession = driver.session();

  try {
    // ── 0. Ensure schema (indexes) ─────────────────────────────────────
    for (const stmt of TCG_SCHEMA_CYPHER.split("\n").filter((s) => s.trim())) {
      try {
        await neo4jSession.run(stmt);
      } catch {
        // Index already exists — benign
      }
    }
    log("Schema indexes ensured");

    // ── 1. Delete existing TCG nodes for this session ──────────────────
    await neo4jSession.run(
      `MATCH (n {session_id: $session})
       WHERE n:TCGCommit OR n:TCGAuthor OR n:TCGFile
       DETACH DELETE n`,
      { session },
    );

    // Also clean orphan cross-layer links
    await neo4jSession.run(
      `MATCH (:KWEntity {session_id: $session})-[r:INTRODUCED_IN|LAST_TOUCHED_IN]->()
       DELETE r`,
      { session },
    );

    // Also clean CO_CHANGED_WITH on KWDoc nodes
    await neo4jSession.run(
      `MATCH (:KWDoc {session_id: $session})-[r:CO_CHANGED_WITH]->()
       DELETE r`,
      { session },
    );
    // And MODIFIED/OWNS from any old TCG run
    await neo4jSession.run(
      `MATCH ()-[r:MODIFIED|OWNS]->(:KWDoc {session_id: $session})
       DELETE r`,
      { session },
    );

    log("Old TCG data deleted");

    // ── 2. Ensure Session node ─────────────────────────────────────────
    await neo4jSession.run("MERGE (s:Session {name: $session})", { session });

    // ── 3. Create TCGAuthor nodes ──────────────────────────────────────
    const authors = output.tcx.authors;
    if (authors.length > 0) {
      await neo4jSession.run(
        `UNWIND $authors AS a
         CREATE (author:TCGAuthor {
           name: a.name,
           email: a.email,
           commitCount: a.commitCount,
           session_id: $session
         })`,
        { authors, session },
      );
    }
    log(`${authors.length} authors created`);

    // ── 4. Create TCGCommit nodes + AUTHORED_BY edges (batched) ────────
    const COMMIT_BATCH = 200;
    const commits = output.tcx.commits;
    let commitsCreated = 0;
    let authoredByEdges = 0;

    for (let i = 0; i < commits.length; i += COMMIT_BATCH) {
      const batch = commits.slice(i, i + COMMIT_BATCH);
      const params = batch.map((c) => ({
        hash: c.hash,
        shortHash: c.shortHash,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        date: c.date,
        message: c.message.slice(0, 200), // truncate long messages
        fileCount: c.files.length,
      }));

      await neo4jSession.run(
        `UNWIND $params AS p
         CREATE (c:TCGCommit {
           hash: p.hash,
           shortHash: p.shortHash,
           authorName: p.authorName,
           authorEmail: p.authorEmail,
           date: datetime(p.date),
           message: p.message,
           fileCount: p.fileCount,
           session_id: $session
         })
         WITH c, p
         MATCH (a:TCGAuthor {email: p.authorEmail, session_id: $session})
         CREATE (c)-[:AUTHORED_BY]->(a)`,
        { params, session },
      );

      commitsCreated += batch.length;
      authoredByEdges += batch.length;
    }
    log(
      `${commitsCreated} commits created, ${authoredByEdges} AUTHORED_BY edges`,
    );

    // ── 5. Session → Commit/Author containment ─────────────────────────
    await neo4jSession.run(
      `MATCH (s:Session {name: $session}), (c:TCGCommit {session_id: $session})
       CREATE (s)-[:CONTAINS]->(c)`,
      { session },
    );
    await neo4jSession.run(
      `MATCH (s:Session {name: $session}), (a:TCGAuthor {session_id: $session})
       CREATE (s)-[:CONTAINS]->(a)`,
      { session },
    );

    // ── 6. MODIFIED edges: commit → file ───────────────────────────────
    // Resolve file nodes: prefer KWDoc, create TCGFile as fallback
    const allFilePaths = output.tcx.filePaths;
    let filesCreated = 0;

    // Create TCGFile nodes for files that don't have KWDoc equivalents
    if (allFilePaths.length > 0) {
      const FILE_BATCH = 500;
      for (let i = 0; i < allFilePaths.length; i += FILE_BATCH) {
        const batch = allFilePaths.slice(i, i + FILE_BATCH);
        const result = await neo4jSession.run(
          `UNWIND $paths AS fp
           OPTIONAL MATCH (d:KWDoc {filePath: fp, session_id: $session})
           WITH fp, d
           WHERE d IS NULL
           CREATE (f:TCGFile {filePath: fp, session_id: $session})
           RETURN count(f) AS created`,
          { paths: batch, session },
        );
        filesCreated += result.records[0]?.get("created")?.toNumber?.() ?? 0;
      }
    }
    log(`${filesCreated} TCGFile nodes created (rest resolved to KWDoc)`);

    // Build MODIFIED edges (batched — one batch per commit batch)
    let modifiedEdges = 0;
    const MODIFIED_BATCH = 100;

    for (let i = 0; i < commits.length; i += MODIFIED_BATCH) {
      const batch = commits.slice(i, i + MODIFIED_BATCH);
      const modRows: Array<{
        commitHash: string;
        filePath: string;
        changeType: string;
        linesAdded: number;
        linesRemoved: number;
      }> = [];

      for (const c of batch) {
        for (const f of c.files) {
          modRows.push({
            commitHash: c.hash,
            filePath: f.filePath,
            changeType: f.changeType,
            linesAdded: f.linesAdded,
            linesRemoved: f.linesRemoved,
          });
        }
      }

      if (modRows.length > 0) {
        await neo4jSession.run(
          `UNWIND $rows AS r
           MATCH (c:TCGCommit {hash: r.commitHash, session_id: $session})
           OPTIONAL MATCH (d:KWDoc {filePath: r.filePath, session_id: $session})
           OPTIONAL MATCH (f:TCGFile {filePath: r.filePath, session_id: $session})
           WITH c, r, COALESCE(d, f) AS fileNode
           WHERE fileNode IS NOT NULL
           CREATE (c)-[:MODIFIED {
             changeType: r.changeType,
             linesAdded: r.linesAdded,
             linesRemoved: r.linesRemoved
           }]->(fileNode)`,
          { rows: modRows, session },
        );
        modifiedEdges += modRows.length;
      }
    }
    log(`${modifiedEdges} MODIFIED edges created`);

    // ── 7. OWNS edges: author → file ───────────────────────────────────
    let ownsEdges = 0;
    const ownershipData = output.own.ownership;

    if (ownershipData.length > 0) {
      const OWN_BATCH = 200;
      for (let i = 0; i < ownershipData.length; i += OWN_BATCH) {
        const batch = ownershipData.slice(i, i + OWN_BATCH);
        const ownRows: Array<{
          authorEmail: string;
          filePath: string;
          commitCount: number;
          percentage: number;
          lastTouch: string;
        }> = [];

        for (const rec of batch) {
          for (const author of rec.authors) {
            ownRows.push({
              authorEmail: author.email,
              filePath: rec.filePath,
              commitCount: author.commitCount,
              percentage: author.percentage,
              lastTouch: author.lastTouch,
            });
          }
        }

        if (ownRows.length > 0) {
          await neo4jSession.run(
            `UNWIND $rows AS r
             MATCH (a:TCGAuthor {email: r.authorEmail, session_id: $session})
             OPTIONAL MATCH (d:KWDoc {filePath: r.filePath, session_id: $session})
             OPTIONAL MATCH (f:TCGFile {filePath: r.filePath, session_id: $session})
             WITH a, r, COALESCE(d, f) AS fileNode
             WHERE fileNode IS NOT NULL
             CREATE (a)-[:OWNS {
               commitCount: r.commitCount,
               percentage: r.percentage,
               lastTouch: r.lastTouch
             }]->(fileNode)`,
            { rows: ownRows, session },
          );
          ownsEdges += ownRows.length;
        }
      }
    }
    log(`${ownsEdges} OWNS edges created`);

    // ── 8. CO_CHANGED_WITH edges ─────────────────────────────────────
    let coChangeEdges = 0;
    const cocEdges = output.coc.edges;

    if (cocEdges.length > 0) {
      const COC_BATCH = 200;
      for (let i = 0; i < cocEdges.length; i += COC_BATCH) {
        const batch = cocEdges.slice(i, i + COC_BATCH);
        const cocRows = batch.map((e) => ({
          fileA: e.fileA,
          fileB: e.fileB,
          frequency: e.coChangeCount,
          jaccardScore: e.jaccardScore,
          commits: e.commitHashes.length,
        }));

        await neo4jSession.run(
          `UNWIND $rows AS r
           OPTIONAL MATCH (da:KWDoc {filePath: r.fileA, session_id: $session})
           OPTIONAL MATCH (fa:TCGFile {filePath: r.fileA, session_id: $session})
           WITH r, COALESCE(da, fa) AS nodeA
           WHERE nodeA IS NOT NULL
           OPTIONAL MATCH (db:KWDoc {filePath: r.fileB, session_id: $session})
           OPTIONAL MATCH (fb:TCGFile {filePath: r.fileB, session_id: $session})
           WITH r, nodeA, COALESCE(db, fb) AS nodeB
           WHERE nodeB IS NOT NULL
           CREATE (nodeA)-[:CO_CHANGED_WITH {
             frequency: r.frequency,
             jaccardScore: r.jaccardScore,
             commits: r.commits
           }]->(nodeB)`,
          { rows: cocRows, session },
        );
        coChangeEdges += batch.length;
      }
    }
    log(`${coChangeEdges} CO_CHANGED_WITH edges created`);

    // ── 9. Cross-layer: KWEntity → TCGCommit links ─────────────────────
    let crossLayerLinks = 0;

    // INTRODUCED_IN: earliest commit that modified a file containing this entity
    const introResult = await neo4jSession.run(
      `MATCH (e:KWEntity {session_id: $session})-[:HAS_MENTION]->(:KWMention)-[:APPEARS_IN]->(d:KWDoc {session_id: $session})
       WITH e, collect(DISTINCT d.filePath) AS docPaths
       UNWIND docPaths AS dp
       OPTIONAL MATCH (c:TCGCommit {session_id: $session})-[:MODIFIED]->(target)
       WHERE (target:KWDoc AND target.filePath = dp AND target.session_id = $session)
          OR (target:TCGFile AND target.filePath = dp AND target.session_id = $session)
       WITH e, c
       WHERE c IS NOT NULL
       ORDER BY c.date ASC
       WITH e, collect(c)[0] AS earliest
       WHERE earliest IS NOT NULL
       CREATE (e)-[:INTRODUCED_IN]->(earliest)
       RETURN count(*) AS cnt`,
      { session },
    );
    const introCount = introResult.records[0]?.get("cnt")?.toNumber?.() ?? 0;
    crossLayerLinks += introCount;

    // LAST_TOUCHED_IN: latest commit that modified a file containing this entity
    const lastResult = await neo4jSession.run(
      `MATCH (e:KWEntity {session_id: $session})-[:HAS_MENTION]->(:KWMention)-[:APPEARS_IN]->(d:KWDoc {session_id: $session})
       WITH e, collect(DISTINCT d.filePath) AS docPaths
       UNWIND docPaths AS dp
       OPTIONAL MATCH (c:TCGCommit {session_id: $session})-[:MODIFIED]->(target)
       WHERE (target:KWDoc AND target.filePath = dp AND target.session_id = $session)
          OR (target:TCGFile AND target.filePath = dp AND target.session_id = $session)
       WITH e, c
       WHERE c IS NOT NULL
       ORDER BY c.date DESC
       WITH e, collect(c)[0] AS latest
       WHERE latest IS NOT NULL
       CREATE (e)-[:LAST_TOUCHED_IN]->(latest)
       RETURN count(*) AS cnt`,
      { session },
    );
    const lastCount = lastResult.records[0]?.get("cnt")?.toNumber?.() ?? 0;
    crossLayerLinks += lastCount;

    log(
      `Cross-layer: ${introCount} INTRODUCED_IN + ${lastCount} LAST_TOUCHED_IN = ${crossLayerLinks} links`,
    );

    // ── 10. Set hotspot + staleness properties on file nodes ──────────
    // Hotspot scores
    for (const hs of output.hot.hotspots) {
      await neo4jSession.run(
        `OPTIONAL MATCH (d:KWDoc {filePath: $fp, session_id: $session})
         OPTIONAL MATCH (f:TCGFile {filePath: $fp, session_id: $session})
         WITH COALESCE(d, f) AS fileNode
         WHERE fileNode IS NOT NULL
         SET fileNode.hotspotZScore = $zScore,
             fileNode.hotspotChurn = $churn,
             fileNode.hotspotRecency = $recency`,
        {
          fp: hs.filePath,
          session,
          zScore: hs.zScore,
          churn: hs.churn,
          recency: hs.recencyScore,
        },
      );
    }

    // Staleness scores
    for (const stl of output.stl.signals) {
      await neo4jSession.run(
        `OPTIONAL MATCH (d:KWDoc {filePath: $fp, session_id: $session})
         OPTIONAL MATCH (f:TCGFile {filePath: $fp, session_id: $session})
         WITH COALESCE(d, f) AS fileNode
         WHERE fileNode IS NOT NULL
         SET fileNode.stalenessDays = $days,
             fileNode.stalenessSeverity = $severity`,
        {
          fp: stl.filePath,
          session,
          days: stl.stalenessScore,
          severity: stl.severity,
        },
      );
    }

    log(
      `Properties set: ${output.hot.hotspots.length} hotspot, ${output.stl.signals.length} staleness`,
    );

    const durationMs = Math.round(performance.now() - startTime);

    return {
      commitsCreated,
      authorsCreated: authors.length,
      filesCreated,
      modifiedEdges,
      authoredByEdges,
      ownsEdges,
      coChangeEdges,
      crossLayerLinks,
      durationMs,
    };
  } finally {
    await neo4jSession.close();
  }
}
