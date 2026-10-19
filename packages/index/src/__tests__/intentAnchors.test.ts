// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { fingerprint } from "../claims/canonical.js";
import { IntentAnchorStore } from "../claims/intentAnchors.js";
import { initSchema } from "../schema.js";

describe("IntentAnchorStore", () => {
  let db: Database.Database;
  let store: IntentAnchorStore;

  /** Insert a Claim identity with one version whose statement is `value`. */
  function insertClaim(
    identityId: string,
    value: unknown,
    ordinal = 1,
  ): string {
    const versionId = `${identityId}:v${ordinal}`;
    db.prepare(
      `INSERT OR IGNORE INTO claim_identities
         (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
       VALUES (?, 'param', 'parameter', 'repo', ?, 0)`,
    ).run(identityId, identityId);
    db.prepare(
      `INSERT INTO claim_versions
         (id, claim_identity_id, version_ordinal, normalized_statement_json,
          assessment_policy_id, assessment_policy_version, repository_revision, created_at)
       VALUES (?, ?, ?, ?, 'policy', '1', 'rev', ?)`,
    ).run(versionId, identityId, ordinal, JSON.stringify(value), ordinal);
    return versionId;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    db.exec(
      `INSERT INTO parameter_identities (id, canonical_key, created_at)
       VALUES ('param', 'param', 0)`,
    );
    store = new IntentAnchorStore(db);
  });

  afterEach(() => db.close());

  it("protects the current statement and records its fingerprint", () => {
    const versionId = insertClaim("claim:timeout", { value: 1800 });
    const anchor = store.protect({
      claimIdentityId: "claim:timeout",
      actor: "reviewer",
      createdAt: 10,
    });
    expect(anchor.claimVersionId).toBe(versionId);
    expect(anchor.statementFingerprint).toBe(fingerprint({ value: 1800 }));
    expect(anchor.authority).toBe("human");
    expect(anchor.status).toBe("active");
  });

  it("is satisfied while the statement is unchanged", () => {
    insertClaim("claim:timeout", { value: 1800 });
    store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    const results = store.evaluate({
      evaluatedClaimIds: new Set(["claim:timeout"]),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["satisfied"]);
  });

  it("reports a conflict when a newer version changes the statement", () => {
    insertClaim("claim:timeout", { value: 1800 });
    store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    insertClaim("claim:timeout", { value: 3600 }, 2);
    const results = store.evaluate({
      evaluatedClaimIds: new Set(["claim:timeout"]),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["intent_conflict"]);
  });

  it("reports a conflict when the anchored Claim is retired", () => {
    insertClaim("claim:timeout", { value: 1800 });
    store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    const results = store.evaluate({
      evaluatedClaimIds: new Set(),
      retiredClaimIds: new Set(["claim:timeout"]),
    });
    expect(results.map((r) => r.outcome)).toEqual(["intent_conflict"]);
  });

  it("reports unresolved, never a silent pass, when the Claim was not evaluated", () => {
    insertClaim("claim:timeout", { value: 1800 });
    store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    const results = store.evaluate({
      evaluatedClaimIds: new Set(),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["intent_unresolved"]);
  });

  it("supersedes the previous active anchor for the same Claim and scope", () => {
    insertClaim("claim:timeout", { value: 1800 });
    const first = store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    insertClaim("claim:timeout", { value: 3600 }, 2);
    const second = store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 20,
    });
    expect(store.get(first.id)?.status).toBe("superseded");
    expect(store.active("claim:timeout").map((a) => a.id)).toEqual([second.id]);
  });

  it("rejects a schema write that uses an unknown status", () => {
    insertClaim("claim:timeout", { value: 1800 });
    const anchor = store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    expect(() =>
      db
        .prepare(`UPDATE intent_anchors SET status = 'bogus' WHERE id = ?`)
        .run(anchor.id),
    ).toThrow();
  });

  /** Record the current assessment of the newest version of a Claim identity. */
  function setAssessment(
    claimIdentityId: string,
    status: "supported" | "refuted" | "contested" | "inconclusive",
  ): void {
    const version = store.latestVersion(claimIdentityId)!;
    db.prepare(
      `INSERT INTO claim_assessments
         (id, claim_version_id, assessment_key, epistemic_status, repository_revision,
          reference_key, is_current, created_at)
       VALUES (?, ?, ?, ?, 'rev', NULL, 1, 0)`,
    ).run(
      `assessment:${claimIdentityId}:${status}`,
      version.id,
      `key:${claimIdentityId}:${status}`,
      status,
    );
  }

  it("reports the current assessment status for conflict decisions", () => {
    insertClaim("claim:timeout", { value: 1800 });
    store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    setAssessment("claim:timeout", "refuted");
    expect(store.currentAssessmentStatus("claim:timeout")).toBe("refuted");
    const results = store.evaluate({
      evaluatedClaimIds: new Set(["claim:timeout"]),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["intent_conflict"]);
  });

  it("accepts an amendment: a new anchor supersedes the old one and is satisfied", () => {
    insertClaim("claim:timeout", { value: 1800 });
    const first = store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      createdAt: 10,
    });
    insertClaim("claim:timeout", { value: 3600 }, 2);
    setAssessment("claim:timeout", "supported");
    const amended = store.protect({
      claimIdentityId: "claim:timeout",
      actor: "r",
      rationale: "longer sessions are intended",
      scope: first.scope,
      createdAt: 20,
    });
    expect(store.get(first.id)?.status).toBe("superseded");
    expect(amended.statementFingerprint).toBe(fingerprint({ value: 3600 }));
    const results = store.evaluate({
      evaluatedClaimIds: new Set(["claim:timeout"]),
      retiredClaimIds: new Set(),
    });
    expect(results.map((r) => r.outcome)).toEqual(["satisfied"]);
  });
});
