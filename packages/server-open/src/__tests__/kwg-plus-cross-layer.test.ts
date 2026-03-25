// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KWG+ Cross-Layer Connectivity Evaluation Test Suite.
 *
 * Evaluates how well the KWG+ builder connects nodes across layers
 * (KWG ↔ TCG ↔ SCG ↔ Drift). Uses mock runners to simulate realistic
 * Neo4j data and verify that bridge nodes and edges form correctly.
 *
 * @see kwg-plus-graph.ts
 */

import { describe, it, expect } from "vitest";
import { buildKwgPlusGraph } from "../insight/kwg-plus-graph.js";
import type {
  InsightNode,
  InsightEdge,
  KnowledgeGraphData,
} from "../insight/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

interface MockQuery {
  pattern: RegExp;
  rows: Record<string, unknown>[];
}

/**
 * Creates a mock Cypher runner that matches queries by regex pattern
 * and returns canned responses. Checks patterns in order — first match wins.
 * Normalizes whitespace so `.*` works across multi-line Cypher strings.
 */
function patternRunner(queries: MockQuery[]) {
  return {
    run: async (cypher: string, _params?: Record<string, unknown>) => {
      const normalized = cypher.replace(/\s+/g, " ");
      for (const q of queries) {
        if (q.pattern.test(normalized)) return q.rows;
      }
      return [];
    },
  };
}

/** Extract edges by label from KnowledgeGraphData */
function edgesByLabel(data: KnowledgeGraphData): Record<string, InsightEdge[]> {
  const map: Record<string, InsightEdge[]> = {};
  for (const e of data.edges) {
    (map[e.label] ??= []).push(e);
  }
  return map;
}

/** Classify nodes by layer prefix */
function nodesByLayer(nodes: InsightNode[]) {
  const kwg = nodes.filter(
    (n) =>
      n.id.startsWith("kwent:") ||
      n.id.startsWith("kwdoc:") ||
      n.id.startsWith("kwcluster:"),
  );
  const tcg = nodes.filter((n) => n.id.startsWith("tcg"));
  const scg = nodes.filter((n) => n.id.startsWith("scg"));
  const drift = nodes.filter((n) => n.id.startsWith("drift:"));
  return { kwg, tcg, scg, drift };
}

/** Count edges crossing between two layer prefixes */
function crossLayerEdgeCount(
  edges: InsightEdge[],
  prefixA: string,
  prefixB: string,
): number {
  return edges.filter(
    (e) =>
      (e.source.startsWith(prefixA) && e.target.startsWith(prefixB)) ||
      (e.source.startsWith(prefixB) && e.target.startsWith(prefixA)),
  ).length;
}

// ── Mock data for a realistic 4-layer scenario ─────────────────────────────

/** Simulates a workspace with overlapping KWG docs, TCG files, SCG files, and drift signals */
function realisticMockQueries(): MockQuery[] {
  return [
    // KWG entities (top by connection count)
    {
      pattern: /KWEntity.*ORDER BY rels DESC/,
      rows: [
        {
          name: "Pipeline",
          type: "concept",
          mentionCount: 20,
          qualifiers: null,
          predominantSource: null,
          filePaths: null,
        },
        {
          name: "Analyzer",
          type: "component",
          mentionCount: 15,
          qualifiers: null,
          predominantSource: null,
          filePaths: null,
        },
        {
          name: "Cache",
          type: "component",
          mentionCount: 12,
          qualifiers: null,
          predominantSource: null,
          filePaths: null,
        },
        {
          name: "drift",
          type: "concept",
          mentionCount: 10,
          qualifiers: null,
          predominantSource: null,
          filePaths: null,
        },
        {
          name: "symbols",
          type: "concept",
          mentionCount: 8,
          qualifiers: null,
          predominantSource: null,
          filePaths: null,
        },
      ],
    },
    // KWDoc nodes
    {
      pattern: /KWDoc.*KW_MENTIONS.*DISTINCT d/,
      rows: [
        { docPath: "docs/ARCHITECTURE.md", entityCount: 30, mentionCount: 100 },
        { docPath: "README.md", entityCount: 10, mentionCount: 40 },
      ],
    },
    // KW_MENTIONS edges
    {
      pattern: /KWDoc.*KW_MENTIONS.*RETURN d\.filePath.*e\.name/,
      rows: [
        { docPath: "docs/ARCHITECTURE.md", entityName: "Pipeline" },
        { docPath: "docs/ARCHITECTURE.md", entityName: "Analyzer" },
        { docPath: "docs/ARCHITECTURE.md", entityName: "Cache" },
        { docPath: "README.md", entityName: "Pipeline" },
      ],
    },
    // CO_OCCURS edges
    {
      pattern: /CO_OCCURS/,
      rows: [
        { entityA: "Pipeline", entityB: "Analyzer", count: 5, score: 0.8 },
        { entityA: "Cache", entityB: "Pipeline", count: 3, score: 0.6 },
      ],
    },
    // KWCluster
    { pattern: /KWCluster.*REPRESENTED_BY/, rows: [] },
    { pattern: /MEMBER_OF.*KWCluster/, rows: [] },
    // KWEntity count
    { pattern: /count\(e\) AS cnt/, rows: [{ cnt: 50 }] },

    // TCGFile — top files by change frequency
    {
      pattern: /TCGFile.*changeCount/,
      rows: [
        {
          filePath: "src/analyzer.ts",
          staleness: 0.2,
          hotspot: 0.8,
          changeCount: 50,
        },
        {
          filePath: "src/cache.ts",
          staleness: 0.1,
          hotspot: 0.6,
          changeCount: 30,
        },
        {
          filePath: "README.md",
          staleness: 0.3,
          hotspot: 0.3,
          changeCount: 10,
        },
        {
          filePath: "src/pipeline.ts",
          staleness: 0.15,
          hotspot: 0.7,
          changeCount: 40,
        },
      ],
    },
    // TCGCommit
    {
      pattern: /TCGCommit.*ORDER BY c\.date/,
      rows: [
        {
          hash: "abc1234",
          message: "Refactor pipeline",
          date: "2026-01-15",
          authorName: "Alice",
        },
      ],
    },
    // TCGAuthor
    {
      pattern: /TCGAuthor.*email/,
      rows: [{ email: "alice@example.com", name: "Alice" }],
    },
    // MODIFIED edges
    {
      pattern: /TCGCommit.*MODIFIED.*TCGFile/,
      rows: [
        { hash: "abc1234", filePath: "src/analyzer.ts" },
        { hash: "abc1234", filePath: "src/pipeline.ts" },
      ],
    },
    // AUTHORED_BY edges
    {
      pattern: /TCGCommit.*AUTHORED_BY/,
      rows: [{ hash: "abc1234", email: "alice@example.com" }],
    },
    // CO_CHANGED_WITH edges
    {
      pattern: /CO_CHANGED_WITH/,
      rows: [{ pathA: "src/analyzer.ts", pathB: "src/cache.ts", count: 5 }],
    },

    // ── SCG Layer + Bridge patterns ───────────────────────────────────────
    // IMPORTANT: Bridge patterns must come BEFORE layer patterns because
    // layer patterns are broad enough to match bridge queries too.
    // The pattern runner returns the first match, so specific → general order.

    // Cross-layer bridge: TCGFile ↔ SCG:File overlap (has BOTH TCGFile and SCG:File)
    {
      pattern: /TCGFile.*SCG:File.*t\.filePath = s\.filePath/,
      rows: [
        { filePath: "src/analyzer.ts", symbolCount: 25 },
        { filePath: "src/cache.ts", symbolCount: 15 },
        { filePath: "src/pipeline.ts", symbolCount: 10 },
      ],
    },
    // Cross-layer bridge: KWDoc ↔ TCGFile
    {
      pattern: /TCGFile.*filePath IN/,
      rows: [{ filePath: "README.md" }],
    },
    // Cross-layer bridge: KWEntity → SCG:Symbol name matches (grounding)
    {
      pattern: /KWEntity.*SCG:Symbol.*toLower/,
      rows: [
        {
          entityName: "Analyzer",
          symbolId: "sym:Analyzer",
          symbolName: "Analyzer",
          symbolKind: "class",
          filePath: "src/analyzer.ts",
        },
        {
          entityName: "Cache",
          symbolId: "sym:Cache",
          symbolName: "Cache",
          symbolKind: "class",
          filePath: "src/cache.ts",
        },
        {
          entityName: "Pipeline",
          symbolId: "sym:Pipeline",
          symbolName: "Pipeline",
          symbolKind: "interface",
          filePath: "src/pipeline.ts",
        },
      ],
    },

    // SCG:File — top files by symbol count
    {
      pattern: /SCG:File.*symbolCount DESC/,
      rows: [
        {
          filePath: "src/analyzer.ts",
          language: "typescript",
          symbolCount: 25,
        },
        { filePath: "src/cache.ts", language: "typescript", symbolCount: 15 },
        { filePath: "src/model.ts", language: "typescript", symbolCount: 20 },
      ],
    },
    // SCG:Symbol — exported symbols (must NOT match grounding bridge query)
    {
      pattern: /SCG_CONTAINS.*SCG:Symbol/,
      rows: [
        {
          symbolId: "sym:Analyzer",
          name: "Analyzer",
          kind: "class",
          filePath: "src/analyzer.ts",
          exportStatus: "exported",
          startLine: 10,
        },
        {
          symbolId: "sym:Cache",
          name: "Cache",
          kind: "class",
          filePath: "src/cache.ts",
          exportStatus: "exported",
          startLine: 5,
        },
        {
          symbolId: "sym:Pipeline",
          name: "Pipeline",
          kind: "interface",
          filePath: "src/pipeline.ts",
          exportStatus: "exported",
          startLine: 1,
        },
        {
          symbolId: "sym:Model",
          name: "Model",
          kind: "class",
          filePath: "src/model.ts",
          exportStatus: "exported",
          startLine: 3,
        },
      ],
    },

    // Drift signals (actual Neo4j schema: name, files[], message, category)
    {
      pattern: /DriftSignal.*name.*detector.*severity/,
      rows: [
        {
          id: "drift-1",
          name: "Pipeline",
          detector: "missing-code-ref",
          severity: "warning",
          message: "Pipeline docs outdated",
          category: "undocumented",
          files: ["src/pipeline.ts"],
        },
        {
          id: "drift-2",
          name: "README",
          detector: "staleness",
          severity: "info",
          message: "README needs update",
          category: "stale",
          files: ["README.md"],
        },
      ],
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe("KWG+ Cross-Layer Connectivity", () => {
  // ── Metric 1: Isolated node ratio ────────────────────────────────────────

  it("keeps SCG isolated node ratio below 30%", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;

    const scgNodes = data.nodes.filter((n) => n.id.startsWith("scg"));
    const scgIds = new Set(scgNodes.map((n) => n.id));
    const connectedScg = new Set<string>();
    for (const e of data.edges) {
      if (scgIds.has(e.source)) connectedScg.add(e.source);
      if (scgIds.has(e.target)) connectedScg.add(e.target);
    }
    const isolatedRatio =
      (scgIds.size - connectedScg.size) / Math.max(scgIds.size, 1);

    expect(isolatedRatio).toBeLessThan(0.3);
  });

  // ── Metric 2: SAME_FILE bridge density ───────────────────────────────────

  it("creates SAME_FILE edges between TCG and SCG layers", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;
    const eb = edgesByLabel(data);

    const sameFileEdges = eb["SAME_FILE"] ?? [];
    expect(sameFileEdges.length).toBeGreaterThanOrEqual(3);

    // At least some should bridge TCG↔SCG
    const tcgScgBridge = sameFileEdges.filter(
      (e) =>
        (e.source.startsWith("tcg") && e.target.startsWith("scg")) ||
        (e.source.startsWith("scg") && e.target.startsWith("tcg")),
    );
    expect(tcgScgBridge.length).toBeGreaterThanOrEqual(2);
  });

  // ── Metric 3: GROUNDED_IN edges (KWG→SCG) ───────────────────────────────

  it("creates GROUNDED_IN edges bridging KWG entities to SCG symbols", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;
    const eb = edgesByLabel(data);

    const groundedEdges = eb["GROUNDED_IN"] ?? [];
    expect(groundedEdges.length).toBeGreaterThanOrEqual(2);

    // Each GROUNDED_IN should connect kwent: → scgsym:
    for (const e of groundedEdges) {
      expect(e.source).toMatch(/^kwent:/);
      expect(e.target).toMatch(/^scgsym:/);
    }
  });

  // ── Metric 4: KWDoc↔TCGFile bridge ──────────────────────────────────────

  it("bridges KWDoc nodes to TCGFile nodes via SAME_FILE", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;

    const docTcgBridges = data.edges.filter(
      (e) =>
        e.label === "SAME_FILE" &&
        ((e.source.startsWith("kwdoc:") && e.target.startsWith("tcg")) ||
          (e.source.startsWith("tcg") && e.target.startsWith("kwdoc:"))),
    );
    expect(docTcgBridges.length).toBeGreaterThanOrEqual(1);
  });

  // ── Metric 5: Drift→Code linking ────────────────────────────────────────

  it("links DriftSignals to file nodes via DRIFTED_FILE", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;
    const eb = edgesByLabel(data);

    // DRIFTED_FILE edges connect drift → scgfile/tcgfile
    const driftedFileEdges = eb["DRIFTED_FILE"] ?? [];
    expect(driftedFileEdges.length).toBeGreaterThanOrEqual(1);

    // Each drift signal should connect to at least one file
    const driftNodes = data.nodes.filter((n) => n.id.startsWith("drift:"));
    const driftWithEdges = driftNodes.filter((n) =>
      data.edges.some((e) => e.source === n.id || e.target === n.id),
    );
    expect(driftWithEdges.length).toBeGreaterThanOrEqual(1);
  });

  // ── Metric 6: Multi-hop reachability ─────────────────────────────────────

  it("allows reaching SCG from KWG within 3 hops", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;

    // BFS from all KWG nodes to see if any SCG node is reachable within 3 hops
    const adj = new Map<string, string[]>();
    for (const e of data.edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      if (!adj.has(e.target)) adj.set(e.target, []);
      adj.get(e.source)!.push(e.target);
      adj.get(e.target)!.push(e.source);
    }

    const kwgIds = data.nodes
      .filter((n) => n.id.startsWith("kwent:") || n.id.startsWith("kwdoc:"))
      .map((n) => n.id);
    const scgIds = new Set(
      data.nodes.filter((n) => n.id.startsWith("scg")).map((n) => n.id),
    );

    let reachableScg = false;
    for (const startId of kwgIds) {
      const visited = new Set<string>([startId]);
      let frontier = [startId];
      for (let hop = 0; hop < 3; hop++) {
        const next: string[] = [];
        for (const nid of frontier) {
          for (const neighbor of adj.get(nid) ?? []) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              next.push(neighbor);
              if (scgIds.has(neighbor)) {
                reachableScg = true;
              }
            }
          }
        }
        frontier = next;
      }
      if (reachableScg) break;
    }

    expect(reachableScg).toBe(true);
  });

  // ── Metric 7: Layer connectivity matrix non-zero ─────────────────────────

  it("has non-zero cross-layer connectivity for KWG↔TCG, TCG↔SCG, KWG↔SCG", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;

    expect(crossLayerEdgeCount(data.edges, "kwdoc:", "tcg")).toBeGreaterThan(0);
    expect(crossLayerEdgeCount(data.edges, "tcg", "scg")).toBeGreaterThan(0);
    expect(crossLayerEdgeCount(data.edges, "kwent:", "scg")).toBeGreaterThan(0);
  });

  // ── Metric 8: No duplicate SAME_FILE edges ──────────────────────────────

  it("does not create duplicate SAME_FILE edges", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;

    const sameFilePairs = new Set<string>();
    const sameFileEdges = data.edges.filter((e) => e.label === "SAME_FILE");
    for (const e of sameFileEdges) {
      const pair = [e.source, e.target].sort().join("↔");
      expect(sameFilePairs.has(pair)).toBe(false);
      sameFilePairs.add(pair);
    }
  });

  // ── Metric 9: Graceful degradation when SCG is empty ────────────────────

  it("works when SCG layer has no data", async () => {
    const queries = realisticMockQueries().map((q) => {
      // Clear any pattern that involves SCG
      const patStr = q.pattern.source;
      if (patStr.includes("SCG")) {
        return { ...q, rows: [] };
      }
      return q;
    });

    const runner = patternRunner(queries);
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });
    const data = result.data as KnowledgeGraphData;

    // KWG + TCG + Drift nodes should still exist
    expect(data.nodes.length).toBeGreaterThan(0);
    // No crash, response well-formed
    expect(result.vizType).toBe("knowledge-graph");
    expect(result.title).toContain("KWG+");
  });

  // ── Metric 10: Summary statistics ────────────────────────────────────────

  it("produces correct layer statistics in title", async () => {
    const runner = patternRunner(realisticMockQueries());
    const result = await buildKwgPlusGraph({ runner, sessionId: "test" });

    expect(result.title).toContain("KWG+");
    expect(result.title).toContain("TCG(");
    expect(result.title).toContain("SCG(");
    expect(result.title).toContain("Drift(");
  });
});
