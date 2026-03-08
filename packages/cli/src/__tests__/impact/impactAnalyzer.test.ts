// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the impact analyzer module.
 *
 * - formatImpactMarkdown: sections, grouping, edge cases
 * - formatImpactJson: serialization
 * - analyzeImpact: Cypher query flow with mock runner
 */

import { describe, it, expect } from "vitest";
import {
  formatImpactMarkdown,
  formatImpactJson,
  analyzeImpact,
} from "../../impact/impactAnalyzer.js";
import {
  createImpactResult,
  createImpactEntity,
  createImpactRelationship,
  createMockRunner,
  createSequentialMockRunner,
} from "../helpers.js";

// =============================================================================
// formatImpactMarkdown
// =============================================================================

describe("formatImpactMarkdown", () => {
  it("renders header with file names and session", () => {
    const result = createImpactResult({
      files: ["src/App.tsx"],
      sessionId: "planpling",
      stats: {
        filesAnalyzed: 1,
        directCount: 2,
        rippleCount: 5,
        totalRelationships: 3,
        decisionCount: 1,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("# Impact Analysis");
    expect(md).toContain("`src/App.tsx`");
    expect(md).toContain("planpling");
    expect(md).toContain("2 direct");
    expect(md).toContain("5 ripple");
  });

  it("groups multiple files (>3) as count", () => {
    const result = createImpactResult({
      files: ["a.ts", "b.ts", "c.ts", "d.ts"],
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("4 files");
  });

  it("shows individual files when <=3", () => {
    const result = createImpactResult({
      files: ["a.ts", "b.ts"],
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("`a.ts`");
    expect(md).toContain("`b.ts`");
  });

  it("renders direct impact section", () => {
    const result = createImpactResult({
      directEntities: [
        createImpactEntity({
          name: "React",
          type: "technology",
          confidence: 0.99,
          via: "direct",
          depth: 0,
          codeRef: {
            filePath: "package.json",
            kind: "package-dep",
            strategy: "dep",
          },
        }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 1,
        rippleCount: 0,
        totalRelationships: 0,
        decisionCount: 0,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("## Direct Impact");
    expect(md).toContain("**React**");
    expect(md).toContain("technology");
    expect(md).toContain("package-dep");
    expect(md).toContain("dep");
  });

  it("shows confidence badge for low-confidence entities", () => {
    const result = createImpactResult({
      directEntities: [
        createImpactEntity({ name: "fuzzy-match", confidence: 0.72 }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 1,
        rippleCount: 0,
        totalRelationships: 0,
        decisionCount: 0,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("[72%]");
  });

  it("omits confidence badge for high-confidence entities (>=0.9)", () => {
    const result = createImpactResult({
      directEntities: [
        createImpactEntity({ name: "sure-thing", confidence: 0.95 }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 1,
        rippleCount: 0,
        totalRelationships: 0,
        decisionCount: 0,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).not.toContain("[95%]");
  });

  it("renders ripple impact grouped by hop depth", () => {
    const result = createImpactResult({
      rippleEntities: [
        createImpactEntity({ name: "Near", via: "ripple", depth: 1 }),
        createImpactEntity({ name: "Far", via: "ripple", depth: 2 }),
        createImpactEntity({ name: "Also Near", via: "ripple", depth: 1 }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 0,
        rippleCount: 3,
        totalRelationships: 0,
        decisionCount: 0,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("## Ripple Impact");
    expect(md).toContain("### 1 hop away");
    expect(md).toContain("### 2 hops away");
    expect(md).toContain("**Near**");
    expect(md).toContain("**Far**");
  });

  it("renders decision trail with DECIDED_FOR / DECIDED_AGAINST", () => {
    const result = createImpactResult({
      decisions: [
        createImpactRelationship({
          sourceName: "architecture",
          predicate: "DECIDED_FOR",
          targetName: "React",
          rationale: "Best ecosystem support",
        }),
        createImpactRelationship({
          sourceName: "architecture",
          predicate: "DECIDED_AGAINST",
          targetName: "Vue",
        }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 0,
        rippleCount: 0,
        totalRelationships: 0,
        decisionCount: 2,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("## Affected Decisions");
    expect(md).toContain("✅ chose");
    expect(md).toContain("❌ rejected");
    expect(md).toContain("Best ecosystem support");
  });

  it("renders risks and blockers", () => {
    const result = createImpactResult({
      risks: [
        createImpactRelationship({
          sourceName: "complexity",
          predicate: "RISKS",
          targetName: "delivery",
        }),
        createImpactRelationship({
          sourceName: "debt",
          predicate: "BLOCKS",
          targetName: "refactor",
        }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 0,
        rippleCount: 0,
        totalRelationships: 0,
        decisionCount: 0,
        riskCount: 2,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("## Risks & Blockers");
    expect(md).toContain("⚠️");
    expect(md).toContain("🚫");
  });

  it("renders key relationships grouped by predicate", () => {
    const result = createImpactResult({
      relationships: [
        createImpactRelationship({
          predicate: "DEPENDS_ON",
          sourceName: "A",
          targetName: "B",
        }),
        createImpactRelationship({
          predicate: "DEPENDS_ON",
          sourceName: "C",
          targetName: "D",
        }),
        createImpactRelationship({
          predicate: "USES",
          sourceName: "E",
          targetName: "F",
        }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 0,
        rippleCount: 0,
        totalRelationships: 3,
        decisionCount: 0,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("## Key Relationships");
    expect(md).toContain("### DEPENDS_ON (2)");
    expect(md).toContain("### USES (1)");
    expect(md).toContain("A → B");
  });

  it("excludes DECIDED_FOR/AGAINST/RISKS/BLOCKS from key relationships", () => {
    const result = createImpactResult({
      relationships: [
        createImpactRelationship({
          predicate: "DECIDED_FOR",
          sourceName: "X",
          targetName: "Y",
        }),
        createImpactRelationship({
          predicate: "RISKS",
          sourceName: "X",
          targetName: "Y",
        }),
      ],
      stats: {
        filesAnalyzed: 1,
        directCount: 0,
        rippleCount: 0,
        totalRelationships: 2,
        decisionCount: 0,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).not.toContain("## Key Relationships");
  });

  it('shows "No Impact Found" when no direct entities', () => {
    const result = createImpactResult();
    const md = formatImpactMarkdown(result);
    expect(md).toContain("## No Impact Found");
    expect(md).toContain("iw xlink");
  });

  it("truncates key relationships to top 10 per predicate", () => {
    const rels = Array.from({ length: 15 }, (_, i) =>
      createImpactRelationship({
        predicate: "USES",
        sourceName: `S${i}`,
        targetName: `T${i}`,
      }),
    );
    const result = createImpactResult({
      relationships: rels,
      stats: {
        filesAnalyzed: 1,
        directCount: 0,
        rippleCount: 0,
        totalRelationships: 15,
        decisionCount: 0,
        riskCount: 0,
      },
    });
    const md = formatImpactMarkdown(result);
    expect(md).toContain("_(5 more)_");
  });
});

// =============================================================================
// formatImpactJson
// =============================================================================

describe("formatImpactJson", () => {
  it("serializes result as valid JSON", () => {
    const result = createImpactResult({
      directEntities: [createImpactEntity({ name: "React" })],
    });
    const json = formatImpactJson(result);
    const parsed = JSON.parse(json);
    expect(parsed.directEntities[0].name).toBe("React");
    expect(parsed.sessionId).toBe("test-session");
  });

  it("preserves all fields", () => {
    const result = createImpactResult({
      files: ["a.ts", "b.ts"],
      risks: [createImpactRelationship({ predicate: "RISKS" })],
    });
    const parsed = JSON.parse(formatImpactJson(result));
    expect(parsed.files).toHaveLength(2);
    expect(parsed.risks).toHaveLength(1);
  });
});

// =============================================================================
// analyzeImpact — integration with mock runner
// =============================================================================

describe("analyzeImpact", () => {
  it("returns empty result when no CodeRef entities found", async () => {
    const runner = createMockRunner(); // returns [] for all queries

    const result = await analyzeImpact(["src/App.tsx"], {
      runner,
      sessionId: "test",
    });

    expect(result.directEntities).toHaveLength(0);
    expect(result.rippleEntities).toHaveLength(0);
    expect(result.stats.directCount).toBe(0);
    expect(runner.calls).toHaveLength(1); // Only the direct query, stops early
  });

  it("finds direct entities via CodeRef queries", async () => {
    const runner = createSequentialMockRunner([
      // Step 1: Direct entities (CodeRef → Canon)
      [
        {
          name: "React",
          type: "technology",
          confidence: 0.99,
          filePath: "package.json",
          kind: "package-dep",
          strategy: "dep",
        },
        {
          name: "TypeScript",
          type: "technology",
          confidence: 0.95,
          filePath: "tsconfig.json",
          kind: "file",
          strategy: "path",
        },
      ],
      // Step 2: Ripple entities
      [],
      // Step 3: Relationships in subgraph
      [],
    ]);

    const result = await analyzeImpact(["package.json"], {
      runner,
      sessionId: "planpling",
    });

    expect(result.directEntities).toHaveLength(2);
    expect(result.directEntities[0].name).toBe("React");
    expect(result.directEntities[0].via).toBe("direct");
    expect(result.directEntities[0].depth).toBe(0);
    expect(result.stats.directCount).toBe(2);
  });

  it("expands ripple entities and classifies decisions/risks", async () => {
    const runner = createSequentialMockRunner([
      // Step 1: Direct entities
      [
        {
          name: "React",
          type: "technology",
          confidence: 0.99,
          filePath: "package.json",
          kind: "package-dep",
          strategy: "dep",
        },
      ],
      // Step 2: Ripple (full range)
      [
        { name: "frontend", type: "component", confidence: 0.9 },
        { name: "state-management", type: "concept", confidence: 0.85 },
      ],
      // Step 2b: Hop-1 refinement
      [{ name: "frontend" }],
      // Step 3: Relationships in subgraph
      [
        {
          sName: "frontend",
          sType: "component",
          predicate: "USES",
          tName: "React",
          tType: "technology",
          confidence: 0.95,
        },
        {
          sName: "architecture",
          sType: "decision",
          predicate: "DECIDED_FOR",
          tName: "React",
          tType: "technology",
          confidence: 0.9,
        },
        {
          sName: "complexity",
          sType: "risk",
          predicate: "RISKS",
          tName: "frontend",
          tType: "component",
          confidence: 0.7,
        },
      ],
      // Step 4: Rationale enrichment
      [],
    ]);

    const result = await analyzeImpact(["package.json"], {
      runner,
      sessionId: "planpling",
      hops: 2,
    });

    expect(result.directEntities).toHaveLength(1);
    expect(result.rippleEntities).toHaveLength(2);
    expect(result.relationships.length).toBeGreaterThanOrEqual(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].predicate).toBe("DECIDED_FOR");
    expect(result.risks).toHaveLength(1);
    expect(result.risks[0].predicate).toBe("RISKS");
  });

  it("normalizes file paths (strips ./ prefix)", async () => {
    const runner = createMockRunner([{ match: /CodeRef/, rows: [] }]);

    await analyzeImpact(["./src/App.tsx"], {
      runner,
      sessionId: "test",
    });

    // The query params should have normalized path
    const firstCall = runner.calls[0];
    expect(firstCall.params?.files).toEqual(["src/App.tsx"]);
  });

  it("respects minConfidence option", async () => {
    const runner = createSequentialMockRunner([
      // Direct entities
      [
        {
          name: "React",
          type: "technology",
          confidence: 0.99,
          filePath: "pkg.json",
          kind: "dep",
          strategy: "dep",
        },
      ],
      // Ripple
      [],
      // Relationships
      [],
    ]);

    await analyzeImpact(["pkg.json"], {
      runner,
      sessionId: "test",
      minConfidence: 0.5,
    });

    // The minConf param should be passed to the ripple query
    const rippleCall = runner.calls[1];
    expect(rippleCall.params?.minConf).toBe(0.5);
  });
});
