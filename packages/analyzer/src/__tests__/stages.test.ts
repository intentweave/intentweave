// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage Tests - CX, MX, PX
 *
 * Tests for the per-artifact pipeline stages (Phase 2).
 * Validates that stages correctly transform Entity/Statement graphs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Entity, Statement, Evidence } from "@intentweave/core";

// Stage imports
import {
  runCxStage,
  getEntities,
  getStatements,
  getAliasMap,
  resolveCgId,
  type CxStageInput,
  type CxStageOutput,
} from "../stages/cx.js";

import {
  runMxStage,
  getAllEntities,
  getTransitionEntities,
  getAllStatements,
  getOrphanIds,
  type MxStageInput,
  type MxStageOutput,
} from "../stages/mx.js";

import {
  runPxStage,
  getFilteredEntities,
  getFilteredStatements,
  getArtifactRole,
  type PxStageInput,
  type PxStageOutput,
} from "../stages/px.js";

import type { RxStageOutput } from "../stages/rx.js";

// Context imports
import {
  createPipelineContext,
  DEFAULT_PROFILE,
  NoopLogger,
  type Profile,
  type PipelineContext,
} from "../pipeline/context.js";

import { createMemoryStore } from "../stores/memoryStore.js";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a minimal test entity
 */
function createEntity(
  partial: Partial<Entity> & { cgId: string; name: string },
): Entity {
  return {
    type: partial.type ?? "concept",
    cgId: partial.cgId,
    name: partial.name,
    state: partial.state ?? "raw",
    confidence: partial.confidence ?? 0.8,
    evidence: partial.evidence ?? [],
    aliases: partial.aliases ?? [],
    props: partial.props ?? {},
  };
}

/**
 * Create a minimal test statement
 */
function createStatement(
  partial: Partial<Statement> & {
    id: string;
    subjectCgId: string;
    predicate: string;
  },
): Statement {
  return {
    id: partial.id,
    subjectCgId: partial.subjectCgId,
    predicate: partial.predicate,
    objectCgId: partial.objectCgId ?? null,
    objectLiteral: partial.objectLiteral ?? null,
    confidence: partial.confidence ?? 0.8,
    evidence: partial.evidence ?? [],
  };
}

/**
 * Create a minimal RX output for testing
 */
function createRxOutput(
  artifactId: string,
  entities: Entity[],
  statements: Statement[] = [],
  evidence: Evidence[] = [],
): RxStageOutput {
  return {
    $schema: "intentweave://schemas/rx-graph/v1",
    schemaVersion: "0.1",
    stage: "RX",
    artifactId,
    filePath: `spec/${artifactId}.md`,
    extractedAt: "2024-01-01T00:00:00.000Z",
    entities,
    statements,
    evidence,
    meta: {
      provider: "test",
      chunksProcessed: 1,
    },
  };
}

/**
 * Create a mock pipeline context for testing
 */
function createTestContext(
  profileOverrides: Partial<Profile> = {},
): PipelineContext {
  const store = createMemoryStore({ runId: "test-run" });
  const profile = { ...DEFAULT_PROFILE, ...profileOverrides };

  // Create a minimal mock that satisfies PipelineContext
  return {
    workspace: { key: "test-workspace", rootPath: "/test" },
    runId: "test-run",
    store,
    profile,
    providers: {
      llm: {} as any,
      extraction: {} as any,
    },
    logger: new NoopLogger(),
    timestamp: () => "2024-01-01T00:00:00.000Z",
    generateCgId: (type, name) =>
      `cg:test:${type}:${name.toLowerCase().replace(/\s+/g, "-")}`,
  };
}

// =============================================================================
// CX Stage Tests
// =============================================================================

describe("CX Stage", () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  describe("runCxStage", () => {
    it("returns valid CX output with schema", async () => {
      const entities = [createEntity({ cgId: "cg:1", name: "Admin" })];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(result.$schema).toBe("intentweave://schemas/cx-graph/v1");
      expect(result.schemaVersion).toBe("0.1");
      expect(result.stage).toBe("CX");
      expect(result.artifactId).toBe("artifact-1");
      expect(result.processedAt).toBeDefined();
    });

    it("passes through entities unchanged when no duplicates", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "Admin" }),
        createEntity({ cgId: "cg:2", name: "User" }),
      ];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(result.entities).toHaveLength(2);
      expect(result.aliases).toHaveLength(0);
      expect(result.meta.mergedCount).toBe(0);
    });

    it("merges entities with matching normalized names", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "Admin User" }),
        createEntity({ cgId: "cg:2", name: "admin_user" }), // Same when normalized
      ];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(result.entities).toHaveLength(1);
      expect(result.aliases).toHaveLength(1);
      expect(result.aliases[0].originalCgId).toBe("cg:2");
      expect(result.aliases[0].canonicalCgId).toBe("cg:1");
      expect(result.meta.mergedCount).toBe(1);
    });

    it("updates statement cgIds when entities are merged", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "Admin" }),
        createEntity({ cgId: "cg:2", name: "admin" }), // Will merge
      ];
      const statements = [
        createStatement({
          id: "stmt:1",
          subjectCgId: "cg:2", // References entity that will be merged
          predicate: "HAS_STATE",
          objectCgId: "cg:other",
        }),
      ];
      const rxOutput = createRxOutput("artifact-1", entities, statements);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      // Statement should now reference the canonical cgId
      expect(result.statements[0].subjectCgId).toBe("cg:1");
    });

    it("canonicalizes entity names", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "  admin  user  " }), // Extra whitespace
      ];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(result.entities[0].name).toBe("Admin User");
    });

    it("records normalizations in meta", async () => {
      const entities = [createEntity({ cgId: "cg:1", name: "admin user" })];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(result.meta.normalizations.length).toBeGreaterThanOrEqual(1);
      expect(result.meta.normalizations[0].type).toBe("name");
    });

    it("preserves evidence from RX", async () => {
      const evidence: Evidence[] = [
        { id: "ev:1", type: "extraction", source: "chunk-1", confidence: 0.9 },
      ];
      const entities = [
        createEntity({ cgId: "cg:1", name: "Admin", evidence: ["ev:1"] }),
      ];
      const rxOutput = createRxOutput("artifact-1", entities, [], evidence);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(result.evidence).toEqual(evidence);
    });
  });

  describe("utility functions", () => {
    it("getEntities returns consolidated entities", async () => {
      const entities = [createEntity({ cgId: "cg:1", name: "Admin" })];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(getEntities(result)).toEqual(result.entities);
    });

    it("getStatements returns statements", async () => {
      const statements = [
        createStatement({
          id: "stmt:1",
          subjectCgId: "cg:1",
          predicate: "HAS_STATE",
        }),
      ];
      const rxOutput = createRxOutput("artifact-1", [], statements);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(getStatements(result)).toEqual(result.statements);
    });

    it("getAliasMap builds cgId mapping", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "Admin" }),
        createEntity({ cgId: "cg:2", name: "admin" }),
      ];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);
      const aliasMap = getAliasMap(result);

      expect(aliasMap.get("cg:2")).toBe("cg:1");
    });

    it("resolveCgId follows alias chain", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "Admin" }),
        createEntity({ cgId: "cg:2", name: "admin" }),
      ];
      const rxOutput = createRxOutput("artifact-1", entities);
      const input: CxStageInput = { artifactId: "artifact-1", rxOutput };

      const result = await runCxStage(input, ctx);

      expect(resolveCgId("cg:2", result)).toBe("cg:1");
      expect(resolveCgId("cg:1", result)).toBe("cg:1"); // Already canonical
      expect(resolveCgId("cg:unknown", result)).toBe("cg:unknown"); // Not in aliases
    });
  });
});

// =============================================================================
// MX Stage Tests
// =============================================================================

describe("MX Stage", () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  /**
   * Create a CX output for MX testing
   */
  function createCxOutput(
    artifactId: string,
    entities: Entity[],
    statements: Statement[] = [],
    evidence: Evidence[] = [],
  ): CxStageOutput {
    return {
      $schema: "intentweave://schemas/cx-graph/v1",
      schemaVersion: "0.1",
      stage: "CX",
      artifactId,
      processedAt: "2024-01-01T00:00:00.000Z",
      entities,
      statements,
      evidence,
      aliases: [],
      meta: {
        entityCount: entities.length,
        mergedCount: 0,
        statementCount: statements.length,
        normalizations: [],
        processingTimeMs: 0,
      },
    };
  }

  describe("runMxStage", () => {
    it("returns valid MX output with schema", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "State A", type: "state" }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);

      expect(result.$schema).toBe("intentweave://schemas/mx-graph/v1");
      expect(result.schemaVersion).toBe("0.1");
      expect(result.stage).toBe("MX");
      expect(result.artifactId).toBe("artifact-1");
    });

    it("materializes transition entity from TRANSITIONS_TO statement", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);

      // Should have original 2 entities + 1 materialized transition + 1 inferred resource
      expect(result.entities.length).toBe(4);

      const transitions = getTransitionEntities(result);
      expect(transitions).toHaveLength(1);
      expect(transitions[0].type).toBe("transition");
      expect(transitions[0].name).toContain("State A");
      expect(transitions[0].name).toContain("State B");
    });

    it("creates FROM_STATE and TO_STATE statements for transitions", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);

      // Find the materialized transition
      const transition = getTransitionEntities(result)[0];
      expect(transition).toBeDefined();

      // Check for binding statements using canonical semantics:
      // source_state --FROM_STATE--> Transition --TO_STATE--> target_state
      const allStatements = getAllStatements(result);

      // FROM_STATE: state → transition (state is subject, transition is object)
      const fromStateStmt = allStatements.find(
        (s) => s.predicate === "FROM_STATE" && s.objectCgId === transition.cgId,
      );
      // TO_STATE: transition → state (transition is subject, state is object)
      const toStateStmt = allStatements.find(
        (s) => s.predicate === "TO_STATE" && s.subjectCgId === transition.cgId,
      );

      expect(fromStateStmt).toBeDefined();
      expect(fromStateStmt!.subjectCgId).toContain("state"); // Source state as subject
      expect(toStateStmt).toBeDefined();
      expect(toStateStmt!.objectCgId).toContain("state"); // Target state as object
    });

    it("tracks orphan entities (not in transitions)", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
        createEntity({
          cgId: "cg:orphan",
          name: "Orphan Entity",
          type: "concept",
        }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);

      const orphans = getOrphanIds(result);
      expect(orphans).toContain("cg:orphan");
      expect(orphans).not.toContain("cg:state-a");
      expect(orphans).not.toContain("cg:state-b");
    });

    it("preserves original entities and statements", async () => {
      const entities = [createEntity({ cgId: "cg:1", name: "Entity 1" })];
      const statements = [
        createStatement({
          id: "stmt:1",
          subjectCgId: "cg:1",
          predicate: "HAS_PROPERTY",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);

      // Original entity should still be present
      const allEntities = getAllEntities(result);
      expect(allEntities.find((e) => e.cgId === "cg:1")).toBeDefined();

      // Original statement should still be present
      const allStatements = getAllStatements(result);
      expect(allStatements.find((s) => s.id === "stmt:1")).toBeDefined();
    });

    it("records metadata about materialization", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);

      expect(result.meta.materializedCount).toBe(1); // 1 transition
      expect(result.meta.entityCount).toBe(4); // 2 original + 1 transition + 1 inferred resource
      // bindingCount tracks new statements from materialization (FROM_STATE + TO_STATE)
      // but is offset by lowered TRANSITIONS_TO, so the net is >=1
      expect(result.meta.bindingCount).toBeGreaterThanOrEqual(1);
      expect(result.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("utility functions", () => {
    it("getAllEntities returns all entities including transitions", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const allEntities = getAllEntities(result);

      expect(allEntities.length).toBe(4); // 2 states + 1 transition + 1 inferred resource
    });

    it("getTransitionEntities returns only transition entities", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const transitions = getTransitionEntities(result);

      expect(transitions.every((e) => e.type === "transition")).toBe(true);
    });
  });

  describe("canonical semantics", () => {
    it("creates TRIGGERS statements with event as subject, transition as object", async () => {
      // Setup: states, event, and TRANSITIONS_TO + TRIGGERS statements
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
        createEntity({
          cgId: "cg:event-1",
          name: "Approval Event",
          type: "event",
        }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
        // Legacy pattern: event TRIGGERS state (meaning "triggers transition to state")
        createStatement({
          id: "stmt:trigger",
          subjectCgId: "cg:event-1",
          predicate: "TRIGGERS",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const allStatements = getAllStatements(result);
      const transition = getTransitionEntities(result)[0];

      // Canonical form: event → transition (event is subject, transition is object)
      const triggersStmt = allStatements.find(
        (s) => s.predicate === "TRIGGERS" && s.objectCgId === transition?.cgId,
      );

      expect(triggersStmt).toBeDefined();
      expect(triggersStmt!.subjectCgId).toBe("cg:event-1");
    });

    it("synthesizes HAS_STATE statements when single resource inferred", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const allStatements = getAllStatements(result);

      // Should have synthesized HAS_STATE statements
      const hasStateStmts = allStatements.filter(
        (s) => s.predicate === "HAS_STATE",
      );
      expect(hasStateStmts.length).toBeGreaterThanOrEqual(2); // One per state
    });

    it("infers resource entity when states have no explicit resource", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const allEntities = getAllEntities(result);

      // Should have inferred a resource entity
      const resources = allEntities.filter((e) => e.type === "resource");
      expect(resources.length).toBe(1);
      expect(resources[0].name).toBe("artifact"); // Inferred from artifact ID
    });

    it("lowers TRANSITIONS_TO to canonical FROM_STATE/TO_STATE bindings", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const allStatements = getAllStatements(result);

      // Original TRANSITIONS_TO should be lowered (not present)
      const transitionsToStmts = allStatements.filter(
        (s) => s.predicate === "TRANSITIONS_TO",
      );
      expect(transitionsToStmts.length).toBe(0);

      // Should have FROM_STATE and TO_STATE instead
      const fromStateStmts = allStatements.filter(
        (s) => s.predicate === "FROM_STATE",
      );
      const toStateStmts = allStatements.filter(
        (s) => s.predicate === "TO_STATE",
      );
      expect(fromStateStmts.length).toBe(1);
      expect(toStateStmts.length).toBe(1);
    });

    it("prefixes state cgIds with resource name", async () => {
      const entities = [
        createEntity({ cgId: "cg:state-a", name: "State A", type: "state" }),
        createEntity({ cgId: "cg:state-b", name: "State B", type: "state" }),
      ];
      const statements = [
        createStatement({
          id: "stmt:trans",
          subjectCgId: "cg:state-a",
          predicate: "TRANSITIONS_TO",
          objectCgId: "cg:state-b",
        }),
      ];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const allEntities = getAllEntities(result);

      // State entities should be prefixed with resource name
      const states = allEntities.filter((e) => e.type === "state");
      expect(states.every((s) => s.cgId.includes("state-artifact"))).toBe(true);
    });

    it("returns no transitions when no state entities present", async () => {
      const entities = [
        createEntity({ cgId: "cg:role-1", name: "Admin Role", type: "role" }),
        createEntity({ cgId: "cg:actor-1", name: "User Actor", type: "actor" }),
      ];
      const statements: Statement[] = [];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx);
      const transitions = getTransitionEntities(result);

      expect(transitions.length).toBe(0);
    });

    it("does not infer transitions when no TRANSITIONS_TO and no event-state matches", async () => {
      // Without explicit TRANSITIONS_TO, inference only works if events reference states
      // by their prefixed name (e.g., 'state-artifact-Inactive')
      const entities = [
        createEntity({ cgId: "cg:state-1", name: "Inactive", type: "state" }),
        createEntity({ cgId: "cg:state-2", name: "Active", type: "state" }),
      ];
      const statements: Statement[] = [];
      const cxOutput = createCxOutput("artifact-1", entities, statements);
      const input: MxStageInput = { artifactId: "artifact-1", cxOutput };

      const result = await runMxStage(input, ctx, { inferTransitions: true });
      const transitions = getTransitionEntities(result);

      // No transitions inferred without TRANSITIONS_TO or matching events
      expect(transitions.length).toBe(0);
    });
  });
});

// =============================================================================
// PX Stage Tests
// =============================================================================

describe("PX Stage", () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  /**
   * Create an MX output for PX testing
   */
  function createMxOutput(
    artifactId: string,
    entities: Entity[],
    statements: Statement[] = [],
    evidence: Evidence[] = [],
  ): MxStageOutput {
    return {
      $schema: "intentweave://schemas/mx-graph/v1",
      schemaVersion: "0.1",
      stage: "MX",
      artifactId,
      processedAt: "2024-01-01T00:00:00.000Z",
      entities,
      statements,
      evidence,
      orphanEntityIds: [],
      meta: {
        entityCount: entities.length,
        materializedCount: 0,
        statementCount: statements.length,
        bindingCount: 0,
        orphanCount: 0,
        processingTimeMs: 0,
      },
    };
  }

  describe("runPxStage", () => {
    it("returns valid PX output with schema", async () => {
      const entities = [createEntity({ cgId: "cg:1", name: "Entity 1" })];
      const mxOutput = createMxOutput("artifact-1", entities);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };

      const result = await runPxStage(input, ctx);

      expect(result.$schema).toBe("intentweave://schemas/px-graph/v1");
      expect(result.schemaVersion).toBe("0.1");
      expect(result.stage).toBe("PX");
      expect(result.artifactId).toBe("artifact-1");
    });

    it("filters entities below confidence threshold", async () => {
      const entities = [
        createEntity({
          cgId: "cg:1",
          name: "High Confidence",
          confidence: 0.9,
        }),
        createEntity({ cgId: "cg:2", name: "Low Confidence", confidence: 0.3 }),
      ];
      const mxOutput = createMxOutput("artifact-1", entities);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };

      // Use minEntityConfidence threshold of 0.5
      const result = await runPxStage(input, ctx, { minEntityConfidence: 0.5 });

      const filtered = getFilteredEntities(result);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].cgId).toBe("cg:1");
    });

    it("records filter decisions", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "High", confidence: 0.9 }),
        createEntity({ cgId: "cg:2", name: "Low", confidence: 0.3 }),
      ];
      const mxOutput = createMxOutput("artifact-1", entities);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };

      const result = await runPxStage(input, ctx, { minEntityConfidence: 0.5 });

      const lowConfDecision = result.filterDecisions.find(
        (d) => d.id === "cg:2",
      );
      expect(lowConfDecision).toBeDefined();
      expect(lowConfDecision!.reason).toBe("low-confidence");
    });

    it("passes all entities when confidence filter is disabled", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "High", confidence: 0.9 }),
        createEntity({ cgId: "cg:2", name: "Low", confidence: 0.1 }),
      ];
      const mxOutput = createMxOutput("artifact-1", entities);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };

      // Set minEntityConfidence to 0 to pass all entities
      const result = await runPxStage(input, ctx, { minEntityConfidence: 0 });

      expect(getFilteredEntities(result)).toHaveLength(2);
    });

    it("infers artifact role from file path", async () => {
      const entities = [createEntity({ cgId: "cg:1", name: "Entity" })];
      const mxOutput = createMxOutput("artifact-1", entities);

      // Test spec role - pattern is **/spec*.md
      const specInput: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };
      const specResult = await runPxStage(specInput, ctx);
      expect(specResult.artifactRole).toBe("spec");

      // Test impl role - pattern is **/*.ts
      const implInput: PxStageInput = {
        artifactId: "artifact-2",
        filePath: "src/auth.ts",
        mxOutput: { ...mxOutput, artifactId: "artifact-2" },
      };
      const implResult = await runPxStage(implInput, ctx);
      expect(implResult.artifactRole).toBe("impl");
    });

    it("filters statements when their entities are filtered", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "Kept", confidence: 0.9 }),
        createEntity({ cgId: "cg:2", name: "Removed", confidence: 0.2 }),
      ];
      const statements = [
        createStatement({
          id: "stmt:1",
          subjectCgId: "cg:1",
          predicate: "CONNECTS",
          objectCgId: "cg:2",
        }),
        createStatement({
          id: "stmt:2",
          subjectCgId: "cg:1",
          predicate: "HAS_PROPERTY",
          objectLiteral: "value",
        }),
      ];
      const mxOutput = createMxOutput("artifact-1", entities, statements);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };

      const result = await runPxStage(input, ctx, { minEntityConfidence: 0.5 });

      // stmt:1 should be filtered (references removed entity)
      // stmt:2 should remain (only references kept entity)
      const stmts = getFilteredStatements(result);
      expect(stmts.find((s) => s.id === "stmt:1")).toBeUndefined();
      expect(stmts.find((s) => s.id === "stmt:2")).toBeDefined();
    });

    it("records metadata about filtering", async () => {
      const entities = [
        createEntity({ cgId: "cg:1", name: "Kept", confidence: 0.9 }),
        createEntity({ cgId: "cg:2", name: "Removed", confidence: 0.2 }),
      ];
      const mxOutput = createMxOutput("artifact-1", entities);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };

      const result = await runPxStage(input, ctx, { minEntityConfidence: 0.5 });

      expect(result.meta.includedEntityCount).toBe(1);
      expect(result.meta.filteredEntityCount).toBe(1);
      expect(result.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("utility functions", () => {
    it("getFilteredEntities returns entities from output", async () => {
      const entities = [createEntity({ cgId: "cg:1", name: "Entity" })];
      const mxOutput = createMxOutput("artifact-1", entities);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/spec-auth.md",
        mxOutput,
      };

      const result = await runPxStage(input, ctx);

      expect(getFilteredEntities(result)).toEqual(result.entities);
    });

    it("getArtifactRole returns inferred role", async () => {
      const mxOutput = createMxOutput("artifact-1", []);
      const input: PxStageInput = {
        artifactId: "artifact-1",
        filePath: "docs/design-overview.md", // pattern is **/design*.md
        mxOutput,
      };

      const result = await runPxStage(input, ctx);

      expect(getArtifactRole(result)).toBe("spec");
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe("Stage Pipeline Integration", () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  it("processes RX → CX → MX → PX correctly", async () => {
    // Create RX output with states and transitions
    const rxEntities = [
      createEntity({ cgId: "cg:pending", name: "Pending", type: "state" }),
      createEntity({ cgId: "cg:approved", name: "Approved", type: "state" }),
      createEntity({ cgId: "cg:submit", name: "Submit", type: "action" }),
    ];
    const rxStatements = [
      createStatement({
        id: "stmt:trans",
        subjectCgId: "cg:pending",
        predicate: "TRANSITIONS_TO",
        objectCgId: "cg:approved",
      }),
      createStatement({
        id: "stmt:trigger",
        subjectCgId: "cg:submit",
        predicate: "TRIGGERS",
        objectCgId: "stmt:trans", // Triggers the transition
      }),
    ];
    const rxOutput = createRxOutput("artifact-1", rxEntities, rxStatements);

    // Run CX
    const cxInput: CxStageInput = { artifactId: "artifact-1", rxOutput };
    const cxOutput = await runCxStage(cxInput, ctx);

    expect(cxOutput.stage).toBe("CX");
    expect(cxOutput.entities).toHaveLength(3);

    // Run MX
    const mxInput: MxStageInput = { artifactId: "artifact-1", cxOutput };
    const mxOutput = await runMxStage(mxInput, ctx);

    expect(mxOutput.stage).toBe("MX");
    // Should have materialized a transition entity
    expect(mxOutput.entities.length).toBeGreaterThan(3);

    // Run PX
    const pxInput: PxStageInput = {
      artifactId: "artifact-1",
      filePath: "docs/spec-workflow.md", // pattern is **/spec*.md
      mxOutput,
    };
    const pxOutput = await runPxStage(pxInput, ctx);

    expect(pxOutput.stage).toBe("PX");
    expect(pxOutput.artifactRole).toBe("spec");
    expect(pxOutput.entities.length).toBeGreaterThanOrEqual(3);
  });

  it("maintains graph consistency through all stages", async () => {
    const rxEntities = [
      createEntity({ cgId: "cg:admin", name: "Admin", type: "role" }),
      createEntity({ cgId: "cg:view", name: "View", type: "action" }),
    ];
    const rxStatements = [
      createStatement({
        id: "stmt:role-can",
        subjectCgId: "cg:admin",
        predicate: "ROLE_CAN",
        objectCgId: "cg:view",
      }),
    ];
    const rxOutput = createRxOutput("artifact-1", rxEntities, rxStatements);

    const cxInput: CxStageInput = { artifactId: "artifact-1", rxOutput };
    const cxOutput = await runCxStage(cxInput, ctx);

    const mxInput: MxStageInput = { artifactId: "artifact-1", cxOutput };
    const mxOutput = await runMxStage(mxInput, ctx);

    const pxInput: PxStageInput = {
      artifactId: "artifact-1",
      filePath: "docs/spec-auth.md",
      mxOutput,
    };
    const pxOutput = await runPxStage(pxInput, ctx);

    // Verify entities are preserved
    const finalEntities = getFilteredEntities(pxOutput);
    expect(finalEntities.find((e) => e.name === "Admin")).toBeDefined();
    expect(finalEntities.find((e) => e.name === "View")).toBeDefined();

    // Verify statement references valid entities
    const finalStatements = getFilteredStatements(pxOutput);
    const roleCanStmt = finalStatements.find((s) => s.predicate === "ROLE_CAN");
    expect(roleCanStmt).toBeDefined();

    const entityIds = new Set(finalEntities.map((e) => e.cgId));
    expect(entityIds.has(roleCanStmt!.subjectCgId)).toBe(true);
    expect(entityIds.has(roleCanStmt!.objectCgId!)).toBe(true);
  });
});
