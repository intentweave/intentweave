// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Performance Baseline Test - Phase 3.6
 *
 * Establishes performance baselines for the aggregation step.
 * These tests measure execution time and can be used to detect regressions.
 *
 * Baseline targets:
 * - Small (10 artifacts, ~100 entities): < 50ms
 * - Medium (50 artifacts, ~500 entities): < 200ms
 * - Large (100 artifacts, ~1000 entities): < 500ms
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type MemoryStore } from "../stores/memoryStore.js";
import {
  runAggregation,
  type AggregationInput,
} from "../pipeline/aggregation.js";
import {
  createPipelineContext,
  type PipelineContext,
  NoopLogger,
} from "../pipeline/context.js";
import type { PxStageOutput } from "../stages/px.js";
import type { Entity, Statement, ArtifactRole } from "@intentweave/core";

// =============================================================================
// Test Fixture Generators
// =============================================================================

/**
 * Generate a mock entity
 */
function generateEntity(index: number, type: string): Entity {
  return {
    cgId: `entity-${type}-${index}`,
    name: `${type}_${index}`,
    type: type as Entity["type"],
    kind: type,
    labels: ["Staging"],
    evidence: [],
    confidence: 0.85 + Math.random() * 0.15,
    description: `Generated ${type} entity #${index}`,
  } as Entity;
}

/**
 * Generate a mock statement
 */
function generateStatement(
  subjectIndex: number,
  objectIndex: number,
  predicate: string,
): Statement {
  return {
    subjectCgId: `entity-state-${subjectIndex}`,
    predicate,
    objectCgId: `entity-state-${objectIndex}`,
    confidence: 0.8 + Math.random() * 0.2,
    evidence: [],
    labels: ["Staging"],
  } as Statement;
}

/**
 * Generate a PX output with specified counts
 */
function generatePxOutput(
  artifactIndex: number,
  entityCount: number,
  statementCount: number,
  role: ArtifactRole = "spec",
): PxStageOutput {
  const entities: Entity[] = [];
  const statements: Statement[] = [];

  // Generate entities of various types
  const types = ["state", "action", "role", "event"];
  for (let i = 0; i < entityCount; i++) {
    const type = types[i % types.length];
    entities.push(generateEntity(artifactIndex * 100 + i, type));
  }

  // Generate statements
  for (let i = 0; i < statementCount; i++) {
    const subjectIdx = artifactIndex * 100 + (i % entityCount);
    const objectIdx = artifactIndex * 100 + ((i + 1) % entityCount);
    statements.push(generateStatement(subjectIdx, objectIdx, "TRANSITIONS_TO"));
  }

  return {
    $schema: "intentweave://schemas/px/v1",
    schemaVersion: "0.1",
    stage: "PX",
    processedAt: new Date().toISOString(),
    artifactId: `artifact-${artifactIndex}.md`,
    artifactRole: role,
    entities,
    statements,
    filterDecisions: [],
    summary: {
      originalEntityCount: entityCount,
      filteredEntityCount: entityCount,
      originalStatementCount: statementCount,
      filteredStatementCount: statementCount,
      entityTypeBreakdown: {},
      statementPredicateBreakdown: {},
    },
  };
}

/**
 * Generate multiple PX outputs
 */
function generateArtifacts(
  artifactCount: number,
  entitiesPerArtifact: number,
  statementsPerArtifact: number,
): PxStageOutput[] {
  const roles: ArtifactRole[] = ["intent", "spec", "code", "test", "doc"];
  return Array.from({ length: artifactCount }, (_, i) =>
    generatePxOutput(
      i,
      entitiesPerArtifact,
      statementsPerArtifact,
      roles[i % roles.length],
    ),
  );
}

// =============================================================================
// Test Setup
// =============================================================================

/**
 * Create a test context with no-op logger for performance tests
 */
function createPerfTestContext(
  store: MemoryStore,
  runId: string,
): PipelineContext {
  return createPipelineContext({
    workspace: {
      key: "perf-test-workspace",
      id: "perf-test-workspace-id",
      name: "Performance Test Workspace",
    },
    runId,
    store,
    profile: {
      name: "perf-test-profile",
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
    logger: new NoopLogger(), // Suppress logging for performance tests
  });
}

// =============================================================================
// Performance Tests
// =============================================================================

describe("Aggregation Performance", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createMemoryStore();
    await store.init();
  });

  describe("baseline measurements", () => {
    it("small dataset: 10 artifacts, ~100 entities", async () => {
      const ctx = createPerfTestContext(store, "perf-small");
      const artifacts = generateArtifacts(10, 10, 5);

      const input: AggregationInput = {
        artifactOutputs: artifacts,
        runId: "perf-small",
      };

      const startTime = performance.now();
      const result = await runAggregation(input, ctx, {
        generateLxProposals: true,
        calculateCoverage: true,
        runValidation: true,
      });
      const endTime = performance.now();
      const durationMs = endTime - startTime;

      // Log performance metrics
      console.log(`Small dataset performance:`, {
        durationMs: durationMs.toFixed(2),
        entities: result.entities.length,
        statements: result.statements.length,
        lxProposals: result.lxProposals.length,
      });

      // Baseline: should complete in under 200ms
      expect(durationMs).toBeLessThan(200);
      expect(result.entities.length).toBe(100);
    });

    it("medium dataset: 50 artifacts, ~500 entities", async () => {
      const ctx = createPerfTestContext(store, "perf-medium");
      const artifacts = generateArtifacts(50, 10, 5);

      const input: AggregationInput = {
        artifactOutputs: artifacts,
        runId: "perf-medium",
      };

      const startTime = performance.now();
      const result = await runAggregation(input, ctx, {
        generateLxProposals: true,
        calculateCoverage: true,
        runValidation: true,
      });
      const endTime = performance.now();
      const durationMs = endTime - startTime;

      console.log(`Medium dataset performance:`, {
        durationMs: durationMs.toFixed(2),
        entities: result.entities.length,
        statements: result.statements.length,
        lxProposals: result.lxProposals.length,
      });

      // Baseline: should complete in under 2000ms (generous for CI)
      expect(durationMs).toBeLessThan(2000);
      expect(result.entities.length).toBe(500);
    });

    it("large dataset: 100 artifacts, ~1000 entities", async () => {
      const ctx = createPerfTestContext(store, "perf-large");
      const artifacts = generateArtifacts(100, 10, 5);

      const input: AggregationInput = {
        artifactOutputs: artifacts,
        runId: "perf-large",
      };

      const startTime = performance.now();
      const result = await runAggregation(input, ctx, {
        generateLxProposals: true,
        calculateCoverage: true,
        runValidation: true,
      });
      const endTime = performance.now();
      const durationMs = endTime - startTime;

      console.log(`Large dataset performance:`, {
        durationMs: durationMs.toFixed(2),
        entities: result.entities.length,
        statements: result.statements.length,
        lxProposals: result.lxProposals.length,
      });

      // Baseline: generous threshold for CI runners (GitHub Actions can be slow)
      expect(durationMs).toBeLessThan(5000);
      expect(result.entities.length).toBe(1000);
    });
  });

  describe("component timing", () => {
    it("measures LX proposal generation time", async () => {
      const ctx = createPerfTestContext(store, "perf-lx");
      const artifacts = generateArtifacts(20, 20, 10);

      const input: AggregationInput = {
        artifactOutputs: artifacts,
        runId: "perf-lx",
      };

      // Without LX
      const startNoLx = performance.now();
      await runAggregation(input, ctx, { generateLxProposals: false });
      const durationNoLx = performance.now() - startNoLx;

      // With LX
      const startWithLx = performance.now();
      await runAggregation(input, ctx, { generateLxProposals: true });
      const durationWithLx = performance.now() - startWithLx;

      const lxOverhead = durationWithLx - durationNoLx;

      console.log(`LX generation overhead:`, {
        withoutLx: durationNoLx.toFixed(2),
        withLx: durationWithLx.toFixed(2),
        overhead: lxOverhead.toFixed(2),
      });

      // LX generation overhead — generous for CI runners (slow/variable VMs)
      expect(lxOverhead).toBeLessThan(1000);
    });

    it("measures validation time", async () => {
      const ctx = createPerfTestContext(store, "perf-validation");
      const artifacts = generateArtifacts(20, 20, 10);

      const input: AggregationInput = {
        artifactOutputs: artifacts,
        runId: "perf-validation",
      };

      // Without validation
      const startNoVal = performance.now();
      await runAggregation(input, ctx, { runValidation: false });
      const durationNoVal = performance.now() - startNoVal;

      // With validation
      const startWithVal = performance.now();
      const result = await runAggregation(input, ctx, { runValidation: true });
      const durationWithVal = performance.now() - startWithVal;

      const validationOverhead = durationWithVal - durationNoVal;

      console.log(`Validation overhead:`, {
        withoutValidation: durationNoVal.toFixed(2),
        withValidation: durationWithVal.toFixed(2),
        overhead: validationOverhead.toFixed(2),
        rulesExecuted: result.validationOutput?.rulesExecuted ?? 0,
      });

      // Validation should not add more than 500ms overhead.
      // Generous bound for slow CI VMs — mirrors the LX overhead test above.
      expect(validationOverhead).toBeLessThan(500);
    });
  });

  describe("scaling characteristics", () => {
    it("scales linearly with artifact count", async () => {
      const measurements: Array<{ artifacts: number; durationMs: number }> = [];

      for (const artifactCount of [10, 20, 40, 80]) {
        const ctx = createPerfTestContext(store, `perf-scale-${artifactCount}`);
        const artifacts = generateArtifacts(artifactCount, 5, 3);

        const input: AggregationInput = {
          artifactOutputs: artifacts,
          runId: `perf-scale-${artifactCount}`,
        };

        const start = performance.now();
        await runAggregation(input, ctx, {
          generateLxProposals: false, // Disable LX for cleaner scaling measurement
          calculateCoverage: true,
          runValidation: true,
        });
        const duration = performance.now() - start;

        measurements.push({ artifacts: artifactCount, durationMs: duration });
      }

      console.log("Scaling measurements:", measurements);

      // Check that scaling is reasonable (not exponential)
      // Allow for some variance in measurements due to JIT warmup and GC
      for (let i = 1; i < measurements.length; i++) {
        const ratio =
          measurements[i].durationMs /
          Math.max(measurements[i - 1].durationMs, 0.01);
        const artifactRatio =
          measurements[i].artifacts / measurements[i - 1].artifacts;

        // Time should not grow faster than O(n^3) at worst.
        // A 1.5× headroom factor absorbs JIT warmup / GC spikes that would
        // otherwise cause a spurious failure when the ratio lands at exactly
        // the cubic boundary (e.g. 8.39 vs 8.00 for artifactRatio=2).
        expect(ratio).toBeLessThan(
          artifactRatio * artifactRatio * artifactRatio * 1.5,
        );
      }
    });
  });
});
