// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import { canonicalJson, fingerprint } from "./canonical.js";
import type {
  ClaimAssessmentStatus,
  PersistedReopen,
  PersistedReviewDecision,
  RecordReviewInput,
  ReopenReviewInput,
} from "./types.js";

interface CurrentDecision {
  id: string;
  basis_assessment_id: string;
  decision: string;
  actor: string;
}

function assertReviewable(
  db: Database.Database,
  claimIdentityId: string,
  assessmentId: string,
): void {
  const assessment = db
    .prepare(
      `SELECT ca.epistemic_status
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       WHERE ca.id = ? AND cv.claim_identity_id = ?`,
    )
    .get(assessmentId, claimIdentityId) as
    | { epistemic_status: ClaimAssessmentStatus }
    | undefined;
  if (!assessment) {
    throw new Error("Assessment does not belong to the claim identity");
  }
  if (assessment.epistemic_status === "inconclusive") {
    throw new Error("Inconclusive assessments are not reviewable");
  }
}

function currentDecision(
  db: Database.Database,
  claimIdentityId: string,
): CurrentDecision | undefined {
  return db
    .prepare(
      `SELECT id, basis_assessment_id, decision, actor
       FROM review_decisions
       WHERE claim_identity_id = ? AND is_current = 1`,
    )
    .get(claimIdentityId) as CurrentDecision | undefined;
}

export class ClaimsReviewStore {
  constructor(private readonly db: Database.Database) {}

  record(input: RecordReviewInput): PersistedReviewDecision {
    const record = this.db.transaction(() => {
      assertReviewable(this.db, input.claimIdentityId, input.basisAssessmentId);
      const previous = currentDecision(this.db, input.claimIdentityId);
      if (previous?.basis_assessment_id === input.basisAssessmentId) {
        return { id: previous.id, carriedForward: false };
      }

      const id = `review:${fingerprint({
        claimIdentityId: input.claimIdentityId,
        basisAssessmentId: input.basisAssessmentId,
        decision: input.decision,
        actor: input.actor,
      })}`;
      if (previous) {
        this.db
          .prepare(`UPDATE review_decisions SET is_current = 0 WHERE id = ?`)
          .run(previous.id);
      }
      this.db
        .prepare(
          `INSERT INTO review_decisions (
             id, claim_identity_id, basis_assessment_id, decision, actor,
             decision_origin, superseded_by_decision_id, is_current, created_at
           ) VALUES (?, ?, ?, ?, ?, 'manual', NULL, 1, ?)`,
        )
        .run(
          id,
          input.claimIdentityId,
          input.basisAssessmentId,
          input.decision,
          input.actor,
          Date.now(),
        );
      if (previous) {
        this.db
          .prepare(
            `UPDATE review_decisions SET superseded_by_decision_id = ? WHERE id = ?`,
          )
          .run(id, previous.id);
      }
      return { id, carriedForward: false };
    });

    return record();
  }

  carryForward(
    claimIdentityId: string,
    basisAssessmentId: string,
  ): PersistedReviewDecision | null {
    const carryForward = this.db.transaction(() => {
      assertReviewable(this.db, claimIdentityId, basisAssessmentId);
      const previous = currentDecision(this.db, claimIdentityId);
      if (!previous) return null;
      if (previous.basis_assessment_id === basisAssessmentId) {
        return { id: previous.id, carriedForward: true };
      }

      const id = `review:${fingerprint({
        claimIdentityId,
        basisAssessmentId,
        carriedForwardFrom: previous.id,
      })}`;
      this.db
        .prepare(`UPDATE review_decisions SET is_current = 0 WHERE id = ?`)
        .run(previous.id);
      this.db
        .prepare(
          `INSERT INTO review_decisions (
             id, claim_identity_id, basis_assessment_id, decision, actor,
             decision_origin, carried_forward_from_decision_id, is_current, created_at
           ) VALUES (?, ?, ?, ?, ?, 'carry-forward', ?, 1, ?)`,
        )
        .run(
          id,
          claimIdentityId,
          basisAssessmentId,
          previous.decision,
          previous.actor,
          previous.id,
          Date.now(),
        );
      this.db
        .prepare(
          `UPDATE review_decisions SET superseded_by_decision_id = ? WHERE id = ?`,
        )
        .run(id, previous.id);
      return { id, carriedForward: true };
    });

    return carryForward();
  }

  reopen(input: ReopenReviewInput): PersistedReopen | null {
    const reopen = this.db.transaction(() => {
      const previous = currentDecision(this.db, input.claimIdentityId);
      if (!previous) return null;

      const id = `reopen:${fingerprint({
        previousReviewDecisionId: previous.id,
        basisAssessmentId: input.basisAssessmentId,
        dependencyKind: input.dependencyKind,
        dependencyVersionId: input.dependencyVersionId,
        reason: input.reason,
      })}`;
      const existing = this.db
        .prepare(`SELECT id FROM review_decision_reopens WHERE id = ?`)
        .get(id) as { id: string } | undefined;
      if (existing) return { id, created: false };

      this.db
        .prepare(
          `INSERT INTO review_decision_reopens (
             id, claim_identity_id, previous_review_decision_id, basis_assessment_id,
             dependency_kind, dependency_version_id, reason, secondary_provenance_json,
             status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          id,
          input.claimIdentityId,
          previous.id,
          input.basisAssessmentId,
          input.dependencyKind,
          input.dependencyVersionId,
          input.reason,
          input.secondaryProvenance
            ? canonicalJson(input.secondaryProvenance)
            : null,
          Date.now(),
        );
      this.db
        .prepare(
          `UPDATE review_decisions
           SET is_current = 0, invalidated_by_reopen_id = ? WHERE id = ?`,
        )
        .run(id, previous.id);
      return { id, created: true };
    });

    return reopen();
  }
}