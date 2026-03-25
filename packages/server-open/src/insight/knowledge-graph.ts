// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * knowledge-graph builder — returns the full KG subgraph for a session
 * (all Canon:Entity nodes + all CANON_REL edges) formatted for the
 * Insight Canvas force-directed visualization.
 */

import type { InsightNode, InsightEdge, InsightResponse } from "./types.js";
import { enrichNodeDescriptions } from "./describe.js";

// ── Runner interface (matches other builders) ────────────────────────────────

interface CypherRunner {
  run: (cypher: string) => Promise<Record<string, unknown>[]>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

export interface BuildKnowledgeGraphOpts {
  runner: CypherRunner;
  sessionId: string;
  /** Optional keyword filter — when provided, only shows matching entities. */
  question?: string;
  /** Maximum entities to return (default: 200). */
  maxNodes?: number;
}

export interface KnowledgeGraphData {
  nodes: InsightNode[];
  edges: InsightEdge[];
  /** Total entity count in session (may exceed maxNodes). */
  totalEntities: number;
  /** Total relationship count in session. */
  totalRelationships: number;
}

export async function buildKnowledgeGraph(
  opts: BuildKnowledgeGraphOpts,
): Promise<InsightResponse> {
  const { runner, sessionId, question, maxNodes = 200 } = opts;
  const sid = sessionId.replace(/"/g, '\\"');
  const t0 = Date.now();

  // ── Step 1: Count totals ─────────────────────────────────────────────────
  const countResult = await runner.run(`
    MATCH (e:Canon:Entity {session_id: "${sid}"})
    WITH count(e) AS ec
    OPTIONAL MATCH (:Canon:Entity {session_id: "${sid}"})-[r:CANON_REL]->(:Canon:Entity {session_id: "${sid}"})
    RETURN ec AS entityCount, count(r) AS relCount
  `);
  const totalEntities = (countResult[0]?.entityCount as number) ?? 0;
  const totalRelationships = (countResult[0]?.relCount as number) ?? 0;

  // ── Step 2: Fetch entities ───────────────────────────────────────────────
  let entityRows: Record<string, unknown>[];

  if (question && question.trim().length > 0) {
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    if (keywords.length > 0) {
      const keywordFilter = keywords
        .map(
          (kw) =>
            `toLower(e.name) CONTAINS "${kw.replace(/"/g, '\\"')}" OR any(a IN coalesce(e.aliases, []) WHERE toLower(a) CONTAINS "${kw.replace(/"/g, '\\"')}")`,
        )
        .join(" OR ");

      entityRows = await runner.run(`
        MATCH (e:Canon:Entity {session_id: "${sid}"})
        WHERE ${keywordFilter}
        RETURN e.canonId AS id, e.name AS name, e.type AS type,
               e.confidence AS confidence, e.aliases AS aliases,
               e.sourceFile AS sourceFile, e.run_id AS runId,
               e.artifactId AS artifactId,
               toString(e.created_at) AS createdAt, toString(e.updated_at) AS updatedAt
        ORDER BY e.confidence DESC
        LIMIT ${maxNodes}
      `);
    } else {
      entityRows = [];
    }

    // Fall back to full graph if keywords didn't match
    if (entityRows.length === 0) {
      entityRows = await runner.run(`
        MATCH (e:Canon:Entity {session_id: "${sid}"})
        OPTIONAL MATCH (e)-[r:CANON_REL]-()
        WITH e, count(r) AS rels
        ORDER BY rels DESC, e.confidence DESC
        LIMIT ${maxNodes}
        RETURN e.canonId AS id, e.name AS name, e.type AS type,
               e.confidence AS confidence, e.aliases AS aliases,
               e.sourceFile AS sourceFile, e.run_id AS runId,
               e.artifactId AS artifactId,
               toString(e.created_at) AS createdAt, toString(e.updated_at) AS updatedAt
      `);
    }
  } else {
    // Full session graph — most connected entities first
    entityRows = await runner.run(`
      MATCH (e:Canon:Entity {session_id: "${sid}"})
      OPTIONAL MATCH (e)-[r:CANON_REL]-()
      WITH e, count(r) AS rels
      ORDER BY rels DESC, e.confidence DESC
      LIMIT ${maxNodes}
      RETURN e.canonId AS id, e.name AS name, e.type AS type,
             e.confidence AS confidence, e.aliases AS aliases,
             e.sourceFile AS sourceFile, e.run_id AS runId,
             e.artifactId AS artifactId,
             toString(e.created_at) AS createdAt, toString(e.updated_at) AS updatedAt
    `);
  }

  const idSet = new Set(entityRows.map((r) => r.id as string));
  const nodeMap = new Map<string, InsightNode>();

  for (const r of entityRows) {
    const id = r.id as string;
    nodeMap.set(id, {
      id,
      label: r.name as string,
      kind: mapEntityTypeToKind(r.type as string),
      entityType: r.type as string | undefined,
      confidence: r.confidence as number | undefined,
      aliases: r.aliases as string[] | undefined,
      sourceDoc: r.sourceFile as string | undefined,
      runId: r.runId as string | undefined,
      createdAt: r.createdAt as string | undefined,
      updatedAt: r.updatedAt as string | undefined,
      rawTriples: [],
      connections: [],
    });
  }

  // ── Step 3: Fetch edges between loaded entities ──────────────────────────
  const idList = [...idSet]
    .map((id) => `"${id.replace(/"/g, '\\"')}"`)
    .join(", ");

  const edgeRows =
    idSet.size > 0
      ? await runner.run(`
          MATCH (a:Canon:Entity {session_id: "${sid}"})-[r:CANON_REL]->(b:Canon:Entity {session_id: "${sid}"})
          WHERE a.canonId IN [${idList}] AND b.canonId IN [${idList}]
          RETURN a.canonId AS sourceId, r.predicate AS predicate,
                 b.canonId AS targetId, r.confidence AS confidence
        `)
      : [];

  const edges: InsightEdge[] = [];
  for (const r of edgeRows) {
    const sourceId = r.sourceId as string;
    const targetId = r.targetId as string;
    const predicate = r.predicate as string;

    edges.push({ source: sourceId, target: targetId, label: predicate });

    // Build connections on the source and target nodes
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

  // ── Step 4: Fetch raw triples for all entities ───────────────────────────
  if (idSet.size > 0) {
    const tripleRows = await runner.run(`
      MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(c:Canon:Entity {session_id: "${sid}"})
      WHERE c.canonId IN [${idList}]
      RETURN c.canonId AS canonId, rt.subject AS subject, rt.predicate AS predicate,
             rt.object AS object
    `);

    for (const r of tripleRows) {
      const node = nodeMap.get(r.canonId as string);
      if (node) {
        node.rawTriples = node.rawTriples ?? [];
        node.rawTriples.push({
          subject: r.subject as string,
          predicate: r.predicate as string,
          object: r.object as string,
        });
      }
    }
  }

  const nodes = [...nodeMap.values()];

  // ── Step 5: Enrich descriptions ──────────────────────────────────────────
  enrichNodeDescriptions(nodes);

  // ── Step 6: Compute connectivity-based depth (for sizing) ────────────────
  const connectionCounts = nodes.map((n) => ({
    id: n.id,
    count: n.connections?.length ?? 0,
  }));
  connectionCounts.sort((a, b) => b.count - a.count);
  const maxConnections = connectionCounts[0]?.count ?? 0;
  for (const n of nodes) {
    const cc = n.connections?.length ?? 0;
    if (maxConnections > 0) {
      n.depth =
        cc > maxConnections * 0.6 ? 0 : cc > maxConnections * 0.2 ? 1 : 2;
    } else {
      n.depth = 1;
    }
  }

  const title = question
    ? `Knowledge Graph: "${question}"`
    : "Full Knowledge Graph";

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

/** Map KG entity types to NodeKind for coloring. */
function mapEntityTypeToKind(type: string | undefined): InsightNode["kind"] {
  switch (type) {
    case "decision":
      return "decision";
    case "option":
      return "option";
    case "risk":
      return "risk";
    case "concept":
    case "technology":
    case "component":
      return "concept";
    case "rationale":
      return "rationale";
    case "requirement":
    case "constraint":
      return "affected";
    case "feature":
    case "resource":
      return "chosen";
    default:
      return "concept";
  }
}
