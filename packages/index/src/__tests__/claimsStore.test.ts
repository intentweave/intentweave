// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { ClaimsStore } from "../claims/store.js";
import { fingerprint, materialFingerprint } from "../claims/canonical.js";
import { initSchema } from "../schema.js";

describe("ClaimsStore", () => {
  let db: Database.Database;
  let store: ClaimsStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new ClaimsStore(db);
  });

  afterEach(() => db.close());

  it("deduplicates evidence fingerprints and increments changed versions", () => {
    const input = {
      parameterKey: "session.timeout",
      sourceKind: "code_default",
      identityKey: "src/session.ts:SESSION_TIMEOUT",
      normalizedValue: 1800,
      semanticLocation: "SESSION_TIMEOUT",
      provenance: { extractor: "claims-v1" },
    };
    const first = store.persistEvidence({
      ...input,
      fingerprint: fingerprint({ ...input, normalizedValue: 1800 }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: input.parameterKey,
        semanticLocation: input.semanticLocation,
        normalizedValue: 1800,
      }),
    });
    const repeated = store.persistEvidence({
      ...input,
      fingerprint: fingerprint({ ...input, normalizedValue: 1800 }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: input.parameterKey,
        semanticLocation: input.semanticLocation,
        normalizedValue: 1800,
      }),
    });
    const changed = store.persistEvidence({
      ...input,
      normalizedValue: 3600,
      fingerprint: fingerprint({ ...input, normalizedValue: 3600 }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: input.parameterKey,
        semanticLocation: input.semanticLocation,
        normalizedValue: 3600,
      }),
    });

    expect(first).toMatchObject({ ordinal: 1, created: true });
    expect(repeated).toEqual({ ...first, created: false });
    expect(changed).toMatchObject({ ordinal: 2, created: true });
  });

  it("links evidence versions with immutable-anchor provenance and binding lineage", () => {
    const before = store.persistEvidence({
      parameterKey: "session.timeout",
      sourceKind: "config",
      identityKey: "session.timeout:config:eu-prod:session.timeout",
      fingerprint: "before",
      materialFingerprint: "material-before",
      normalizedValue: 1800,
      semanticLocation: "session.timeout",
      provenance: { revision: "base" },
      repositoryRevision: "base",
    });
    const after = store.persistEvidence({
      parameterKey: "session.timeout",
      sourceKind: "config",
      identityKey: "session.timeout:config:eu-prod:session.timeout",
      fingerprint: "after",
      materialFingerprint: "material-after",
      normalizedValue: 3600,
      semanticLocation: "session.timeout",
      provenance: { revision: "head" },
      repositoryRevision: "head",
    });

    expect(
      store.persistEvidenceContinuity({
        fromEvidenceVersionId: before.id,
        toEvidenceVersionId: after.id,
        basis: "git-merge-base",
        confidence: "high",
        provenance: { base: "base", head: "head", materialChange: true },
      }),
    ).toBe(true);
    expect(
      store.persistEvidenceContinuity({
        fromEvidenceVersionId: before.id,
        toEvidenceVersionId: after.id,
        basis: "git-merge-base",
        confidence: "high",
        provenance: { base: "base", head: "head", materialChange: true },
      }),
    ).toBe(false);
    expect(
      db.prepare(`SELECT basis, confidence, provenance_json FROM evidence_continuity`).get(),
    ).toMatchObject({
      basis: "git-merge-base",
      confidence: "high",
      provenance_json: JSON.stringify({ base: "base", head: "head", materialChange: true }),
    });
    expect(
      db
        .prepare(
          `SELECT predecessor_binding_id FROM parameter_evidence_bindings
           WHERE evidence_version_id = ?`,
        )
        .get(after.id),
    ).toEqual({ predecessor_binding_id: expect.any(String) });
  });

  it("deduplicates normalized rule results and links their evidence", () => {
    const evidence = store.persistEvidence({
      parameterKey: "session.timeout",
      sourceKind: "config",
      identityKey: "config:session.timeout",
      fingerprint: "evidence-v1",
      materialFingerprint: "material-v1",
      normalizedValue: 1800,
      semanticLocation: "session.timeout",
      provenance: {},
    });
    const rule = {
      ruleId: "r3-effective-timeout",
      scope: "eu-prod",
      applicability: "applicable" as const,
      normalizedStatus: "passed" as const,
      normalizedOutput: { value: 1800 },
      normalizedReasons: ["config-present"],
      ruleContractVersion: "r3-v1",
      implementationFingerprint: "impl-v1",
    };

    const first = store.persistRuleResult(rule, [evidence.id]);
    const repeated = store.persistRuleResult(rule, [evidence.id]);
    const evidenceLinks = db
      .prepare(
        `SELECT evidence_version_id FROM rule_result_evidence
         WHERE rule_result_version_id = ?`,
      )
      .all(first.id) as Array<{ evidence_version_id: string }>;

    expect(first).toMatchObject({ ordinal: 1, created: true });
    expect(repeated).toEqual({ ...first, created: false });
    expect(evidenceLinks).toEqual([{ evidence_version_id: evidence.id }]);
  });

  it("versions claim statements and supersedes prior current assessments", () => {
    const dependencies = [
      {
        dependencyKind: "rule_result_version" as const,
        dependencyVersionId: "rule:r3@1",
        epistemicRole: "warrant" as const,
        warrantPolarity: "supports" as const,
        assessmentEffect: "supports" as const,
      },
    ];
    const first = store.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-EFFECTIVE",
      scope: "eu-prod",
      normalizedStatement: { value: 3600 },
      assessmentPolicyId: "runtime-resolution",
      assessmentPolicyVersion: "v1",
      repositoryRevision: "c0",
      status: "supported",
      dependencies,
    });
    const repeated = store.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-EFFECTIVE",
      scope: "eu-prod",
      normalizedStatement: { value: 3600 },
      assessmentPolicyId: "runtime-resolution",
      assessmentPolicyVersion: "v1",
      repositoryRevision: "c0",
      status: "supported",
      dependencies,
    });
    const changed = store.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-EFFECTIVE",
      scope: "eu-prod",
      normalizedStatement: { value: 5400 },
      assessmentPolicyId: "runtime-resolution",
      assessmentPolicyVersion: "v1",
      repositoryRevision: "c2",
      status: "supported",
      dependencies: [
        {
          ...dependencies[0],
          dependencyVersionId: "rule:r3@2",
        },
      ],
    });
    const assessments = db
      .prepare(
        `SELECT id, is_current, superseded_by_assessment_id
        FROM claim_assessments ORDER BY is_current ASC`,
      )
      .all() as Array<{
      id: string;
      is_current: number;
      superseded_by_assessment_id: string | null;
    }>;

    expect(repeated).toEqual({ ...first, created: false });
    expect(changed.claimVersionId).not.toBe(first.claimVersionId);
    expect(assessments).toEqual([
      {
        id: first.id,
        is_current: 0,
        superseded_by_assessment_id: changed.id,
      },
      {
        id: changed.id,
        is_current: 1,
        superseded_by_assessment_id: null,
      },
    ]);
  });
});