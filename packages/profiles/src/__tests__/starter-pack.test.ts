// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for Starter Profile Pack
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { loadProfilePack, validateProfilePack } from "../loader.js";

const STARTER_PACK_PATH = path.join(__dirname, "../../packs/starter/v1");

describe("Starter Profile Pack", () => {
  it("loads successfully", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    expect(pack.meta.name).toBe("starter");
    expect(pack.meta.version).toBe("1.0.0");
  });

  it("has required kinds", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    const kindIds = pack.kinds.map((k) => k.id);

    // Core kinds
    expect(kindIds).toContain("resource");
    expect(kindIds).toContain("state");
    expect(kindIds).toContain("action");
    expect(kindIds).toContain("event");
    expect(kindIds).toContain("role");

    // Structural kinds
    expect(kindIds).toContain("service");
    expect(kindIds).toContain("endpoint");

    // Flow kinds
    expect(kindIds).toContain("transition");
  });

  it("has shapes for core kinds", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    const subjects = pack.shapes.map((s) => s.subject);

    expect(subjects).toContain("role");
    expect(subjects).toContain("resource");
    expect(subjects).toContain("action");
    expect(subjects).toContain("transition");
    expect(subjects).toContain("service");
  });

  it("has linking rules", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    expect(pack.linkingRules.length).toBeGreaterThan(0);

    // Check for core linking rules
    const specToCode = pack.linkingRules.find(
      (r) => r.sourceRole === "spec" && r.targetRole === "code",
    );
    expect(specToCode).toBeDefined();
    expect(specToCode?.predicate).toBe("IMPLEMENTS");
  });

  it("has validation rules", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    expect(pack.rules.length).toBeGreaterThan(0);

    // Check for completeness rules
    const completenessRules = pack.rules.filter((r) =>
      r.id.startsWith("completeness-"),
    );
    expect(completenessRules.length).toBeGreaterThan(0);

    // Check for consistency rules
    const consistencyRules = pack.rules.filter((r) =>
      r.id.startsWith("consistency-"),
    );
    expect(consistencyRules.length).toBeGreaterThan(0);
  });

  it("passes validation", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH, { validate: false });

    expect(() => validateProfilePack(pack)).not.toThrow();
  });

  it("has all shape subjects as defined kinds", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH, { validate: false });

    const kindIds = new Set(pack.kinds.map((k) => k.id));

    for (const shape of pack.shapes) {
      expect(kindIds.has(shape.subject)).toBe(true);

      for (const pred of shape.predicates) {
        for (const target of pred.targets) {
          expect(kindIds.has(target)).toBe(true);
        }
      }
    }
  });

  it("has proper transition shape with required predicates", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    const transitionShape = pack.shapes.find((s) => s.subject === "transition");
    expect(transitionShape).toBeDefined();

    const fromState = transitionShape?.predicates.find(
      (p) => p.name === "FROM_STATE",
    );
    const toState = transitionShape?.predicates.find(
      (p) => p.name === "TO_STATE",
    );

    expect(fromState?.required).toBe(true);
    expect(toState?.required).toBe(true);
  });

  it("has role-can shape", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    const roleShape = pack.shapes.find((s) => s.subject === "role");
    expect(roleShape).toBeDefined();

    const canPredicate = roleShape?.predicates.find((p) => p.name === "CAN");
    expect(canPredicate).toBeDefined();
    expect(canPredicate?.targets).toContain("action");
  });

  it("has resource-has_state shape", async () => {
    const pack = await loadProfilePack(STARTER_PACK_PATH);

    const resourceShape = pack.shapes.find((s) => s.subject === "resource");
    expect(resourceShape).toBeDefined();

    const hasStatePredicate = resourceShape?.predicates.find(
      (p) => p.name === "HAS_STATE",
    );
    expect(hasStatePredicate).toBeDefined();
    expect(hasStatePredicate?.targets).toContain("state");
  });
});
