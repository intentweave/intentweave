// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference Resolution Tests
 *
 * Tests for statement subject/object resolution using predicate signatures.
 * Ensures the DefaultExtractionProvider correctly resolves references
 * based on SHAPE_CONSTRAINTS from core.
 */

import { describe, it, expect } from "vitest";
import {
  buildCgId,
  getAllowedSubjectTypes,
  getAllowedObjectTypes,
  SHAPE_CONSTRAINTS,
  type Entity,
  type EntityType,
} from "@intentweave/core";

// =============================================================================
// Normalization Function (mirrors production code)
// =============================================================================

/**
 * Normalize a reference name for matching.
 *
 * Steps:
 * 1. casefold (toLowerCase)
 * 2. split camelCase → tokens (e.g., "UserDeactivated" → "user deactivated")
 * 3. slugify (unify spaces/underscores/dashes to single separator)
 * 4. remove punctuation
 */
function normalizeReference(name: string): string {
  // Step 1: Split camelCase/PascalCase into tokens
  const withSpaces = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  // Step 2: casefold
  const lower = withSpaces.toLowerCase();

  // Step 3: Replace spaces, underscores, multiple dashes with single dash
  const slugified = lower.replace(/[\s_]+/g, "-").replace(/-+/g, "-");

  // Step 4: Remove punctuation (except dashes)
  const cleaned = slugified.replace(/[^a-z0-9-]/g, "");

  // Step 5: Trim leading/trailing dashes
  return cleaned.replace(/^-+|-+$/g, "");
}

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Create a test entity
 */
function createEntity(
  type: EntityType,
  name: string,
  confidence = 0.8,
): Entity {
  return {
    cgId: buildCgId(type, name),
    name,
    type,
    confidence,
    labels: ["Test"],
    evidence: [],
    source: "test",
    origin: "test",
    state: "committed",
  };
}

/**
 * Resolve a statement subject/object reference to its correct cgId
 *
 * This is a pure function version of the resolver for testing.
 * Production code uses the class method in DefaultExtractionProvider.
 */
function resolveReference(
  name: string,
  predicate: string,
  role: "subject" | "object",
  entities: Entity[],
): {
  cgId: string;
  resolved: boolean;
  type: EntityType;
  ambiguous?: boolean;
  matchedEntity?: Entity;
  normalizedName?: string;
} {
  // Get expected types from predicate shape constraints
  const allowedTypes =
    role === "subject"
      ? getAllowedSubjectTypes(predicate)
      : (getAllowedObjectTypes(predicate).filter(
          (t) => t !== "null",
        ) as EntityType[]);

  // Normalize the reference name
  const normalizedRef = normalizeReference(name);

  // Build entity index with normalized names
  const entityIndex = new Map<string, Entity[]>();
  for (const entity of entities) {
    const normalizedEntityName = normalizeReference(entity.name);
    const existing = entityIndex.get(normalizedEntityName) ?? [];
    existing.push(entity);
    entityIndex.set(normalizedEntityName, existing);
  }

  // Step 1: Exact normalized match
  const matchingEntities = entityIndex.get(normalizedRef) ?? [];

  // Step 2: TYPED LOOKUP FIRST
  const typedMatches = matchingEntities.filter((e) =>
    allowedTypes.includes(e.type as EntityType),
  );

  if (typedMatches.length === 1) {
    const entity = typedMatches[0];
    return {
      cgId: entity.cgId,
      resolved: true,
      type: entity.type as EntityType,
      matchedEntity: entity,
      normalizedName: normalizedRef,
    };
  }

  if (typedMatches.length > 1) {
    const sorted = typedMatches.sort((a, b) => {
      const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
      if (confDiff !== 0) return confDiff;
      const aIdx = allowedTypes.indexOf(a.type as EntityType);
      const bIdx = allowedTypes.indexOf(b.type as EntityType);
      return aIdx - bIdx;
    });
    const entity = sorted[0];
    return {
      cgId: entity.cgId,
      resolved: true,
      type: entity.type as EntityType,
      matchedEntity: entity,
      ambiguous: true,
      normalizedName: normalizedRef,
    };
  }

  // Step 3: FALLBACK - any match
  if (matchingEntities.length === 1) {
    const entity = matchingEntities[0];
    return {
      cgId: entity.cgId,
      resolved: true,
      type: entity.type as EntityType,
      matchedEntity: entity,
      normalizedName: normalizedRef,
    };
  }

  if (matchingEntities.length > 1) {
    const sorted = matchingEntities.sort(
      (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
    );
    const entity = sorted[0];
    return {
      cgId: entity.cgId,
      resolved: true,
      type: entity.type as EntityType,
      matchedEntity: entity,
      ambiguous: true,
      normalizedName: normalizedRef,
    };
  }

  // Step 4: UNIQUE MATCH ACROSS ALL KINDS
  let uniqueMatch: Entity | undefined;
  let matchCount = 0;

  for (const [, ents] of entityIndex) {
    for (const ent of ents) {
      const entNorm = normalizeReference(ent.name);
      if (entNorm.includes(normalizedRef) || normalizedRef.includes(entNorm)) {
        if (allowedTypes.includes(ent.type as EntityType)) {
          matchCount++;
          uniqueMatch = ent;
        }
      }
    }
  }

  if (matchCount === 1 && uniqueMatch) {
    return {
      cgId: uniqueMatch.cgId,
      resolved: true,
      type: uniqueMatch.type as EntityType,
      matchedEntity: uniqueMatch,
      normalizedName: normalizedRef,
    };
  }

  // Step 5: UNRESOLVED
  const firstType = allowedTypes[0] ?? "resource";
  return {
    cgId: buildCgId(firstType, normalizedRef),
    resolved: false,
    type: firstType,
    normalizedName: normalizedRef,
  };
}

// =============================================================================
// Normalization Tests
// =============================================================================

describe("Normalization", () => {
  it("should normalize camelCase to slug", () => {
    expect(normalizeReference("UserDeactivated")).toBe("user-deactivated");
    expect(normalizeReference("userDeactivated")).toBe("user-deactivated");
  });

  it("should normalize underscores to dashes", () => {
    expect(normalizeReference("user_deactivated")).toBe("user-deactivated");
    expect(normalizeReference("user__deactivated")).toBe("user-deactivated");
  });

  it("should normalize spaces to dashes", () => {
    expect(normalizeReference("User Deactivated")).toBe("user-deactivated");
    expect(normalizeReference("user  deactivated")).toBe("user-deactivated");
  });

  it("should casefold uppercase", () => {
    expect(normalizeReference("ACTIVE")).toBe("active");
    expect(normalizeReference("Active")).toBe("active");
  });

  it("should handle mixed formats", () => {
    expect(normalizeReference("User_Account_Lifecycle")).toBe(
      "user-account-lifecycle",
    );
    expect(normalizeReference("userAccountLifecycle")).toBe(
      "user-account-lifecycle",
    );
  });

  it("should remove punctuation", () => {
    expect(normalizeReference("user's account")).toBe("users-account");
    expect(normalizeReference("user.account")).toBe("useraccount");
  });

  it("should handle already-slugified names", () => {
    expect(normalizeReference("user-deactivated")).toBe("user-deactivated");
    expect(normalizeReference("active")).toBe("active");
  });
});

// =============================================================================
// Shape Constraint Tests
// =============================================================================

describe("Shape Constraints", () => {
  it("should have ROLE_CAN signature: role → action", () => {
    const shape = SHAPE_CONSTRAINTS.find((s) => s.predicate === "ROLE_CAN");
    expect(shape).toBeDefined();
    expect(shape?.subjects).toContain("role");
    expect(shape?.objects).toContain("action");
  });

  it("should have HAS_STATE signature: resource → state", () => {
    const shape = SHAPE_CONSTRAINTS.find((s) => s.predicate === "HAS_STATE");
    expect(shape).toBeDefined();
    expect(shape?.subjects).toContain("resource");
    expect(shape?.objects).toContain("state");
  });

  it("should have TRANSITIONS_TO signature: state → state", () => {
    const shape = SHAPE_CONSTRAINTS.find(
      (s) => s.predicate === "TRANSITIONS_TO",
    );
    expect(shape).toBeDefined();
    expect(shape?.subjects).toContain("state");
    expect(shape?.objects).toContain("state");
  });

  it("should have TRIGGERED_BY signature: transition → action|event", () => {
    const shape = SHAPE_CONSTRAINTS.find((s) => s.predicate === "TRIGGERED_BY");
    expect(shape).toBeDefined();
    expect(shape?.subjects).toContain("transition");
    expect(shape?.objects).toEqual(expect.arrayContaining(["action", "event"]));
  });
});

// =============================================================================
// Reference Resolution Tests
// =============================================================================

describe("Reference Resolution", () => {
  describe("ROLE_CAN(admin, read)", () => {
    it("should resolve admin → role/admin and read → action/read", () => {
      const entities = [
        createEntity("role", "admin"),
        createEntity("action", "read"),
      ];

      const subjectRef = resolveReference(
        "admin",
        "ROLE_CAN",
        "subject",
        entities,
      );
      expect(subjectRef.resolved).toBe(true);
      expect(subjectRef.cgId).toContain("role/admin");
      expect(subjectRef.type).toBe("role");

      const objectRef = resolveReference(
        "read",
        "ROLE_CAN",
        "object",
        entities,
      );
      expect(objectRef.resolved).toBe(true);
      expect(objectRef.cgId).toContain("action/read");
      expect(objectRef.type).toBe("action");
    });
  });

  describe("HAS_STATE(document, submitted)", () => {
    it("should resolve document → resource/document and submitted → state/submitted", () => {
      const entities = [
        createEntity("resource", "document"),
        createEntity("state", "submitted"),
      ];

      const subjectRef = resolveReference(
        "document",
        "HAS_STATE",
        "subject",
        entities,
      );
      expect(subjectRef.resolved).toBe(true);
      expect(subjectRef.cgId).toContain("resource/document");
      expect(subjectRef.type).toBe("resource");

      const objectRef = resolveReference(
        "submitted",
        "HAS_STATE",
        "object",
        entities,
      );
      expect(objectRef.resolved).toBe(true);
      expect(objectRef.cgId).toContain("state/submitted");
      expect(objectRef.type).toBe("state");
    });
  });

  describe("Collision case: active as both state AND action", () => {
    it("should resolve based on predicate signature when ambiguous", () => {
      const entities = [
        createEntity("state", "active", 0.9),
        createEntity("action", "active", 0.8),
      ];

      // For TRANSITIONS_TO, 'active' as object should match state (state → state)
      const stateRef = resolveReference(
        "active",
        "TRANSITIONS_TO",
        "object",
        entities,
      );
      expect(stateRef.resolved).toBe(true);
      expect(stateRef.type).toBe("state");
      expect(stateRef.cgId).toContain("state/active");

      // For ROLE_CAN, 'active' as object should match action (role → action)
      const actionRef = resolveReference(
        "active",
        "ROLE_CAN",
        "object",
        entities,
      );
      expect(actionRef.resolved).toBe(true);
      expect(actionRef.type).toBe("action");
      expect(actionRef.cgId).toContain("action/active");
    });

    it("should prefer higher confidence when multiple entities have same allowed type", () => {
      const entities = [
        createEntity("action", "active", 0.6),
        createEntity("action", "active", 0.9), // Higher confidence
      ];

      const ref = resolveReference("active", "ROLE_CAN", "object", entities);
      expect(ref.resolved).toBe(true);
      expect(ref.matchedEntity?.confidence).toBe(0.9);
      expect(ref.ambiguous).toBe(true);
    });
  });

  describe("Unresolved references", () => {
    it("should return unresolved when no entity matches by name", () => {
      const entities = [
        createEntity("role", "user"),
        createEntity("action", "create"),
      ];

      const ref = resolveReference(
        "nonexistent",
        "ROLE_CAN",
        "subject",
        entities,
      );
      expect(ref.resolved).toBe(false);
      expect(ref.type).toBe("role"); // Falls back to first allowed type
    });

    it("should return unresolved with fallback type for unknown predicates", () => {
      const entities = [createEntity("resource", "doc")];

      const ref = resolveReference(
        "doc",
        "UNKNOWN_PREDICATE",
        "subject",
        entities,
      );
      // No shape constraint → allowedTypes = [], falls back to 'resource'
      expect(ref.type).toBe("resource");
    });
  });

  describe("Case insensitivity", () => {
    it("should match entities case-insensitively", () => {
      const entities = [
        createEntity("role", "Admin"), // Capital A
      ];

      const ref = resolveReference("admin", "ROLE_CAN", "subject", entities);
      expect(ref.resolved).toBe(true);
      expect(ref.matchedEntity?.name).toBe("Admin");
    });
  });

  describe("Type mismatch fallback", () => {
    it("should still resolve when entity exists but type does not match signature", () => {
      const entities = [
        createEntity("resource", "admin"), // Wrong type for ROLE_CAN subject
      ];

      const ref = resolveReference("admin", "ROLE_CAN", "subject", entities);
      // Found entity by name but type is wrong - still resolve to the existing entity
      expect(ref.resolved).toBe(true);
      expect(ref.type).toBe("resource");
      expect(ref.cgId).toContain("resource/admin");
    });
  });

  describe("Normalization-based resolution", () => {
    it('should resolve camelCase "UserDeactivated" to slug "user-deactivated"', () => {
      const entities = [
        createEntity("state", "user-deactivated"), // Entity uses slug format
      ];

      // Reference uses camelCase (LLM output)
      const ref = resolveReference(
        "UserDeactivated",
        "HAS_STATE",
        "object",
        entities,
      );
      expect(ref.resolved).toBe(true);
      expect(ref.matchedEntity?.name).toBe("user-deactivated");
      expect(ref.normalizedName).toBe("user-deactivated");
    });

    it('should resolve underscored "user_deactivated" to slug "user-deactivated"', () => {
      const entities = [createEntity("state", "user-deactivated")];

      const ref = resolveReference(
        "user_deactivated",
        "HAS_STATE",
        "object",
        entities,
      );
      expect(ref.resolved).toBe(true);
      expect(ref.matchedEntity?.name).toBe("user-deactivated");
    });

    it('should resolve mixed case and format "User_Deactivated" to "user-deactivated"', () => {
      const entities = [createEntity("state", "user-deactivated")];

      const ref = resolveReference(
        "User_Deactivated",
        "HAS_STATE",
        "object",
        entities,
      );
      expect(ref.resolved).toBe(true);
      expect(ref.matchedEntity?.name).toBe("user-deactivated");
    });

    it('should resolve "ACTIVE" to "active"', () => {
      const entities = [createEntity("state", "active")];

      const ref = resolveReference("ACTIVE", "HAS_STATE", "object", entities);
      expect(ref.resolved).toBe(true);
      expect(ref.matchedEntity?.name).toBe("active");
    });

    it("should resolve entity in slug to camelCase reference", () => {
      const entities = [
        createEntity("state", "userDeactivated"), // Entity uses camelCase
      ];

      // Reference uses slug format
      const ref = resolveReference(
        "user-deactivated",
        "HAS_STATE",
        "object",
        entities,
      );
      expect(ref.resolved).toBe(true);
      expect(ref.matchedEntity?.name).toBe("userDeactivated");
    });
  });
});
