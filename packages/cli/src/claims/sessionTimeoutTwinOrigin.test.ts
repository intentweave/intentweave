// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsEngine,
  ClaimsReviewStore,
  ClaimsStore,
  emptyPortableClaimsState,
  fingerprint,
  initSchema,
  materialFingerprint,
} from "@intentweave/index";
import { persistR1Candidates } from "./candidateDiscovery.js";
import { reviewCandidate } from "./candidateGovernance.js";
import type { CodeEvidenceObservation } from "./discovery.js";
import { projectClaimOrigins } from "./origins.js";
import { writePortableClaimsState } from "./portableState.js";
import { runClaimsExplain } from "../commands/claims.js";

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

function persistDeclaredSessionTimeout(database: Database.Database): {
  claimIdentityId: string;
  assessmentId: string;
} {
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
  return {
    claimIdentityId: assessment.claimIdentityId,
    assessmentId: assessment.id,
  };
}

function persistReconstructedSessionTimeout(database: Database.Database): {
  claimIdentityId: string;
  assessmentId: string;
  claimVersionId: string;
} {
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
  const candidate = persistR1Candidates(candidates, [observation], "c0")[0]!;
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
    claimVersionId: result.assessment!.claimVersionId,
  };
}

function persistSessionTimeoutAssessment(
  database: Database.Database,
  input: {
    value: number;
    filePath: string;
    line: number;
    repositoryRevision: string;
  },
): {
  assessmentId: string;
  claimIdentityId: string;
  claimVersionId: string;
  ruleResultId: string;
} {
  const store = new ClaimsStore(database);
  const evidence = store.persistEvidence({
    parameterKey: "session.timeout",
    sourceKind: "code-default",
    identityKey: "session.timeout:code-default:src/session.ts:SESSION_TIMEOUT",
    fingerprint: fingerprint({
      sourceKind: "code-default",
      value: input.value,
      semanticLocation: "session.timeout",
      filePath: input.filePath,
      symbolId: "SESSION_TIMEOUT",
      line: input.line,
    }),
    materialFingerprint: materialFingerprint({
      parameterIdentity: "session.timeout",
      semanticLocation: "session.timeout",
      normalizedValue: input.value,
    }),
    normalizedValue: input.value,
    semanticLocation: "session.timeout",
    provenance: {
      filePath: input.filePath,
      symbolId: "SESSION_TIMEOUT",
      line: input.line,
      repositoryRevision: input.repositoryRevision,
    },
    filePath: input.filePath,
    symbolId: "SESSION_TIMEOUT",
    spanStartLine: input.line,
    spanEndLine: input.line,
    repositoryRevision: input.repositoryRevision,
    bindingBasis: "r1-discovery",
    bindingConfidence: "probable",
  });
  const result = new ClaimsEngine(store).evaluateDefault({
    parameterKey: "session.timeout",
    claimType: "CLM-DEFAULT",
    repositoryRevision: input.repositoryRevision,
    codeDefault: {
      versionId: evidence.id,
      value: input.value,
    },
    contracts,
  });
  const assessment = result.assessments[0]!;
  const rule = result.ruleResults[0]!;
  return {
    assessmentId: assessment.id,
    claimIdentityId: assessment.claimIdentityId,
    claimVersionId: assessment.claimVersionId,
    ruleResultId: rule.id,
  };
}

describe("G5.2 session.timeout Twin-Origin lifecycle fixture", () => {
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

  it("keeps Origin-neutral lifecycle semantics across location and value changes", () => {
    const database = new Database(":memory:");
    initSchema(database);

    const declared = persistDeclaredSessionTimeout(database);
    const reconstructed = persistReconstructedSessionTimeout(database);
    expect(reconstructed.claimIdentityId).toBe(declared.claimIdentityId);

    const reviews = new ClaimsReviewStore(database);
    const accepted = reviews.record({
      claimIdentityId: reconstructed.claimIdentityId,
      basisAssessmentId: reconstructed.assessmentId,
      decision: "accepted",
      actor: "lifecycle-reviewer",
    });

    // The file and span move, but the semantic location and value remain the same.
    const moved = persistSessionTimeoutAssessment(database, {
      value: 1800,
      filePath: "src/config/session.ts",
      line: 12,
      repositoryRevision: "c1",
    });
    expect(moved.claimIdentityId).toBe(reconstructed.claimIdentityId);
    expect(moved.claimVersionId).toBe(reconstructed.claimVersionId);
    expect(
      reviews.carryForward(moved.claimIdentityId, moved.assessmentId),
    ).toEqual(expect.objectContaining({ carriedForward: true }));
    expect(
      database
        .prepare(
          `SELECT decision, basis_assessment_id, is_current
           FROM review_decisions WHERE claim_identity_id = ? AND is_current = 1`,
        )
        .get(reconstructed.claimIdentityId),
    ).toEqual({
      decision: "accepted",
      basis_assessment_id: moved.assessmentId,
      is_current: 1,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM review_decision_reopens
           WHERE claim_identity_id = ? AND status = 'open'`,
        )
        .get(reconstructed.claimIdentityId),
    ).toEqual({ count: 0 });

    // The value changes, so the material fingerprint changes as well.
    const changed = persistSessionTimeoutAssessment(database, {
      value: 3600,
      filePath: "src/config/session.ts",
      line: 12,
      repositoryRevision: "c2",
    });
    expect(changed.claimIdentityId).toBe(reconstructed.claimIdentityId);
    expect(changed.claimVersionId).not.toBe(moved.claimVersionId);
    expect(
      reviews.reopen({
        claimIdentityId: changed.claimIdentityId,
        basisAssessmentId: changed.assessmentId,
        dependencyKind: "rule_result_version",
        dependencyVersionId: changed.ruleResultId,
        reason: "material-change",
        secondaryProvenance: {
          trigger: "session-timeout-lifecycle-fixture",
          originKinds: projectClaimOrigins(
            database,
            changed.claimIdentityId,
          ).map((origin) => origin.kind),
        },
      }),
    ).toMatchObject({ created: true });
    expect(
      database
        .prepare(
          `SELECT decision, is_current FROM review_decisions
           WHERE claim_identity_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(changed.claimIdentityId),
    ).toEqual({ decision: "accepted", is_current: 0 });
    expect(
      database
        .prepare(
          `SELECT reason, status, dependency_kind, dependency_version_id
           FROM review_decision_reopens
           WHERE claim_identity_id = ? AND status = 'open'`,
        )
        .get(changed.claimIdentityId),
    ).toEqual({
      reason: "material-change",
      status: "open",
      dependency_kind: "rule_result_version",
      dependency_version_id: changed.ruleResultId,
    });

    expect(
      projectClaimOrigins(database, changed.claimIdentityId).map(
        (origin) => origin.kind,
      ),
    ).toEqual(["declared", "reconstructed"]);
    expect(accepted.carriedForward).toBe(false);
    database.close();
  });

  it("replays Origins from state.yaml in a fresh SQLite projection", async () => {
    const source = new Database(":memory:");
    initSchema(source);
    const declared = persistDeclaredSessionTimeout(source);
    persistReconstructedSessionTimeout(source);
    const origins = projectClaimOrigins(source, declared.claimIdentityId);
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-origin-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(path.join(workspace, ".iw"));
      const portableState = emptyPortableClaimsState();
      portableState.claimOrigins[declared.claimIdentityId] = origins.map(
        (origin) => ({
          ...origin,
          provenance: JSON.parse(JSON.stringify(origin.provenance)),
        }),
      );
      writePortableClaimsState(workspace, portableState);

      const fresh = new Database(path.join(workspace, ".iw", "index.db"));
      initSchema(fresh);
      const freshAssessment = new ClaimsStore(fresh).persistClaimAssessment({
        parameterKey: "session.timeout",
        claimType: "CLM-DEFAULT",
        normalizedStatement: { value: 1800 },
        assessmentPolicyId: "default-contract",
        assessmentPolicyVersion: contracts.defaultPolicyVersion,
        repositoryRevision: "fresh-checkout",
        status: "inconclusive",
        dependencies: [],
      });
      expect(freshAssessment.claimIdentityId).toBe(declared.claimIdentityId);
      expect(
        fresh.prepare(`SELECT COUNT(*) AS count FROM claim_candidates`).get(),
      ).toEqual({ count: 0 });
      fresh.close();

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      process.chdir(workspace);
      await runClaimsExplain({
        claim: declared.claimIdentityId,
        format: "json",
      });
      const explained = JSON.parse(String(log.mock.calls[0][0])) as Array<{
        origins: unknown[];
        dependencies: unknown[];
        status: string;
      }>;
      expect(explained[0]).toMatchObject({
        origins,
        dependencies: [],
        status: "inconclusive",
      });
      vi.restoreAllMocks();
    } finally {
      process.chdir(originalCwd);
      source.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
