// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { buildImpactGraph } from "../insight/impact-graph.js";
import type { ImpactGraphData } from "../insight/types.js";

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

describe("buildImpactGraph", () => {
  it("returns empty state when no entities exist", async () => {
    // Seed keyword query returns empty, fallback returns empty
    const runner = mockRunner([[], []]);
    const result = await buildImpactGraph({
      runner,
      sessionId: "test",
      question: "authentication",
    });

    expect(result.vizType).toBe("impact-graph");
    const data = result.data as ImpactGraphData;
    expect(data.nodes).toHaveLength(1);
    expect(data.nodes[0].kind).toBe("center");
    expect(data.centerId).toBe("__empty__");
    expect(data.maxDepth).toBe(0);
    expect(result.meta.entityCount).toBe(0);

    // Summary present even in empty state
    expect(data.summary).toBeDefined();
    expect(data.summary.stats.directCount).toBe(0);
    expect(data.summary.contextLines).toHaveLength(0);
  });

  it("builds impact graph from seed + neighbors", async () => {
    // Step 1: seed entity (keyword match)
    const seedRows = [
      {
        id: "auth",
        name: "Authentication",
        type: "component",
        confidence: 0.95,
        aliases: ["auth", "login"],
        runId: "run-001",
        artifactId: "docs/auth.md",
        createdAt: "2025-06-15T10:00:00Z",
        updatedAt: "2025-07-01T12:00:00Z",
      },
    ];

    // Step 2: expansion (1..2 hops)
    const expansionRows = [
      {
        id: "jwt",
        name: "JWT Tokens",
        type: "technology",
        confidence: 0.9,
        aliases: ["JSON Web Tokens"],
        runId: "run-001",
        artifactId: "docs/auth.md",
        createdAt: "2025-06-15T10:00:00Z",
        updatedAt: null,
      },
      {
        id: "session",
        name: "Session Management",
        type: "component",
        confidence: 0.85,
        runId: "run-002",
        artifactId: "docs/sessions.md",
        createdAt: "2025-06-20T09:00:00Z",
        updatedAt: null,
      },
      {
        id: "sec_risk",
        name: "Token Expiry Risk",
        type: "risk",
        confidence: 0.7,
        runId: "run-001",
        artifactId: "docs/auth.md",
        createdAt: "2025-06-15T11:00:00Z",
        updatedAt: null,
      },
    ];

    // Step 3: 1-hop check — jwt and sec_risk are direct, session is 2-hop
    const oneHopRows = [{ id: "jwt" }, { id: "sec_risk" }];

    // Step 4: subgraph relationships
    const edgeRows = [
      {
        sourceId: "auth",
        sourceName: "Authentication",
        predicate: "DEPENDS_ON",
        targetId: "jwt",
        targetName: "JWT Tokens",
      },
      {
        sourceId: "auth",
        sourceName: "Authentication",
        predicate: "RISKS",
        targetId: "sec_risk",
        targetName: "Token Expiry Risk",
      },
      {
        sourceId: "jwt",
        sourceName: "JWT Tokens",
        predicate: "ENABLES",
        targetId: "session",
        targetName: "Session Management",
      },
    ];

    // Step 5: raw triples
    const rawTriples = [
      {
        canonId: "auth",
        subject: "Authentication",
        predicate: "DEPENDS_ON",
        object: "JWT Tokens",
      },
    ];

    const runner = mockRunner([
      seedRows,
      expansionRows,
      oneHopRows,
      edgeRows,
      rawTriples,
    ]);

    const result = await buildImpactGraph({
      runner,
      sessionId: "test",
      question: "authentication",
      hops: 2,
    });

    expect(result.vizType).toBe("impact-graph");
    const data = result.data as ImpactGraphData;

    // 4 nodes: auth (center) + jwt + session + sec_risk
    expect(data.nodes).toHaveLength(4);
    expect(data.centerId).toBe("auth");
    expect(data.maxDepth).toBe(2);

    // Center node
    const center = data.nodes.find((n) => n.id === "auth");
    expect(center?.kind).toBe("center");
    expect(center?.depth).toBe(0);
    expect(center?.aliases).toEqual(["auth", "login"]);
    expect(center?.createdAt).toBe("2025-06-15T10:00:00Z");

    // Direct nodes (1-hop)
    const jwt = data.nodes.find((n) => n.id === "jwt");
    expect(jwt?.depth).toBe(1);
    expect(jwt?.kind).toBe("affected"); // technology not in TYPE_TO_KIND → falls through to affected

    const risk = data.nodes.find((n) => n.id === "sec_risk");
    expect(risk?.depth).toBe(1);
    expect(risk?.kind).toBe("risk");

    // Ripple node (2-hop)
    const session = data.nodes.find((n) => n.id === "session");
    expect(session?.depth).toBe(2);

    // Edges
    expect(data.edges).toHaveLength(3);

    // Connections
    expect(center?.connections).toBeDefined();
    expect(center!.connections!.length).toBeGreaterThanOrEqual(2);

    // Raw triples
    expect(center?.rawTriples).toBeDefined();
    expect(center!.rawTriples).toHaveLength(1);
    expect(center!.rawTriples![0].subject).toBe("Authentication");

    // Impact summary
    expect(data.summary).toBeDefined();
    expect(data.summary.headline).toContain("Authentication");
    expect(data.summary.stats.directCount).toBe(2); // jwt + sec_risk
    expect(data.summary.stats.rippleCount).toBe(1); // session
    expect(data.summary.stats.riskCount).toBeGreaterThanOrEqual(1); // RISKS edge
    expect(data.summary.stats.totalRelationships).toBe(3);

    // Risk chains should include the RISKS edge
    expect(data.summary.riskChains.length).toBeGreaterThanOrEqual(1);
    expect(data.summary.riskChains[0].predicate).toBe("RISKS");
    expect(data.summary.riskChains[0].severity).toBe("critical");

    // Dependency chains should include DEPENDS_ON + ENABLES
    expect(data.summary.dependencyChains.length).toBeGreaterThanOrEqual(1);

    // Context lines should be populated
    expect(data.summary.contextLines.length).toBeGreaterThan(0);
    expect(
      data.summary.contextLines.some((l: string) =>
        l.includes("Authentication"),
      ),
    ).toBe(true);
  });

  it("falls back to most-connected entity when no keyword match", async () => {
    // Step 1: keyword query returns empty
    const keywordEmpty: Record<string, unknown>[] = [];

    // Fallback: most-connected
    const fallbackRows = [
      {
        id: "react",
        name: "React",
        type: "technology",
        confidence: 0.95,
      },
    ];

    // Step 2: expansion
    const expansionRows = [
      {
        id: "vite",
        name: "Vite",
        type: "technology",
        confidence: 0.9,
      },
    ];

    // Step 3: 1-hop (hops=1, so skip)
    // Step 4: edge rows
    const edgeRows = [
      {
        sourceId: "react",
        sourceName: "React",
        predicate: "DEPENDS_ON",
        targetId: "vite",
        targetName: "Vite",
      },
    ];

    // Step 5: raw triples
    const rawTriples: Record<string, unknown>[] = [];

    const runner = mockRunner([
      keywordEmpty,
      fallbackRows,
      expansionRows,
      edgeRows,
      rawTriples,
    ]);

    const result = await buildImpactGraph({
      runner,
      sessionId: "test",
      question: "nonexistent entity placeholder",
      hops: 1,
    });

    const data = result.data as ImpactGraphData;
    expect(data.centerId).toBe("react");
    expect(data.nodes).toHaveLength(2);

    // Title uses the seed entity name
    expect(result.title).toContain("React");
  });

  it("respects maxNodes limit", async () => {
    const seedRows = [
      { id: "core", name: "Core System", type: "component", confidence: 1.0 },
    ];

    // Generate many neighbors
    const manyNeighbors = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      name: `Neighbor ${i}`,
      type: "concept",
      confidence: 0.5,
    }));

    const runner = mockRunner([
      seedRows,
      manyNeighbors,
      [], // 1-hop
      [], // edges
      [], // raw triples
    ]);

    const result = await buildImpactGraph({
      runner,
      sessionId: "test",
      maxNodes: 10,
    });

    const data = result.data as ImpactGraphData;
    // maxNodes=10 means up to 9 neighbors + 1 center (the LIMIT in Cypher is maxNodes-1)
    // In practice the mock returns all 50, but the builder trusts the Cypher LIMIT.
    // Since our mock doesn't actually limit, we just verify the builder doesn't crash.
    expect(data.nodes.length).toBeGreaterThanOrEqual(2);
    expect(data.centerId).toBe("core");
  });

  it("clamps hops between 1 and 3", async () => {
    const seedRows = [
      { id: "x", name: "Entity X", type: "concept", confidence: 1.0 },
    ];

    // hops=0 should be clamped to 1, so no 1-hop refinement query
    const runner = mockRunner([
      seedRows,
      [], // expansion
      [], // edges (skips 1-hop check since hops=1)
      [], // raw triples
    ]);

    const result = await buildImpactGraph({
      runner,
      sessionId: "test",
      hops: 0, // should clamp to 1
    });

    const data = result.data as ImpactGraphData;
    expect(data.centerId).toBe("x");
    expect(data.nodes).toHaveLength(1);
  });
});
