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
  NodeKind,
} from "./types.js";

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
    RETURN d.canonId AS id, d.name AS name, d.type AS type, d.confidence AS confidence
    LIMIT ${maxDecisions}
  `);

  // If no decisions matched by keywords, fall back to all decisions
  let decisionsToUse = decisionRows;
  if (decisionsToUse.length === 0 && keywords.length > 0) {
    decisionsToUse = await runner.run(`
      MATCH (d:Canon:Entity {session_id: "${sid}"})
      WHERE d.type = 'decision'
      RETURN d.canonId AS id, d.name AS name, d.type AS type, d.confidence AS confidence
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
           r.predicate AS predicate,
           b.canonId  AS targetId,   b.name  AS targetName, b.type  AS targetType, b.confidence AS targetConf
    LIMIT ${maxEdges}
  `);

  // ── Step 3: Assemble nodes + edges ───────────────────────────────────────
  const nodeMap = new Map<string, InsightNode>();
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
      });
    }

    edges.push({ source: sId, target: tId, label: pred });
  }

  const dedupedEdges = deduplicateEdges(edges);

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
