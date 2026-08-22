// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  ClaimsReviewStore,
  emptyPortableClaimsState,
  fingerprint,
  type PortableAssessmentReview,
  type PortableClaimsActor,
  type PortableClaimsState,
} from "@intentweave/index";
import {
  loadPortableClaimsState,
  writePortableClaimsState,
} from "./portableState.js";

interface AssessmentBasis {
  id: string;
  epistemic_status: string;
  normalized_statement_json: string;
  assessment_policy_id: string;
  assessment_policy_version: string;
  materiality_contract_id: string | null;
  materiality_contract_version: string | null;
}

interface AssessmentDependencyBasis {
  dependency_kind: string;
  epistemic_role: string;
  warrant_polarity: string | null;
  assessment_effect: string;
  source_kind: string | null;
  material_fingerprint: string | null;
  rule_identity_key: string | null;
  applicability: string | null;
  normalized_status: string | null;
  normalized_output_json: string | null;
  normalized_reasons_json: string | null;
  rule_contract_version: string | null;
}

export interface PortableReviewProjectionIssue {
  claimIdentityId: string;
  kind: "missing_claim" | "stale_assessment" | "unreviewable";
  message: string;
  expectedAssessmentFingerprint?: string;
  actualAssessmentFingerprint?: string;
}

export interface PortableReviewProjectionResult {
  imported: number;
  skipped: number;
  issues: PortableReviewProjectionIssue[];
}

function portableAssessmentFingerprint(
  database: Database.Database,
  claimIdentityId: string,
  basis: AssessmentBasis,
): string {
  const dependencies = database
    .prepare(
      `SELECT dependency.dependency_kind, dependency.epistemic_role,
              dependency.warrant_polarity, dependency.assessment_effect,
              evidence_identity.source_kind, evidence.material_fingerprint,
              result_identity.identity_key AS rule_identity_key,
              result.applicability, result.normalized_status,
              result.normalized_output_json, result.normalized_reasons_json,
              result.rule_contract_version
       FROM claim_assessment_dependencies dependency
       LEFT JOIN evidence_versions evidence
         ON dependency.dependency_kind = 'evidence_version'
        AND evidence.id = dependency.dependency_version_id
       LEFT JOIN evidence_identities evidence_identity
         ON evidence_identity.id = evidence.evidence_identity_id
       LEFT JOIN rule_result_versions result
         ON dependency.dependency_kind = 'rule_result_version'
        AND result.id = dependency.dependency_version_id
       LEFT JOIN rule_result_identities result_identity
         ON result_identity.id = result.rule_result_identity_id
       WHERE dependency.claim_assessment_id = ?`,
    )
    .all(basis.id) as AssessmentDependencyBasis[];
  const normalizedDependencies = dependencies
    .map((dependency) => ({
      dependencyKind: dependency.dependency_kind,
      epistemicRole: dependency.epistemic_role,
      warrantPolarity: dependency.warrant_polarity,
      assessmentEffect: dependency.assessment_effect,
      semanticBasis:
        dependency.dependency_kind === "evidence_version"
          ? {
              sourceKind: dependency.source_kind,
              materialFingerprint: dependency.material_fingerprint,
            }
          : {
              identityKey: dependency.rule_identity_key,
              applicability: dependency.applicability,
              normalizedStatus: dependency.normalized_status,
              normalizedOutput: JSON.parse(
                dependency.normalized_output_json ?? "null",
              ),
              normalizedReasons: JSON.parse(
                dependency.normalized_reasons_json ?? "[]",
              ),
              ruleContractVersion: dependency.rule_contract_version,
            },
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const materialityContract =
    basis.materiality_contract_id && basis.materiality_contract_version
      ? {
          id: basis.materiality_contract_id,
          version: basis.materiality_contract_version,
        }
      : undefined;
  return fingerprint({
    claimIdentityId,
    normalizedStatement: JSON.parse(basis.normalized_statement_json),
    epistemicStatus: basis.epistemic_status,
    assessmentPolicyId: basis.assessment_policy_id,
    assessmentPolicyVersion: basis.assessment_policy_version,
    ...(materialityContract ? { materialityContract } : {}),
    dependencies: normalizedDependencies,
  });
}

function portableActorLabel(actor: PortableClaimsActor): string {
  return actor.kind === "human"
    ? actor.id
    : `policy:${actor.id}@${actor.version}`;
}

function assessmentBasis(
  database: Database.Database,
  claimIdentityId: string,
  assessmentId?: string,
): AssessmentBasis | undefined {
  return database
    .prepare(
      `SELECT ca.id, ca.epistemic_status, cv.normalized_statement_json,
              cv.assessment_policy_id, cv.assessment_policy_version,
              cv.materiality_contract_id, cv.materiality_contract_version
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       WHERE cv.claim_identity_id = ?
         AND ((? IS NULL AND ca.is_current = 1) OR ca.id = ?)`,
    )
    .get(claimIdentityId, assessmentId ?? null, assessmentId ?? null) as
    | AssessmentBasis
    | undefined;
}

/** Project portable reviews only when SQLite has no effective review yet. */
export function projectPortableAssessmentReviews(
  database: Database.Database,
  state: PortableClaimsState,
): PortableReviewProjectionResult {
  const result: PortableReviewProjectionResult = {
    imported: 0,
    skipped: 0,
    issues: [],
  };
  const reviews = new ClaimsReviewStore(database);

  for (const [claimIdentityId, review] of Object.entries(
    state.assessmentReviews,
  )) {
    const existingReview = database
      .prepare(
        `SELECT 1 AS present
         FROM review_decisions
         WHERE claim_identity_id = ?
         LIMIT 1`,
      )
      .get(claimIdentityId) as { present: number } | undefined;
    if (existingReview) {
      result.skipped += 1;
      continue;
    }

    const basis = assessmentBasis(database, claimIdentityId);
    if (!basis) {
      const knownClaim = database
        .prepare(`SELECT 1 AS present FROM claim_identities WHERE id = ?`)
        .get(claimIdentityId) as { present: number } | undefined;
      if (knownClaim) {
        // Retired claims remain in history but have no effective review target.
        result.skipped += 1;
        continue;
      }
      result.issues.push({
        claimIdentityId,
        kind: "missing_claim",
        message: `Portable review references unknown claim ${claimIdentityId}`,
        expectedAssessmentFingerprint: review.assessmentFingerprint,
      });
      continue;
    }

    const actualFingerprint = portableAssessmentFingerprint(
      database,
      claimIdentityId,
      basis,
    );
    if (
      actualFingerprint !== review.assessmentFingerprint ||
      basis.assessment_policy_id !== review.assessmentPolicyId ||
      basis.assessment_policy_version !== review.assessmentPolicyVersion
    ) {
      result.issues.push({
        claimIdentityId,
        kind: "stale_assessment",
        message: `Portable review basis does not match the current assessment for ${claimIdentityId}`,
        expectedAssessmentFingerprint: review.assessmentFingerprint,
        actualAssessmentFingerprint: actualFingerprint,
      });
      continue;
    }
    if (basis.epistemic_status === "inconclusive") {
      result.issues.push({
        claimIdentityId,
        kind: "unreviewable",
        message: `Portable review references an inconclusive assessment for ${claimIdentityId}`,
        expectedAssessmentFingerprint: review.assessmentFingerprint,
        actualAssessmentFingerprint: actualFingerprint,
      });
      continue;
    }

    reviews.record({
      claimIdentityId,
      basisAssessmentId: basis.id,
      decision: review.decision,
      actor: portableActorLabel(review.actor),
      decisionOrigin: "portable",
      createdAt: Date.parse(review.decidedAt),
    });
    result.imported += 1;
  }

  return result;
}

export function persistPortableAssessmentReview(
  workspaceRoot: string,
  database: Database.Database,
  input: {
    claimIdentityId: string;
    basisAssessmentId: string;
    decision: PortableAssessmentReview["decision"];
    actor: string;
    rationale: string;
    decidedAt: string;
  },
): string {
  const basis = assessmentBasis(
    database,
    input.claimIdentityId,
    input.basisAssessmentId,
  );
  if (!basis) {
    throw new Error("Assessment does not belong to the claim identity");
  }
  if (basis.epistemic_status === "inconclusive") {
    throw new Error("Inconclusive assessments are not reviewable");
  }

  const state =
    loadPortableClaimsState(workspaceRoot) ?? emptyPortableClaimsState();
  state.assessmentReviews[input.claimIdentityId] = {
    decision: input.decision,
    assessmentFingerprint: portableAssessmentFingerprint(
      database,
      input.claimIdentityId,
      basis,
    ),
    assessmentPolicyId: basis.assessment_policy_id,
    assessmentPolicyVersion: basis.assessment_policy_version,
    actor: { kind: "human", id: input.actor },
    decidedAt: input.decidedAt,
    rationale: input.rationale,
  };
  return writePortableClaimsState(workspaceRoot, state);
}
