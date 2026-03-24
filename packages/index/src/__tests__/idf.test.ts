// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { computeIdf, STOPWORD_BASELINE, STOPWORD_CEILING } from "../idf.js";
import type { KwxStageOutput, MentionRecord } from "@intentweave/core";

function makeMention(entityName: string): MentionRecord {
  return {
    entityName,
    text: `mention of ${entityName}`,
    filePath: "doc.md",
    startLine: 1,
    endLine: 1,
    startChar: 0,
    endChar: 10,
    qualifiers: [],
    source: "code-span",
    chunkId: "c1",
    chunkType: "section",
  };
}

function makeKwx(
  filePath: string,
  entityNames: string[],
): KwxStageOutput {
  return {
    $schema: "intentweave://schemas/kwx/v1",
    stage: "KWX",
    schemaVersion: 1,
    artifactId: filePath.replace(/\//g, "."),
    filePath,
    mentions: entityNames.map((n) => makeMention(n)),
    entities: entityNames.map((n) => ({
      name: n,
      mentionCount: 1,
      filePaths: [filePath],
      qualifiers: [],
      predominantSource: "code-span" as const,
    })),
    meta: {
      mentionCount: entityNames.length,
      entityCount: entityNames.length,
      qualifiedMentionCount: 0,
      processingTimeMs: 1,
    },
  };
}

describe("computeIdf", () => {
  it("returns empty map for no inputs", () => {
    const result = computeIdf([]);
    expect(result.size).toBe(0);
  });

  it("entity in all docs → IDF = 0", () => {
    const kwx1 = makeKwx("a.md", ["neo4j"]);
    const kwx2 = makeKwx("b.md", ["neo4j"]);
    const kwx3 = makeKwx("c.md", ["neo4j"]);

    const scores = computeIdf([kwx1, kwx2, kwx3]);

    expect(scores.get("neo4j")).toBe(0);
  });

  it("entity in 1 of 3 docs → IDF = 2/3", () => {
    const kwx1 = makeKwx("a.md", ["neo4j"]);
    const kwx2 = makeKwx("b.md", ["react"]);
    const kwx3 = makeKwx("c.md", ["vue"]);

    const scores = computeIdf([kwx1, kwx2, kwx3]);

    expect(scores.get("neo4j")).toBeCloseTo(2 / 3, 5);
    expect(scores.get("react")).toBeCloseTo(2 / 3, 5);
    expect(scores.get("vue")).toBeCloseTo(2 / 3, 5);
  });

  it("entity in 2 of 4 docs → IDF = 0.5", () => {
    const kwx1 = makeKwx("a.md", ["typescript"]);
    const kwx2 = makeKwx("b.md", ["typescript"]);
    const kwx3 = makeKwx("c.md", ["python"]);
    const kwx4 = makeKwx("d.md", ["python"]);

    const scores = computeIdf([kwx1, kwx2, kwx3, kwx4]);

    expect(scores.get("typescript")).toBe(0.5);
    expect(scores.get("python")).toBe(0.5);
  });

  it("is case-insensitive (normalizes to lowercase)", () => {
    const kwx1 = makeKwx("a.md", ["Neo4j"]);
    const kwx2 = makeKwx("b.md", ["neo4j"]);

    const scores = computeIdf([kwx1, kwx2]);

    // Both "neo4j" entries merge (same lowercased key), df=2, N=2 → IDF=0
    expect(scores.get("neo4j")).toBe(0);
  });

  it("duplicate mentions in same doc count as 1", () => {
    // "neo4j" appears 3 times in same doc, but df should be 1
    const kwx = makeKwx("a.md", ["neo4j", "neo4j", "neo4j"]);
    const kwx2 = makeKwx("b.md", ["react"]);

    const scores = computeIdf([kwx, kwx2]);

    expect(scores.get("neo4j")).toBe(0.5); // 1 - (1/2)
  });

  // =========================================================================
  // Stopword baseline (Phase 5.4)
  // =========================================================================

  it("caps stopword IDF to STOPWORD_CEILING", () => {
    // "system" is in STOPWORD_BASELINE. In 1 of 3 docs → normal IDF = 2/3 ≈ 0.667
    // Should be capped to 0.15
    const kwx1 = makeKwx("a.md", ["system"]);
    const kwx2 = makeKwx("b.md", ["neo4j"]);
    const kwx3 = makeKwx("c.md", ["react"]);

    const scores = computeIdf([kwx1, kwx2, kwx3]);

    expect(scores.get("system")).toBe(STOPWORD_CEILING);
    // Non-stopword terms unaffected
    expect(scores.get("neo4j")).toBeCloseTo(2 / 3, 5);
    expect(scores.get("react")).toBeCloseTo(2 / 3, 5);
  });

  it("stopword in all docs → IDF = 0 (below ceiling, unchanged)", () => {
    const kwx1 = makeKwx("a.md", ["system"]);
    const kwx2 = makeKwx("b.md", ["system"]);

    const scores = computeIdf([kwx1, kwx2]);

    // IDF = 1 - 2/2 = 0, which is < 0.15, so min(0, 0.15) = 0
    expect(scores.get("system")).toBe(0);
  });

  it("pre-seeds unseen stopwords with STOPWORD_CEILING", () => {
    const kwx1 = makeKwx("a.md", ["neo4j"]);

    const scores = computeIdf([kwx1]);

    // "system" never appeared but should be pre-seeded
    expect(scores.get("system")).toBe(STOPWORD_CEILING);
    // Other baseline terms too
    expect(scores.get("data")).toBe(STOPWORD_CEILING);
    expect(scores.get("implementation")).toBe(STOPWORD_CEILING);
  });

  it("STOPWORD_BASELINE is a non-empty set", () => {
    expect(STOPWORD_BASELINE.size).toBeGreaterThan(40);
    expect(STOPWORD_BASELINE.has("system")).toBe(true);
    expect(STOPWORD_BASELINE.has("data")).toBe(true);
    expect(STOPWORD_BASELINE.has("component")).toBe(true);
  });

  it("STOPWORD_CEILING is 0.15", () => {
    expect(STOPWORD_CEILING).toBe(0.15);
  });
});
