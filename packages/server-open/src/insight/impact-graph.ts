// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact-graph builder — queries the knowledge graph for a seed entity and
 * expands outward N hops to visualize semantic impact / blast radius.
 *
 * Algorithm:
 *   1. Find the best-matching Canon:Entity from the user question.
 *   2. Expand outward via CANON_REL (bidirectional) up to `hops` levels.
 *   3. Determine depth for each entity (BFS distance from seed).
 *   4. Fetch all relationships within the expanded subgraph.
 *   5. Classify nodes by kind (decision, risk, concept, …) and depth.
 *   6. Attach raw triples for provenance.
 */

import type {
  InsightResponse,
  InsightNode,
  InsightEdge,
  InsightConnection,
  InsightRawTriple,
  ImpactSummary,
  ImpactChain,
  NodeKind,
} from "./types.js";
import { enrichNodeDescriptions } from "./describe.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Predicates that signal risk or blocking relationships. */
const RISK_PREDICATES = new Set(["RISKS", "BLOCKS"]);

/** Predicates that signal decisions. */
const DECISION_PREDICATES = new Set(["DECIDED_FOR", "DECIDED_AGAINST"]);

/** Predicates that signal dependency relationships. */
const DEPENDENCY_PREDICATES = new Set([
  "DEPENDS_ON",
  "ENABLES",
  "CONTAINS",
  "USES",
  "CALLS",
]);

/** Classify a predicate into a severity level. */
function predicateSeverity(pred: string): "critical" | "warning" | "info" {
  if (RISK_PREDICATES.has(pred)) return "critical";
  if (DEPENDENCY_PREDICATES.has(pred) || pred === "DECIDED_AGAINST")
    return "warning";
  return "info";
}

/** Map KG entity type → NodeKind. */
const TYPE_TO_KIND: Record<string, NodeKind> = {
  decision: "decision",
  option: "option",
  risk: "risk",
  concept: "concept",
  rationale: "rationale",
};

/** Stop words stripped when extracting seed keywords from a question. */
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
  "all",
  "show",
  "me",
  "my",
  "our",
  "your",
  "impact",
  "affects",
  "affect",
  "change",
  "changes",
  "if",
  "i",
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function asStringArray(val: unknown): string[] | undefined {
  if (Array.isArray(val) && val.length > 0) return val.map(String);
  return undefined;
}

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

function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function deduplicateEdges(edges: InsightEdge[]): InsightEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}→${e.target}→${e.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Classify a node into a visual kind based on entity type and neighboring predicates. */
function classifyImpactNode(
  entityType: string,
  depth: number,
  neighborPredicates: Set<string>,
): NodeKind {
  if (depth === 0) return "center";
  // KG entity type takes precedence
  if (TYPE_TO_KIND[entityType]) return TYPE_TO_KIND[entityType];
  // Check if this entity is primarily risk-related
  for (const p of neighborPredicates) {
    if (RISK_PREDICATES.has(p)) return "risk";
    if (DECISION_PREDICATES.has(p)) return "decision";
  }
  return "affected";
}

// ── Runner interface ─────────────────────────────────────────────────────────

interface CypherRunner {
  run: (cypher: string) => Promise<Record<string, unknown>[]>;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface BuildImpactGraphOpts {
  runner: CypherRunner;
  sessionId: string;
  /** Entity name or natural language question. Used to find the seed entity. */
  question?: string;
  /** Maximum expansion hops from the seed (1–3, default 2). */
  hops?: number;
  /** Maximum total nodes in the subgraph (default 60). */
  maxNodes?: number;
  /** Maximum edges in the subgraph (default 500). */
  maxEdges?: number;
}

/**
 * Build an impact-graph visualization from the knowledge graph.
 *
 * The center node is the entity best matching the user's question.
 * We expand outward via CANON_REL to reveal impact chains.
 */
export async function buildImpactGraph(
  opts: BuildImpactGraphOpts,
): Promise<InsightResponse> {
  const {
    runner,
    sessionId,
    question,
    hops = 2,
    maxNodes = 60,
    maxEdges = 500,
  } = opts;
  const t0 = Date.now();

  const sid = escapeStr(sessionId);
  const keywords = question ? extractKeywords(question) : [];
  const effectiveHops = Math.min(Math.max(hops, 1), 3);

  // ── Step 1: Find seed entity ─────────────────────────────────────────────
  // Try keyword matching first, then fall back to highest-confidence entity.
  let seedRow: Record<string, unknown> | undefined;

  if (keywords.length > 0) {
    const keywordFilter = keywords
      .map(
        (k) =>
          `toLower(c.name) CONTAINS "${escapeStr(k)}" OR any(a IN coalesce(c.aliases, []) WHERE toLower(a) CONTAINS "${escapeStr(k)}")`,
      )
      .join(" OR ");

    const seedRows = await runner.run(`
      MATCH (c:Canon:Entity {session_id: "${sid}"})
      WHERE (${keywordFilter})
      RETURN c.canonId AS id, c.name AS name, c.type AS type,
             coalesce(c.confidence, 1.0) AS confidence,
             c.aliases AS aliases, c.run_id AS runId, c.artifactId AS artifactId,
             toString(c.created_at) AS createdAt, toString(c.updated_at) AS updatedAt
      ORDER BY c.confidence DESC
      LIMIT 1
    `);
    seedRow = seedRows[0];
  }

  // Fallback: most-connected entity
  if (!seedRow) {
    const fallbackRows = await runner.run(`
      MATCH (c:Canon:Entity {session_id: "${sid}"})-[r:CANON_REL]-()
      WITH c, count(r) AS rels
      ORDER BY rels DESC
      LIMIT 1
      RETURN c.canonId AS id, c.name AS name, c.type AS type,
             coalesce(c.confidence, 1.0) AS confidence,
             c.aliases AS aliases, c.run_id AS runId, c.artifactId AS artifactId,
             toString(c.created_at) AS createdAt, toString(c.updated_at) AS updatedAt
    `);
    seedRow = fallbackRows[0];
  }

  // Empty state — no entities at all
  if (!seedRow) {
    return {
      vizType: "impact-graph",
      title: question ?? "Impact Analysis",
      data: {
        nodes: [
          {
            id: "__empty__",
            label: "No entities found",
            kind: "center" as const,
            depth: 0,
          },
        ],
        edges: [],
        centerId: "__empty__",
        maxDepth: 0,
        summary: {
          headline: "No entities found matching the query.",
          stats: {
            directCount: 0,
            rippleCount: 0,
            riskCount: 0,
            decisionCount: 0,
            totalRelationships: 0,
          },
          riskChains: [],
          decisionChains: [],
          dependencyChains: [],
          contextLines: [],
        },
      },
      meta: {
        session: sessionId,
        entityCount: 0,
        edgeCount: 0,
        queryTimeMs: Date.now() - t0,
      },
    };
  }

  const seedId = seedRow.id as string;

  // ── Step 2: Expand outward N hops ────────────────────────────────────────
  // Bidirectional expansion via variable-length CANON_REL.
  const expansionRows = await runner.run(`
    MATCH (seed:Canon:Entity {session_id: "${sid}", canonId: "${escapeStr(seedId)}"})
    OPTIONAL MATCH (seed)-[:CANON_REL*1..${effectiveHops}]-(neighbor:Canon:Entity {session_id: "${sid}"})
    WHERE neighbor.canonId <> "${escapeStr(seedId)}"
    WITH DISTINCT neighbor
    WHERE neighbor IS NOT NULL
    RETURN neighbor.canonId AS id, neighbor.name AS name, neighbor.type AS type,
           coalesce(neighbor.confidence, 1.0) AS confidence,
           neighbor.aliases AS aliases, neighbor.run_id AS runId, neighbor.artifactId AS artifactId,
           toString(neighbor.created_at) AS createdAt, toString(neighbor.updated_at) AS updatedAt
    ORDER BY neighbor.confidence DESC
    LIMIT ${maxNodes - 1}
  `);

  // ── Step 3: Determine depth via BFS ──────────────────────────────────────
  // Fetch 1-hop neighbors to distinguish depth=1 from depth=2+
  const allNeighborIds = expansionRows.map((r) => r.id as string);
  const depthMap = new Map<string, number>();
  depthMap.set(seedId, 0);

  if (allNeighborIds.length > 0 && effectiveHops > 1) {
    const neighborIdList = allNeighborIds
      .map((id) => `"${escapeStr(id)}"`)
      .join(", ");

    const oneHopRows = await runner.run(`
      MATCH (seed:Canon:Entity {session_id: "${sid}", canonId: "${escapeStr(seedId)}"})
            -[:CANON_REL]-
            (n:Canon:Entity {session_id: "${sid}"})
      WHERE n.canonId IN [${neighborIdList}]
      RETURN DISTINCT n.canonId AS id
    `);

    const oneHopSet = new Set(oneHopRows.map((r) => r.id as string));

    for (const id of allNeighborIds) {
      depthMap.set(id, oneHopSet.has(id) ? 1 : 2);
    }
  } else {
    // hops=1: everything is depth 1
    for (const id of allNeighborIds) {
      depthMap.set(id, 1);
    }
  }

  // ── Step 4: Fetch subgraph relationships ─────────────────────────────────
  const allIds = [seedId, ...allNeighborIds];
  const allIdList = allIds.map((id) => `"${escapeStr(id)}"`).join(", ");

  const edgeRows = await runner.run(`
    MATCH (a:Canon:Entity {session_id: "${sid}"})-[r:CANON_REL]->(b:Canon:Entity {session_id: "${sid}"})
    WHERE a.canonId IN [${allIdList}] AND b.canonId IN [${allIdList}]
    RETURN a.canonId AS sourceId, a.name AS sourceName,
           r.predicate AS predicate,
           b.canonId AS targetId, b.name AS targetName
    ORDER BY r.confidence DESC
    LIMIT ${maxEdges}
  `);

  // ── Step 5: Assemble nodes + edges ───────────────────────────────────────
  const nodeMap = new Map<string, InsightNode>();
  const connectionMap = new Map<string, InsightConnection[]>();
  const edges: InsightEdge[] = [];

  // Track which predicates connect to each node (for classification)
  const nodePredicates = new Map<string, Set<string>>();
  for (const row of edgeRows) {
    const sId = row.sourceId as string;
    const tId = row.targetId as string;
    const pred = row.predicate as string;

    if (!nodePredicates.has(sId)) nodePredicates.set(sId, new Set());
    if (!nodePredicates.has(tId)) nodePredicates.set(tId, new Set());
    nodePredicates.get(sId)!.add(pred);
    nodePredicates.get(tId)!.add(pred);
  }

  // Add seed node
  nodeMap.set(seedId, {
    id: seedId,
    label: seedRow.name as string,
    kind: "center",
    description: `Impact center — ${seedRow.type as string}`,
    confidence: seedRow.confidence as number | undefined,
    aliases: asStringArray(seedRow.aliases),
    sourceDoc: seedRow.artifactId as string | undefined,
    runId: seedRow.runId as string | undefined,
    entityType: seedRow.type as string | undefined,
    createdAt: seedRow.createdAt as string | undefined,
    updatedAt: seedRow.updatedAt as string | undefined,
    depth: 0,
  });

  // Add neighbor nodes
  for (const row of expansionRows) {
    const id = row.id as string;
    const depth = depthMap.get(id) ?? 2;
    const entityType = row.type as string;
    const preds = nodePredicates.get(id) ?? new Set<string>();

    nodeMap.set(id, {
      id,
      label: row.name as string,
      kind: classifyImpactNode(entityType, depth, preds),
      confidence: row.confidence as number | undefined,
      aliases: asStringArray(row.aliases),
      sourceDoc: row.artifactId as string | undefined,
      runId: row.runId as string | undefined,
      entityType,
      createdAt: row.createdAt as string | undefined,
      updatedAt: row.updatedAt as string | undefined,
      depth,
    });
  }

  // Build edges + connections
  for (const row of edgeRows) {
    const sId = row.sourceId as string;
    const tId = row.targetId as string;
    const pred = row.predicate as string;

    if (nodeMap.has(sId) && nodeMap.has(tId)) {
      edges.push({ source: sId, target: tId, label: pred });

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
  }

  // Attach connections to nodes
  for (const [nodeId, connections] of connectionMap) {
    const node = nodeMap.get(nodeId);
    if (node) node.connections = connections;
  }

  // ── Step 6: Fetch raw triples for provenance ─────────────────────────────
  const canonIds = allIds.filter((id) => nodeMap.has(id));
  if (canonIds.length > 0) {
    const canonIdList = canonIds.map((id) => `"${escapeStr(id)}"`).join(", ");
    const rawTripleRows = await runner.run(`
      MATCH (rt:RawTriple)-[:CANONICALIZED_FROM]->(c:Canon:Entity {session_id: "${sid}"})
      WHERE c.canonId IN [${canonIdList}]
      RETURN c.canonId AS canonId, rt.subject AS subject, rt.predicate AS predicate, rt.object AS object
      LIMIT 500
    `);

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

    for (const [canonId, triples] of tripleMap) {
      const node = nodeMap.get(canonId);
      if (node) node.rawTriples = triples;
    }
  }

  const dedupedEdges = deduplicateEdges(edges);
  const actualMaxDepth = Math.max(...Array.from(depthMap.values()), 0);
  const seedName = seedRow.name as string;
  const title = question ? `Impact: ${seedName}` : `Impact: ${seedName}`;

  // ── Step 7: Synthesize descriptions from raw triples ─────────────────────
  enrichNodeDescriptions(nodeMap.values());

  // ── Step 8: Build impact summary ─────────────────────────────────────────
  const summary = buildImpactSummary(
    seedName,
    seedRow.type as string,
    Array.from(nodeMap.values()),
    dedupedEdges,
    depthMap,
    nodeMap,
  );

  return {
    vizType: "impact-graph",
    title,
    data: {
      nodes: Array.from(nodeMap.values()),
      edges: dedupedEdges,
      centerId: seedId,
      maxDepth: actualMaxDepth,
      summary,
    },
    meta: {
      session: sessionId,
      entityCount: nodeMap.size,
      edgeCount: dedupedEdges.length,
      queryTimeMs: Date.now() - t0,
    },
  };
}

// ── Summary builder ──────────────────────────────────────────────────────────

function buildImpactSummary(
  seedName: string,
  seedType: string,
  nodes: InsightNode[],
  edges: InsightEdge[],
  depthMap: Map<string, number>,
  nodeMap: Map<string, InsightNode>,
): ImpactSummary {
  const directNodes = nodes.filter((n) => n.depth === 1);
  const rippleNodes = nodes.filter((n) => (n.depth ?? 0) >= 2);
  const riskNodes = nodes.filter(
    (n) => n.kind === "risk" || n.entityType === "risk",
  );
  const decisionNodes = nodes.filter(
    (n) => n.kind === "decision" || n.entityType === "decision",
  );

  // Classify edges into chains
  const riskChains: ImpactChain[] = [];
  const decisionChains: ImpactChain[] = [];
  const dependencyChains: ImpactChain[] = [];

  for (const edge of edges) {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const pred = edge.label;
    const severity = predicateSeverity(pred);
    const humanPred = pred.toLowerCase().replace(/_/g, " ");
    const chain: ImpactChain = {
      path: `${sourceNode.label} → ${humanPred} → ${targetNode.label}`,
      severity,
      predicate: pred,
      entities: [sourceNode.label, targetNode.label],
    };

    if (RISK_PREDICATES.has(pred)) {
      riskChains.push(chain);
    } else if (DECISION_PREDICATES.has(pred)) {
      decisionChains.push(chain);
    } else if (DEPENDENCY_PREDICATES.has(pred)) {
      dependencyChains.push(chain);
    }
  }

  // Build headline
  const parts: string[] = [];
  parts.push(
    `Changing **${seedName}** (${seedType}) directly affects **${directNodes.length}** entit${directNodes.length === 1 ? "y" : "ies"}`,
  );
  if (rippleNodes.length > 0) {
    parts.push(`and ripples to **${rippleNodes.length}** more`);
  }
  const headline = parts.join(" ") + ".";

  // Build context lines (RAG-quality structured text)
  const contextLines: string[] = [];

  contextLines.push(`## Impact Analysis: ${seedName}`);
  contextLines.push("");
  contextLines.push(`Center entity: ${seedName} (type: ${seedType})`);
  contextLines.push(
    `Blast radius: ${directNodes.length} direct + ${rippleNodes.length} ripple = ${nodes.length - 1} total affected entities`,
  );
  contextLines.push("");

  if (riskChains.length > 0) {
    contextLines.push("### Risks & Blockers");
    for (const c of riskChains) {
      contextLines.push(`- [${c.severity.toUpperCase()}] ${c.path}`);
    }
    contextLines.push("");
  }

  if (decisionChains.length > 0) {
    contextLines.push("### Related Decisions");
    for (const c of decisionChains) {
      contextLines.push(`- ${c.path}`);
    }
    contextLines.push("");
  }

  if (dependencyChains.length > 0) {
    contextLines.push("### Dependencies");
    for (const c of dependencyChains) {
      contextLines.push(`- [${c.severity.toUpperCase()}] ${c.path}`);
    }
    contextLines.push("");
  }

  // List affected entities by depth
  if (directNodes.length > 0) {
    contextLines.push("### Direct Impact (1 hop)");
    for (const n of directNodes) {
      const typeTag = n.entityType ? ` (${n.entityType})` : "";
      const confTag =
        n.confidence != null
          ? ` [conf: ${(n.confidence * 100).toFixed(0)}%]`
          : "";
      contextLines.push(`- ${n.label}${typeTag}${confTag}`);
    }
    contextLines.push("");
  }

  if (rippleNodes.length > 0) {
    contextLines.push("### Ripple Effect (2+ hops)");
    for (const n of rippleNodes) {
      const typeTag = n.entityType ? ` (${n.entityType})` : "";
      contextLines.push(`- ${n.label}${typeTag}`);
    }
    contextLines.push("");
  }

  return {
    headline,
    stats: {
      directCount: directNodes.length,
      rippleCount: rippleNodes.length,
      riskCount: riskChains.length,
      decisionCount: decisionChains.length,
      totalRelationships: edges.length,
    },
    riskChains,
    decisionChains,
    dependencyChains,
    contextLines,
  };
}
