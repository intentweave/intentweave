// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWG (Keyword Graph) builder — returns the doc-health keyword extraction
 * graph for a session, formatted for the Insight Canvas force-directed
 * visualization.
 *
 * Neo4j schema (persisted by kwgPersist.ts):
 *   - (:KWEntity {name, type, confidence, aliases, session_id})
 *   - (:KWDoc {filePath, session_id})               ← no `name` property
 *   - (:KWSource {filePath, session_id})             ← no `name` property
 *   - (:KWDoc)-[:KW_MENTIONS]->(:KWEntity)
 *   - (:KWSource)-[:KW_CONTAINS]->(:KWEntity)
 *
 * Mapped to InsightNode kinds:
 *   KWEntity  → "concept"   (purple)
 *   KWDoc     → "topic"     (blue)
 *   KWSource  → "affected"  (light purple)
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
    OPTIONAL MATCH (:KWSource {session_id: $sid})-[c:KW_CONTAINS]->(:KWEntity {session_id: $sid})
    WITH ec, mc, count(c) AS sc
    RETURN ec AS entityCount, mc + sc AS relCount
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
         RETURN e.name AS name, e.type AS type, e.confidence AS confidence, e.aliases AS aliases`,
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
         RETURN e.name AS name, e.type AS type, e.confidence AS confidence, e.aliases AS aliases`,
        { sid: sessionId, limit: maxNodes },
      );
    }
  } else {
    entityRows = await runner.run(
      `MATCH (e:KWEntity {session_id: $sid})
       OPTIONAL MATCH ()-[r]->(e)
       WITH e, count(r) AS rels ORDER BY rels DESC LIMIT $limit
       RETURN e.name AS name, e.type AS type, e.confidence AS confidence, e.aliases AS aliases`,
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
    nodeMap.set(id, {
      id,
      label: name,
      kind: "concept",
      entityType: (r.type as string) ?? "keyword",
      confidence: r.confidence as number | undefined,
      aliases: r.aliases as string[] | undefined,
      rawTriples: [],
      connections: [],
    });
  }

  if (entityNames.size === 0) {
    return emptyResponse(sessionId, question, totalEntities, totalRelationships, t0);
  }

  // Escape entity names for Cypher IN clause
  const nameList = [...entityNames]
    .map((n) => `"${n.replace(/"/g, '\\"')}"`)
    .join(", ");

  // ── 3. Fetch KWDoc nodes (identified by filePath, not name) ─────────────
  const docRows = await runner.run(`
    MATCH (d:KWDoc {session_id: "${sid}"})-[:KW_MENTIONS]->(e:KWEntity {session_id: "${sid}"})
    WHERE e.name IN [${nameList}]
    WITH DISTINCT d
    RETURN d.filePath AS docPath
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

  // ── 4. Fetch KWSource nodes (identified by filePath, not name) ──────────
  const srcRows = await runner.run(`
    MATCH (s:KWSource {session_id: "${sid}"})-[:KW_CONTAINS]->(e:KWEntity {session_id: "${sid}"})
    WHERE e.name IN [${nameList}]
    WITH DISTINCT s
    RETURN s.filePath AS filePath
    LIMIT 500
  `);

  for (const r of srcRows) {
    const filePath = r.filePath as string;
    if (!filePath) continue;
    const srcId = `kwsrc:${filePath}`;
    if (!nodeMap.has(srcId)) {
      const label = filePath.split("/").pop() ?? filePath;
      nodeMap.set(srcId, {
        id: srcId,
        label,
        kind: "affected",
        entityType: "source",
        sourceDoc: filePath,
        rawTriples: [],
        connections: [],
      });
    }
  }

  // ── 5. Build edges ────────────────────────────────────────────────────────
  const edges: InsightEdge[] = [];

  // KW_MENTIONS (doc → entity)
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

  // KW_CONTAINS (source → entity)
  const containRows = await runner.run(`
    MATCH (s:KWSource {session_id: "${sid}"})-[:KW_CONTAINS]->(e:KWEntity {session_id: "${sid}"})
    WHERE e.name IN [${nameList}]
    RETURN s.filePath AS filePath, e.name AS entityName
  `);

  for (const r of containRows) {
    const srcId = `kwsrc:${r.filePath as string}`;
    const entId = `kwent:${r.entityName as string}`;
    if (nodeMap.has(srcId) && nodeMap.has(entId)) {
      edges.push({ source: srcId, target: entId, label: "CONTAINS" });
      addConnection(nodeMap, srcId, entId, "CONTAINS");
    }
  }

  // ── 6. Compute depth from connectivity ────────────────────────────────────
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
    title: question ? `Keyword Graph: "${question}"` : "Keyword Knowledge Graph",
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
