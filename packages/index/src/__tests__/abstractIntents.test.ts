// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import {
  AbstractIntentError,
  AbstractIntentStore,
} from "../claims/abstractIntents.js";
import { initSchema } from "../schema.js";

describe("Abstract Intent Anchors (G5.4 slice 2)", () => {
  let db: Database.Database;
  let intents: AbstractIntentStore;

  function insertClaim(id: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO claim_identities
         (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
       VALUES (?, 'param', 'parameter', 'repo', ?, 0)`,
    ).run(id, id);
  }

  function setAssessment(
    id: string,
    status: "supported" | "refuted" | "contested" | "inconclusive",
  ): void {
    db.prepare(
      `INSERT OR IGNORE INTO claim_versions
         (id, claim_identity_id, version_ordinal, normalized_statement_json,
          assessment_policy_id, assessment_policy_version, repository_revision, created_at)
       VALUES (?, ?, 1, '{}', 'policy', '1', 'rev', 1)`,
    ).run(`${id}:v1`, id);
    db.prepare(
      `INSERT INTO claim_assessments
         (id, claim_version_id, assessment_key, epistemic_status, repository_revision,
          reference_key, is_current, created_at)
       VALUES (?, ?, ?, ?, 'rev', NULL, 1, 0)`,
    ).run(
      `assessment:${id}:${status}`,
      `${id}:v1`,
      `key:${id}:${status}`,
      status,
    );
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    db.exec(
      `INSERT INTO parameter_identities (id, canonical_key, created_at) VALUES ('param', 'param', 0)`,
    );
    for (const id of [
      "claim:config-json",
      "claim:config-yaml",
      "claim:config-tests",
    ]) {
      insertClaim(id);
    }
    intents = new AbstractIntentStore(db);
  });

  afterEach(() => db.close());

  function realizeAll(key: string): void {
    for (const id of [
      "claim:config-json",
      "claim:config-yaml",
      "claim:config-tests",
    ]) {
      intents.realize({
        intentKey: key,
        claimIdentityId: id,
        actor: "reviewer",
        createdAt: 1,
      });
    }
  }

  it("refuses to protect an intent with no realizers, and an empty intent key", () => {
    expect(() =>
      intents.protect({ intentKey: "index-is-configurable", actor: "r" }),
    ).toThrow(/no realizers/);
    expect(() =>
      intents.realize({
        intentKey: " ",
        claimIdentityId: "claim:config-json",
        actor: "r",
      }),
    ).toThrow(AbstractIntentError);
  });

  it("is satisfied while the realizer set is unchanged and every realizer is supported", () => {
    realizeAll("index-is-configurable");
    intents.protect({
      intentKey: "index-is-configurable",
      actor: "r",
      createdAt: 5,
    });
    for (const id of [
      "claim:config-json",
      "claim:config-yaml",
      "claim:config-tests",
    ]) {
      setAssessment(id, "supported");
    }
    const results = intents.evaluate({ retiredClaimIds: new Set() });
    expect(results.map((r) => r.outcome)).toEqual(["satisfied"]);
  });

  it("reports a conflict when a realizer is added or removed", () => {
    realizeAll("index-is-configurable");
    const anchor = intents.protect({
      intentKey: "index-is-configurable",
      actor: "r",
      createdAt: 5,
    });
    insertClaim("claim:config-env");
    intents.realize({
      intentKey: "index-is-configurable",
      claimIdentityId: "claim:config-env",
      actor: "r",
    });
    const added = intents.evaluate({ retiredClaimIds: new Set() });
    expect(added.map((r) => r.outcome)).toEqual(["intent_conflict"]);
    expect(added[0]!.reason).toContain("realizer set changed");
    expect(anchor.realizers).toHaveLength(3);
  });

  it("reports a conflict when a realizer is refuted or retired", () => {
    realizeAll("index-is-configurable");
    intents.protect({
      intentKey: "index-is-configurable",
      actor: "r",
      createdAt: 5,
    });
    setAssessment("claim:config-json", "supported");
    setAssessment("claim:config-yaml", "refuted");
    setAssessment("claim:config-tests", "supported");
    const refuted = intents.evaluate({ retiredClaimIds: new Set() });
    expect(refuted.map((r) => r.outcome)).toEqual(["intent_conflict"]);
    expect(refuted[0]!.reason).toContain(
      "realizer claim:config-yaml is refuted",
    );
    const retired = intents.evaluate({
      retiredClaimIds: new Set(["claim:config-tests"]),
    });
    expect(retired[0]!.reason).toContain(
      "realizer claim:config-tests was retired",
    );
  });

  it("reports unresolved when a realizer has no decided assessment", () => {
    realizeAll("index-is-configurable");
    intents.protect({
      intentKey: "index-is-configurable",
      actor: "r",
      createdAt: 5,
    });
    setAssessment("claim:config-json", "supported");
    setAssessment("claim:config-yaml", "inconclusive");
    const results = intents.evaluate({ retiredClaimIds: new Set() });
    expect(results.map((r) => r.outcome)).toEqual(["intent_unresolved"]);
  });

  it("refuses to replace an active anchor without an amendment, and accepts one with it", () => {
    realizeAll("index-is-configurable");
    const first = intents.protect({
      intentKey: "index-is-configurable",
      actor: "r",
      createdAt: 5,
    });
    expect(() =>
      intents.protect({ intentKey: "index-is-configurable", actor: "r" }),
    ).toThrow(/already protected/);
    insertClaim("claim:config-env");
    intents.realize({
      intentKey: "index-is-configurable",
      claimIdentityId: "claim:config-env",
      actor: "r",
    });
    const amended = intents.protect({
      intentKey: "index-is-configurable",
      actor: "r",
      amendment: true,
      createdAt: 9,
    });
    expect(intents.anchor(first.id)?.status).toBe("superseded");
    expect(intents.active().map((a) => a.id)).toEqual([amended.id]);
    for (const id of [
      "claim:config-json",
      "claim:config-yaml",
      "claim:config-tests",
      "claim:config-env",
    ]) {
      setAssessment(id, "supported");
    }
    expect(
      intents.evaluate({ retiredClaimIds: new Set() }).map((r) => r.outcome),
    ).toEqual(["satisfied"]);
  });

  it("does not depend on the order in which realizers were recorded", () => {
    intents.realize({
      intentKey: "k",
      claimIdentityId: "claim:config-yaml",
      actor: "r",
    });
    intents.realize({
      intentKey: "k",
      claimIdentityId: "claim:config-json",
      actor: "r",
    });
    const anchor = intents.protect({ intentKey: "k", actor: "r" });
    const reordered = new AbstractIntentStore(db);
    expect(reordered.activeRealizers("k")).toEqual([
      "claim:config-json",
      "claim:config-yaml",
    ]);
    expect(anchor.realizers).toEqual([
      "claim:config-json",
      "claim:config-yaml",
    ]);
    expect(
      reordered.evaluate({ retiredClaimIds: new Set() }).map((r) => r.outcome),
    ).toEqual(["intent_unresolved"]);
  });

  it("imports a realization and an anchor from portable state, and keeps an existing one", () => {
    const realization = {
      id: "realization:one",
      intentKey: "k",
      claimIdentityId: "claim:config-json",
      status: "active" as const,
      actor: "r",
      createdAt: 1,
    };
    expect(intents.importRealization(realization)).toBe("imported");
    expect(intents.importRealization(realization)).toBe("present");
    expect(
      intents.importRealization({
        ...realization,
        id: "realization:two",
        claimIdentityId: "claim:missing",
      }),
    ).toBe("unknown_claim");
    const anchor = {
      id: "abstract-anchor:one",
      intentKey: "k",
      scope: "intent",
      realizerSetFingerprint: "x".repeat(64),
      realizers: ["claim:config-json"],
      authority: "human" as const,
      status: "active" as const,
      actor: "r",
      createdAt: 2,
    };
    expect(intents.importAnchor(anchor)).toBe("imported");
    expect(intents.importAnchor({ ...anchor, id: "abstract-anchor:two" })).toBe(
      "active_conflict",
    );
  });
});
