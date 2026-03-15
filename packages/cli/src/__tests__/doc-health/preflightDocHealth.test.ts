// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the preflight (keyword-only) doc-health module.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  extractMarkdownEntities,
  preflightDocHealth,
  formatPreflightMarkdown,
  formatPreflightForAgent,
  type MarkdownEntity,
} from "../../doc-health/preflightDocHealth.js";

// =============================================================================
// extractMarkdownEntities
// =============================================================================

describe("extractMarkdownEntities", () => {
  it("extracts heading text from H1-H4", () => {
    const md = "# Auth Service\n## Rate Limiter\n### Token Bucket\n#### Overflow Guard";
    const entities = extractMarkdownEntities(md);
    const names = entities.map((e) => e.name);
    expect(names).toContain("Auth Service");
    expect(names).toContain("Rate Limiter");
    expect(names).toContain("Token Bucket");
    expect(names).toContain("Overflow Guard");
    expect(entities.filter((e) => e.source === "heading")).toHaveLength(4);
  });

  it("ignores H5 and H6 headings", () => {
    const md = "##### Sub Detail\n###### Tiny";
    const entities = extractMarkdownEntities(md);
    const headings = entities.filter((e) => e.source === "heading");
    expect(headings).toHaveLength(0);
  });

  it("strips inline formatting from headings", () => {
    const md = "## **Bold Heading** with `code`";
    const entities = extractMarkdownEntities(md);
    const heading = entities.find((e) => e.source === "heading");
    expect(heading?.name).toBe("Bold Heading with code");
  });

  it("extracts bold phrases", () => {
    const md = "The **Auth Service** depends on **Token Manager** and __Rate Limiter__.";
    const entities = extractMarkdownEntities(md);
    const bold = entities.filter((e) => e.source === "bold");
    expect(bold.map((e) => e.name)).toEqual(
      expect.arrayContaining(["Auth Service", "Token Manager", "Rate Limiter"]),
    );
  });

  it("extracts code spans (PascalCase)", () => {
    const md = "Uses `AuthService` and `TokenManager` for auth. Also mentions `foo`.";
    const entities = extractMarkdownEntities(md);
    const codeSpans = entities.filter((e) => e.source === "code-span");
    expect(codeSpans.map((e) => e.name)).toContain("AuthService");
    expect(codeSpans.map((e) => e.name)).toContain("TokenManager");
    // `foo` is lowercase, no uppercase start → should be excluded
    expect(codeSpans.map((e) => e.name)).not.toContain("foo");
  });

  it("extracts code spans with dashes and underscores", () => {
    const md = "Install `rate-limiter` and `token_bucket`.";
    const entities = extractMarkdownEntities(md);
    const names = entities.map((e) => e.name);
    expect(names).toContain("rate-limiter");
    expect(names).toContain("token_bucket");
  });

  it("extracts capitalized multi-word phrases", () => {
    const md =
      "The system uses Auth Service and Rate Limiter for traffic management.";
    const entities = extractMarkdownEntities(md);
    const cap = entities.filter((e) => e.source === "capitalized");
    expect(cap.map((e) => e.name)).toContain("Auth Service");
    expect(cap.map((e) => e.name)).toContain("Rate Limiter");
  });

  it("deduplicates by lowercase name", () => {
    const md = "# Auth Service\n\nThe **Auth Service** is critical.";
    const entities = extractMarkdownEntities(md);
    const matching = entities.filter(
      (e) => e.name.toLowerCase() === "auth service",
    );
    expect(matching).toHaveLength(1);
  });

  it("filters out names shorter than 3 chars", () => {
    const md = "# OK\n\n**AI** is great. Uses `DB`.";
    const entities = extractMarkdownEntities(md);
    const names = entities.map((e) => e.name);
    expect(names).not.toContain("OK");
    expect(names).not.toContain("AI");
    expect(names).not.toContain("DB");
  });

  it("filters noise words", () => {
    const md = "## Overview\n\n**Example** of **Summary**.";
    const entities = extractMarkdownEntities(md);
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names).not.toContain("overview");
    expect(names).not.toContain("example");
    expect(names).not.toContain("summary");
  });

  it("handles empty markdown", () => {
    expect(extractMarkdownEntities("")).toEqual([]);
    expect(extractMarkdownEntities("   \n\n   ")).toEqual([]);
  });

  it("handles complex real-world markdown", () => {
    const md = `# Architecture Overview

## Pipeline Stages

The **Open Track** uses three stages:
- \`FX\` — Free extraction
- \`KX\` — Canonicalization
- \`GX\` — Global merge

The system depends on **Neo4j** for persistence and **React** for the UI.

### Decision Log

We chose Token Bucket over Leaky Bucket for rate limiting.
`;
    const entities = extractMarkdownEntities(md);
    const names = entities.map((e) => e.name);

    expect(names).toContain("Architecture Overview");
    expect(names).toContain("Pipeline Stages");
    expect(names).toContain("Open Track");
    expect(names).toContain("Decision Log");
    expect(names).toContain("Neo4j");
    expect(names).toContain("React");
    // FX, KX, GX are < 3 chars → correctly filtered out
    expect(names).not.toContain("FX");
    expect(names).toContain("Token Bucket");
    expect(names).toContain("Leaky Bucket");
  });
});

// =============================================================================
// preflightDocHealth — integration tests with temp directory
// =============================================================================

describe("preflightDocHealth", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "iw-preflight-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(relativePath: string, content: string) {
    const full = path.join(tmpDir, relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  }

  it("detects grounded entities", async () => {
    await writeFile(
      "docs/arch.md",
      "# Architecture\n\nUses **AuthService** for auth and **TokenManager** for tokens.",
    );
    await writeFile(
      "src/auth.ts",
      'export class AuthService {\n  validate() { return true; }\n}\n',
    );
    await writeFile(
      "src/tokens.ts",
      'export class TokenManager {\n  issue() { return "tok"; }\n}\n',
    );

    const result = await preflightDocHealth({
      files: ["docs/arch.md"],
      cwd: tmpDir,
    });

    expect(result.reports).toHaveLength(1);
    const report = result.reports[0];
    expect(report.groundedNames).toContain("AuthService");
    expect(report.groundedNames).toContain("TokenManager");
    expect(report.groundingPercent).toBeGreaterThan(0);
  });

  it("detects floating entities", async () => {
    await writeFile(
      "docs/plan.md",
      "# Roadmap\n\nWe plan to build **GraphQL Gateway** and **EventBus**.",
    );
    await writeFile(
      "src/app.ts",
      'console.log("no matching code");\n',
    );

    const result = await preflightDocHealth({
      files: ["docs/plan.md"],
      cwd: tmpDir,
    });

    const report = result.reports[0];
    expect(report.floatingNames).toContain("GraphQL Gateway");
    expect(report.floatingNames).toContain("EventBus");
  });

  it("classifies floating entities from planning docs as planned", async () => {
    await writeFile(
      "docs/roadmap.md",
      "# Roadmap\n\nPlanned: **Phase Two** and **API Gateway**.",
    );
    await writeFile("src/app.ts", 'console.log("nothing");\n');

    const result = await preflightDocHealth({
      files: ["docs/roadmap.md"],
      cwd: tmpDir,
    });

    const report = result.reports[0];
    const phaseTwoDetail = report.floatingDetails.find(
      (d) => d.name === "Phase Two",
    );
    // "roadmap" matches planning doc pattern → planned
    expect(phaseTwoDetail?.likelyStatus).toBe("planned");
  });

  it("scans directories for markdown files", async () => {
    await writeFile("docs/a.md", "# Alpha\n\nUses **ServiceA**.");
    await writeFile("docs/b.md", "# Beta\n\nUses **ServiceB**.");
    await writeFile("src/a.ts", "export class ServiceA {}");
    await writeFile("src/b.ts", "export class ServiceB {}");

    const result = await preflightDocHealth({
      files: ["docs"],
      cwd: tmpDir,
    });

    expect(result.stats.docsAnalyzed).toBe(2);
  });

  it("returns empty result for no documents", async () => {
    const result = await preflightDocHealth({
      files: ["nonexistent.md"],
      cwd: tmpDir,
    });

    expect(result.stats.docsAnalyzed).toBe(0);
    expect(result.stats.avgGroundingPercent).toBe(100);
  });

  it("computes correct aggregate stats", async () => {
    await writeFile(
      "docs/a.md",
      "# Module A\n\n**WidgetService** and **FooHelper** are used.",
    );
    await writeFile("src/widget.ts", "export class WidgetService {}");
    // FooHelper is not in any source file

    const result = await preflightDocHealth({
      files: ["docs/a.md"],
      cwd: tmpDir,
    });

    expect(result.stats.docsAnalyzed).toBe(1);
    expect(result.stats.groundedCount).toBeGreaterThanOrEqual(1);
    expect(result.stats.floatingCount).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Formatters
// =============================================================================

describe("formatPreflightMarkdown", () => {
  it("produces markdown with summary table", () => {
    const result = {
      reports: [
        {
          filePath: "docs/test.md",
          entities: [{ name: "Foo", source: "bold" as const }],
          groundedNames: ["Foo"],
          floatingNames: [],
          groundingPercent: 100,
          floatingDetails: [],
        },
      ],
      stats: {
        docsAnalyzed: 1,
        totalEntities: 1,
        groundedCount: 1,
        floatingCount: 0,
        avgGroundingPercent: 100,
      },
    };
    const md = formatPreflightMarkdown(result);
    expect(md).toContain("Preflight Doc Health");
    expect(md).toContain("Documents scanned");
    expect(md).toContain("docs/test.md");
    expect(md).toContain("100%");
  });

  it("shows floating entities with status badges", () => {
    const result = {
      reports: [
        {
          filePath: "docs/plan.md",
          entities: [{ name: "NewFeature", source: "bold" as const }],
          groundedNames: [],
          floatingNames: ["NewFeature"],
          groundingPercent: 0,
          floatingDetails: [
            {
              name: "NewFeature",
              source: "bold",
              likelyStatus: "planned" as const,
            },
          ],
        },
      ],
      stats: {
        docsAnalyzed: 1,
        totalEntities: 1,
        groundedCount: 0,
        floatingCount: 1,
        avgGroundingPercent: 0,
      },
    };
    const md = formatPreflightMarkdown(result);
    expect(md).toContain("NewFeature");
    expect(md).toContain("planned");
    expect(md).toContain("🔴"); // 0% grounding icon
  });
});

describe("formatPreflightForAgent", () => {
  it("includes structured JSON block", () => {
    const result = {
      reports: [
        {
          filePath: "docs/arch.md",
          entities: [{ name: "AuthService", source: "code-span" as const }],
          groundedNames: ["AuthService"],
          floatingNames: [],
          groundingPercent: 100,
          floatingDetails: [],
        },
      ],
      stats: {
        docsAnalyzed: 1,
        totalEntities: 1,
        groundedCount: 1,
        floatingCount: 0,
        avgGroundingPercent: 100,
      },
    };
    const output = formatPreflightForAgent(result);
    expect(output).toContain("preflight-keyword-only");
    expect(output).toContain("Structured Preflight Data");
    expect(output).toContain('"AuthService"');
    expect(output).toContain("```json");
  });

  it("includes agent workflow hints", () => {
    const result = {
      reports: [],
      stats: {
        docsAnalyzed: 0,
        totalEntities: 0,
        groundedCount: 0,
        floatingCount: 0,
        avgGroundingPercent: 100,
      },
    };
    const output = formatPreflightForAgent(result);
    expect(output).toContain("Next steps for agent");
    expect(output).toContain("iw run");
  });
});
