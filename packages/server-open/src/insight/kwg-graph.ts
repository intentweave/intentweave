// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWG (Keyword Graph) builder — returns the Phase A keyword extraction
 * graph for a session, formatted for the Insight Canvas force-directed
 * visualization.
 *
 * Neo4j schema (persisted by persistKwg.ts — Phase A evidence graph):
 *   - (:KWEntity {name, type, mentionCount, qualifiers, predominantSource, filePaths, session_id})
 *   - (:KWDoc {filePath, artifactId, entityCount, mentionCount, session_id})
 *   - (:KWMention {entityName, text, heading, filePath, startLine, session_id})
 *   - (:KWCluster {clusterId, label, memberCount, session_id})
 *   - (:KWDoc)-[:KW_MENTIONS]->(:KWEntity)           — direct doc→entity edge
 *   - (:KWEntity)-[:CO_OCCURS {count, score}]->(:KWEntity)
 *   - (:KWEntity)-[:MEMBER_OF]->(:KWCluster)
 *   - (:KWCluster)-[:REPRESENTED_BY]->(:KWEntity)    — envelope entity
 *
 * Mapped to InsightNode kinds:
 *   KWEntity   → "concept"    (purple)
 *   KWDoc      → "topic"      (blue)
 *   KWCluster  → "rationale"  (green)
 */

import type {
  InsightNode,
  InsightEdge,
  InsightResponse,
  KnowledgeGraphData,
} from "./types.js";

// ── Runner interface ─────────────────────────────────────────────────────────

interface CypherRunner {
  run: (
    cypher: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>[]>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuildKwgGraphOpts {
  runner: CypherRunner;
  sessionId: string;
  question?: string;
  maxNodes?: number;
}

export async function buildKwgGraph(
  opts: BuildKwgGraphOpts,
): Promise<InsightResponse> {
  const { runner, sessionId, question, maxNodes = 200 } = opts;
  const sid = sessionId.replace(/"/g, '\\"');
  const t0 = Date.now();

  // ── 1. Count totals ─────────────────────────────────────────────────────
  const countResult = await runner.run(
    `
    MATCH (e:KWEntity {session_id: $sid})
    WITH count(e) AS ec
    OPTIONAL MATCH (:KWDoc {session_id: $sid})-[m:KW_MENTIONS]->(:KWEntity {session_id: $sid})
    WITH ec, count(m) AS mc
    OPTIONAL MATCH (:KWEntity {session_id: $sid})-[c:CO_OCCURS]->(:KWEntity {session_id: $sid})
    WITH ec, mc, count(c) AS cc
    RETURN ec AS entityCount, mc + cc AS relCount
    `,
    { sid: sessionId },
  );
  const totalEntities = (countResult[0]?.entityCount as number) ?? 0;
  const totalRelationships = (countResult[0]?.relCount as number) ?? 0;

  // ── 2. Fetch KWEntity nodes ─────────────────────────────────────────────
  let entityRows: Record<string, unknown>[];

  if (question && question.trim().length > 0) {
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    if (keywords.length > 0) {
      const kwFilter = keywords
        .map((kw) => `toLower(e.name) CONTAINS "${kw.replace(/"/g, '\\"')}"`)
        .join(" OR ");

      entityRows = await runner.run(
        `MATCH (e:KWEntity {session_id: $sid})
         WHERE ${kwFilter}
         OPTIONAL MATCH ()-[r]->(e)
         WITH e, count(r) AS rels ORDER BY rels DESC LIMIT $limit
         RETURN e.name AS name, e.type AS type, e.mentionCount AS mentionCount,
                e.qualifiers AS qualifiers, e.predominantSource AS predominantSource,
                e.filePaths AS filePaths`,
        { sid: sessionId, limit: maxNodes },
      );
    } else {
      entityRows = [];
    }

    if (entityRows.length === 0) {
      entityRows = await runner.run(
        `MATCH (e:KWEntity {session_id: $sid})
         OPTIONAL MATCH ()-[r]->(e)
         WITH e, count(r) AS rels ORDER BY rels DESC LIMIT $limit
         RETURN e.name AS name, e.type AS type, e.mentionCount AS mentionCount,
                e.qualifiers AS qualifiers, e.predominantSource AS predominantSource,
                e.filePaths AS filePaths`,
        { sid: sessionId, limit: maxNodes },
      );
    }
  } else {
    entityRows = await runner.run(
      `MATCH (e:KWEntity {session_id: $sid})
       OPTIONAL MATCH ()-[r]->(e)
       WITH e, count(r) AS rels ORDER BY rels DESC LIMIT $limit
       RETURN e.name AS name, e.type AS type, e.mentionCount AS mentionCount,
              e.qualifiers AS qualifiers, e.predominantSource AS predominantSource,
              e.filePaths AS filePaths`,
      { sid: sessionId, limit: maxNodes },
    );
  }

  const nodeMap = new Map<string, InsightNode>();
  const entityNames = new Set<string>();

  for (const r of entityRows) {
    const name = r.name as string;
    if (!name) continue;
    const id = `kwent:${name}`;
    entityNames.add(name);

    // Normalize mentionCount into 0–1 confidence for UI sizing
    const mentionCount = (r.mentionCount as number) ?? 1;
    const confidence = Math.min(mentionCount / 20, 1.0);

    nodeMap.set(id, {
      id,
      label: name,
      kind: "concept",
      entityType: (r.type as string) ?? "keyword",
      confidence,
      aliases: r.qualifiers as string[] | undefined,
      rawTriples: [],
      connections: [],
    });
  }

  if (entityNames.size === 0) {
    return emptyResponse(
      sessionId,
      question,
      totalEntities,
      totalRelationships,
      t0,
    );
  }

  // Escape entity names for Cypher IN clause
  const nameList = [...entityNames]
    .map((n) => `"${n.replace(/"/g, '\\"')}"`)
    .join(", ");

  // ── 3. Fetch KWDoc nodes (identified by filePath) ───────────────────────
  const docRows = await runner.run(`
    MATCH (d:KWDoc {session_id: "${sid}"})-[:KW_MENTIONS]->(e:KWEntity {session_id: "${sid}"})
    WHERE e.name IN [${nameList}]
    WITH DISTINCT d
    RETURN d.filePath AS docPath, d.entityCount AS entityCount, d.mentionCount AS mentionCount
    LIMIT 500
  `);

  for (const r of docRows) {
    const docPath = r.docPath as string;
    if (!docPath) continue;
    const docId = `kwdoc:${docPath}`;
    if (!nodeMap.has(docId)) {
      const label = docPath.split("/").pop() ?? docPath;
      nodeMap.set(docId, {
        id: docId,
        label,
        kind: "topic",
        entityType: "document",
        sourceDoc: docPath,
        rawTriples: [],
        connections: [],
      });
    }
  }

  // ── 4. Build edges: KW_MENTIONS (doc → entity) ─────────────────────────
  const edges: InsightEdge[] = [];

  const mentionRows = await runner.run(`
    MATCH (d:KWDoc {session_id: "${sid}"})-[:KW_MENTIONS]->(e:KWEntity {session_id: "${sid}"})
    WHERE e.name IN [${nameList}]
    RETURN d.filePath AS docPath, e.name AS entityName
  `);

  for (const r of mentionRows) {
    const docId = `kwdoc:${r.docPath as string}`;
    const entId = `kwent:${r.entityName as string}`;
    if (nodeMap.has(docId) && nodeMap.has(entId)) {
      edges.push({ source: docId, target: entId, label: "MENTIONS" });
      addConnection(nodeMap, docId, entId, "MENTIONS");
    }
  }

  // ── 5. Build edges: CO_OCCURS (entity ↔ entity) ────────────────────────
  const cooccurRows = await runner.run(`
    MATCH (a:KWEntity {session_id: "${sid}"})-[r:CO_OCCURS]->(b:KWEntity {session_id: "${sid}"})
    WHERE a.name IN [${nameList}] AND b.name IN [${nameList}]
    RETURN a.name AS entityA, b.name AS entityB, r.count AS count, r.score AS score
    ORDER BY r.score DESC
    LIMIT 500
  `);

  for (const r of cooccurRows) {
    const srcId = `kwent:${r.entityA as string}`;
    const tgtId = `kwent:${r.entityB as string}`;
    if (nodeMap.has(srcId) && nodeMap.has(tgtId)) {
      edges.push({ source: srcId, target: tgtId, label: "CO_OCCURS" });
      addConnection(nodeMap, srcId, tgtId, "CO_OCCURS");
    }
  }

  // ── 6. Fetch KWCluster nodes + MEMBER_OF edges ─────────────────────────
  const clusterRows = await runner.run(`
    MATCH (e:KWEntity {session_id: "${sid}"})-[:MEMBER_OF]->(c:KWCluster {session_id: "${sid}"})
    WHERE e.name IN [${nameList}]
    WITH DISTINCT c, count(e) AS visibleMembers
    OPTIONAL MATCH (c)-[:REPRESENTED_BY]->(env:KWEntity {session_id: "${sid}"})
    RETURN c.clusterId AS clusterId, c.label AS label, c.memberCount AS memberCount,
           visibleMembers, env.name AS envelope
    LIMIT 100
  `);

  for (const r of clusterRows) {
    const cId = r.clusterId as string;
    if (!cId) continue;
    const nodeId = `kwcluster:${cId}`;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId,
        label: (r.label as string) ?? `Cluster ${cId}`,
        kind: "rationale",
        entityType: "cluster",
        confidence: Math.min(((r.memberCount as number) ?? 2) / 10, 1.0),
        rawTriples: [],
        connections: [],
      });
    }
  }

  // MEMBER_OF edges (entity → cluster)
  const memberRows = await runner.run(`
    MATCH (e:KWEntity {session_id: "${sid}"})-[:MEMBER_OF]->(c:KWCluster {session_id: "${sid}"})
    WHERE e.name IN [${nameList}]
    RETURN e.name AS entityName, c.clusterId AS clusterId
  `);

  for (const r of memberRows) {
    const entId = `kwent:${r.entityName as string}`;
    const cId = `kwcluster:${r.clusterId as string}`;
    if (nodeMap.has(entId) && nodeMap.has(cId)) {
      edges.push({ source: entId, target: cId, label: "MEMBER_OF" });
      addConnection(nodeMap, entId, cId, "MEMBER_OF");
    }
  }

  // ── 7. Compute depth from connectivity ────────────────────────────────────
  const nodes = [...nodeMap.values()];
  const maxConn = Math.max(...nodes.map((n) => n.connections?.length ?? 0), 1);
  for (const n of nodes) {
    const cc = n.connections?.length ?? 0;
    n.depth = cc > maxConn * 0.6 ? 0 : cc > maxConn * 0.2 ? 1 : 2;
  }

  const title = question
    ? `Keyword Graph: "${question}"`
    : "Keyword Knowledge Graph";

  const data: KnowledgeGraphData = {
    nodes,
    edges,
    totalEntities,
    totalRelationships,
  };

  return {
    vizType: "knowledge-graph",
    title,
    data,
    meta: {
      session: sessionId,
      entityCount: nodes.length,
      edgeCount: edges.length,
      queryTimeMs: Date.now() - t0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function addConnection(
  nodeMap: Map<string, InsightNode>,
  sourceId: string,
  targetId: string,
  predicate: string,
): void {
  const srcNode = nodeMap.get(sourceId);
  const tgtNode = nodeMap.get(targetId);
  if (srcNode) {
    srcNode.connections = srcNode.connections ?? [];
    srcNode.connections.push({
      targetId,
      targetLabel: tgtNode?.label ?? targetId,
      predicate,
      direction: "outgoing",
    });
  }
  if (tgtNode) {
    tgtNode.connections = tgtNode.connections ?? [];
    tgtNode.connections.push({
      targetId: sourceId,
      targetLabel: srcNode?.label ?? sourceId,
      predicate,
      direction: "incoming",
    });
  }
}

function emptyResponse(
  sessionId: string,
  question: string | undefined,
  totalEntities: number,
  totalRelationships: number,
  t0: number,
): InsightResponse {
  return {
    vizType: "knowledge-graph",
    title: question
      ? `Keyword Graph: "${question}"`
      : "Keyword Knowledge Graph",
    data: {
      nodes: [],
      edges: [],
      totalEntities,
      totalRelationships,
    } as KnowledgeGraphData,
    meta: {
      session: sessionId,
      entityCount: 0,
      edgeCount: 0,
      queryTimeMs: Date.now() - t0,
    },
  };
}
