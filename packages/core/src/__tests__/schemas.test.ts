// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the schemas module
 */
import { describe, it, expect } from "vitest";
import {
  SCHEMA_IDS,
  SchemaId,
  loadSchema,
  getSchemaIdUri,
  getSchemaTypes,
  loadAllSchemas,
} from "../schemas/index.js";

describe("Schemas Module", () => {
  describe("SCHEMA_IDS", () => {
    it("should have all expected schema IDs", () => {
      expect(SCHEMA_IDS.RUN_META).toBe("intentweave://schemas/run-meta/v1");
      expect(SCHEMA_IDS.PX_GRAPH).toBe("intentweave://schemas/px-graph/v1");
      expect(SCHEMA_IDS.LX_PROPOSALS).toBe(
        "intentweave://schemas/lx-proposals/v1",
      );
      expect(SCHEMA_IDS.COVERAGE).toBe("intentweave://schemas/coverage/v1");
      expect(SCHEMA_IDS.FINDINGS).toBe("intentweave://schemas/findings/v1");
    });
  });

  describe("loadSchema", () => {
    it("should load run-meta schema", () => {
      const schema = loadSchema("RUN_META") as { $id: string; title: string };
      expect(schema.$id).toBe("intentweave://schemas/run-meta/v1");
      expect(schema.title).toBe("IntentWeave Run Metadata");
    });

    it("should load px-graph schema", () => {
      const schema = loadSchema("PX_GRAPH") as { $id: string; title: string };
      expect(schema.$id).toBe("intentweave://schemas/px-graph/v1");
      expect(schema.title).toBe("IntentWeave PX Stage Output");
    });

    it("should load lx-proposals schema", () => {
      const schema = loadSchema("LX_PROPOSALS") as {
        $id: string;
        title: string;
      };
      expect(schema.$id).toBe("intentweave://schemas/lx-proposals/v1");
      expect(schema.title).toBe("IntentWeave LX Proposals");
    });

    it("should load coverage schema", () => {
      const schema = loadSchema("COVERAGE") as { $id: string; title: string };
      expect(schema.$id).toBe("intentweave://schemas/coverage/v1");
      expect(schema.title).toBe("IntentWeave Coverage Report");
    });

    it("should load findings schema", () => {
      const schema = loadSchema("FINDINGS") as { $id: string; title: string };
      expect(schema.$id).toBe("intentweave://schemas/findings/v1");
      expect(schema.title).toBe("IntentWeave Findings Report");
    });

    it("should cache schemas", () => {
      const schema1 = loadSchema("RUN_META");
      const schema2 = loadSchema("RUN_META");
      expect(schema1).toBe(schema2); // Same reference
    });
  });

  describe("getSchemaIdUri", () => {
    it("should return correct URI for each type", () => {
      expect(getSchemaIdUri("RUN_META")).toBe(
        "intentweave://schemas/run-meta/v1",
      );
      expect(getSchemaIdUri("PX_GRAPH")).toBe(
        "intentweave://schemas/px-graph/v1",
      );
    });
  });

  describe("getSchemaTypes", () => {
    it("should return all schema types", () => {
      const types = getSchemaTypes();
      expect(types).toHaveLength(5);
      expect(types).toContain("RUN_META");
      expect(types).toContain("PX_GRAPH");
      expect(types).toContain("LX_PROPOSALS");
      expect(types).toContain("COVERAGE");
      expect(types).toContain("FINDINGS");
    });
  });

  describe("loadAllSchemas", () => {
    it("should load all schemas", () => {
      const schemas = loadAllSchemas();
      expect(Object.keys(schemas)).toHaveLength(5);
      expect(schemas.RUN_META).toBeDefined();
      expect(schemas.PX_GRAPH).toBeDefined();
      expect(schemas.LX_PROPOSALS).toBeDefined();
      expect(schemas.COVERAGE).toBeDefined();
      expect(schemas.FINDINGS).toBeDefined();
    });
  });
});
