// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the cross-layer linker module.
 *
 * - formatXLinkReport: markdown report generation
 * - runCrossLayerLinker: integration with mock runner (canon entity loading)
 * - persistCrossLinks: Neo4j write flow
 */

import { describe, it, expect } from "vitest";
import { formatXLinkReport } from "../../linker/crossLayerLinker.js";
import { createCrossLink, createXLinkResult } from "../helpers.js";

// =============================================================================
// formatXLinkReport
// =============================================================================

describe("formatXLinkReport", () => {
  it("renders header and summary section", () => {
    const result = createXLinkResult({
      stats: {
        totalCanonEntities: 251,
        linkedEntities: 35,
        unlinkedEntities: 216,
        totalCodeRefs: 45,
        byStrategy: { dep: 10, import: 15, name: 12, path: 8 },
        byEntityType: {},
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("# Cross-Layer Link Report");
    expect(report).toContain("Canon entities: 251");
    expect(report).toContain("Linked to code: 35");
    expect(report).toContain("Unlinked: 216");
    expect(report).toContain("Total code references: 45");
  });

  it("renders strategy breakdown", () => {
    const result = createXLinkResult({
      stats: {
        totalCanonEntities: 100,
        linkedEntities: 20,
        unlinkedEntities: 80,
        totalCodeRefs: 25,
        byStrategy: { dep: 5, import: 10, name: 7, path: 3 },
        byEntityType: {},
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("## Matches by Strategy");
    expect(report).toContain("**Package deps**: 5");
    expect(report).toContain("**Imports**: 10");
    expect(report).toContain("**Symbol names**: 7");
    expect(report).toContain("**File paths**: 3");
  });

  it("skips strategies with zero matches", () => {
    const result = createXLinkResult({
      stats: {
        totalCanonEntities: 10,
        linkedEntities: 5,
        unlinkedEntities: 5,
        totalCodeRefs: 5,
        byStrategy: { dep: 5, import: 0, name: 0, path: 0 },
        byEntityType: {},
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("**Package deps**: 5");
    expect(report).not.toContain("**Imports**: 0");
  });

  it("renders coverage by entity type", () => {
    const result = createXLinkResult({
      stats: {
        totalCanonEntities: 50,
        linkedEntities: 10,
        unlinkedEntities: 40,
        totalCodeRefs: 15,
        byStrategy: { dep: 5, import: 5, name: 5, path: 0 },
        byEntityType: {
          technology: { linked: 8, total: 12 },
          concept: { linked: 2, total: 30 },
        },
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("## Coverage by Entity Type");
    expect(report).toContain("**technology**: 8/12 linked");
    expect(report).toContain("**concept**: 2/30 linked");
  });

  it("renders linked entities grouped by canon name", () => {
    const result = createXLinkResult({
      links: [
        createCrossLink({
          canonName: "React",
          canonType: "technology",
          codeRef: {
            filePath: "package.json",
            name: "react",
            kind: "package-dep",
          },
          strategy: "dep",
          confidence: 0.99,
          detail: "Found react in dependencies",
        }),
        createCrossLink({
          canonName: "React",
          canonType: "technology",
          codeRef: { filePath: "src/App.tsx", name: "react", kind: "import" },
          strategy: "import",
          confidence: 0.95,
          detail: "Import from react",
        }),
        createCrossLink({
          canonName: "TypeScript",
          canonType: "technology",
          codeRef: {
            filePath: "tsconfig.json",
            name: "typescript",
            kind: "file",
          },
          strategy: "path",
          confidence: 0.85,
          detail: "tsconfig.json references TypeScript",
        }),
      ],
      stats: {
        totalCanonEntities: 100,
        linkedEntities: 2,
        unlinkedEntities: 98,
        totalCodeRefs: 3,
        byStrategy: { dep: 1, import: 1, name: 0, path: 1 },
        byEntityType: {},
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("## Linked Entities");
    expect(report).toContain("### React (technology)");
    expect(report).toContain("package.json");
    expect(report).toContain("src/App.tsx");
    expect(report).toContain("### TypeScript (technology)");
  });

  it("truncates entities with >8 references", () => {
    const links = Array.from({ length: 12 }, (_, i) =>
      createCrossLink({
        canonName: "React",
        canonType: "technology",
        codeRef: { filePath: `file${i}.ts`, name: "react", kind: "import" },
        detail: `ref ${i}`,
      }),
    );
    const result = createXLinkResult({
      links,
      stats: {
        totalCanonEntities: 10,
        linkedEntities: 1,
        unlinkedEntities: 9,
        totalCodeRefs: 12,
        byStrategy: { dep: 0, import: 12, name: 0, path: 0 },
        byEntityType: {},
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("+4 more references");
  });

  it("renders unlinked entities by type", () => {
    const result = createXLinkResult({
      unlinked: [
        { name: "microservices", type: "concept" },
        { name: "event-sourcing", type: "concept" },
        { name: "Redis", type: "technology" },
      ],
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("## Unlinked Entities");
    expect(report).toContain("**concept**: microservices, event-sourcing");
    expect(report).toContain("**technology**: Redis");
  });

  it("computes percentages correctly", () => {
    const result = createXLinkResult({
      stats: {
        totalCanonEntities: 200,
        linkedEntities: 50,
        unlinkedEntities: 150,
        totalCodeRefs: 60,
        byStrategy: { dep: 10, import: 20, name: 15, path: 15 },
        byEntityType: {},
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("25%");
  });

  it("handles zero total entities without division error", () => {
    const result = createXLinkResult({
      stats: {
        totalCanonEntities: 0,
        linkedEntities: 0,
        unlinkedEntities: 0,
        totalCodeRefs: 0,
        byStrategy: { dep: 0, import: 0, name: 0, path: 0 },
        byEntityType: {},
      },
    });
    const report = formatXLinkReport(result);
    expect(report).toContain("0%");
  });

  it("renders empty report cleanly", () => {
    const result = createXLinkResult();
    const report = formatXLinkReport(result);
    expect(report).toContain("# Cross-Layer Link Report");
    expect(report).toContain("Canon entities: 0");
  });
});
