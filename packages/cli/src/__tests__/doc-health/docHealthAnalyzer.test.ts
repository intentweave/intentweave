// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Document Health Analyzer.
 *
 * Covers:
 * - analyzeDocHealth: staleness, drift, contradiction, undocumented detection
 * - formatDocHealthMarkdown: all sections, icons, sorting, recommendations
 * - formatDocHealthJson: serialization
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  analyzeDocHealth,
  formatDocHealthMarkdown,
  formatDocHealthForAgent,
  formatDocHealthJson,
  classifyOrphanedEntity,
  type DocHealthResult,
  type DocReport,
  type UndocumentedEntity,
} from "../../doc-health/index.js";
import { createMockRunner, createSequentialMockRunner } from "../helpers.js";

// =============================================================================
// Helpers — build result objects for formatter tests
// =============================================================================

function createDocReport(overrides: Partial<DocReport> = {}): DocReport {
  return {
    filePath: "docs/ARCHITECTURE.md",
    status: "fresh",
    freshCount: 10,
    totalCount: 10,
    freshnessPercent: 100,
    groundedCount: 10,
    groundingPercent: 100,
    issues: [],
    ...overrides,
  };
}

function createResult(
  overrides: Partial<DocHealthResult> = {},
): DocHealthResult {
  return {
    sessionId: "test",
    reports: [],
    undocumented: [],
    stats: {
      docsAnalyzed: 0,
      freshDocs: 0,
      warningDocs: 0,
      rottenDocs: 0,
      totalIssues: 0,
      staleCount: 0,
      driftCount: 0,
      missingCount: 0,
      contradictionCount: 0,
      temporalCount: 0,
      orphanedCount: 0,
      undocumentedCount: 0,
      avgGroundingPercent: 100,
    },
    ...overrides,
  };
}

// =============================================================================
// formatDocHealthMarkdown
// =============================================================================

describe("formatDocHealthMarkdown", () => {
  it("renders header with session and doc count", () => {
    const result = createResult({
      sessionId: "planpling",
      stats: { ...createResult().stats, docsAnalyzed: 3 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("Documentation Health Report");
    expect(md).toContain("planpling");
    expect(md).toContain("3");
  });

  it("renders summary table with status counts", () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        docsAnalyzed: 5,
        freshDocs: 3,
        warningDocs: 1,
        rottenDocs: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("✅ Fresh | 3");
    expect(md).toContain("⚠️ Warning | 1");
    expect(md).toContain("🔴 Rotten | 1");
  });

  it("renders issue breakdown", () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 5,
        staleCount: 2,
        driftCount: 2,
        contradictionCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("5");
    expect(md).toContain("🪦 2 stale");
    expect(md).toContain("🔀 2 drift");
    expect(md).toContain("⚡ 1 contradiction");
  });

  it("renders per-document reports with freshness percentage", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/API.md",
          status: "warning",
          freshCount: 7,
          totalCount: 10,
          freshnessPercent: 70,
          issues: [
            {
              severity: "stale",
              message: '"MongoDB" was decided against by "Neo4j"',
              entityName: "MongoDB",
              entityType: "technology",
            },
          ],
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        warningDocs: 1,
        totalIssues: 1,
        staleCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("docs/API.md");
    expect(md).toContain("70%");
    expect(md).toContain("7/10");
    expect(md).toContain("🪦");
    expect(md).toContain("MongoDB");
    expect(md).toContain("decided against");
  });

  it("sorts documents worst-first (rotten > warning > fresh)", () => {
    const result = createResult({
      reports: [
        createDocReport({ filePath: "fresh.md", status: "fresh" }),
        createDocReport({ filePath: "rotten.md", status: "rotten" }),
        createDocReport({ filePath: "warning.md", status: "warning" }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 3,
        freshDocs: 1,
        warningDocs: 1,
        rottenDocs: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    const rottenIdx = md.indexOf("rotten.md");
    const warningIdx = md.indexOf("warning.md");
    const freshIdx = md.indexOf("fresh.md");
    expect(rottenIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(freshIdx);
  });

  it("renders undocumented entities table", () => {
    const result = createResult({
      undocumented: [
        { name: "RateLimiter", type: "component", relationshipCount: 5 },
        { name: "WebSocket", type: "technology", relationshipCount: 3 },
      ],
      stats: { ...createResult().stats, undocumentedCount: 2 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("Undocumented Entities");
    expect(md).toContain("RateLimiter");
    expect(md).toContain("component");
    expect(md).toContain("5");
    expect(md).toContain("WebSocket");
  });

  it("renders recommendations for stale issues", () => {
    const result = createResult({
      stats: { ...createResult().stats, totalIssues: 1, staleCount: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("Recommendations");
    expect(md).toContain("stale references");
  });

  it("renders recommendations for drift issues", () => {
    const result = createResult({
      stats: { ...createResult().stats, totalIssues: 1, driftCount: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("Document new relationships");
  });

  it("renders recommendations for undocumented entities", () => {
    const result = createResult({
      undocumented: [{ name: "X", type: "concept", relationshipCount: 3 }],
      stats: { ...createResult().stats, undocumentedCount: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("Document new entities");
  });

  it("renders clean output for no issues", () => {
    const result = createResult({
      reports: [createDocReport()],
      stats: { ...createResult().stats, docsAnalyzed: 1, freshDocs: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("No issues found");
    expect(md).not.toContain("Recommendations");
  });

  it("includes the tip/footer", () => {
    const md = formatDocHealthMarkdown(createResult());
    expect(md).toContain("iw doc-health");
    expect(md).toContain("iw context");
  });
});

// =============================================================================
// formatDocHealthJson
// =============================================================================

describe("formatDocHealthJson", () => {
  it("serializes as valid JSON", () => {
    const result = createResult({ sessionId: "planpling" });
    const json = formatDocHealthJson(result);
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe("planpling");
  });

  it("preserves all fields", () => {
    const result = createResult({
      reports: [createDocReport({ filePath: "a.md", status: "warning" })],
      undocumented: [{ name: "X", type: "concept", relationshipCount: 2 }],
    });
    const parsed = JSON.parse(formatDocHealthJson(result));
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0].filePath).toBe("a.md");
    expect(parsed.undocumented).toHaveLength(1);
  });
});

// =============================================================================
// analyzeDocHealth — integration with mock runner
// =============================================================================

describe("analyzeDocHealth", () => {
  it("returns empty results when no documents found", async () => {
    const runner = createMockRunner(); // no matches → empty rows

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.reports).toHaveLength(0);
    expect(result.stats.docsAnalyzed).toBe(0);
  });

  it("discovers documents from RawTriple sourceFile", async () => {
    const runner = createSequentialMockRunner([
      // Step 1: discover docs
      [{ filePath: "docs/ARCH.md" }, { filePath: "docs/API.md" }],
      // Step 2-4: first doc entities
      [{ name: "React", type: "technology", canonId: "react" }],
      // stale check
      [],
      // drift check
      [],
      // contradiction check
      [],
      // grounding check
      [{ entityName: "React", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 }],
      // Step 2-4: second doc entities
      [{ name: "Vue", type: "technology", canonId: "vue" }],
      [],
      [],
      [],
      // grounding check
      [{ entityName: "Vue", codeRefs: 0, otherDocRefs: 1, kgConnections: 1 }],
      // Step 5: undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.reports).toHaveLength(2);
    expect(result.reports[0].filePath).toBe("docs/ARCH.md");
    expect(result.reports[1].filePath).toBe("docs/API.md");
  });

  it("detects stale entities (DECIDED_AGAINST)", async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: "docs/ARCH.md" }],
      // entities
      [
        { name: "MongoDB", type: "technology", canonId: "mongodb" },
        { name: "Neo4j", type: "technology", canonId: "neo4j" },
      ],
      // stale check: MongoDB was decided against (target of DECIDED_AGAINST)
      [
        {
          entityName: "MongoDB",
          predicate: "DECIDED_AGAINST",
          decidedBy: "Neo4j",
        },
      ],
      // drift check
      [],
      // contradiction check
      [],
      // grounding check
      [
        {
          entityName: "MongoDB",
          codeRefs: 0,
          otherDocRefs: 0,
          kgConnections: 1,
        },
        { entityName: "Neo4j", codeRefs: 1, otherDocRefs: 0, kgConnections: 3 },
      ],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.reports).toHaveLength(1);
    const report = result.reports[0];
    expect(report.status).not.toBe("fresh");
    expect(report.issues.length).toBeGreaterThanOrEqual(1);
    expect(report.issues[0].severity).toBe("stale");
    expect(report.issues[0].entityName).toBe("MongoDB");
    expect(report.issues[0].message).toContain("decided against");
  });

  it("detects structural drift", async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: "docs/API.md" }],
      // entities
      [{ name: "AuthService", type: "component", canonId: "auth-service" }],
      // stale check
      [],
      // drift check: AuthService gained new relationships
      [
        {
          entityName: "AuthService",
          newRels: ["DEPENDS_ON → RateLimiter", "USES → JwtLib"],
        },
      ],
      // contradiction check
      [],
      // grounding check
      [
        {
          entityName: "AuthService",
          codeRefs: 1,
          otherDocRefs: 0,
          kgConnections: 3,
        },
      ],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    const report = result.reports[0];
    const driftIssues = report.issues.filter((i) => i.severity === "drift");
    expect(driftIssues.length).toBeGreaterThanOrEqual(1);
    expect(driftIssues[0].entityName).toBe("AuthService");
    expect(driftIssues[0].message).toContain("relationship");
  });

  it("detects contradictions", async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: "docs/DECISIONS.md" }],
      // entities
      [{ name: "React", type: "technology", canonId: "react" }],
      // stale check
      [],
      // drift check
      [],
      // contradiction check: doc says DECIDED_FOR but graph says DECIDED_AGAINST
      [
        {
          entityName: "React",
          docPred: "DECIDED_FOR",
          graphPred: "DECIDED_AGAINST",
          target: "Vue",
        },
      ],
      // grounding check
      [{ entityName: "React", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    const report = result.reports[0];
    const contradictions = report.issues.filter(
      (i) => i.severity === "contradiction",
    );
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0].message).toContain("DECIDED_FOR");
    expect(contradictions[0].message).toContain("DECIDED_AGAINST");
  });

  it("finds undocumented entities", async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: "docs/ARCH.md" }],
      // entities for doc
      [],
      // undocumented entities
      [
        { name: "RateLimiter", type: "component", relCount: 5 },
        { name: "WebSocket", type: "technology", relCount: 3 },
      ],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.undocumented).toHaveLength(2);
    expect(result.undocumented[0].name).toBe("RateLimiter");
    expect(result.undocumented[0].relationshipCount).toBe(5);
  });

  it("filters to specified files", async () => {
    const runner = createSequentialMockRunner([
      // discover all docs
      [
        { filePath: "docs/ARCH.md" },
        { filePath: "docs/API.md" },
        { filePath: "docs/README.md" },
      ],
      // only analyze docs/ARCH.md (filtered)
      [{ name: "React", type: "technology", canonId: "react" }],
      [],
      [],
      [],
      // grounding check
      [{ entityName: "React", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
      files: ["docs/ARCH.md"],
    });

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].filePath).toBe("docs/ARCH.md");
  });

  it("computes freshness percentage correctly", async () => {
    const runner = createSequentialMockRunner([
      // discover
      [{ filePath: "docs/A.md" }],
      // entities: 4 entities
      [
        { name: "A", type: "concept", canonId: "a" },
        { name: "B", type: "concept", canonId: "b" },
        { name: "C", type: "concept", canonId: "c" },
        { name: "D", type: "concept", canonId: "d" },
      ],
      // stale: A was decided against (target of DECIDED_AGAINST)
      [{ entityName: "A", predicate: "DECIDED_AGAINST", decidedBy: "E" }],
      [],
      [],
      // grounding check: all grounded
      [
        { entityName: "A", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
        { entityName: "B", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
        { entityName: "C", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
        { entityName: "D", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
      ],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    const report = result.reports[0];
    // 3 of 4 entities are still fresh → 75%
    expect(report.freshCount).toBe(3);
    expect(report.totalCount).toBe(4);
    expect(report.freshnessPercent).toBe(75);
  });

  it("classifies document status correctly", async () => {
    // Rotten: <50% or >=3 stale issues
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/OLD.md" }],
      // 4 entities, 3 stale
      [
        { name: "A", type: "concept", canonId: "a" },
        { name: "B", type: "concept", canonId: "b" },
        { name: "C", type: "concept", canonId: "c" },
        { name: "D", type: "concept", canonId: "d" },
      ],
      // 3 stale entities (all returned by single target-direction query)
      [
        { entityName: "A", predicate: "DECIDED_AGAINST", decidedBy: "X" },
        { entityName: "B", predicate: "SUPERSEDES", decidedBy: "Y" },
        { entityName: "C", predicate: "REPLACES", decidedBy: "Z" },
      ],
      [],
      [],
      // grounding check
      [
        { entityName: "A", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
        { entityName: "B", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
        { entityName: "C", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
        { entityName: "D", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
      ],
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.reports[0].status).toBe("rotten");
  });
});

// =============================================================================
// Temporal staleness detection
// =============================================================================

describe("temporal staleness", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "iw-dochealth-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects entities updated after document mtime", async () => {
    // Create a document file with an old mtime
    const docPath = path.join(tmpDir, "docs", "ARCH.md");
    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await fs.writeFile(docPath, "# Architecture");
    // Set mtime to 30 days ago
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(docPath, oldDate, oldDate);

    // The entity was "updated" after the doc mtime — we'll use a string date (tomorrow)
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: "docs/ARCH.md" }],
      // keyword indexing: all entity names (cwd is set)
      [{ name: "React" }],
      // entities
      [{ name: "React", type: "technology", canonId: "react" }],
      // stale check
      [],
      // drift check
      [],
      // contradiction check
      [],
      // temporal check: entity updated after doc mtime
      [{ name: "React", type: "technology", updatedAt: futureDate }],
      // grounding check
      [{ entityName: "React", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
      cwd: tmpDir,
    });

    const report = result.reports[0];
    const temporalIssues = report.issues.filter(
      (i) => i.severity === "stale-temporal",
    );
    expect(temporalIssues.length).toBeGreaterThanOrEqual(1);
    expect(temporalIssues[0].entityName).toBe("React");
    expect(temporalIssues[0].message).toContain("updated in the graph");
    expect(temporalIssues[0].detail).toContain("Entity updated");
    expect(result.stats.temporalCount).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag entities updated before document mtime", async () => {
    // Create a fresh document file (just written now)
    const docPath = path.join(tmpDir, "docs", "API.md");
    await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
    await fs.writeFile(docPath, "# API");

    // Entity was updated a year ago — well before the doc
    const oldDate = new Date(
      Date.now() - 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: "docs/API.md" }],
      // keyword indexing: all entity names (cwd is set)
      [{ name: "FastAPI" }],
      // entities
      [{ name: "FastAPI", type: "technology", canonId: "fastapi" }],
      // stale check
      [],
      // drift
      [],
      // contradiction
      [],
      // temporal: entity updated before doc mtime
      [{ name: "FastAPI", type: "technology", updatedAt: oldDate }],
      // grounding check
      [
        {
          entityName: "FastAPI",
          codeRefs: 1,
          otherDocRefs: 0,
          kgConnections: 2,
        },
      ],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
      cwd: tmpDir,
    });

    const temporalIssues = result.reports[0].issues.filter(
      (i) => i.severity === "stale-temporal",
    );
    expect(temporalIssues).toHaveLength(0);
  });

  it("skips temporal check when cwd is not provided", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/X.md" }],
      [{ name: "Vue", type: "technology", canonId: "vue" }],
      [],
      [],
      [],
      // grounding check (no temporal without cwd, but grounding still runs)
      [{ entityName: "Vue", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
      // no cwd — temporal check should be skipped
    });

    // Should still work, just no temporal issues
    expect(result.reports).toHaveLength(1);
    const temporalIssues = result.reports[0].issues.filter(
      (i) => i.severity === "stale-temporal",
    );
    expect(temporalIssues).toHaveLength(0);
  });

  it("includes temporal count in stats", async () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 2,
        temporalCount: 2,
      },
    });
    expect(result.stats.temporalCount).toBe(2);
  });
});

// =============================================================================
// formatDocHealthMarkdown — temporal rendering
// =============================================================================

describe("formatDocHealthMarkdown — temporal", () => {
  it("renders temporal issue count in summary", () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 3,
        temporalCount: 3,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("🕐 3 temporal");
  });

  it("renders temporal recommendation", () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 1,
        temporalCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("temporally stale");
  });

  it("renders stale-temporal icon in per-document issues", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/OLD.md",
          status: "warning",
          issues: [
            {
              severity: "stale-temporal",
              message:
                '"React" was updated in the graph 15d after this document was last modified',
              entityName: "React",
              entityType: "technology",
              detail: "Entity updated: 2026-03-01, Doc modified: 2026-02-14",
            },
          ],
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        warningDocs: 1,
        totalIssues: 1,
        temporalCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("🕐");
    expect(md).toContain("stale-temporal");
    expect(md).toContain("React");
  });
});

// =============================================================================
// Grounding analysis
// =============================================================================

describe("grounding analysis", () => {
  it("detects orphaned entities with no code refs, no cross-doc refs, low KG connectivity", async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: "docs/ARCH.md" }],
      // entities
      [
        { name: "React", type: "technology", canonId: "react" },
        { name: "OldConcept", type: "concept", canonId: "old-concept" },
      ],
      // stale
      [],
      // drift
      [],
      // contradiction
      [],
      // grounding: React is grounded, OldConcept is orphaned
      [
        { entityName: "React", codeRefs: 3, otherDocRefs: 1, kgConnections: 5 },
        {
          entityName: "OldConcept",
          codeRefs: 0,
          otherDocRefs: 0,
          kgConnections: 0,
        },
      ],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    const report = result.reports[0];
    const orphaned = report.issues.filter((i) => i.severity === "orphaned");
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].entityName).toBe("OldConcept");
    expect(orphaned[0].message).toContain("no code references");
    expect(orphaned[0].detail).toContain("codeRefs=0");
    expect(report.groundedCount).toBe(1);
    expect(report.groundingPercent).toBe(50);
  });

  it("does NOT flag entities that have code references", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/A.md" }],
      [{ name: "AuthService", type: "component", canonId: "auth-service" }],
      [],
      [],
      [],
      // grounding: has code refs
      [
        {
          entityName: "AuthService",
          codeRefs: 2,
          otherDocRefs: 0,
          kgConnections: 1,
        },
      ],
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    const orphaned = result.reports[0].issues.filter(
      (i) => i.severity === "orphaned",
    );
    expect(orphaned).toHaveLength(0);
    expect(result.reports[0].groundingPercent).toBe(100);
  });

  it("does NOT flag entities with cross-doc references", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/A.md" }],
      [{ name: "Pipeline", type: "concept", canonId: "pipeline" }],
      [],
      [],
      [],
      // grounding: no code refs but has cross-doc refs
      [
        {
          entityName: "Pipeline",
          codeRefs: 0,
          otherDocRefs: 3,
          kgConnections: 1,
        },
      ],
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    const orphaned = result.reports[0].issues.filter(
      (i) => i.severity === "orphaned",
    );
    expect(orphaned).toHaveLength(0);
    expect(result.reports[0].groundingPercent).toBe(100);
  });

  it("does NOT flag entities with high KG connectivity (>1)", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/A.md" }],
      [{ name: "MCP", type: "technology", canonId: "mcp" }],
      [],
      [],
      [],
      // grounding: no code refs, no cross-doc, but kgConns > 1
      [{ entityName: "MCP", codeRefs: 0, otherDocRefs: 0, kgConnections: 3 }],
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    const orphaned = result.reports[0].issues.filter(
      (i) => i.severity === "orphaned",
    );
    expect(orphaned).toHaveLength(0);
    expect(result.reports[0].groundingPercent).toBe(100);
  });

  it("marks status as rotten when groundingPercent < 30", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/OLD.md" }],
      // 4 entities, all orphaned → 0% grounding
      [
        { name: "A", type: "concept", canonId: "a" },
        { name: "B", type: "concept", canonId: "b" },
        { name: "C", type: "concept", canonId: "c" },
        { name: "D", type: "concept", canonId: "d" },
      ],
      [],
      [],
      [],
      // grounding: all orphaned (no refs, no cross-doc, kgConns ≤ 1)
      [
        { entityName: "A", codeRefs: 0, otherDocRefs: 0, kgConnections: 0 },
        { entityName: "B", codeRefs: 0, otherDocRefs: 0, kgConnections: 1 },
        { entityName: "C", codeRefs: 0, otherDocRefs: 0, kgConnections: 0 },
        { entityName: "D", codeRefs: 0, otherDocRefs: 0, kgConnections: 0 },
      ],
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.reports[0].status).toBe("rotten");
    expect(result.reports[0].groundingPercent).toBe(0);
    expect(result.stats.orphanedCount).toBe(4);
  });

  it("marks status as warning when groundingPercent is between 30-59", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/MIXED.md" }],
      // 3 entities: 1 grounded, 2 orphaned → 33% grounding
      [
        { name: "React", type: "technology", canonId: "react" },
        { name: "OldLib", type: "technology", canonId: "old-lib" },
        { name: "DeadCode", type: "concept", canonId: "dead-code" },
      ],
      [],
      [],
      [],
      // grounding: React grounded, others orphaned
      [
        {
          entityName: "React",
          codeRefs: 5,
          otherDocRefs: 2,
          kgConnections: 10,
        },
        {
          entityName: "OldLib",
          codeRefs: 0,
          otherDocRefs: 0,
          kgConnections: 0,
        },
        {
          entityName: "DeadCode",
          codeRefs: 0,
          otherDocRefs: 0,
          kgConnections: 1,
        },
      ],
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.reports[0].status).toBe("warning");
    expect(result.reports[0].groundingPercent).toBe(33);
  });

  it("aggregates orphanedCount and avgGroundingPercent in stats", async () => {
    const runner = createSequentialMockRunner([
      // discover: 2 docs
      [{ filePath: "docs/A.md" }, { filePath: "docs/B.md" }],
      // Doc A: 2 entities, 1 orphaned → 50%
      [
        { name: "X", type: "concept", canonId: "x" },
        { name: "Y", type: "concept", canonId: "y" },
      ],
      [],
      [],
      [],
      [
        { entityName: "X", codeRefs: 1, otherDocRefs: 0, kgConnections: 2 },
        { entityName: "Y", codeRefs: 0, otherDocRefs: 0, kgConnections: 0 },
      ],
      // Doc B: 1 entity, fully grounded → 100%
      [{ name: "Z", type: "concept", canonId: "z" }],
      [],
      [],
      [],
      [{ entityName: "Z", codeRefs: 2, otherDocRefs: 1, kgConnections: 5 }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: "test",
    });

    expect(result.stats.orphanedCount).toBe(1); // only Y from doc A
    expect(result.stats.avgGroundingPercent).toBe(75); // avg of 50% and 100%
  });
});

// =============================================================================
// formatDocHealthMarkdown — grounding rendering
// =============================================================================

describe("formatDocHealthMarkdown — grounding", () => {
  it("renders orphaned count in issue breakdown", () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 3,
        orphanedCount: 3,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("👻 3 orphaned");
  });

  it("renders avg grounding percent in summary", () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        avgGroundingPercent: 65,
        orphanedCount: 2,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("65%");
    expect(md).toContain("grounding");
  });

  it("renders grounding percent per document when < 100%", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/OLD.md",
          status: "warning",
          groundedCount: 3,
          groundingPercent: 60,
          totalCount: 5,
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        warningDocs: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("Grounding");
    expect(md).toContain("60%");
    expect(md).toContain("3/5");
  });

  it("does NOT render grounding line when 100%", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/FRESH.md",
          status: "fresh",
          groundedCount: 10,
          groundingPercent: 100,
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        freshDocs: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).not.toContain("Grounding");
  });

  it("renders orphaned icon in per-document issues", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/STALE.md",
          status: "rotten",
          groundedCount: 0,
          groundingPercent: 0,
          issues: [
            {
              severity: "orphaned",
              message:
                '"OldConcept" has no code references, no cross-document mentions, and low KG connectivity',
              entityName: "OldConcept",
              entityType: "concept",
              detail: "codeRefs=0, otherDocRefs=0, kgConns=0, inCode=false",
            },
          ],
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        rottenDocs: 1,
        totalIssues: 1,
        orphanedCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("👻");
    expect(md).toContain("orphaned");
    expect(md).toContain("OldConcept");
  });

  it("renders orphaned recommendation", () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 2,
        orphanedCount: 2,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain("orphaned entities");
    expect(md).toContain("Investigate");
  });
});

// =============================================================================
// classifyOrphanedEntity — heuristic classification
// =============================================================================

describe("classifyOrphanedEntity", () => {
  it("classifies technology in non-planning doc as stale", () => {
    expect(classifyOrphanedEntity("technology", "docs/ARCHITECTURE.md")).toBe(
      "stale",
    );
  });

  it("classifies component in non-planning doc as stale", () => {
    expect(classifyOrphanedEntity("component", "docs/API.md")).toBe("stale");
  });

  it("classifies resource in non-planning doc as stale", () => {
    expect(classifyOrphanedEntity("resource", "docs/OVERVIEW.md")).toBe(
      "stale",
    );
  });

  it("classifies phase from any doc as planned", () => {
    expect(classifyOrphanedEntity("phase", "docs/ARCHITECTURE.md")).toBe(
      "planned",
    );
  });

  it("classifies requirement from any doc as planned", () => {
    expect(classifyOrphanedEntity("requirement", "docs/SPEC.md")).toBe(
      "planned",
    );
  });

  it("classifies feature from any doc as planned", () => {
    expect(classifyOrphanedEntity("feature", "docs/OVERVIEW.md")).toBe(
      "planned",
    );
  });

  it("classifies any type from roadmap doc as planned", () => {
    expect(classifyOrphanedEntity("technology", "docs/ROADMAP.md")).toBe(
      "planned",
    );
    expect(
      classifyOrphanedEntity("component", "docs/implementation-plan.md"),
    ).toBe("planned");
    expect(classifyOrphanedEntity("concept", "docs/rfc-auth.md")).toBe(
      "planned",
    );
  });

  it("classifies any type from strategy doc as planned", () => {
    expect(classifyOrphanedEntity("concept", "docs/STRATEGY.md")).toBe(
      "planned",
    );
  });

  it("classifies concept in non-planning doc as unknown", () => {
    expect(classifyOrphanedEntity("concept", "docs/ARCHITECTURE.md")).toBe(
      "unknown",
    );
  });

  it("classifies decision in non-planning doc as unknown", () => {
    expect(classifyOrphanedEntity("decision", "docs/DECISIONS.md")).toBe(
      "unknown",
    );
  });
});

// =============================================================================
// likelyStatus integration in analyzeDocHealth
// =============================================================================

describe("grounding likelyStatus integration", () => {
  it("adds likelyStatus=stale for technology in ARCHITECTURE doc", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/ARCHITECTURE.md" }],
      [{ name: "MongoDB", type: "technology", canonId: "mongodb" }],
      [],
      [],
      [],
      // grounding: orphaned
      [
        {
          entityName: "MongoDB",
          codeRefs: 0,
          otherDocRefs: 0,
          kgConnections: 0,
        },
      ],
      [],
    ]);

    const result = await analyzeDocHealth({ runner, sessionId: "test" });
    const issue = result.reports[0].issues.find(
      (i) => i.severity === "orphaned" && i.entityName === "MongoDB",
    );
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain("likelyStatus=stale");
    expect(issue!.message).toContain("likely stale");
  });

  it("adds likelyStatus=planned for feature in ROADMAP doc", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/ROADMAP.md" }],
      [{ name: "SSO", type: "feature", canonId: "sso" }],
      [],
      [],
      [],
      // grounding: orphaned
      [{ entityName: "SSO", codeRefs: 0, otherDocRefs: 0, kgConnections: 0 }],
      [],
    ]);

    const result = await analyzeDocHealth({ runner, sessionId: "test" });
    const issue = result.reports[0].issues.find(
      (i) => i.severity === "orphaned" && i.entityName === "SSO",
    );
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain("likelyStatus=planned");
    expect(issue!.message).toContain("likely planned");
  });

  it("includes groundingDetails in report", async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: "docs/A.md" }],
      [
        { name: "X", type: "concept", canonId: "x" },
        { name: "Y", type: "technology", canonId: "y" },
      ],
      [],
      [],
      [],
      [
        { entityName: "X", codeRefs: 0, otherDocRefs: 0, kgConnections: 0 },
        { entityName: "Y", codeRefs: 2, otherDocRefs: 0, kgConnections: 3 },
      ],
      [],
    ]);

    const result = await analyzeDocHealth({ runner, sessionId: "test" });
    const report = result.reports[0];
    expect(report.groundingDetails).toBeDefined();
    expect(report.groundingDetails).toHaveLength(2);

    const xDetail = report.groundingDetails!.find((g) => g.name === "X");
    expect(xDetail).toBeDefined();
    expect(xDetail!.grounded).toBe(false);
    expect(xDetail!.likelyStatus).toBe("unknown");

    const yDetail = report.groundingDetails!.find((g) => g.name === "Y");
    expect(yDetail).toBeDefined();
    expect(yDetail!.grounded).toBe(true);
    expect(yDetail!.likelyStatus).toBeUndefined(); // only set on orphaned
  });
});

// =============================================================================
// formatDocHealthForAgent — MCP structured output
// =============================================================================

describe("formatDocHealthForAgent", () => {
  it("includes markdown report and structured JSON block", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/ARCH.md",
          status: "warning",
          groundingPercent: 50,
          groundedCount: 1,
          totalCount: 2,
          groundingDetails: [
            {
              name: "React",
              type: "technology",
              codeRefs: 3,
              otherDocRefs: 1,
              kgConnections: 5,
              foundInCode: true,
              grounded: true,
            },
            {
              name: "MongoDB",
              type: "technology",
              codeRefs: 0,
              otherDocRefs: 0,
              kgConnections: 0,
              foundInCode: false,
              grounded: false,
              likelyStatus: "stale" as const,
            },
          ],
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        warningDocs: 1,
        orphanedCount: 1,
        avgGroundingPercent: 50,
      },
    });

    const output = formatDocHealthForAgent(result);

    // Contains markdown sections
    expect(output).toContain("Documentation Health Report");
    expect(output).toContain("docs/ARCH.md");

    // Contains structured agent block
    expect(output).toContain("Structured Grounding Data");
    expect(output).toContain("```json");
    expect(output).toContain('"likelyStatus"');

    // Contains agent workflow hints
    expect(output).toContain("Agent workflow hints");
    expect(output).toContain("kg_context");
  });

  it("includes orphaned entity details in JSON block", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/ROADMAP.md",
          groundingPercent: 0,
          groundedCount: 0,
          totalCount: 1,
          groundingDetails: [
            {
              name: "SSO",
              type: "feature",
              codeRefs: 0,
              otherDocRefs: 0,
              kgConnections: 0,
              foundInCode: false,
              grounded: false,
              likelyStatus: "planned" as const,
            },
          ],
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        orphanedCount: 1,
        avgGroundingPercent: 0,
      },
    });

    const output = formatDocHealthForAgent(result);

    // Find and parse the JSON block
    const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).toBeDefined();
    const parsed = JSON.parse(jsonMatch![1]);

    expect(parsed.stats.orphanedCount).toBe(1);
    expect(parsed.documents["docs/ROADMAP.md"]).toBeDefined();

    const docData = parsed.documents["docs/ROADMAP.md"];
    expect(docData.orphanedEntities).toHaveLength(1);
    expect(docData.orphanedEntities[0].name).toBe("SSO");
    expect(docData.orphanedEntities[0].likelyStatus).toBe("planned");
    expect(docData.groundedEntities).toHaveLength(0);
  });

  it("lists grounded entities by name in JSON block", () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: "docs/A.md",
          groundingPercent: 100,
          groundedCount: 2,
          totalCount: 2,
          groundingDetails: [
            {
              name: "React",
              type: "technology",
              codeRefs: 5,
              otherDocRefs: 2,
              kgConnections: 10,
              foundInCode: true,
              grounded: true,
            },
            {
              name: "Neo4j",
              type: "technology",
              codeRefs: 3,
              otherDocRefs: 1,
              kgConnections: 8,
              foundInCode: true,
              grounded: true,
            },
          ],
        }),
      ],
      stats: { ...createResult().stats, docsAnalyzed: 1, freshDocs: 1 },
    });

    const output = formatDocHealthForAgent(result);
    const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
    const parsed = JSON.parse(jsonMatch![1]);

    const docData = parsed.documents["docs/A.md"];
    expect(docData.orphanedEntities).toHaveLength(0);
    expect(docData.groundedEntities).toEqual(["React", "Neo4j"]);
  });
});
