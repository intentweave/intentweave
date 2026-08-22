// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { ClaimsStore } from "../claims/store.js";
import { fingerprint, materialFingerprint } from "../claims/canonical.js";
import {
  affectedCurrentAssessmentsForSubject,
  affectedCurrentAssessmentsForSubjectAlias,
  affectedCurrentAssessmentsForSubjectContinuity,
  subjectIdentity,
} from "../claims/subjects.js";
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

  it("reactivates a returning evidence fingerprint as the highest version", () => {
    const input = {
      parameterKey: "session.timeout",
      sourceKind: "code_default",
      identityKey: "src/session.ts:SESSION_TIMEOUT",
      semanticLocation: "SESSION_TIMEOUT",
      provenance: { extractor: "claims-v1" },
    };
    const persist = (value: number) =>
      store.persistEvidence({
        ...input,
        normalizedValue: value,
        fingerprint: fingerprint({ ...input, value }),
        materialFingerprint: materialFingerprint({
          parameterIdentity: input.parameterKey,
          semanticLocation: input.semanticLocation,
          normalizedValue: value,
        }),
      });

    const first = persist(1800);
    const changed = persist(3600);
    const returning = persist(1800);

    expect(returning).toMatchObject({ ordinal: 3, created: true });
    expect(returning.id).not.toBe(first.id);
    expect(
      db
        .prepare(
          `SELECT id, version_ordinal, fingerprint, provenance_json
           FROM evidence_versions
           WHERE evidence_identity_id = ? ORDER BY version_ordinal`,
        )
        .all(first.id.slice(0, first.id.lastIndexOf("@"))),
    ).toEqual([
      {
        id: first.id,
        version_ordinal: 1,
        fingerprint: fingerprint({ ...input, value: 1800 }),
        provenance_json: expect.any(String),
      },
      {
        id: changed.id,
        version_ordinal: 2,
        fingerprint: fingerprint({ ...input, value: 3600 }),
        provenance_json: expect.any(String),
      },
      {
        id: returning.id,
        version_ordinal: 3,
        fingerprint: `${fingerprint({ ...input, value: 1800 })}#reobserved:3`,
        provenance_json: expect.any(String),
      },
    ]);
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
      db
        .prepare(
          `SELECT basis, confidence, provenance_json FROM evidence_continuity`,
        )
        .get(),
    ).toMatchObject({
      basis: "git-merge-base",
      confidence: "high",
      provenance_json: JSON.stringify({
        base: "base",
        head: "head",
        materialChange: true,
      }),
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

  it("rolls back all claim state on transaction failure", () => {
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

    // Verify evidence was persisted
    const evidenceCount = db
      .prepare(`SELECT COUNT(*) AS count FROM evidence_versions`)
      .get() as { count: number };
    expect(evidenceCount.count).toBe(1);

    // Attempt to persist a rule result with invalid evidence reference
    // This should fail due to FK constraint and roll back
    expect(() =>
      store.persistRuleResult(
        {
          ruleId: "r3-effective-timeout",
          scope: "eu-prod",
          applicability: "applicable",
          normalizedStatus: "passed",
          normalizedOutput: { value: 1800 },
          normalizedReasons: ["config-present"],
          ruleContractVersion: "r3-v1",
          implementationFingerprint: "impl-v1",
        },
        ["nonexistent-evidence-id"],
      ),
    ).toThrow();

    // Verify no rule result was persisted (rollback)
    const ruleCount = db
      .prepare(`SELECT COUNT(*) AS count FROM rule_result_versions`)
      .get() as { count: number };
    expect(ruleCount.count).toBe(0);

    // Verify evidence still exists (not rolled back)
    const evidenceAfter = db
      .prepare(`SELECT COUNT(*) AS count FROM evidence_versions`)
      .get() as { count: number };
    expect(evidenceAfter.count).toBe(1);
  });

  it("rolls back claim assessment on dependency failure", () => {
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

    const rule = store.persistRuleResult(
      {
        ruleId: "r3-effective-timeout",
        scope: "eu-prod",
        applicability: "applicable",
        normalizedStatus: "passed",
        normalizedOutput: { value: 1800 },
        normalizedReasons: ["config-present"],
        ruleContractVersion: "r3-v1",
        implementationFingerprint: "impl-v1",
      },
      [evidence.id],
    );

    // Attempt to persist claim with invalid claim_version_id (FK violation)
    // We simulate this by manually inserting into claim_assessments with bad FK
    expect(() =>
      db
        .prepare(
          `INSERT INTO claim_assessments (
             id, claim_version_id, assessment_key, epistemic_status,
             repository_revision, created_at
           ) VALUES ('test:1', 'nonexistent-claim-version', 'key:1', 'supported', 'c0', 1000)`,
        )
        .run(),
    ).toThrow();

    // Verify no claim assessment was persisted
    const claimCount = db
      .prepare(`SELECT COUNT(*) AS count FROM claim_assessments`)
      .get() as { count: number };
    expect(claimCount.count).toBe(0);

    // Verify rule result still exists
    const ruleCount = db
      .prepare(`SELECT COUNT(*) AS count FROM rule_result_versions`)
      .get() as { count: number };
    expect(ruleCount.count).toBe(1);
  });
});

describe("ClaimsStore generic Subjects (G1b)", () => {
  let db: Database.Database;
  let store: ClaimsStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new ClaimsStore(db);
  });

  afterEach(() => db.close());

  const dependencyClaim = () => ({
    subjects: [
      {
        kind: "module" as const,
        identityKey: "module:workspace:@intentweave/ui",
        role: "source",
      },
      {
        kind: "module" as const,
        identityKey: "module:workspace:@intentweave/persistence",
        role: "target",
      },
    ],
    claimType: "CLM-DEPENDENCY-CONFORMANCE",
    identityContract: { id: "dependency-claim-identity", version: "1" },
    materialityContract: {
      id: "dependency-claim-materiality",
      version: "1",
    },
    normalizedStatement: {
      source: "module:workspace:@intentweave/ui",
      target: "module:workspace:@intentweave/persistence",
      rule: "no-ui-to-persistence",
    },
    assessmentPolicyId: "dependency-conformance",
    assessmentPolicyVersion: "1",
    repositoryRevision: "rev:1",
    status: "supported" as const,
    dependencies: [],
  });

  it("persists a two-Subject Claim without a ParameterIdentity", () => {
    const assessment = store.persistGenericClaimAssessment(dependencyClaim());

    expect(assessment.created).toBe(true);
    const claim = db
      .prepare(
        `SELECT parameter_identity_id, claim_type, identity_key
         FROM claim_identities WHERE id = ?`,
      )
      .get(assessment.claimIdentityId) as {
      parameter_identity_id: string | null;
      claim_type: string;
      identity_key: string;
    };
    expect(claim.parameter_identity_id).toBeNull();
    expect(claim.claim_type).toBe("CLM-DEPENDENCY-CONFORMANCE");

    const links = db
      .prepare(
        `SELECT link.subject_role, subject.kind, subject.identity_key
         FROM claim_subjects link
         JOIN subject_identities subject
           ON subject.id = link.subject_identity_id
         WHERE link.claim_identity_id = ?
         ORDER BY link.subject_role`,
      )
      .all(assessment.claimIdentityId) as Array<{
      subject_role: string;
      kind: string;
      identity_key: string;
    }>;
    expect(links).toEqual([
      {
        subject_role: "source",
        kind: "module",
        identity_key: "module:workspace:@intentweave/ui",
      },
      {
        subject_role: "target",
        kind: "module",
        identity_key: "module:workspace:@intentweave/persistence",
      },
    ]);
    // No synthetic Parameter identity was created.
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM parameter_identities`).get(),
    ).toEqual({ count: 0 });
  });

  it("is idempotent for unchanged generic Claims and versions material changes", () => {
    const first = store.persistGenericClaimAssessment(dependencyClaim());
    const repeated = store.persistGenericClaimAssessment(dependencyClaim());
    expect(repeated).toEqual({ ...first, created: false });

    const changed = store.persistGenericClaimAssessment({
      ...dependencyClaim(),
      normalizedStatement: {
        source: "module:workspace:@intentweave/ui",
        target: "module:workspace:@intentweave/persistence",
        rule: "no-ui-to-persistence",
        exception: "read-models",
      },
      repositoryRevision: "rev:2",
    });
    expect(changed.created).toBe(true);
    expect(changed.claimIdentityId).toBe(first.claimIdentityId);
    expect(changed.claimVersionId).not.toBe(first.claimVersionId);

    const versions = db
      .prepare(
        `SELECT COUNT(*) AS count FROM claim_versions
         WHERE claim_identity_id = ?`,
      )
      .get(first.claimIdentityId) as { count: number };
    expect(versions.count).toBe(2);
  });

  it("versions materiality contracts and identities separately", () => {
    const first = store.persistGenericClaimAssessment(dependencyClaim());
    const materialityChanged = store.persistGenericClaimAssessment({
      ...dependencyClaim(),
      materialityContract: {
        id: "dependency-claim-materiality",
        version: "2",
      },
      repositoryRevision: "rev:2",
    });
    const identityChanged = store.persistGenericClaimAssessment({
      ...dependencyClaim(),
      identityContract: { id: "dependency-claim-identity", version: "2" },
      repositoryRevision: "rev:3",
    });

    expect(materialityChanged.claimIdentityId).toBe(first.claimIdentityId);
    expect(materialityChanged.claimVersionId).not.toBe(first.claimVersionId);
    expect(identityChanged.claimIdentityId).not.toBe(first.claimIdentityId);
    expect(
      db
        .prepare(
          `SELECT identity_contract_id, identity_contract_version
           FROM claim_identities WHERE id = ?`,
        )
        .get(first.claimIdentityId),
    ).toEqual({
      identity_contract_id: "dependency-claim-identity",
      identity_contract_version: "1",
    });
    expect(
      db
        .prepare(
          `SELECT materiality_contract_id, materiality_contract_version
           FROM claim_versions WHERE id = ?`,
        )
        .get(materialityChanged.claimVersionId),
    ).toEqual({
      materiality_contract_id: "dependency-claim-materiality",
      materiality_contract_version: "2",
    });
  });

  it("derives a stable Claim identity independent of Subject order", () => {
    const forward = store.persistGenericClaimAssessment(dependencyClaim());
    const reversed = store.persistGenericClaimAssessment({
      ...dependencyClaim(),
      subjects: [...dependencyClaim().subjects].reverse(),
    });
    expect(reversed.claimIdentityId).toBe(forward.claimIdentityId);
    expect(reversed.created).toBe(false);
  });

  it("rejects generic Claims without Subjects or with duplicate roles", () => {
    expect(() =>
      store.persistGenericClaimAssessment({
        ...dependencyClaim(),
        subjects: [],
      }),
    ).toThrow(/at least one Subject/);
    expect(() =>
      store.persistGenericClaimAssessment({
        ...dependencyClaim(),
        subjects: [
          dependencyClaim().subjects[0]!,
          dependencyClaim().subjects[0]!,
        ],
      }),
    ).toThrow(/Duplicate Claim Subject/);
    expect(() =>
      store.persistGenericClaimAssessment({
        ...dependencyClaim(),
        subjects: [
          {
            kind: "module",
            identityKey: "module:workspace:@intentweave/ui",
            role: "  ",
          },
        ],
      }),
    ).toThrow(/non-empty role/);
  });

  it("does not conflate distinct Subject tuples with the same concatenation", () => {
    expect(() =>
      store.persistGenericClaimAssessment({
        ...dependencyClaim(),
        subjects: [
          {
            kind: "module",
            identityKey: "module:symbol:x",
            role: "source",
          },
          {
            kind: "symbol",
            identityKey: "symbol:x",
            role: "sourcemodule:",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("derives reverse impact from Subjects, aliases, and continuity", () => {
    const first = store.persistGenericClaimAssessment(dependencyClaim());
    const renamedInput = {
      ...dependencyClaim(),
      subjects: [
        {
          kind: "module" as const,
          identityKey: "module:workspace:@intentweave/web",
          role: "source",
        },
      ],
      normalizedStatement: { documented: true },
    };
    const renamed = store.persistGenericClaimAssessment(renamedInput);
    const source = subjectIdentity(
      "module",
      "module:workspace:@intentweave/ui",
    );
    const target = subjectIdentity(
      "module",
      "module:workspace:@intentweave/web",
    );

    expect(
      store.persistSubjectAlias({
        subjectIdentityId: source.id,
        aliasKind: "module-name",
        aliasKey: "@intentweave/frontend",
      }),
    ).toBe(true);
    expect(
      store.persistSubjectAlias({
        subjectIdentityId: source.id,
        aliasKind: "module-name",
        aliasKey: "@intentweave/frontend",
      }),
    ).toBe(false);
    expect(() =>
      store.persistSubjectAlias({
        subjectIdentityId: target.id,
        aliasKind: "module-name",
        aliasKey: "@intentweave/frontend",
      }),
    ).toThrow(/already belongs to another Subject/);
    const continuity = store.persistSubjectContinuity({
      fromSubjectIdentityId: source.id,
      toSubjectIdentityId: target.id,
      basis: "git-rename",
      confidence: "probable",
      provenance: { from: "ui", to: "web" },
    });
    expect(continuity).toMatchObject({ ordinal: 1, created: true });
    expect(
      store.persistSubjectContinuity({
        fromSubjectIdentityId: source.id,
        toSubjectIdentityId: target.id,
        basis: "git-rename",
        confidence: "probable",
        provenance: { from: "ui", to: "web" },
      }),
    ).toEqual({ ...continuity, created: false });
    const revisedContinuity = store.persistSubjectContinuity({
      fromSubjectIdentityId: source.id,
      toSubjectIdentityId: target.id,
      basis: "git-rename",
      confidence: "certain",
      provenance: { from: "ui", to: "web", reviewed: true },
    });
    expect(revisedContinuity).toMatchObject({ ordinal: 2, created: true });

    expect(affectedCurrentAssessmentsForSubject(db, source.id)).toEqual([
      { claimIdentityId: first.claimIdentityId, assessmentId: first.id },
    ]);
    expect(
      affectedCurrentAssessmentsForSubjectAlias(
        db,
        "module-name",
        "@intentweave/frontend",
      ),
    ).toEqual([
      { claimIdentityId: first.claimIdentityId, assessmentId: first.id },
    ]);
    expect(
      affectedCurrentAssessmentsForSubjectContinuity(db, revisedContinuity.id),
    ).toEqual(
      [
        { claimIdentityId: first.claimIdentityId, assessmentId: first.id },
        { claimIdentityId: renamed.claimIdentityId, assessmentId: renamed.id },
      ].sort((left, right) =>
        left.claimIdentityId.localeCompare(right.claimIdentityId),
      ),
    );
  });

  it("keeps the legacy Parameter path byte-identical alongside generic Claims", () => {
    const parameterAssessment = store.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-DEFAULT",
      normalizedStatement: { value: 1800 },
      assessmentPolicyId: "default-contract",
      assessmentPolicyVersion: "1",
      repositoryRevision: "rev:1",
      status: "supported",
      dependencies: [],
    });
    const genericAssessment =
      store.persistGenericClaimAssessment(dependencyClaim());

    const parameterClaim = db
      .prepare(
        `SELECT parameter_identity_id, identity_key FROM claim_identities
         WHERE id = ?`,
      )
      .get(parameterAssessment.claimIdentityId) as {
      parameter_identity_id: string | null;
      identity_key: string;
    };
    expect(parameterClaim.parameter_identity_id).not.toBeNull();
    expect(parameterClaim.identity_key).toBe("session.timeout:CLM-DEFAULT:");

    const genericClaim = db
      .prepare(
        `SELECT parameter_identity_id FROM claim_identities WHERE id = ?`,
      )
      .get(genericAssessment.claimIdentityId) as {
      parameter_identity_id: string | null;
    };
    expect(genericClaim.parameter_identity_id).toBeNull();
  });
});
