// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
  subjectIdentity,
} from "@intentweave/index";
import {
  crossArtifactFamilyForSourceKind,
  discoverCrossArtifactCohorts,
} from "./crossArtifactCorrelation.js";

function subject(identityKey: string, role: string, displayName: string) {
  return {
    kind: "module" as const,
    identityKey,
    displayName,
    role,
    basis: "fixture",
    confidence: "certain" as const,
  };
}

describe("cross-artifact correlation cohorts", () => {
  let database: Database.Database;

  beforeEach(() => {
    database = new Database(":memory:");
    initSchema(database);
  });

  afterEach(() => database.close());

  it("joins Candidates through Subject continuity and preserves EvidenceVersion references", () => {
    const claims = new ClaimsStore(database);
    const candidates = new CandidateStore(database);
    const originalSubject = subject(
      "module:feature:auth",
      "subject",
      "Auth module",
    );
    const renamedSubject = subject(
      "module:feature:authentication",
      "source",
      "Authentication module",
    );
    const codeEvidence = claims.persistGenericEvidence({
      subjects: [originalSubject],
      sourceKind: "code-symbol",
      identityKey: "fixture:code:auth",
      fingerprint: fingerprint({ source: "code", subject: originalSubject }),
      materialFingerprint: fingerprint({ source: "code" }),
      normalizedValue: { symbol: "AuthConfig" },
      semanticLocation: originalSubject.identityKey,
      provenance: { fixture: true },
    });
    const architectureEvidence = claims.persistGenericEvidence({
      subjects: [renamedSubject],
      sourceKind: "architecture-rule-definition",
      identityKey: "fixture:architecture:auth",
      fingerprint: fingerprint({
        source: "architecture",
        subject: renamedSubject,
      }),
      materialFingerprint: fingerprint({ source: "architecture" }),
      normalizedValue: { rule: "auth-boundary" },
      semanticLocation: renamedSubject.identityKey,
      provenance: { fixture: true },
    });
    claims.persistSubjectContinuity({
      fromSubjectIdentityId: subjectIdentity(
        "module",
        originalSubject.identityKey,
        originalSubject.displayName,
      ).id,
      toSubjectIdentityId: subjectIdentity(
        "module",
        renamedSubject.identityKey,
        renamedSubject.displayName,
      ).id,
      basis: "fixture-module-rename",
      confidence: "probable",
      provenance: { fixture: true },
    });
    candidates.persist({
      identityKey: "candidate:code-auth",
      candidateKind: "r1-code-value",
      proposedClaimType: "CLM-DEFAULT",
      discoveryMode: "deterministic",
      discoveryAdapterId: "fixture-code",
      discoveryContractVersion: "1",
      confidence: "certain",
      normalizedStatement: { value: "auth" },
      provenance: { fixture: true },
      evidence: [
        {
          evidenceKey: "fixture:code:auth",
          evidenceVersionId: codeEvidence.id,
          sourceKind: "code-symbol",
          role: "source",
          provenance: { fixture: true },
        },
      ],
      subjects: [originalSubject],
    });
    candidates.persist({
      identityKey: "candidate:architecture-auth",
      candidateKind: "architecture-dependency-conformance",
      proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE",
      discoveryMode: "deterministic",
      discoveryAdapterId: "fixture-architecture",
      discoveryContractVersion: "1",
      confidence: "certain",
      normalizedStatement: { rule: "auth-boundary" },
      provenance: { fixture: true },
      evidence: [
        {
          evidenceKey: "fixture:architecture:auth",
          evidenceVersionId: architectureEvidence.id,
          sourceKind: "architecture-rule-definition",
          role: "source",
          provenance: { fixture: true },
        },
      ],
      subjects: [renamedSubject],
    });
    candidates.persist({
      identityKey: "candidate:missing-evidence-version",
      candidateKind: "r1-code-value",
      proposedClaimType: "CLM-DEFAULT",
      discoveryMode: "deterministic",
      discoveryAdapterId: "fixture-config",
      discoveryContractVersion: "1",
      confidence: "certain",
      normalizedStatement: { value: "ignored" },
      provenance: { fixture: true },
      evidence: [
        {
          evidenceKey: "fixture:config:missing-version",
          sourceKind: "config",
          role: "source",
          provenance: { fixture: true },
        },
      ],
      subjects: [originalSubject],
    });

    const [cohort] = discoverCrossArtifactCohorts(database);

    expect(cohort).toMatchObject({
      contractVersion: "cross-artifact-correlation@1",
      subjectIdentityKeys: [
        "module:feature:auth",
        "module:feature:authentication",
      ],
      subjectKinds: ["module"],
      candidateIdentityKeys: [
        "candidate:architecture-auth",
        "candidate:code-auth",
      ],
      artifactFamilies: ["code", "architecture-rule"],
      evidenceVersionIds: [codeEvidence.id, architectureEvidence.id].sort(),
      continuity: [
        {
          basis: "fixture-module-rename",
          confidence: "probable",
          fromSubjectIdentityKey: "module:feature:auth",
          toSubjectIdentityKey: "module:feature:authentication",
        },
      ],
    });
    expect(
      cohort?.candidates.map((candidate) => candidate.identityKey),
    ).toEqual(["candidate:architecture-auth", "candidate:code-auth"]);
    expect(
      cohort?.candidateIdentityKeys.includes(
        "candidate:missing-evidence-version",
      ),
    ).toBe(false);
    expect(discoverCrossArtifactCohorts(database)).toEqual(
      discoverCrossArtifactCohorts(database),
    );
  });

  it("maps known artifact source kinds and rejects invalid cohort thresholds", () => {
    expect(crossArtifactFamilyForSourceKind("code-default")).toBe("code");
    expect(crossArtifactFamilyForSourceKind("config")).toBe("configuration");
    expect(crossArtifactFamilyForSourceKind("documentation-reference")).toBe(
      "documentation",
    );
    expect(crossArtifactFamilyForSourceKind("adr-decision")).toBe("adr");
    expect(
      crossArtifactFamilyForSourceKind("architecture-rule-definition"),
    ).toBe("architecture-rule");
    expect(crossArtifactFamilyForSourceKind("unknown-source")).toBeUndefined();
    expect(() =>
      discoverCrossArtifactCohorts(database, { minimumArtifactFamilies: 1 }),
    ).toThrow(/at least two artifact families/);
  });
});
