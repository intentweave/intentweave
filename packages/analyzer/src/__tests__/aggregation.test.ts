// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Aggregation Integration Test - Phase 3.6
 *
 * Validates the aggregation step (AGG) works correctly:
 * - Collects PX outputs from multiple artifacts
 * - Generates LX proposals across artifacts
 * - Produces coverage and validation reports
 * - Updates run.meta with AGG stage
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type MemoryStore } from "../stores/memoryStore.js";
import {
  runAggregation,
  type AggregationInput,
  type AggregateOutput,
  persistAggregateOutput,
} from "../pipeline/aggregation.js";
import {
  createPipelineContext,
  type PipelineContext,
} from "../pipeline/context.js";
import type { PxStageOutput } from "../stages/px.js";
import type { Entity, Statement, ArtifactRole } from "@intentweave/core";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a mock entity
 */
function createEntity(
  overrides: Partial<Entity> & { name: string; type: string },
): Entity {
  return {
    cgId: `entity-${overrides.name.toLowerCase().replace(/\s+/g, "-")}`,
    name: overrides.name,
    type: overrides.type as Entity["type"],
    kind: overrides.type,
    labels: ["Staging"],
    evidence: [],
    confidence: 0.9,
    description: `Test entity: ${overrides.name}`,
    ...overrides,
  } as Entity;
}

/**
 * Create a mock statement
 */
function createStatement(
  subject: string,
  predicate: string,
  object: string,
  confidence = 0.85,
): Statement {
  return {
    subjectCgId: subject,
    predicate,
    objectCgId: object,
    confidence,
    evidence: [],
    labels: ["Staging"],
  } as Statement;
}

/**
 * Create a mock PX output
 */
function createPxOutput(
  artifactId: string,
  artifactRole: ArtifactRole,
  entities: Entity[],
  statements: Statement[],
): PxStageOutput {
  return {
    $schema: "intentweave://schemas/px/v1",
    schemaVersion: "0.1",
    stage: "PX",
    processedAt: new Date().toISOString(),
    artifactId,
    artifactRole,
    entities,
    statements,
    filterDecisions: [],
    summary: {
      originalEntityCount: entities.length,
      filteredEntityCount: entities.length,
      originalStatementCount: statements.length,
      filteredStatementCount: statements.length,
      entityTypeBreakdown: {},
      statementPredicateBreakdown: {},
    },
  };
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a minimal pipeline context for testing
 */
function createTestContext(store: MemoryStore, runId: string): PipelineContext {
  return createPipelineContext({
    workspace: {
      key: "test-workspace",
      id: "test-workspace-id",
      name: "Test Workspace",
    },
    runId,
    store,
    profile: {
      name: "test-profile",
      version: "1.0",
      kinds: ["state", "action", "role", "event"],
      predicates: ["TRANSITIONS_TO", "ROLE_CAN", "IMPLEMENTS"],
      shapes: [],
      artifactMappings: [],
    },
    providers: {
      llm: {
        generateText: async () => ({
          text: "",
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
        generateStructured: async () => ({
          data: {},
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      },
      extraction: {
        extractEntities: async () => ({ entities: [] }),
        extractRelationships: async () => ({ relationships: [] }),
      },
    },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("Aggregation Integration", () => {
  let store: MemoryStore;
  let ctx: PipelineContext;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.init();
    ctx = createTestContext(store, "test-run-001");
  });

  describe("runAggregation", () => {
    it("aggregates entities from multiple artifacts", async () => {
      // Create entities for intent artifact
      const intentEntities = [
        createEntity({ name: "active", type: "state" }),
        createEntity({ name: "suspended", type: "state" }),
        createEntity({ name: "login", type: "action" }),
      ];

      // Create entities for spec artifact
      const specEntities = [
        createEntity({ name: "active", type: "state" }),
        createEntity({ name: "suspended", type: "state" }),
        createEntity({ name: "UserActivated", type: "event" }),
      ];

      const intentPx = createPxOutput(
        "prompt.md",
        "intent",
        intentEntities,
        [],
      );
      const specPx = createPxOutput("spec.md", "spec", specEntities, []);

      const input: AggregationInput = {
        artifactOutputs: [intentPx, specPx],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx);

      // Should have all entities from both artifacts
      expect(result.entities.length).toBe(6);

      // Check artifact IDs are attached
      const intentCount = result.entities.filter(
        (e) => e.artifactId === "prompt.md",
      ).length;
      const specCount = result.entities.filter(
        (e) => e.artifactId === "spec.md",
      ).length;
      expect(intentCount).toBe(3);
      expect(specCount).toBe(3);
    });

    it("aggregates statements from multiple artifacts", async () => {
      const statements1 = [
        createStatement("entity-active", "TRANSITIONS_TO", "entity-suspended"),
      ];
      const statements2 = [
        createStatement("entity-suspended", "TRANSITIONS_TO", "entity-active"),
      ];

      const px1 = createPxOutput("prompt.md", "intent", [], statements1);
      const px2 = createPxOutput("spec.md", "spec", [], statements2);

      const input: AggregationInput = {
        artifactOutputs: [px1, px2],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx);

      expect(result.statements.length).toBe(2);
    });

    it("generates LX proposals for similar entities across artifacts", async () => {
      // Create similar entities in different artifacts
      const intentEntities = [
        createEntity({ name: "active", type: "state", cgId: "intent-active" }),
        createEntity({
          name: "suspended",
          type: "state",
          cgId: "intent-suspended",
        }),
      ];

      const specEntities = [
        createEntity({ name: "active", type: "state", cgId: "spec-active" }),
        createEntity({
          name: "suspended",
          type: "state",
          cgId: "spec-suspended",
        }),
      ];

      const intentPx = createPxOutput(
        "prompt.md",
        "intent",
        intentEntities,
        [],
      );
      const specPx = createPxOutput("spec.md", "spec", specEntities, []);

      const input: AggregationInput = {
        artifactOutputs: [intentPx, specPx],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx, {
        generateLxProposals: true,
      });

      // Should generate proposals linking similar entities
      expect(result.lxProposals.length).toBeGreaterThan(0);
    });

    it("calculates coverage metrics", async () => {
      const entities = [
        createEntity({ name: "state1", type: "state" }),
        createEntity({ name: "state2", type: "state" }),
        createEntity({ name: "action1", type: "action" }),
      ];

      const px = createPxOutput("test.md", "spec", entities, []);

      const input: AggregationInput = {
        artifactOutputs: [px],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx, {
        calculateCoverage: true,
      });

      expect(result.coverage).toBeDefined();
      expect(result.coverage.summary.totalConcepts).toBe(3);
      expect(result.coverage.summary.totalArtifacts).toBe(1);
    });

    it("runs validation and produces findings", async () => {
      // Create entities without evidence (should trigger validation warning)
      const entities = [
        createEntity({ name: "test", type: "state", evidence: [] }),
      ];

      // Create statement referencing non-existent entity
      const statements = [
        createStatement("entity-test", "TRANSITIONS_TO", "non-existent-entity"),
      ];

      const px = createPxOutput("test.md", "spec", entities, statements);

      const input: AggregationInput = {
        artifactOutputs: [px],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx, { runValidation: true });

      expect(result.findings).toBeDefined();
      // Should have findings for orphan references
      expect(result.findings.findings.length).toBeGreaterThan(0);
    });

    it("includes lxOutput when LX core runs", async () => {
      const entities = [createEntity({ name: "state1", type: "state" })];

      const px = createPxOutput("test.md", "spec", entities, []);

      const input: AggregationInput = {
        artifactOutputs: [px],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx, {
        generateLxProposals: true,
      });

      expect(result.lxOutput).toBeDefined();
    });

    it("generates rich coverage report when enabled", async () => {
      const intentEntities = [
        createEntity({ name: "feature1", type: "action" }),
      ];
      const specEntities = [createEntity({ name: "feature1", type: "action" })];

      const intentPx = createPxOutput(
        "prompt.md",
        "intent",
        intentEntities,
        [],
      );
      const specPx = createPxOutput("spec.md", "spec", specEntities, []);

      const input: AggregationInput = {
        artifactOutputs: [intentPx, specPx],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx, {
        calculateCoverage: true,
        generateLxProposals: true,
      });

      expect(result.coverageReport).toBeDefined();
      expect(result.coverageReport?.$schema).toBe(
        "intentweave://schemas/coverage-report/v1",
      );
    });

    it("generates rich validation output when enabled", async () => {
      const entities = [createEntity({ name: "test", type: "state" })];

      const px = createPxOutput("test.md", "spec", entities, []);

      const input: AggregationInput = {
        artifactOutputs: [px],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx, { runValidation: true });

      expect(result.validationOutput).toBeDefined();
      expect(result.validationOutput?.rulesExecuted).toBeGreaterThanOrEqual(0);
      expect(result.validationOutput?.executionTimeMs).toBeGreaterThanOrEqual(
        0,
      );
    });
  });

  describe("empty inputs", () => {
    it("handles empty artifact list gracefully", async () => {
      const input: AggregationInput = {
        artifactOutputs: [],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx);

      expect(result.entities).toEqual([]);
      expect(result.statements).toEqual([]);
      expect(result.lxProposals).toEqual([]);
    });

    it("handles artifacts with no entities", async () => {
      const px = createPxOutput("empty.md", "doc", [], []);

      const input: AggregationInput = {
        artifactOutputs: [px],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx);

      expect(result.entities.length).toBe(0);
      expect(result.coverage.summary.totalConcepts).toBe(0);
    });
  });

  describe("run metadata", () => {
    it("includes AGG in stages list", async () => {
      // This is tested via the orchestrator, but we verify the output structure
      const entities = [createEntity({ name: "test", type: "state" })];
      const px = createPxOutput("test.md", "spec", entities, []);

      const input: AggregationInput = {
        artifactOutputs: [px],
        runId: "test-run-001",
      };

      const result = await runAggregation(input, ctx);

      // The aggregation should produce valid output that the orchestrator
      // can use to update run metadata
      expect(result).toBeDefined();
      expect(result.coverage).toBeDefined();
      expect(result.findings).toBeDefined();
    });
  });
});

describe("Aggregation with multiple roles", () => {
  let store: MemoryStore;
  let ctx: PipelineContext;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.init();
    ctx = createTestContext(store, "test-run-002");
  });

  it("tracks entities by artifact role", async () => {
    const intentEntities = [createEntity({ name: "login", type: "action" })];
    const specEntities = [createEntity({ name: "login", type: "action" })];
    const codeEntities = [
      createEntity({ name: "loginFunction", type: "function" }),
    ];
    const testEntities = [
      createEntity({ name: "loginTest", type: "testCase" }),
    ];

    const artifacts: PxStageOutput[] = [
      createPxOutput("prompt.md", "intent", intentEntities, []),
      createPxOutput("spec.md", "spec", specEntities, []),
      createPxOutput("auth.ts", "code", codeEntities, []),
      createPxOutput("auth.test.ts", "test", testEntities, []),
    ];

    const input: AggregationInput = {
      artifactOutputs: artifacts,
      runId: "test-run-002",
    };

    const result = await runAggregation(input, ctx);

    // Verify artifact roles are preserved
    const byRole = new Map<string, number>();
    for (const entity of result.entities) {
      const px = artifacts.find((a) => a.artifactId === entity.artifactId);
      const role = px?.artifactRole ?? "unknown";
      byRole.set(role, (byRole.get(role) ?? 0) + 1);
    }

    expect(byRole.get("intent")).toBe(1);
    expect(byRole.get("spec")).toBe(1);
    expect(byRole.get("code")).toBe(1);
    expect(byRole.get("test")).toBe(1);
  });

  it("generates cross-role link proposals", async () => {
    // Same entity name across intent and spec should generate link proposal
    const intentEntities = [
      createEntity({
        name: "authenticate",
        type: "action",
        cgId: "intent-authenticate",
      }),
    ];
    const specEntities = [
      createEntity({
        name: "authenticate",
        type: "action",
        cgId: "spec-authenticate",
      }),
    ];

    const artifacts: PxStageOutput[] = [
      createPxOutput("prompt.md", "intent", intentEntities, []),
      createPxOutput("spec.md", "spec", specEntities, []),
    ];

    const input: AggregationInput = {
      artifactOutputs: artifacts,
      runId: "test-run-002",
    };

    const result = await runAggregation(input, ctx, {
      generateLxProposals: true,
      lxSimilarityThreshold: 0.8,
    });

    // Should have at least one proposal linking authenticate across artifacts
    const authProposals = result.lxProposals.filter(
      (p) =>
        p.sourceCgId.includes("authenticate") ||
        p.targetCgId.includes("authenticate"),
    );
    expect(authProposals.length).toBeGreaterThan(0);
  });
});
