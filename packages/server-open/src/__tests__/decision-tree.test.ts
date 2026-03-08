// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { buildDecisionTree } from "../insight/decision-tree.js";

// ── Mock runner ────────────────────────────────────────────────────────────

function mockRunner(responses: Record<string, unknown>[][]) {
  let callIdx = 0;
  return {
    run: async (_cypher: string) => {
      return responses[callIdx++] ?? [];
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("buildDecisionTree", () => {
  it("returns empty tree when no decisions exist", async () => {
    const runner = mockRunner([[]]);
    const result = await buildDecisionTree({
      runner,
      sessionId: "test",
    });

    expect(result.vizType).toBe("decision-tree");
    expect(result.data.nodes).toHaveLength(1); // just root
    expect(result.data.nodes[0].kind).toBe("topic");
    expect(result.data.edges).toHaveLength(0);
    expect(result.meta.entityCount).toBe(0);
  });

  it("builds tree from decision + edge data", async () => {
    const decisions = [
      {
        id: "auth_method",
        name: "Authentication Method",
        type: "decision",
        confidence: 0.9,
      },
      {
        id: "db_choice",
        name: "Database Choice",
        type: "decision",
        confidence: 0.85,
      },
    ];

    const edges = [
      {
        sourceId: "auth_method",
        sourceName: "Authentication Method",
        sourceType: "decision",
        sourceConf: 0.9,
        predicate: "DECIDED_FOR",
        targetId: "jwt_tokens",
        targetName: "JWT Tokens",
        targetType: "option",
        targetConf: 0.8,
      },
      {
        sourceId: "auth_method",
        sourceName: "Authentication Method",
        sourceType: "decision",
        sourceConf: 0.9,
        predicate: "DECIDED_AGAINST",
        targetId: "session_cookies",
        targetName: "Session Cookies",
        targetType: "option",
        targetConf: 0.7,
      },
      {
        sourceId: "db_choice",
        sourceName: "Database Choice",
        sourceType: "decision",
        sourceConf: 0.85,
        predicate: "DECIDED_FOR",
        targetId: "neo4j",
        targetName: "Neo4j",
        targetType: "technology",
        targetConf: 0.95,
      },
    ];

    const runner = mockRunner([decisions, edges]);
    const result = await buildDecisionTree({
      runner,
      sessionId: "test",
    });

    expect(result.vizType).toBe("decision-tree");
    expect(result.data.rootId).toBe("__root__");

    // nodes: root + 2 decisions + 3 options/technologies = 6
    expect(result.data.nodes).toHaveLength(6);

    // Find by kind
    const chosen = result.data.nodes.filter((n) => n.kind === "chosen");
    const rejected = result.data.nodes.filter((n) => n.kind === "rejected");
    expect(chosen).toHaveLength(2); // JWT + Neo4j
    expect(rejected).toHaveLength(1); // Session Cookies

    // Edges: 2 root→decision + 3 decision→option = 5
    expect(result.data.edges).toHaveLength(5);

    expect(result.meta.entityCount).toBe(6);
  });

  it("extracts keywords from question for filtering", async () => {
    // First query (topic-filtered) returns empty, fallback returns decisions
    const fallbackDecisions = [
      { id: "d1", name: "Auth decision", type: "decision", confidence: 0.8 },
    ];
    const runner = mockRunner([[], fallbackDecisions, []]);

    const result = await buildDecisionTree({
      runner,
      sessionId: "test",
      question: "What decisions were made about authentication?",
    });

    expect(result.vizType).toBe("decision-tree");
    // Should have at least the root + the fallback decision
    expect(result.data.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates edges", async () => {
    const decisions = [
      { id: "d1", name: "Decision 1", type: "decision", confidence: 0.9 },
    ];

    // Same edge returned twice
    const edges = [
      {
        sourceId: "d1",
        sourceName: "Decision 1",
        sourceType: "decision",
        sourceConf: 0.9,
        predicate: "DECIDED_FOR",
        targetId: "opt1",
        targetName: "Option 1",
        targetType: "option",
        targetConf: 0.8,
      },
      {
        sourceId: "d1",
        sourceName: "Decision 1",
        sourceType: "decision",
        sourceConf: 0.9,
        predicate: "DECIDED_FOR",
        targetId: "opt1",
        targetName: "Option 1",
        targetType: "option",
        targetConf: 0.8,
      },
    ];

    const runner = mockRunner([decisions, edges]);
    const result = await buildDecisionTree({ runner, sessionId: "test" });

    // Should deduplicate: root→d1 + d1→opt1 = 2 (not 3)
    expect(result.data.edges).toHaveLength(2);
  });
});
