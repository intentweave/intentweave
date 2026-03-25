// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision-tree builder — queries the knowledge graph for decisions and
 * structures the result into a renderable tree.
 *
 * Algorithm:
 *   1. Find all :Canon:Entity nodes with type='decision' in the session.
 *      Optionally filter by topic keyword(s).
 *   2. Expand one hop along decision-related predicates (DECIDED_FOR,
 *      DECIDED_AGAINST, ALTERNATIVE_TO, MOTIVATED_BY, etc.).
 *   3. Classify each related node by the predicate that links it to its
 *      decision.
 *   4. Build a JSON graph with a synthetic root node linking to all decisions.
 */

import type {
  InsightResponse,
  InsightNode,
  InsightEdge,
  InsightConnection,
  InsightRawTriple,
  NodeKind,
} from "./types.js";
import { enrichNodeDescriptions } from "./describe.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Predicates relevant to decision exploration. */
const DECISION_PREDICATES = [
  "DECIDED_FOR",
  "DECIDED_AGAINST",
  "ALTERNATIVE_TO",
  "MOTIVATED_BY",
  "SUPERSEDES",
  "ENABLES",
  "BLOCKS",
  "RISKS",
  "DEPENDS_ON",
] as const;

/** Map predicate → visual node kind for the *target* of the relationship. */
const PREDICATE_TO_KIND: Record<string, NodeKind> = {
  DECIDED_FOR: "chosen",
  DECIDED_AGAINST: "rejected",
  ALTERNATIVE_TO: "option",
  MOTIVATED_BY: "rationale",
  RISKS: "risk",
};

/** English stop words stripped when extracting topic keywords. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "what",
  "which",
  "who",
  "how",
  "when",
  "where",
  "why",
  "do",
  "does",
  "did",
  "about",
  "for",
  "of",
  "in",
  "on",
  "to",
  "and",
  "or",
  "not",
  "with",
  "from",
  "that",
  "this",
  "it",
  "its",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "made",
  "were",
  "all",
  "show",
  "me",
  "my",
  "our",
  "your",
  "decisions",
  "decision",
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Safely coerce a Neo4j value to string[] or undefined. */
function asStringArray(val: unknown): string[] | undefined {
  if (Array.isArray(val) && val.length > 0) return val.map(String);
  return undefined;
}

/** Append a connection entry to the map. */
function addConnection(
  map: Map<string, InsightConnection[]>,
  nodeId: string,
  conn: InsightConnection,
): void {
  let list = map.get(nodeId);
  if (!list) {
    list = [];
    map.set(nodeId, list);
  }
  list.push(conn);
}

// ── Runner interface ─────────────────────────────────────────────────────────

interface CypherRunner {
  run: (cypher: string) => Promise<Record<string, unknown>[]>;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface BuildDecisionTreeOpts {
  runner: CypherRunner;
  sessionId: string;
  question?: string;
  maxDecisions?: number;
  maxEdges?: number;
}

/**
 * Build a decision-tree visualization from the knowledge graph.
 */
export async function buildDecisionTree(
  opts: BuildDecisionTreeOpts,
): Promise<InsightResponse> {
  const {
    runner,
    sessionId,
    question,
    maxDecisions = 30,
    maxEdges = 300,
  } = opts;
  const t0 = Date.now();

  const sid = escapeStr(sessionId);
  const keywords = question ? extractKeywords(question) : [];

  // ── Step 1: Find decisions ───────────────────────────────────────────────
  const topicFilter =
    keywords.length > 0
      ? `AND (${keywords
          .map(
            (k) =>
              `toLower(d.name) CONTAINS "${escapeStr(k)}" OR any(a IN coalesce(d.aliases, []) WHERE toLower(a) CONTAINS "${escapeStr(k)}")`,
          )
          .join(" OR ")})`
      : "";

  const decisionRows = await runner.run(`
    MATCH (d:Canon:Entity {session_id: "${sid}"})
    WHERE d.type = 'decision'
    ${topicFilter}
    RETURN d.canonId AS id, d.name AS name, d.type AS type, d.confidence AS confidence,
           d.aliases AS aliases, d.run_id AS runId, d.artifactId AS artifactId,
           toString(d.created_at) AS createdAt, toString(d.updated_at) AS updatedAt
    LIMIT ${maxDecisions}
  `);

  // If no decisions matched by keywords, fall back to all decisions
  let decisionsToUse = decisionRows;
  if (decisionsToUse.length === 0 && keywords.length > 0) {
    decisionsToUse = await runner.run(`
      MATCH (d:Canon:Entity {session_id: "${sid}"})
      WHERE d.type = 'decision'
      RETURN d.canonId AS id, d.name AS name, d.type AS type, d.confidence AS confidence,
             d.aliases AS aliases, d.run_id AS runId, d.artifactId AS artifactId,
             toString(d.created_at) AS createdAt, toString(d.updated_at) AS updatedAt
      LIMIT ${maxDecisions}
    `);
  }

  // ── Empty result ─────────────────────────────────────────────────────────
  if (decisionsToUse.length === 0) {
    const rootId = "__root__";
    return {
      vizType: "decision-tree",
      title: question ?? "Decisions",
      data: {
        nodes: [
          { id: rootId, label: "No decisions found", kind: "topic" as const },
        ],
        edges: [],
        rootId,
      },
      meta: {
        session: sessionId,
        entityCount: 0,
        edgeCount: 0,
        queryTimeMs: Date.now() - t0,
      },
    };
  }

  // ── Step 2: Expand decision edges ────────────────────────────────────────
  const decisionIds = decisionsToUse.map((d) => d.id as string);
  const idList = decisionIds.map((id) => `"${escapeStr(id)}"`).join(", ");
  const predList = DECISION_PREDICATES.map((p) => `"${p}"`).join(", ");

  const edgeRows = await runner.run(`
    MATCH (a:Canon:Entity {session_id: "${sid}"})-[r:CANON_REL]->(b:Canon:Entity {session_id: "${sid}"})
    WHERE (a.canonId IN [${idList}] OR b.canonId IN [${idList}])
    AND r.predicate IN [${predList}]
    RETURN a.canonId  AS sourceId,   a.name  AS sourceName, a.type  AS sourceType, a.confidence AS sourceConf,
           a.aliases AS sourceAliases, a.run_id AS sourceRunId, a.artifactId AS sourceArtifactId,
           toString(a.created_at) AS sourceCreatedAt, toString(a.updated_at) AS sourceUpdatedAt,
           r.predicate AS predicate,
           b.canonId  AS targetId,   b.name  AS targetName, b.type  AS targetType, b.confidence AS targetConf,
           b.aliases AS targetAliases, b.run_id AS targetRunId, b.artifactId AS targetArtifactId,
           toString(b.created_at) AS targetCreatedAt, toString(b.updated_at) AS targetUpdatedAt
    LIMIT ${maxEdges}
  `);

  // ── Step 3: Assemble nodes + edges ───────────────────────────────────────
  const nodeMap = new Map<string, InsightNode>();
  const connectionMap = new Map<string, InsightConnection[]>();
  const edges: InsightEdge[] = [];

  // Root node
  const rootId = "__root__";
  const title = keywords.length
    ? `Decisions: ${keywords.join(", ")}`
    : "All Decisions";
  nodeMap.set(rootId, { id: rootId, label: title, kind: "topic" });

  // Decision nodes
  for (const d of decisionsToUse) {
    const id = d.id as string;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        label: d.name as string,
        kind: "decision",
        confidence: d.confidence as number | undefined,
        aliases: asStringArray(d.aliases),
        sourceDoc: d.artifactId as string | undefined,
        runId: d.runId as string | undefined,
        entityType: d.type as string | undefined,
        createdAt: d.createdAt as string | undefined,
        updatedAt: d.updatedAt as string | undefined,
      });
    }
    edges.push({ source: rootId, target: id, label: "" });
  }

  // Related nodes from edges
  for (const row of edgeRows) {
    const sId = row.sourceId as string;
    const tId = row.targetId as string;
    const pred = row.predicate as string;

    // Ensure source node exists
    if (!nodeMap.has(sId)) {
      nodeMap.set(sId, {
        id: sId,
        label: row.sourceName as string,
        kind: classifyNode(
          row.sourceType as string,
          pred,
          decisionIds.includes(sId),
          false,
        ),
        confidence: row.sourceConf as number | undefined,
        aliases: asStringArray(row.sourceAliases),
        sourceDoc: row.sourceArtifactId as string | undefined,
        runId: row.sourceRunId as string | undefined,
        entityType: row.sourceType as string | undefined,
        createdAt: row.sourceCreatedAt as string | undefined,
        updatedAt: row.sourceUpdatedAt as string | undefined,
      });
    }

    // Ensure target node exists
    if (!nodeMap.has(tId)) {
      nodeMap.set(tId, {
        id: tId,
        label: row.targetName as string,
        kind: classifyNode(
          row.targetType as string,
          pred,
          decisionIds.includes(tId),
          true,
        ),
        confidence: row.targetConf as number | undefined,
        aliases: asStringArray(row.targetAliases),
        sourceDoc: row.targetArtifactId as string | undefined,
        runId: row.targetRunId as string | undefined,
        entityType: row.targetType as string | undefined,
        createdAt: row.targetCreatedAt as string | undefined,
        updatedAt: row.targetUpdatedAt as string | undefined,
      });
    }

    edges.push({ source: sId, target: tId, label: pred });

    // Build connection lists for detail panel
    addConnection(connectionMap, sId, {
      targetId: tId,
      targetLabel: row.targetName as string,
      predicate: pred,
      direction: "outgoing",
    });
    addConnection(connectionMap, tId, {
      targetId: sId,
      targetLabel: row.sourceName as string,
      predicate: pred,
      direction: "incoming",
    });
  }

  // Attach connections to nodes
  for (const [nodeId, connections] of connectionMap) {
    const node = nodeMap.get(nodeId);
    if (node) node.connections = connections;
  }

  // ── Step 4: Temporal ordering ──────────────────────────────────────────
  // Assign temporalOrder to decision nodes based on runId sort order.
  // Lexicographic sort of runIds gives chronological order (they are typically
  // timestamps or monotonic IDs).
  const decisionNodes = Array.from(nodeMap.values()).filter(
    (n) => n.kind === "decision" && n.runId,
  );
  if (decisionNodes.length > 0) {
    const uniqueRunIds = [
      ...new Set(decisionNodes.map((n) => n.runId!)),
    ].sort();
    const runIdRank = new Map(uniqueRunIds.map((id, i) => [id, i + 1]));
    for (const node of decisionNodes) {
      node.temporalOrder = runIdRank.get(node.runId!);
    }
  }

  // ── Step 5: Fetch raw triples for provenance ────────────────────────────
  // Query RawTriple nodes that were CANONICALIZED_FROM any of our Canon entities.
  const allNodeIds = Array.from(nodeMap.keys()).filter((id) => id !== rootId);
  if (allNodeIds.length > 0) {
    const nodeIdList = allNodeIds.map((id) => `"${escapeStr(id)}"`).join(", ");
    const rawTripleRows = await runner.run(`
      MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(c:Canon:Entity {session_id: "${sid}"})
      WHERE c.canonId IN [${nodeIdList}]
      RETURN c.canonId AS canonId, rt.subject AS subject, rt.predicate AS predicate, rt.object AS object
      LIMIT 500
    `);

    // Group raw triples by canonId
    const tripleMap = new Map<string, InsightRawTriple[]>();
    for (const row of rawTripleRows) {
      const cId = row.canonId as string;
      const triple: InsightRawTriple = {
        subject: row.subject as string,
        predicate: row.predicate as string,
        object: row.object as string,
      };
      let list = tripleMap.get(cId);
      if (!list) {
        list = [];
        tripleMap.set(cId, list);
      }
      list.push(triple);
    }

    // Attach to nodes
    for (const [canonId, triples] of tripleMap) {
      const node = nodeMap.get(canonId);
      if (node) node.rawTriples = triples;
    }
  }

  const dedupedEdges = deduplicateEdges(edges);

  // ── Step 6: Synthesize descriptions from raw triples ────────────────────
  enrichNodeDescriptions(nodeMap.values());

  return {
    vizType: "decision-tree",
    title,
    data: {
      nodes: Array.from(nodeMap.values()),
      edges: dedupedEdges,
      rootId,
    },
    meta: {
      session: sessionId,
      entityCount: nodeMap.size,
      edgeCount: dedupedEdges.length,
      queryTimeMs: Date.now() - t0,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Classify a node by entity type + the predicate that links it. */
function classifyNode(
  entityType: string,
  predicate: string,
  isDecision: boolean,
  isTarget: boolean,
): NodeKind {
  if (isDecision) return "decision";
  if (isTarget && PREDICATE_TO_KIND[predicate]) {
    return PREDICATE_TO_KIND[predicate];
  }
  if (entityType === "option") return "option";
  if (entityType === "risk") return "risk";
  return "concept";
}

/** Extract non-stop-word keywords from a question. */
function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/** Remove duplicate edges (same source + target + label). */
function deduplicateEdges(edges: InsightEdge[]): InsightEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}→${e.target}→${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Escape double quotes for embedding in Cypher string literals. */
function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
