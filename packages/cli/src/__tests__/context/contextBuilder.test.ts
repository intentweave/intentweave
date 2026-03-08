// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the context builder module.
 *
 * - formatContextMarkdown: sections, token budget trimming, options
 * - formatContextJson: serialization
 * - buildEntityContext / buildFullContext / buildTopicContext: mock runner flows
 * - enrichWithDescriptions / enrichWithCodeRefs: enrichment
 */

import { describe, it, expect } from "vitest";
import {
  formatContextMarkdown,
  formatContextJson,
  buildEntityContext,
  buildFullContext,
  buildTopicContext,
  enrichWithDescriptions,
  enrichWithCodeRefs,
} from "../../context/contextBuilder.js";
import {
  createContextBundle,
  createContextEntity,
  createContextRelationship,
  createMockRunner,
  createSequentialMockRunner,
  createMockLlm,
} from "../helpers.js";

// =============================================================================
// formatContextMarkdown
// =============================================================================

describe("formatContextMarkdown", () => {
  it("renders header with topic and session", () => {
    const bundle = createContextBundle({
      topic: "authentication",
      sessionId: "planpling",
      stats: {
        totalEntities: 5,
        totalRelationships: 3,
        entityTypes: {},
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle);
    expect(md).toContain("# Knowledge Context: authentication");
    expect(md).toContain("planpling");
    expect(md).toContain("5 entities");
    expect(md).toContain("3 relationships");
  });

  it("renders entity overview by type", () => {
    const bundle = createContextBundle({
      stats: {
        totalEntities: 3,
        totalRelationships: 0,
        entityTypes: { technology: 2, concept: 1 },
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle);
    expect(md).toContain("## Entity Overview");
    expect(md).toContain("**technology**: 2");
    expect(md).toContain("**concept**: 1");
  });

  it("renders entities grouped by type", () => {
    const bundle = createContextBundle({
      entities: [
        createContextEntity({
          name: "React",
          type: "technology",
          aliases: ["react.js"],
        }),
        createContextEntity({ name: "Redux", type: "technology" }),
        createContextEntity({ name: "SPA", type: "concept", confidence: 0.7 }),
      ],
      stats: {
        totalEntities: 3,
        totalRelationships: 0,
        entityTypes: { technology: 2, concept: 1 },
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle);
    expect(md).toContain("## Technologys");
    expect(md).toContain("**React**");
    expect(md).toContain("aka: react.js");
    expect(md).toContain("## Concepts");
    expect(md).toContain("[70%]"); // Low confidence badge
  });

  it("includes descriptions when option set", () => {
    const bundle = createContextBundle({
      entities: [
        createContextEntity({
          name: "React",
          type: "technology",
          description: "UI library by Meta",
        }),
      ],
      stats: {
        totalEntities: 1,
        totalRelationships: 0,
        entityTypes: { technology: 1 },
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle, { includeDescriptions: true });
    expect(md).toContain("UI library by Meta");
  });

  it("omits descriptions when option not set", () => {
    const bundle = createContextBundle({
      entities: [
        createContextEntity({
          name: "React",
          type: "technology",
          description: "UI library by Meta",
        }),
      ],
      stats: {
        totalEntities: 1,
        totalRelationships: 0,
        entityTypes: { technology: 1 },
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle, {});
    expect(md).not.toContain("UI library by Meta");
  });

  it("includes provenance when option set", () => {
    const bundle = createContextBundle({
      entities: [
        createContextEntity({
          name: "React",
          type: "technology",
          sources: ["concept-talk.md"],
        }),
      ],
      stats: {
        totalEntities: 1,
        totalRelationships: 0,
        entityTypes: { technology: 1 },
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle, { includeProvenance: true });
    expect(md).toContain("concept-talk.md");
  });

  it("includes code refs when option set", () => {
    const bundle = createContextBundle({
      entities: [
        createContextEntity({
          name: "React",
          type: "technology",
          codeRefs: [
            {
              filePath: "package.json",
              name: "react",
              kind: "package-dep",
              strategy: "dep",
              confidence: 0.99,
            },
          ],
        }),
      ],
      stats: {
        totalEntities: 1,
        totalRelationships: 0,
        entityTypes: { technology: 1 },
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle, { includeCodeRefs: true });
    expect(md).toContain("📂 Code:");
    expect(md).toContain("package.json");
    expect(md).toContain("## Code References");
  });

  it("renders relationships grouped by predicate", () => {
    const bundle = createContextBundle({
      relationships: [
        createContextRelationship({
          sourceName: "A",
          predicate: "DEPENDS_ON",
          targetName: "B",
          confidence: 0.9,
        }),
        createContextRelationship({
          sourceName: "C",
          predicate: "USES",
          targetName: "D",
          confidence: 0.7,
        }),
      ],
      stats: {
        totalEntities: 0,
        totalRelationships: 2,
        entityTypes: {},
        predicateCounts: { DEPENDS_ON: 1, USES: 1 },
      },
    });
    const md = formatContextMarkdown(bundle);
    expect(md).toContain("## Relationships");
    expect(md).toContain("### DEPENDS_ON");
    expect(md).toContain("A → B");
    expect(md).toContain("### USES");
    expect(md).toContain("[70%]");
  });

  it("shows rationales inline when option set", () => {
    const bundle = createContextBundle({
      relationships: [
        createContextRelationship({
          sourceName: "App",
          predicate: "USES",
          targetName: "React",
          rationale: "Main UI framework",
        }),
      ],
      stats: {
        totalEntities: 0,
        totalRelationships: 1,
        entityTypes: {},
        predicateCounts: { USES: 1 },
      },
    });
    const md = formatContextMarkdown(bundle, { includeRationales: true });
    expect(md).toContain("Main UI framework");
  });

  it("renders decision trail for DECIDED_FOR/AGAINST rels", () => {
    const bundle = createContextBundle({
      relationships: [
        createContextRelationship({
          sourceName: "arch",
          predicate: "DECIDED_FOR",
          targetName: "React",
        }),
        createContextRelationship({
          sourceName: "arch",
          predicate: "DECIDED_AGAINST",
          targetName: "Angular",
        }),
      ],
      stats: {
        totalEntities: 0,
        totalRelationships: 2,
        entityTypes: {},
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle);
    expect(md).toContain("## Decision Trail");
    expect(md).toContain("✅ chose");
    expect(md).toContain("❌ rejected");
  });

  it("renders risks section", () => {
    const bundle = createContextBundle({
      relationships: [
        createContextRelationship({
          sourceName: "complexity",
          predicate: "RISKS",
          targetName: "delivery",
        }),
      ],
      stats: {
        totalEntities: 0,
        totalRelationships: 1,
        entityTypes: {},
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle);
    expect(md).toContain("## Risks");
    expect(md).toContain("⚠");
  });

  it("trims provenance first when over token budget", () => {
    const entities = Array.from({ length: 50 }, (_, i) =>
      createContextEntity({
        name: `Entity${i}`,
        type: "concept",
        sources: [`very-long-source-document-name-${i}.md`],
      }),
    );
    const bundle = createContextBundle({
      entities,
      stats: {
        totalEntities: 50,
        totalRelationships: 0,
        entityTypes: { concept: 50 },
        predicateCounts: {},
      },
    });

    // Very tight budget
    const md = formatContextMarkdown(bundle, {
      includeProvenance: true,
      tokenBudget: 200,
    });
    // Provenance should be stripped first
    expect(md).not.toContain("_Source:");
  });

  it("hard-truncates when budget is extremely small", () => {
    const entities = Array.from({ length: 100 }, (_, i) =>
      createContextEntity({ name: `Entity${i}`, type: "concept" }),
    );
    const bundle = createContextBundle({
      entities,
      stats: {
        totalEntities: 100,
        totalRelationships: 0,
        entityTypes: { concept: 100 },
        predicateCounts: {},
      },
    });
    const md = formatContextMarkdown(bundle, { tokenBudget: 50 });
    expect(md).toContain("[Context truncated to fit token budget]");
  });
});

// =============================================================================
// formatContextJson
// =============================================================================

describe("formatContextJson", () => {
  it("serializes as valid JSON", () => {
    const bundle = createContextBundle({
      entities: [createContextEntity({ name: "React" })],
    });
    const json = formatContextJson(bundle);
    const parsed = JSON.parse(json);
    expect(parsed.entities[0].name).toBe("React");
    expect(parsed.topic).toBe("test topic");
  });
});

// =============================================================================
// buildFullContext — with mock runner
// =============================================================================

describe("buildFullContext", () => {
  it("fetches all entities and relationships from session", async () => {
    const runner = createSequentialMockRunner([
      // Entities query
      [
        {
          canonId: "react",
          name: "React",
          type: "technology",
          aliases: ["react.js"],
          confidence: 0.99,
          sources: ["doc.md"],
        },
        {
          canonId: "spa",
          name: "SPA",
          type: "concept",
          aliases: [],
          confidence: 0.85,
          sources: [],
        },
      ],
      // Relationships query
      [
        {
          sName: "SPA",
          sType: "concept",
          predicate: "USES",
          tName: "React",
          tType: "technology",
          confidence: 0.9,
        },
      ],
    ]);

    const bundle = await buildFullContext({
      runner,
      sessionId: "test-session",
    });

    expect(bundle.entities).toHaveLength(2);
    expect(bundle.entities[0].name).toBe("React");
    expect(bundle.relationships).toHaveLength(1);
    expect(bundle.stats.totalEntities).toBe(2);
    expect(bundle.stats.totalRelationships).toBe(1);
    expect(bundle.stats.entityTypes.technology).toBe(1);
    expect(bundle.stats.entityTypes.concept).toBe(1);
  });

  it("returns empty bundle for empty session", async () => {
    const runner = createSequentialMockRunner([[], []]);

    const bundle = await buildFullContext({
      runner,
      sessionId: "empty",
    });

    expect(bundle.entities).toHaveLength(0);
    expect(bundle.relationships).toHaveLength(0);
  });
});

// =============================================================================
// buildEntityContext — with mock runner
// =============================================================================

describe("buildEntityContext", () => {
  it("finds entity and expands neighborhood", async () => {
    const runner = createSequentialMockRunner([
      // Seed lookup (fuzzy match)
      [{ canonId: "react", name: "React", type: "technology" }],
      // Neighborhood expansion
      [
        {
          canonId: "react",
          name: "React",
          type: "technology",
          aliases: [],
          confidence: 0.99,
          sources: [],
        },
        {
          canonId: "frontend",
          name: "frontend",
          type: "component",
          aliases: [],
          confidence: 0.9,
          sources: [],
        },
      ],
      // Relationships
      [
        {
          sName: "frontend",
          sType: "component",
          predicate: "USES",
          tName: "React",
          tType: "technology",
          confidence: 0.9,
        },
      ],
    ]);

    const bundle = await buildEntityContext("React", {
      runner,
      sessionId: "test",
      hops: 1,
    });

    expect(bundle.entities.length).toBeGreaterThanOrEqual(1);
    expect(bundle.topic).toContain("React");
  });

  it("returns empty bundle when entity not found", async () => {
    const runner = createSequentialMockRunner([
      [], // No seed match
    ]);

    const bundle = await buildEntityContext("NonExistent", {
      runner,
      sessionId: "test",
    });

    expect(bundle.entities).toHaveLength(0);
  });
});

// =============================================================================
// buildTopicContext — with mock runner + LLM
// =============================================================================

describe("buildTopicContext", () => {
  it("requires an LLM completer", async () => {
    const runner = createMockRunner();

    await expect(
      buildTopicContext("auth", { runner, sessionId: "test" }),
    ).rejects.toThrow("LLM completer required");
  });

  it("uses LLM to pick seed entities from full list", async () => {
    const runner = createSequentialMockRunner([
      // All entity names
      [
        { name: "React", type: "technology" },
        { name: "authentication", type: "concept" },
        { name: "JWT", type: "technology" },
      ],
      // Seed lookup
      [{ canonId: "auth", name: "authentication", type: "concept" }],
      // Neighborhood
      [
        {
          canonId: "auth",
          name: "authentication",
          type: "concept",
          aliases: [],
          confidence: 0.9,
          sources: [],
        },
        {
          canonId: "jwt",
          name: "JWT",
          type: "technology",
          aliases: [],
          confidence: 0.85,
          sources: [],
        },
      ],
      // Relationships
      [
        {
          sName: "authentication",
          sType: "concept",
          predicate: "USES",
          tName: "JWT",
          tType: "technology",
          confidence: 0.9,
        },
      ],
    ]);

    // LLM returns seed entity names as JSON array
    const llm = createMockLlm('["authentication", "JWT"]');

    const bundle = await buildTopicContext("auth mechanisms", {
      runner,
      sessionId: "test",
      llm,
    });

    expect(bundle.topic).toBe("auth mechanisms");
    expect(bundle.entities.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// enrichWithDescriptions
// =============================================================================

describe("enrichWithDescriptions", () => {
  it("attaches descriptions from raw triple rationales", async () => {
    const runner = createMockRunner([
      {
        match: /RawTriple/,
        rows: [
          {
            entityName: "React",
            bestRationale: "A JavaScript library for building UIs",
          },
        ],
      },
    ]);

    const entities = [
      createContextEntity({ name: "React", type: "technology" }),
      createContextEntity({ name: "Vue", type: "technology" }),
    ];

    await enrichWithDescriptions(runner, "test", entities);

    expect(entities[0].description).toBe(
      "A JavaScript library for building UIs",
    );
    expect(entities[1].description).toBeUndefined();
  });
});

// =============================================================================
// enrichWithCodeRefs
// =============================================================================

describe("enrichWithCodeRefs", () => {
  it("attaches code references from CodeRef nodes", async () => {
    const runner = createMockRunner([
      {
        match: /CodeRef/,
        rows: [
          {
            entityName: "React",
            filePath: "package.json",
            name: "react",
            kind: "package-dep",
            strategy: "dep",
            confidence: 0.99,
          },
        ],
      },
    ]);

    const entities = [
      createContextEntity({ name: "React", type: "technology" }),
    ];

    await enrichWithCodeRefs(runner, "test", entities);

    expect(entities[0].codeRefs).toHaveLength(1);
    expect(entities[0].codeRefs![0].filePath).toBe("package.json");
    expect(entities[0].codeRefs![0].kind).toBe("package-dep");
  });
});
