// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Weave Module Tests
 *
 * Tests for normalization, ID generation, evidence, registry, and executor.
 */

import { describe, it, expect } from "vitest";
import {
  // Normalization
  NORMALIZATION_VERSION,
  normalizeName,
  normalizePredicate,
  isDeprecatedPredicate,
  buildCanonicalKey,
  parseCanonicalKey,
  generateStableCgId,
  generateCanonicalId,
  generateCanonicalStatementId,

  // Evidence
  generateEvidenceId,
  generateEvidenceLogicalKey,
  createFileEvidence,
  createIwEvidence,
  deduplicateEvidence,
  mergeEvidenceIds,
  sanitizeExcerpt,

  // Registry
  createEmptyRegistry,
  resolveCanonicalKey,
  resolveToCanonicalId,
  addAlias,
  deprecateCanonical,
  isDeprecated,

  // Executor
  executeWeave,
  type RawEntity,
  type RawStatement,
  type EvidenceRecord,
} from "../weave";

// =============================================================================
// Normalization Tests
// =============================================================================

describe("normalizeName", () => {
  it("normalizes basic names", () => {
    expect(normalizeName("Session State")).toBe("session_state");
    expect(normalizeName("  Foo   Bar  ")).toBe("foo_bar");
    expect(normalizeName("The-User-Profile")).toBe("the_user_profile");
  });

  it("removes punctuation except allowed chars", () => {
    expect(normalizeName("User's Profile")).toBe("users_profile");
    expect(normalizeName("path/to/resource")).toBe("path/to/resource");
    expect(normalizeName("snake_case_name")).toBe("snake_case_name");
  });

  it("handles edge cases", () => {
    expect(normalizeName("")).toBe("unnamed");
    expect(normalizeName("   ")).toBe("unnamed");
    expect(normalizeName("___")).toBe("unnamed");
  });

  it("removes stopwords when requested", () => {
    expect(normalizeName("The User Profile", { removeStopwords: true })).toBe(
      "user_profile",
    );
    expect(normalizeName("A and B", { removeStopwords: true })).toBe("b");
  });
});

describe("normalizePredicate", () => {
  it("normalizes predicate format", () => {
    expect(normalizePredicate("hasState")).toBe("HAS_STATE");
    expect(normalizePredicate("depends-on")).toBe("REQUIRES");
    expect(normalizePredicate("HAS_STATUS")).toBe("HAS_STATE");
  });

  it("applies alias table", () => {
    expect(normalizePredicate("IMPLEMENTS")).toBe("REALIZES");
    expect(normalizePredicate("SATISFIES")).toBe("REALIZES");
    expect(normalizePredicate("MENTIONS")).toBe("REFERENCES");
  });

  it("preserves unknown predicates", () => {
    expect(normalizePredicate("CUSTOM_PREDICATE")).toBe("CUSTOM_PREDICATE");
    expect(normalizePredicate("my-predicate")).toBe("MY_PREDICATE");
  });
});

describe("isDeprecatedPredicate", () => {
  it("identifies deprecated predicates", () => {
    expect(isDeprecatedPredicate("HAS_STATUS")).toBe(true);
    expect(isDeprecatedPredicate("IMPLEMENTS")).toBe(true);
    expect(isDeprecatedPredicate("HAS_STATE")).toBe(false);
    expect(isDeprecatedPredicate("CUSTOM")).toBe(false);
  });
});

// =============================================================================
// Canonical Key Tests
// =============================================================================

describe("buildCanonicalKey", () => {
  it("builds canonical key with version", () => {
    const key = buildCanonicalKey({
      role: "spec",
      type: "rule",
      name: "Promotion Criteria",
    });
    expect(key).toBe(`${NORMALIZATION_VERSION}|spec|rule|promotion_criteria`);
  });

  it("normalizes names in key", () => {
    const key = buildCanonicalKey({
      role: "intent",
      type: "state",
      name: "  Session   State  ",
    });
    expect(key).toContain("|session_state");
  });
});

describe("parseCanonicalKey", () => {
  it("parses valid canonical keys", () => {
    const parsed = parseCanonicalKey(
      `${NORMALIZATION_VERSION}|spec|rule|promotion_criteria`,
    );
    expect(parsed).toEqual({
      version: NORMALIZATION_VERSION,
      role: "spec",
      type: "rule",
      normalizedName: "promotion_criteria",
    });
  });

  it("returns null for invalid keys", () => {
    expect(parseCanonicalKey("invalid")).toBeNull();
    expect(parseCanonicalKey("a|b|c")).toBeNull();
    expect(parseCanonicalKey("a|b|c|d|e")).toBeNull();
  });
});

// =============================================================================
// ID Generation Tests
// =============================================================================

describe("generateStableCgId", () => {
  it("generates stable IDs for same input", () => {
    const id1 = generateStableCgId({
      artifactId: "docs/README",
      artifactRole: "spec",
      type: "resource",
      name: "User Profile",
    });
    const id2 = generateStableCgId({
      artifactId: "docs/README",
      artifactRole: "spec",
      type: "resource",
      name: "User Profile",
    });
    expect(id1).toBe(id2);
  });

  it("generates different IDs for different artifacts", () => {
    const id1 = generateStableCgId({
      artifactId: "docs/A",
      artifactRole: "spec",
      type: "resource",
      name: "Foo",
    });
    const id2 = generateStableCgId({
      artifactId: "docs/B",
      artifactRole: "spec",
      type: "resource",
      name: "Foo",
    });
    expect(id1).not.toBe(id2);
  });

  it("normalizes names before hashing", () => {
    const id1 = generateStableCgId({
      artifactId: "docs/A",
      artifactRole: "spec",
      type: "state",
      name: "Session State",
    });
    const id2 = generateStableCgId({
      artifactId: "docs/A",
      artifactRole: "spec",
      type: "state",
      name: "  session   state  ",
    });
    expect(id1).toBe(id2);
  });

  it("supports ordinal for disambiguation", () => {
    const id1 = generateStableCgId({
      artifactId: "docs/A",
      artifactRole: "spec",
      type: "state",
      name: "Foo",
      ordinal: 0,
    });
    const id2 = generateStableCgId({
      artifactId: "docs/A",
      artifactRole: "spec",
      type: "state",
      name: "Foo",
      ordinal: 1,
    });
    expect(id1).not.toBe(id2);
  });
});

describe("generateCanonicalId", () => {
  it("generates deterministic IDs from canonical keys", () => {
    const key = `${NORMALIZATION_VERSION}|spec|rule|promotion_criteria`;
    const id1 = generateCanonicalId(key);
    const id2 = generateCanonicalId(key);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^ce_[a-f0-9]{16}$/);
  });

  it("generates different IDs for different keys", () => {
    const id1 = generateCanonicalId(`${NORMALIZATION_VERSION}|spec|rule|foo`);
    const id2 = generateCanonicalId(`${NORMALIZATION_VERSION}|spec|rule|bar`);
    expect(id1).not.toBe(id2);
  });
});

describe("generateCanonicalStatementId", () => {
  it("generates deterministic statement IDs", () => {
    const id1 = generateCanonicalStatementId({
      subjectCanonicalId: "ce_abc123",
      predicate: "HAS_STATE",
      objectCanonicalId: "ce_def456",
    });
    const id2 = generateCanonicalStatementId({
      subjectCanonicalId: "ce_abc123",
      predicate: "hasState", // Will be normalized
      objectCanonicalId: "ce_def456",
    });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cs_[a-f0-9]{16}$/);
  });

  it("handles literal objects", () => {
    const id = generateCanonicalStatementId({
      subjectCanonicalId: "ce_abc123",
      predicate: "HAS_VALUE",
      objectLiteral: "42",
    });
    expect(id).toMatch(/^cs_[a-f0-9]{16}$/);
  });
});

// =============================================================================
// Evidence Tests
// =============================================================================

describe("createFileEvidence", () => {
  it("creates file evidence with all fields", () => {
    const evidence = createFileEvidence({
      artifactId: "docs/README",
      artifactVersionId: "abc123",
      filePath: "docs/README.md",
      lineStart: 10,
      lineEnd: 15,
      byteStart: 100,
      byteEnd: 200,
      excerpt: "This is the excerpt text.",
    });

    expect(evidence.kind).toBe("file");
    expect(evidence.ref.artifactId).toBe("docs/README");
    expect(evidence.locator?.lineStart).toBe(10);
    expect(evidence.excerpt).toBe("This is the excerpt text.");
    expect(evidence.id).toMatch(/^ev_[a-f0-9]+$/);
    expect(evidence.logicalKey).toBeDefined();
  });

  it("truncates long excerpts", () => {
    const longExcerpt = "x".repeat(500);
    const evidence = createFileEvidence({
      artifactId: "docs/A",
      filePath: "docs/A.md",
      excerpt: longExcerpt,
      policy: { maxExcerptChars: 100, sanitizeSecrets: false, allowCode: true },
    });

    expect(evidence.excerpt.length).toBeLessThanOrEqual(100);
    expect(evidence.excerpt.endsWith("...")).toBe(true);
  });
});

describe("createIwEvidence", () => {
  it("creates IW evidence for transcripts", () => {
    const evidence = createIwEvidence({
      artifactId: "chat:specstory:abc",
      sourceKey: "specstory:abc:m:42",
      seq: 42,
      excerpt: "User said something.",
    });

    expect(evidence.kind).toBe("iw");
    expect(evidence.sourceKey).toBe("specstory:abc:m:42");
    expect(evidence.seq).toBe(42);
    expect(evidence.ref.uri).toContain("iw://artifact/");
  });
});

describe("deduplicateEvidence", () => {
  it("deduplicates by physical ID", () => {
    const ev1 = createFileEvidence({
      artifactId: "docs/A",
      filePath: "docs/A.md",
      excerpt: "Same text",
    });
    const ev2 = { ...ev1 }; // Same ID

    const { deduplicated } = deduplicateEvidence([ev1, ev2]);
    expect(deduplicated).toHaveLength(1);
  });

  it("tracks superseded evidence by logical key", () => {
    const ev1 = createFileEvidence({
      artifactId: "docs/A",
      artifactVersionId: "v1",
      filePath: "docs/A.md",
      byteStart: 0,
      byteEnd: 10,
      excerpt: "Same text",
    });
    const ev2 = createFileEvidence({
      artifactId: "docs/A",
      artifactVersionId: "v2",
      filePath: "docs/A.md",
      byteStart: 5, // Shifted
      byteEnd: 15,
      excerpt: "Same text",
    });

    // Same logical key, different physical IDs
    expect(ev1.logicalKey).toBe(ev2.logicalKey);
    expect(ev1.id).not.toBe(ev2.id);

    const { deduplicated, superseded } = deduplicateEvidence([ev1, ev2]);
    expect(deduplicated).toHaveLength(1);
    expect(superseded.size).toBe(1);
  });
});

describe("mergeEvidenceIds", () => {
  it("merges and deduplicates ID arrays", () => {
    const result = mergeEvidenceIds(
      ["ev_a", "ev_b", "ev_c"],
      ["ev_b", "ev_d"],
      ["ev_a", "ev_e"],
    );
    expect(result).toEqual(["ev_a", "ev_b", "ev_c", "ev_d", "ev_e"]);
  });
});

describe("sanitizeExcerpt", () => {
  it("redacts API keys", () => {
    const input = "api_key: sk_live_abc123def456ghi789";
    const result = sanitizeExcerpt(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk_live");
  });

  it("redacts bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const result = sanitizeExcerpt(input);
    expect(result).toContain("[REDACTED]");
  });

  it("preserves safe content", () => {
    const input = "This is normal documentation text.";
    const result = sanitizeExcerpt(input);
    expect(result).toBe(input);
  });
});

// =============================================================================
// Registry Tests
// =============================================================================

describe("Registry alias resolution", () => {
  it("resolves direct aliases", () => {
    const registry = addAlias(
      createEmptyRegistry(),
      "norm-v1|spec|rule|session_state",
      "norm-v1|spec|rule|sessionstate",
    );

    const resolved = resolveCanonicalKey(
      "norm-v1|spec|rule|session_state",
      registry,
    );
    expect(resolved).toBe("norm-v1|spec|rule|sessionstate");
  });

  it("resolves alias chains", () => {
    let registry = createEmptyRegistry();
    registry = addAlias(registry, "key_a", "key_b");
    registry = addAlias(registry, "key_b", "key_c");

    const resolved = resolveCanonicalKey("key_a", registry);
    expect(resolved).toBe("key_c");
  });

  it("returns original key if no alias", () => {
    const registry = createEmptyRegistry();
    const resolved = resolveCanonicalKey("norm-v1|spec|rule|foo", registry);
    expect(resolved).toBe("norm-v1|spec|rule|foo");
  });
});

describe("resolveToCanonicalId", () => {
  it("resolves through aliases to canonical ID", () => {
    const registry = addAlias(
      createEmptyRegistry(),
      "norm-v1|spec|rule|old_name",
      "norm-v1|spec|rule|new_name",
    );

    const id1 = resolveToCanonicalId("norm-v1|spec|rule|old_name", registry);
    const id2 = resolveToCanonicalId("norm-v1|spec|rule|new_name", registry);

    // Both should resolve to the same canonical ID
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^ce_[a-f0-9]{16}$/);
  });
});

describe("deprecation", () => {
  it("marks canonical IDs as deprecated", () => {
    const registry = deprecateCanonical(
      createEmptyRegistry(),
      "ce_abc123",
      "split",
      ["ce_def456", "ce_ghi789"],
    );

    const status = isDeprecated("ce_abc123", registry);
    expect(status.deprecated).toBe(true);
    expect(status.reason).toBe("split");
    expect(status.replacedBy).toEqual(["ce_def456", "ce_ghi789"]);
  });

  it("returns not deprecated for unknown IDs", () => {
    const registry = createEmptyRegistry();
    const status = isDeprecated("ce_unknown", registry);
    expect(status.deprecated).toBe(false);
  });
});

// =============================================================================
// Executor Tests
// =============================================================================

describe("executeWeave", () => {
  // Helper to create raw entities
  function createRawEntity(overrides: Partial<RawEntity>): RawEntity {
    return {
      cgId: `cg_${Math.random().toString(36).slice(2, 10)}`,
      artifactId: "docs/README",
      artifactRole: "spec",
      type: "resource",
      name: "TestEntity",
      evidenceIds: [],
      ...overrides,
    };
  }

  // Helper to create raw statements
  function createRawStatement(overrides: Partial<RawStatement>): RawStatement {
    return {
      id: `stmt_${Math.random().toString(36).slice(2, 10)}`,
      subjectCgId: "cg_subject",
      predicate: "HAS_STATE",
      evidenceIds: [],
      ...overrides,
    };
  }

  describe("entity merging", () => {
    it("merges entities with same name and type within same role", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a", artifactId: "docs/A", name: "User" }),
        createRawEntity({ cgId: "cg_b", artifactId: "docs/B", name: "User" }),
      ];

      const result = executeWeave({
        entities,
        statements: [],
        evidence: [],
      });

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].memberCgIds).toEqual(["cg_a", "cg_b"]);
      expect(result.entities[0].displayName).toBe("User");
    });

    it("keeps entities with different names separate", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a", name: "User" }),
        createRawEntity({ cgId: "cg_b", name: "Profile" }),
      ];

      const result = executeWeave({
        entities,
        statements: [],
        evidence: [],
      });

      expect(result.entities).toHaveLength(2);
    });

    it("keeps entities with different types separate", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a", name: "Active", type: "state" }),
        createRawEntity({ cgId: "cg_b", name: "Active", type: "action" }),
      ];

      const result = executeWeave({
        entities,
        statements: [],
        evidence: [],
      });

      expect(result.entities).toHaveLength(2);
    });

    it("keeps entities with different roles separate (Phase 1)", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a", artifactRole: "spec", name: "User" }),
        createRawEntity({
          cgId: "cg_b",
          artifactRole: "implementation",
          name: "User",
        }),
      ];

      const result = executeWeave(
        {
          entities,
          statements: [],
          evidence: [],
          registry: createEmptyRegistry(),
        },
        { sameRoleOnly: true },
      );

      expect(result.entities).toHaveLength(2);
    });
  });

  describe("statement remapping", () => {
    it("remaps statements to canonical IDs", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_user", name: "User" }),
        createRawEntity({ cgId: "cg_active", name: "Active", type: "state" }),
      ];
      const statements: RawStatement[] = [
        createRawStatement({
          subjectCgId: "cg_user",
          predicate: "HAS_STATE",
          objectCgId: "cg_active",
        }),
      ];

      const result = executeWeave({
        entities,
        statements,
        evidence: [],
      });

      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].subjectCanonicalId).toMatch(/^ce_/);
      expect(result.statements[0].objectCanonicalId).toMatch(/^ce_/);
      expect(result.statements[0].predicate).toBe("HAS_STATE");
    });

    it("deduplicates statements with same subject/predicate/object", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a1", artifactId: "docs/A", name: "User" }),
        createRawEntity({ cgId: "cg_a2", artifactId: "docs/B", name: "User" }),
        createRawEntity({
          cgId: "cg_b1",
          artifactId: "docs/A",
          name: "Active",
          type: "state",
        }),
        createRawEntity({
          cgId: "cg_b2",
          artifactId: "docs/B",
          name: "Active",
          type: "state",
        }),
      ];
      const statements: RawStatement[] = [
        createRawStatement({
          id: "stmt_1",
          subjectCgId: "cg_a1",
          predicate: "HAS_STATE",
          objectCgId: "cg_b1",
          evidenceIds: ["ev_1"],
        }),
        createRawStatement({
          id: "stmt_2",
          subjectCgId: "cg_a2",
          predicate: "hasState", // Different case, should normalize
          objectCgId: "cg_b2",
          evidenceIds: ["ev_2"],
        }),
      ];

      const result = executeWeave({
        entities,
        statements,
        evidence: [],
      });

      // Entities merge: User (2 -> 1), Active (2 -> 1)
      expect(result.entities).toHaveLength(2);

      // Statements dedupe: both point to same canonicals
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].memberStmtIds).toEqual(["stmt_1", "stmt_2"]);
      expect(result.statements[0].evidenceIds).toEqual(["ev_1", "ev_2"]);
    });

    it("normalizes predicates in statements", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a", name: "A" }),
        createRawEntity({ cgId: "cg_b", name: "B" }),
      ];
      const statements: RawStatement[] = [
        createRawStatement({
          subjectCgId: "cg_a",
          predicate: "depends-on",
          objectCgId: "cg_b",
        }),
      ];

      const result = executeWeave({
        entities,
        statements,
        evidence: [],
      });

      expect(result.statements[0].predicate).toBe("REQUIRES");
    });
  });

  describe("evidence merging", () => {
    it("merges evidence IDs when entities merge", () => {
      const entities: RawEntity[] = [
        createRawEntity({
          cgId: "cg_a",
          artifactId: "docs/A",
          name: "User",
          evidenceIds: ["ev_1", "ev_2"],
        }),
        createRawEntity({
          cgId: "cg_b",
          artifactId: "docs/B",
          name: "User",
          evidenceIds: ["ev_3", "ev_4"],
        }),
      ];

      const result = executeWeave({
        entities,
        statements: [],
        evidence: [],
      });

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].evidenceIds).toEqual([
        "ev_1",
        "ev_2",
        "ev_3",
        "ev_4",
      ]);
    });
  });

  describe("conflict detection", () => {
    it("detects type mismatch conflicts", () => {
      // This shouldn't happen in practice (different types = different groups)
      // But if the name normalization creates collision, we should detect it
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a", name: "Active", type: "state" }),
        createRawEntity({ cgId: "cg_b", name: "Active", type: "action" }),
      ];

      const result = executeWeave({
        entities,
        statements: [],
        evidence: [],
      });

      // With Phase 1, different types are in different groups, so no conflict
      expect(result.entities).toHaveLength(2);
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe("stats tracking", () => {
    it("tracks merge statistics", () => {
      const entities: RawEntity[] = [
        createRawEntity({ cgId: "cg_a", artifactId: "docs/A", name: "User" }),
        createRawEntity({ cgId: "cg_b", artifactId: "docs/B", name: "User" }),
        createRawEntity({
          cgId: "cg_c",
          artifactId: "docs/C",
          name: "Profile",
        }),
      ];
      const statements: RawStatement[] = [
        createRawStatement({ subjectCgId: "cg_a", objectCgId: "cg_c" }),
        createRawStatement({ subjectCgId: "cg_b", objectCgId: "cg_c" }),
      ];

      const result = executeWeave({
        entities,
        statements,
        evidence: [],
      });

      expect(result.stats.rawEntityCount).toBe(3);
      expect(result.stats.rawStatementCount).toBe(2);
      expect(result.stats.canonicalEntityCount).toBe(2); // User + Profile
      expect(result.stats.canonicalStatementCount).toBe(1); // Deduplicated
      expect(result.stats.mergedEntityGroups).toBe(2);
    });
  });

  describe("determinism", () => {
    it("produces same output for same input (rerun stability)", () => {
      const entities: RawEntity[] = [
        createRawEntity({
          cgId: "cg_fixed_a",
          artifactId: "docs/A",
          name: "User",
        }),
        createRawEntity({
          cgId: "cg_fixed_b",
          artifactId: "docs/B",
          name: "User",
        }),
      ];

      const result1 = executeWeave({ entities, statements: [], evidence: [] });
      const result2 = executeWeave({ entities, statements: [], evidence: [] });

      expect(result1.entities[0].canonicalId).toBe(
        result2.entities[0].canonicalId,
      );
      expect(result1.entities[0].key).toBe(result2.entities[0].key);
    });
  });
});
