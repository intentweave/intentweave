// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { CandidateStore, ClaimsStore, initSchema } from "@intentweave/index";
import { persistR1Candidates } from "./candidateDiscovery.js";
import { reviewCandidate } from "./candidateGovernance.js";
import type { CodeEvidenceObservation } from "./discovery.js";
import { projectClaimOrigins } from "./origins.js";

const contracts = {
  r1RuleContractVersion: "r1-v1",
  r3RuleContractVersion: "r3-v1",
  r7RuleContractVersion: "r7-v1",
  implementationFingerprint: "claims-engine-v1",
  literalPolicyVersion: "literal-binding-v1",
  defaultPolicyVersion: "default-contract-v1",
  runtimePolicyVersion: "runtime-resolution-v1",
  documentationPolicyVersion: "documentation-conformance-v1",
};

const declaredOrigin = {
  contractVersion: "1" as const,
  kind: "declared" as const,
  source: "adr" as const,
  sourceIdentity: "docs/ADR-017.md#session-timeout",
  sourceVersion: "adr-017@1",
  provenance: {
    actor: "architecture-review",
    section: "Runtime defaults",
  },
};

function persistDeclaredSessionTimeout(
  database: Database.Database,
): { claimIdentityId: string; assessmentId: string } {
  const candidates = new CandidateStore(database);
  const candidate = candidates.persist({
    identityKey: "adr:ADR-017#session.timeout",
    candidateKind: "declared-parameter-claim",
    proposedClaimType: "CLM-DEFAULT",
    discoveryMode: "manual",
    discoveryAdapterId: "test-adr-declaration",
    discoveryContractVersion: "1",
    confidence: "certain",
    normalizedStatement: {
      subject: "session.timeout",
      predicate: "defaults-to",
      value: 1800,
      observedValues: [1800],
    },
    provenance: {
      repositoryRevision: "c0",
      origin: declaredOrigin,
    },
    evidence: [],
    subjects: [
      {
        kind: "parameter",
        identityKey: "parameter:session.timeout",
        displayName: "session.timeout",
        role: "subject",
        basis: "adr-declaration",
        confidence: "certain",
      },
    ],
  });
  const triaged = candidates.triage(candidate.id, {
    basis: "test-declaration-triage",
  });
  const assessment = new ClaimsStore(database).persistClaimAssessment({
    parameterKey: "session.timeout",
    claimType: "CLM-DEFAULT",
    normalizedStatement: { value: 1800 },
    assessmentPolicyId: "default-contract",
    assessmentPolicyVersion: contracts.defaultPolicyVersion,
    repositoryRevision: "c0",
    status: "inconclusive",
    dependencies: [],
  });
  candidates.review({
    candidateId: triaged.id,
    actorKind: "human",
    actorId: "architecture-review",
    decision: "promote",
    effect: "effective",
    rationale: "ADR-017 governs the session timeout default",
    provenance: { origin: declaredOrigin },
    promotedClaimIdentityId: assessment.claimIdentityId,
  });
  return { claimIdentityId: assessment.claimIdentityId, assessmentId: assessment.id };
}

function persistReconstructedSessionTimeout(
  database: Database.Database,
): { claimIdentityId: string; assessmentId: string } {
  const observation: CodeEvidenceObservation = {
    parameterKey: "session.timeout",
    claimType: "CLM-DEFAULT",
    sourceKind: "code-default",
    identityKey: "session.timeout:code-default:src/session.ts:SESSION_TIMEOUT",
    semanticLocation: "session.timeout",
    normalizedValue: 1800,
    filePath: "src/session.ts",
    symbolId: "SESSION_TIMEOUT",
    line: 4,
    bindingBasis: "r1-discovery",
    bindingConfidence: "probable",
  };
  const candidates = new CandidateStore(database);
  const candidate = persistR1Candidates(
    candidates,
    [observation],
    "c0",
  )[0]!;
  const triaged = candidates.triage(candidate.id, {
    basis: "test-reconstruction-triage",
  });
  const result = reviewCandidate(database, {
    candidateId: triaged.id,
    actor: "reconstruction-review",
    decision: "promote",
    rationale: "CARI reconstructed the configured default from code",
    provenance: { source: "cari" },
    contracts,
  });
  return {
    claimIdentityId: result.assessment!.claimIdentityId,
    assessmentId: result.assessment!.id,
  };
}

describe("G5.2b session.timeout Twin-Origin fixture", () => {
  it("converges ADR declaration and code reconstruction on one legacy-v1 Claim", () => {
    const database = new Database(":memory:");
    initSchema(database);

    const declared = persistDeclaredSessionTimeout(database);
    expect(
      database
        .prepare(`SELECT epistemic_status FROM claim_assessments WHERE id = ?`)
        .get(declared.assessmentId),
    ).toEqual({ epistemic_status: "inconclusive" });

    const reconstructed = persistReconstructedSessionTimeout(database);

    expect(reconstructed.claimIdentityId).toBe(declared.claimIdentityId);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM claim_versions
           WHERE claim_identity_id = ?`,
        )
        .get(declared.claimIdentityId),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT ci.claim_type, ci.scope,
                  ci.identity_contract_id, ci.identity_contract_version,
                  cv.materiality_contract_id, cv.materiality_contract_version,
                  cv.normalized_statement_json
           FROM claim_identities ci
           JOIN claim_versions cv ON cv.claim_identity_id = ci.id
           WHERE ci.id = ?`,
        )
        .get(declared.claimIdentityId),
    ).toEqual({
      claim_type: "CLM-DEFAULT",
      scope: null,
      // NULL is the frozen ParameterClaimIdentityV1/ParameterMaterialityV1 contract.
      identity_contract_id: null,
      identity_contract_version: null,
      materiality_contract_id: null,
      materiality_contract_version: null,
      normalized_statement_json: '{"value":1800}',
    });
    expect(
      database
        .prepare(
          `SELECT subject.kind, subject.identity_key, link.subject_role
           FROM claim_subjects link
           JOIN subject_identities subject
             ON subject.id = link.subject_identity_id
           WHERE link.claim_identity_id = ?`,
        )
        .all(declared.claimIdentityId),
    ).toEqual([
      {
        kind: "parameter",
        identity_key: "parameter:session.timeout",
        subject_role: "subject",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT epistemic_status FROM claim_assessments
           WHERE id = ?`,
        )
        .get(reconstructed.assessmentId),
    ).toEqual({ epistemic_status: "supported" });

    const origins = projectClaimOrigins(database, declared.claimIdentityId);
    expect(origins.map((origin) => origin.kind)).toEqual([
      "declared",
      "reconstructed",
    ]);
    expect(origins).toContainEqual(declaredOrigin);
    expect(origins).toContainEqual(
      expect.objectContaining({
        kind: "reconstructed",
        source: "cari",
        sourceIdentity: "r1:session.timeout:CLM-DEFAULT",
      }),
    );
    database.close();
  });
});
