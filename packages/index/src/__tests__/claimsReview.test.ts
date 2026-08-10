// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { ClaimsReviewStore } from "../claims/review.js";
import { ClaimsStore } from "../claims/store.js";
import { initSchema } from "../schema.js";

describe("ClaimsReviewStore", () => {
  let db: Database.Database;
  let claims: ClaimsStore;
  let reviews: ClaimsReviewStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    claims = new ClaimsStore(db);
    reviews = new ClaimsReviewStore(db);
  });

  afterEach(() => db.close());

  function assessment(value: number, dependencyVersionId: string) {
    return claims.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-EFFECTIVE",
      scope: "eu-prod",
      normalizedStatement: { value },
      assessmentPolicyId: "runtime-resolution",
      assessmentPolicyVersion: "v1",
      repositoryRevision: `c${value}`,
      status: "supported",
      dependencies: [
        {
          dependencyKind: "rule_result_version",
          dependencyVersionId,
          epistemicRole: "warrant",
          warrantPolarity: "supports",
          assessmentEffect: "supports",
        },
      ],
    });
  }

  it("carries a review forward to an equivalent new assessment", () => {
    const first = assessment(3600, "r3@1");
    const review = reviews.record({
      claimIdentityId: first.claimIdentityId,
      basisAssessmentId: first.id,
      decision: "accepted",
      actor: "reviewer",
    });
    const next = assessment(3600, "r3@2");
    const carried = reviews.carryForward(next.claimIdentityId, next.id);
    const rows = db
      .prepare(
        `SELECT decision_origin, carried_forward_from_decision_id, is_current
        FROM review_decisions ORDER BY is_current ASC`,
      )
      .all();

    expect(carried).toMatchObject({ carriedForward: true });
    expect(rows).toEqual([
      {
        decision_origin: "manual",
        carried_forward_from_decision_id: null,
        is_current: 0,
      },
      {
        decision_origin: "carry-forward",
        carried_forward_from_decision_id: review.id,
        is_current: 1,
      },
    ]);
  });

  it("invalidates a current review with an explicit material-change reopen", () => {
    const first = assessment(3600, "r3@1");
    reviews.record({
      claimIdentityId: first.claimIdentityId,
      basisAssessmentId: first.id,
      decision: "accepted",
      actor: "reviewer",
    });
    const changed = assessment(5400, "r3@2");
    const reopen = reviews.reopen({
      claimIdentityId: changed.claimIdentityId,
      basisAssessmentId: changed.id,
      dependencyKind: "rule_result_version",
      dependencyVersionId: "r3@2",
      reason: "material-change",
    });
    const review = db
      .prepare(`SELECT is_current, invalidated_by_reopen_id FROM review_decisions`)
      .get() as { is_current: number; invalidated_by_reopen_id: string | null };

    expect(reopen).toMatchObject({ created: true });
    expect(review).toEqual({
      is_current: 0,
      invalidated_by_reopen_id: reopen?.id,
    });
  });

  it("does not allow inconclusive assessments to be reviewed", () => {
    const result = claims.persistClaimAssessment({
      parameterKey: "session.timeout",
      claimType: "CLM-EFFECTIVE",
      scope: "staging",
      normalizedStatement: { value: null },
      assessmentPolicyId: "runtime-resolution",
      assessmentPolicyVersion: "v1",
      repositoryRevision: "c8",
      status: "inconclusive",
      dependencies: [],
    });

    expect(() =>
      reviews.record({
        claimIdentityId: result.claimIdentityId,
        basisAssessmentId: result.id,
        decision: "accepted",
        actor: "reviewer",
      }),
    ).toThrow("not reviewable");
  });
});