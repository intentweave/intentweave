// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import {
  ClaimRelationError,
  ClaimRelationStore,
} from "../claims/claimRelations.js";
import { IntentAnchorStore } from "../claims/intentAnchors.js";
import { initSchema } from "../schema.js";

describe("Claim Relations (G5.4 slice 2)", () => {
  let db: Database.Database;
  let relations: ClaimRelationStore;
  let anchors: IntentAnchorStore;

  function insertClaim(identityId: string, value: unknown): void {
    db.prepare(
      `INSERT OR IGNORE INTO claim_identities
         (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
       VALUES (?, 'param', 'parameter', 'repo', ?, 0)`,
    ).run(identityId, identityId);
    db.prepare(
      `INSERT INTO claim_versions
         (id, claim_identity_id, version_ordinal, normalized_statement_json,
          assessment_policy_id, assessment_policy_version, repository_revision, created_at)
       VALUES (?, ?, 1, ?, 'policy', '1', 'rev', 1)`,
    ).run(`${identityId}:v1`, identityId, JSON.stringify(value));
  }

  function setAssessment(
    identityId: string,
    status: "supported" | "refuted" | "contested" | "inconclusive",
  ): void {
    db.prepare(
      `INSERT INTO claim_assessments
         (id, claim_version_id, assessment_key, epistemic_status, repository_revision,
          reference_key, is_current, created_at)
       VALUES (?, ?, ?, ?, 'rev', NULL, 1, 0)`,
    ).run(
      `assessment:${identityId}:${status}`,
      `${identityId}:v1`,
      `key:${identityId}:${status}`,
      status,
    );
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    db.exec(
      `INSERT INTO parameter_identities (id, canonical_key, created_at)
       VALUES ('param', 'param', 0)`,
    );
    relations = new ClaimRelationStore(db);
    anchors = new IntentAnchorStore(db);
    for (const id of ["claim:design", "claim:impl", "claim:other"]) {
      insertClaim(id, { value: 1800 });
    }
  });

  afterEach(() => db.close());

  it("records a realization and lists it as a realizer of the target", () => {
    relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "reviewer",
      createdAt: 10,
    });
    expect(relations.realizersOf("claim:design")).toEqual(["claim:impl"]);
    expect(relations.realizersOf("claim:impl")).toEqual([]);
  });

  it("refuses a self-edge, a duplicate active edge, and an unknown Claim", () => {
    expect(() =>
      relations.add({
        sourceClaimIdentityId: "claim:impl",
        targetClaimIdentityId: "claim:impl",
        relation: "refines",
        actor: "r",
      }),
    ).toThrow(ClaimRelationError);
    relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
    });
    expect(() =>
      relations.add({
        sourceClaimIdentityId: "claim:impl",
        targetClaimIdentityId: "claim:design",
        relation: "realizes",
        actor: "r",
      }),
    ).toThrow(/already exists/);
    expect(() =>
      relations.add({
        sourceClaimIdentityId: "claim:missing",
        targetClaimIdentityId: "claim:design",
        relation: "realizes",
        actor: "r",
      }),
    ).toThrow(/Unknown Claim identity/);
  });

  it("refuses a realization cycle, including a longer one", () => {
    relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
    });
    expect(() =>
      relations.add({
        sourceClaimIdentityId: "claim:design",
        targetClaimIdentityId: "claim:impl",
        relation: "refines",
        actor: "r",
      }),
    ).toThrow(/cycle/);
    relations.add({
      sourceClaimIdentityId: "claim:design",
      targetClaimIdentityId: "claim:other",
      relation: "realizes",
      actor: "r",
    });
    expect(() =>
      relations.add({
        sourceClaimIdentityId: "claim:other",
        targetClaimIdentityId: "claim:impl",
        relation: "realizes",
        actor: "r",
      }),
    ).toThrow(/cycle/);
  });

  it("allows a constrains edge that would close a loop, because it does not realize", () => {
    relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
    });
    expect(() =>
      relations.add({
        sourceClaimIdentityId: "claim:design",
        targetClaimIdentityId: "claim:impl",
        relation: "constrains",
        actor: "r",
      }),
    ).not.toThrow();
  });

  it("re-adds a retired edge under a new id", () => {
    const first = relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
      createdAt: 10,
    });
    relations.retire(first.id, 20);
    expect(relations.realizersOf("claim:design")).toEqual([]);
    const second = relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
      createdAt: 30,
    });
    expect(second.id).not.toBe(first.id);
    expect(relations.realizersOf("claim:design")).toEqual(["claim:impl"]);
  });

  it("keeps an anchor satisfied while its supported realizer holds", () => {
    relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
    });
    anchors.protect({
      claimIdentityId: "claim:design",
      actor: "r",
      createdAt: 5,
    });
    setAssessment("claim:design", "supported");
    setAssessment("claim:impl", "supported");
    const results = anchors.evaluate({
      evaluatedClaimIds: new Set(["claim:design"]),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["satisfied"]);
  });

  it("reports a conflict when a realizer is refuted, and unresolved when it has no assessment", () => {
    relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
    });
    anchors.protect({
      claimIdentityId: "claim:design",
      actor: "r",
      createdAt: 5,
    });
    setAssessment("claim:design", "supported");
    const undecided = anchors.evaluate({
      evaluatedClaimIds: new Set(["claim:design"]),
      retiredClaimIds: new Set(),
    });
    expect(undecided.map((r) => r.outcome)).toEqual(["intent_unresolved"]);
    setAssessment("claim:impl", "refuted");
    const refuted = anchors.evaluate({
      evaluatedClaimIds: new Set(["claim:design"]),
      retiredClaimIds: new Set(),
    });
    expect(refuted.map((r) => r.outcome)).toEqual(["intent_conflict"]);
    expect(refuted[0]!.reason).toContain("realizer claim:impl is refuted");
  });

  it("evaluates an anchor when only its realizer changed", () => {
    relations.add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "r",
    });
    anchors.protect({
      claimIdentityId: "claim:design",
      actor: "r",
      createdAt: 5,
    });
    setAssessment("claim:design", "supported");
    setAssessment("claim:impl", "supported");
    const results = anchors.evaluate({
      evaluatedClaimIds: new Set(["claim:impl"]),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["satisfied"]);
  });

  it("does not let a constrains edge change an anchor's outcome", () => {
    relations.add({
      sourceClaimIdentityId: "claim:other",
      targetClaimIdentityId: "claim:design",
      relation: "constrains",
      actor: "r",
    });
    anchors.protect({
      claimIdentityId: "claim:design",
      actor: "r",
      createdAt: 5,
    });
    setAssessment("claim:design", "supported");
    setAssessment("claim:other", "refuted");
    const results = anchors.evaluate({
      evaluatedClaimIds: new Set(["claim:design"]),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["satisfied"]);
  });
});
