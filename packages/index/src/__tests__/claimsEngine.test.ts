// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { ClaimsEngine } from "../claims/engine.js";
import { materialFingerprint, fingerprint } from "../claims/canonical.js";
import { ClaimsStore } from "../claims/store.js";
import { initSchema } from "../schema.js";

describe("ClaimsEngine", () => {
  let db: Database.Database;
  let store: ClaimsStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new ClaimsStore(db);
  });
  afterEach(() => db.close());

  function evidence(
    identityKey: string,
    value: string | number | boolean | null,
  ) {
    return store.persistEvidence({
      parameterKey: "session.timeout",
      sourceKind: "fixture",
      identityKey,
      fingerprint: fingerprint({ identityKey, value }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: "session.timeout",
        semanticLocation: identityKey,
        normalizedValue: value,
      }),
      normalizedValue: value,
      semanticLocation: identityKey,
      provenance: {},
    });
  }

  const contracts = {
    r1RuleContractVersion: "r1-v1",
    r3RuleContractVersion: "r3-v1",
    r7RuleContractVersion: "r7-v1",
    implementationFingerprint: "impl-v1",
    literalPolicyVersion: "v1",
    defaultPolicyVersion: "v1",
    runtimePolicyVersion: "v1",
    documentationPolicyVersion: "v1",
  };

  it("materializes idempotent C0-style supported assessments", () => {
    const defaultValue = evidence("code-default", 1800);
    const annotation = evidence("code-annotation", 1800);
    const config = evidence("config-eu-prod", 3600);
    const documentation = evidence("doc-eu-prod", 3600);
    const scope = evidence("scope-eu-prod", "session-runtime");
    const engine = new ClaimsEngine(store);
    const input = {
      parameterKey: "session.timeout",
      scope: "eu-prod",
      repositoryRevision: "c0",
      codeDefault: { versionId: defaultValue.id, value: 1800 },
      codeAnnotation: { versionId: annotation.id, value: 1800 },
      configOverride: { versionId: config.id, value: 3600 },
      documentedOverride: { versionId: documentation.id, value: 3600 },
      scopeEvidence: { versionId: scope.id, capabilities: ["session-runtime"] },
      contracts,
    };

    const first = engine.evaluateScope(input);
    const repeated = engine.evaluateScope(input);
    const statuses = db
      .prepare(
        `SELECT epistemic_status FROM claim_assessments ORDER BY claim_version_id`,
      )
      .all() as Array<{ epistemic_status: string }>;

    expect(first.ruleResults).toHaveLength(4);
    expect(first.assessments).toHaveLength(3);
    expect(repeated.ruleResults.every((result) => !result.created)).toBe(true);
    expect(
      repeated.assessments.every((assessment) => !assessment.created),
    ).toBe(true);
    expect(statuses).toEqual([
      { epistemic_status: "supported" },
      { epistemic_status: "supported" },
      { epistemic_status: "supported" },
    ]);
  });

  it("persists a valid not-applicable R7 result without creating an effective claim", () => {
    const scope = evidence("scope-mobile", "static-preview");
    const result = new ClaimsEngine(store).evaluateScope({
      parameterKey: "session.timeout",
      scope: "mobile-preview",
      repositoryRevision: "c8",
      scopeEvidence: { versionId: scope.id, capabilities: ["static-preview"] },
      contracts,
    });

    expect(result.ruleResults).toHaveLength(2);
    expect(result.assessments).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM claim_identities WHERE claim_type = 'CLM-EFFECTIVE'`,
        )
        .get(),
    ).toMatchObject({ count: 0 });
  });

  it("refutes default documentation that disagrees with implemented evidence", () => {
    const codeDefault = evidence("code-default", "full");
    const documentedDefault = evidence("documented-default", "structured");

    const result = new ClaimsEngine(store).evaluateDefault({
      parameterKey: "cli.index-build.depth",
      repositoryRevision: "p-001",
      codeDefault: { versionId: codeDefault.id, value: "full" },
      documentedDefault: {
        versionId: documentedDefault.id,
        value: "structured",
      },
      contracts,
    });

    expect(result.ruleResults).toHaveLength(2);
    expect(result.assessments).toHaveLength(2);
    expect(
      db
        .prepare(
          `SELECT ci.claim_type, ca.epistemic_status
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           JOIN claim_identities ci ON ci.id = cv.claim_identity_id
           ORDER BY ci.claim_type`,
        )
        .all(),
    ).toEqual([
      { claim_type: "CLM-DEFAULT", epistemic_status: "supported" },
      { claim_type: "CLM-DOC-CONFORMANCE", epistemic_status: "refuted" },
    ]);
  });
});
