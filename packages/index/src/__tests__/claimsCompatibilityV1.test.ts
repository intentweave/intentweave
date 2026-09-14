// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { materialFingerprint } from "../claims/canonical.js";
import { ClaimsStore } from "../claims/store.js";
import { initSchema } from "../schema.js";

const V1 = {
  parameterIdentity:
    "parameter:5a860a5ed7612f6812ad097808f8b989a555553cf999845c2a5166262e65978a",
  evidenceIdentity:
    "evidence:6d09f20fba39e578be032b6d174c30a0efc4271712852ac39c8648001eb9f500",
  evidenceVersion:
    "evidence:6d09f20fba39e578be032b6d174c30a0efc4271712852ac39c8648001eb9f500@1",
  materialFingerprint:
    "99102ebfcf67f4949e9c3c7c86f02921834c92ad08cd2b40c2dcf95030b1ce48",
  ruleResultIdentity:
    "rule-result:91debdb64ea9360e53fca562b9db60c8dd56bb1ec3fd77d24f597e323c13c7c0",
  ruleResultVersion:
    "rule-result:91debdb64ea9360e53fca562b9db60c8dd56bb1ec3fd77d24f597e323c13c7c0@1",
  ruleResultFingerprint:
    "f1a50757728c23242bf5eb6163c2c8f27054452a5aa565d818e6735e6c29101d",
  claimIdentity:
    "claim:7936f1a0e3f4283252273bd8eca32056f204bd25f8c23a5d9bc87ba08a79d99f",
  claimVersion:
    "claim:7936f1a0e3f4283252273bd8eca32056f204bd25f8c23a5d9bc87ba08a79d99f@1",
  assessmentKey:
    "72b1a34c68b76ed91f73bddbaf0b0bf890562e44a03a16a496b9fb272ccbaee8",
  assessment:
    "assessment:72b1a34c68b76ed91f73bddbaf0b0bf890562e44a03a16a496b9fb272ccbaee8",
} as const;

describe("Parameter Claims compatibility v1", () => {
  let database: Database.Database;
  let store: ClaimsStore;

  beforeEach(() => {
    database = new Database(":memory:");
    initSchema(database);
    store = new ClaimsStore(database);
  });

  afterEach(() => database.close());

  it("pins identity, version, material, rule, claim, and assessment vectors", () => {
    const material = materialFingerprint({
      parameterIdentity: "session.timeout",
      semanticLocation: "session.timeout",
      normalizedValue: 1800,
    });
    const evidence = store.persistEvidence({
      parameterKey: "session.timeout",
      sourceKind: "code-default",
      identityKey:
        "session.timeout:code-default:src/auth/session.ts:SESSION_TIMEOUT",
      fingerprint: "observation-v1",
      materialFingerprint: material,
      normalizedValue: 1800,
      semanticLocation: "session.timeout",
      filePath: "src/auth/session.ts",
      symbolId: "SESSION_TIMEOUT",
      repositoryRevision: "c0",
      provenance: { extractor: "r1-v1" },
    });
    const rule = store.persistRuleResult(
      {
        ruleId: "R1.literal-binding",
        subjectKey: "session.timeout",
        applicability: "applicable",
        normalizedStatus: "passed",
        normalizedOutput: { value: 1800 },
        normalizedReasons: ["literal-binding"],
        ruleContractVersion: "r1-v1",
        implementationFingerprint: "claims-engine-v1",
      },
      [evidence.id],
    );
    const assessment = store.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-DEFAULT",
      normalizedStatement: { value: 1800 },
      assessmentPolicyId: "default-contract",
      assessmentPolicyVersion: "default-contract-v1",
      repositoryRevision: "c0",
      status: "supported",
      dependencies: [
        {
          dependencyKind: "evidence_version",
          dependencyVersionId: evidence.id,
          epistemicRole: "assertion",
          warrantPolarity: null,
          assessmentEffect: "supports",
        },
        {
          dependencyKind: "rule_result_version",
          dependencyVersionId: rule.id,
          epistemicRole: "warrant",
          warrantPolarity: "supports",
          assessmentEffect: "supports",
        },
      ],
    });

    expect(material).toBe(V1.materialFingerprint);
    expect(evidence.id).toBe(V1.evidenceVersion);
    expect(rule.id).toBe(V1.ruleResultVersion);
    expect(assessment).toMatchObject({
      id: V1.assessment,
      claimIdentityId: V1.claimIdentity,
      claimVersionId: V1.claimVersion,
    });
    expect(
      database.prepare("SELECT id FROM parameter_identities").get(),
    ).toEqual({ id: V1.parameterIdentity });
    expect(
      database.prepare("SELECT id FROM evidence_identities").get(),
    ).toEqual({ id: V1.evidenceIdentity });
    expect(
      database
        .prepare(
          "SELECT id, material_fingerprint FROM evidence_versions WHERE id = ?",
        )
        .get(evidence.id),
    ).toEqual({
      id: V1.evidenceVersion,
      material_fingerprint: V1.materialFingerprint,
    });
    expect(
      database.prepare("SELECT id FROM rule_result_identities").get(),
    ).toEqual({ id: V1.ruleResultIdentity });
    expect(
      database
        .prepare("SELECT id, fingerprint FROM rule_result_versions")
        .get(),
    ).toEqual({
      id: V1.ruleResultVersion,
      fingerprint: V1.ruleResultFingerprint,
    });
    expect(database.prepare("SELECT id FROM claim_identities").get()).toEqual({
      id: V1.claimIdentity,
    });
    expect(database.prepare("SELECT id FROM claim_versions").get()).toEqual({
      id: V1.claimVersion,
    });
    expect(
      database
        .prepare("SELECT id, assessment_key FROM claim_assessments")
        .get(),
    ).toEqual({ id: V1.assessment, assessment_key: V1.assessmentKey });
    expect(
      database
        .prepare(
          `SELECT parameter.subject_identity_id, subject.identity_key
           FROM parameter_identities parameter
           JOIN subject_identities subject ON subject.id = parameter.subject_identity_id`,
        )
        .get(),
    ).toEqual({
      subject_identity_id:
        "subject:7b57ba0a2670daa7bc027664d912ee37df1cd3a49351a929bbc73dc8599c91bc",
      identity_key: "parameter:session.timeout",
    });
    expect(
      database.prepare("SELECT subject_role FROM claim_subjects").get(),
    ).toEqual({
      subject_role: "subject",
    });
    expect(
      database.prepare("SELECT subject_role FROM evidence_subjects").get(),
    ).toEqual({ subject_role: "subject" });
  });
});
