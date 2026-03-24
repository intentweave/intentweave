// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWG Neo4j Persistence — basic delta strategy
 *
 * Persists the KWG pipeline output to Neo4j:
 *   - MERGE entities and docs (create new, update changed)
 *   - File-level delete + recreate for mentions
 *   - Session-level rewrite for co-occurrence edges and clusters
 *
 * With --force: full delete + recreate (no MERGE).
 *
 * Uses dynamic import of neo4j-driver to avoid hard dependency.
 * No GraphPersister interface — direct Neo4j calls per Phase A §1.1.
 *
 * @version 0.1
 */

import type {
  KwgPipelineOutput,
  KwxStageOutput,
  PersistResult,
  CoOccurrenceEdge,
  EntityCluster,
  KwgEntityRecord,
  MentionRecord,
} from "@intentweave/core";

// =============================================================================
// Schema Setup
// =============================================================================

const KWG_SCHEMA_CYPHER = `
CREATE INDEX kwg_entity_name IF NOT EXISTS FOR (e:KWEntity) ON (e.name, e.session_id);
CREATE INDEX kwg_mention_file IF NOT EXISTS FOR (m:KWMention) ON (m.filePath, m.session_id);
CREATE INDEX kwg_mention_entity IF NOT EXISTS FOR (m:KWMention) ON (m.entityName, m.session_id);
CREATE INDEX kwg_doc_file IF NOT EXISTS FOR (d:KWDoc) ON (d.filePath, d.session_id);
CREATE INDEX kwg_cluster_session IF NOT EXISTS FOR (c:KWCluster) ON (c.session_id);
`.trim();

// =============================================================================
// Types
// =============================================================================

export interface PersistKwgOptions {
  /** Force full rewrite (skip MERGE, delete everything first) */
  force?: boolean;
  /** Log callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Persist KWG pipeline output to Neo4j.
 *
 * Basic delta: MERGE entities/docs, file-level delete+recreate mentions,
 * session-level rewrite for edges and clusters.
 *
 * @param output   Full KWG pipeline output (kwxOutputs, coxOutput, clxOutput)
 * @param session  Session name for graph isolation
 * @param driver   Neo4j driver instance (caller manages lifecycle)
 * @param options  Persist options
 * @returns        Persist result with counts
 */
export async function persistKwg(
  output: KwgPipelineOutput,
  session: string,
  driver: import("neo4j-driver").Driver,
  options?: PersistKwgOptions,
): Promise<PersistResult> {
  const startTime = performance.now();
  const log = options?.log ?? (() => {});
  const force = options?.force ?? false;

  let nodesCreated = 0;
  let nodesUpdated = 0;
  let relsCreated = 0;
  let relsDeleted = 0;

  const neo4jSession = driver.session();

  try {
    // -- Ensure schema (indexes)
    log("KWG persist: ensuring schema indexes...");
    for (const stmt of KWG_SCHEMA_CYPHER.split("\n").filter((l) => l.trim())) {
      try {
        await neo4jSession.run(stmt);
      } catch {
        // Indexes may already exist — ignore
      }
    }

    // -- Ensure Session node
    await neo4jSession.run(
      "MERGE (s:Session {name: $session})",
      { session },
    );

    if (force) {
      // Full rewrite: delete all KW nodes for this session
      log("KWG persist: --force — deleting all KW nodes for session...");
      const deleteResult = await neo4jSession.run(
        `MATCH (n) WHERE n.session_id = $session AND (n:KWEntity OR n:KWDoc OR n:KWMention OR n:KWCluster) DETACH DELETE n`,
        { session },
      );
      const deleted = deleteResult.summary.counters.updates().nodesDeleted;
      relsDeleted += deleteResult.summary.counters.updates().relationshipsDeleted;
      log(`KWG persist: deleted ${deleted} nodes`);
    }

    // ── 1. Collect all entities across files ─────────────────────────
    const allEntities = new Map<string, KwgEntityRecord>();
    for (const [_filePath, kwxOutput] of output.kwxOutputs) {
      for (const entity of kwxOutput.entities) {
        const existing = allEntities.get(entity.name);
        if (existing) {
          // Merge: sum counts, union filePaths and qualifiers
          existing.mentionCount += entity.mentionCount;
          existing.filePaths = [
            ...new Set([...existing.filePaths, ...entity.filePaths]),
          ];
          existing.qualifiers = [
            ...new Set([...existing.qualifiers, ...entity.qualifiers]),
          ];
        } else {
          allEntities.set(entity.name, { ...entity });
        }
      }
    }

    // ── 2. MERGE entities ────────────────────────────────────────────
    log(`KWG persist: merging ${allEntities.size} entities...`);
    const entityParams = [...allEntities.values()].map((e) => ({
      name: e.name,
      mentionCount: e.mentionCount,
      qualifiers: e.qualifiers,
      predominantSource: e.predominantSource,
      filePaths: e.filePaths,
    }));

    if (entityParams.length > 0) {
      const entityResult = await neo4jSession.run(
        `
        UNWIND $entities AS e
        MERGE (entity:KWEntity {name: e.name, session_id: $session})
        ON CREATE SET
          entity.type = 'keyword',
          entity.mentionCount = e.mentionCount,
          entity.qualifiers = e.qualifiers,
          entity.predominantSource = e.predominantSource,
          entity.filePaths = e.filePaths,
          entity.createdAt = datetime()
        ON MATCH SET
          entity.type = 'keyword',
          entity.mentionCount = e.mentionCount,
          entity.qualifiers = e.qualifiers,
          entity.predominantSource = e.predominantSource,
          entity.filePaths = e.filePaths
        WITH entity
        MERGE (s:Session {name: $session})
        MERGE (s)-[:CONTAINS]->(entity)
        `,
        { entities: entityParams, session },
      );
      nodesCreated += entityResult.summary.counters.updates().nodesCreated;
      nodesUpdated += entityResult.summary.counters.updates().propertiesSet > 0
        ? entityParams.length
        : 0;
    }

    // ── 3. Per-file: MERGE doc + delete/recreate mentions ────────────
    for (const [filePath, kwxOutput] of output.kwxOutputs) {
      log(`KWG persist: processing ${filePath} (${kwxOutput.mentions.length} mentions)...`);

      // MERGE document node
      await neo4jSession.run(
        `
        MERGE (doc:KWDoc {filePath: $filePath, session_id: $session})
        ON CREATE SET
          doc.artifactId = $artifactId,
          doc.entityCount = $entityCount,
          doc.mentionCount = $mentionCount,
          doc.createdAt = datetime()
        ON MATCH SET
          doc.artifactId = $artifactId,
          doc.entityCount = $entityCount,
          doc.mentionCount = $mentionCount
        WITH doc
        MERGE (s:Session {name: $session})
        MERGE (s)-[:CONTAINS]->(doc)
        `,
        {
          filePath,
          artifactId: kwxOutput.artifactId,
          entityCount: kwxOutput.entities.length,
          mentionCount: kwxOutput.mentions.length,
          session,
        },
      );
      nodesCreated++; // Approximate

      // Delete existing mentions for this file
      const delResult = await neo4jSession.run(
        `
        MATCH (m:KWMention {filePath: $filePath, session_id: $session})
        DETACH DELETE m
        `,
        { filePath, session },
      );
      relsDeleted += delResult.summary.counters.updates().relationshipsDeleted;

      // Create new mentions + relationships
      if (kwxOutput.mentions.length > 0) {
        const mentionParams = kwxOutput.mentions.map((m: MentionRecord) => ({
          entityName: m.entityName,
          text: m.text,
          heading: m.heading ?? "",
          filePath: m.filePath,
          startLine: m.startLine,
          endLine: m.endLine,
          startChar: m.startChar,
          endChar: m.endChar,
          qualifiers: m.qualifiers,
          source: m.source,
          chunkId: m.chunkId,
        }));

        const mentionResult = await neo4jSession.run(
          `
          UNWIND $mentions AS m
          CREATE (mention:KWMention {
            entityName: m.entityName,
            text: m.text,
            heading: m.heading,
            filePath: m.filePath,
            startLine: m.startLine,
            endLine: m.endLine,
            startChar: m.startChar,
            endChar: m.endChar,
            qualifiers: m.qualifiers,
            source: m.source,
            chunkId: m.chunkId,
            session_id: $session,
            createdAt: datetime()
          })
          WITH mention, m
          MATCH (entity:KWEntity {name: m.entityName, session_id: $session})
          MERGE (entity)-[:HAS_MENTION]->(mention)
          WITH mention, m
          MATCH (doc:KWDoc {filePath: m.filePath, session_id: $session})
          MERGE (mention)-[:APPEARS_IN]->(doc)
          `,
          { mentions: mentionParams, session },
        );
        nodesCreated += mentionResult.summary.counters.updates().nodesCreated;
        relsCreated += mentionResult.summary.counters.updates().relationshipsCreated;
      }

      // Create direct doc→entity KW_MENTIONS edges (for UI traversal)
      const uniqueEntities = [
        ...new Set(kwxOutput.mentions.map((m: MentionRecord) => m.entityName)),
      ];
      if (uniqueEntities.length > 0) {
        const kwmResult = await neo4jSession.run(
          `
          UNWIND $entityNames AS eName
          MATCH (doc:KWDoc {filePath: $filePath, session_id: $session})
          MATCH (entity:KWEntity {name: eName, session_id: $session})
          MERGE (doc)-[:KW_MENTIONS]->(entity)
          `,
          { entityNames: uniqueEntities, filePath, session },
        );
        relsCreated += kwmResult.summary.counters.updates().relationshipsCreated;
      }
    }

    // ── 4. Session-level: delete + recreate CO_OCCURS edges ──────────
    log(`KWG persist: writing ${output.coxOutput.edges.length} co-occurrence edges...`);

    // Delete old edges
    const edgeDelResult = await neo4jSession.run(
      `
      MATCH (:KWEntity {session_id: $session})-[r:CO_OCCURS]->()
      DELETE r
      `,
      { session },
    );
    relsDeleted += edgeDelResult.summary.counters.updates().relationshipsDeleted;

    // Create new edges
    if (output.coxOutput.edges.length > 0) {
      const edgeParams = output.coxOutput.edges.map((e: CoOccurrenceEdge) => ({
        entityA: e.entityA,
        entityB: e.entityB,
        count: e.count,
        score: e.score,
        filePaths: e.filePaths,
      }));

      const edgeResult = await neo4jSession.run(
        `
        UNWIND $edges AS e
        MATCH (a:KWEntity {name: e.entityA, session_id: $session})
        MATCH (b:KWEntity {name: e.entityB, session_id: $session})
        CREATE (a)-[:CO_OCCURS {count: e.count, score: e.score, filePaths: e.filePaths}]->(b)
        `,
        { edges: edgeParams, session },
      );
      relsCreated += edgeResult.summary.counters.updates().relationshipsCreated;
    }

    // ── 5. Session-level: delete + recreate clusters ─────────────────
    log(`KWG persist: writing ${output.clxOutput.clusters.length} clusters...`);

    // Delete old clusters
    const clusterDelResult = await neo4jSession.run(
      `
      MATCH (c:KWCluster {session_id: $session})
      DETACH DELETE c
      `,
      { session },
    );
    relsDeleted += clusterDelResult.summary.counters.updates().relationshipsDeleted;

    // Create new clusters + MEMBER_OF + REPRESENTED_BY
    if (output.clxOutput.clusters.length > 0) {
      const clusterParams = output.clxOutput.clusters.map(
        (c: EntityCluster) => ({
          clusterId: c.id,
          label: c.label,
          members: c.members,
          envelope: c.envelope,
          memberCount: c.members.length,
          internalEdges: c.internalEdges,
          externalEdges: c.externalEdges,
        }),
      );

      const clusterResult = await neo4jSession.run(
        `
        UNWIND $clusters AS c
        CREATE (cluster:KWCluster {
          clusterId: c.clusterId,
          label: c.label,
          memberCount: c.memberCount,
          internalEdges: c.internalEdges,
          externalEdges: c.externalEdges,
          session_id: $session,
          createdAt: datetime()
        })
        WITH cluster, c
        UNWIND c.members AS memberName
        MATCH (entity:KWEntity {name: memberName, session_id: $session})
        MERGE (entity)-[:MEMBER_OF]->(cluster)
        WITH cluster, c
        MATCH (envelope:KWEntity {name: c.envelope, session_id: $session})
        MERGE (cluster)-[:REPRESENTED_BY]->(envelope)
        `,
        { clusters: clusterParams, session },
      );
      nodesCreated += clusterResult.summary.counters.updates().nodesCreated;
      relsCreated += clusterResult.summary.counters.updates().relationshipsCreated;
    }

    const durationMs = Math.round(performance.now() - startTime);
    log(`KWG persist: done in ${durationMs}ms`);

    return {
      nodesCreated,
      nodesUpdated,
      relsCreated,
      relsDeleted,
      durationMs,
    };
  } finally {
    await neo4jSession.close();
  }
}

// =============================================================================
// Driver Factory
// =============================================================================

/**
 * Create a Neo4j driver from environment variables.
 * Uses dynamic import to avoid hard dependency on neo4j-driver.
 */
export async function createNeo4jDriver(): Promise<import("neo4j-driver").Driver> {
  const neo4j = await import("neo4j-driver");

  const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
  const user = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "neo4j";
  const password = process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      "Neo4j password required. Set NEO4J_PASSWORD environment variable.\n" +
        '  Example: export NEO4J_PASSWORD="your-password"\n' +
        "  Or start Neo4j with: docker run -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5",
    );
  }

  return neo4j.default.driver(uri, neo4j.default.auth.basic(user, password));
}
