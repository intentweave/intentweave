// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT,
  CandidateRecommendationValidationError,
  candidateRecommendationKey,
  createCandidateTriageRecommendation,
  createCandidateTriageRecommendationSchema,
  validateCandidateTriageRecommendationOutput,
} from "../claims/recommendations.js";

const context = {
  candidateId: "candidate:current@1",
  candidateObservationFingerprint: "observation-current",
  contextFingerprint: "context-current",
  candidateClaimType: "CLM-ENDPOINT-AUTHENTICATED",
  evidenceVersionIds: ["evidence:route@1", "evidence:guard@1"],
  subjects: [
    {
      kind: "endpoint" as const,
      identityKey: "endpoint:http:POST:/admin/users",
      roles: ["endpoint"],
    },
    {
      kind: "symbol" as const,
      identityKey: "symbol:AdminController.createUser",
      roles: ["handler"],
    },
  ],
  requiredSubjectRoles: ["endpoint", "handler"],
  allowedClaimTypes: ["CLM-ENDPOINT-AUTHENTICATED"],
  currentCandidateIds: ["candidate:current@1", "candidate:other@1"],
};

describe("CandidateTriageRecommendationV1", () => {
  it("validates grounded probable output and creates a canonical envelope", () => {
    const output = validateCandidateTriageRecommendationOutput(
      {
        recommendation: "promote",
        rationale: "The route has a grounded authentication guard.",
        evidenceVersionIds: ["evidence:guard@1"],
        confidence: "probable",
        priority: "high",
        proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
        proposedSubjectBindings: [
          {
            kind: "endpoint",
            identityKey: "endpoint:http:POST:/admin/users",
            role: "endpoint",
          },
          {
            kind: "symbol",
            identityKey: "symbol:AdminController.createUser",
            role: "handler",
          },
        ],
      },
      context,
    );
    const envelope = createCandidateTriageRecommendation(output, {
      inferenceId: "candidate-inference:current@1",
      candidateId: context.candidateId,
      candidateFingerprint: "candidate-version@1",
      candidateObservationFingerprint: context.candidateObservationFingerprint,
      contextFingerprint: context.contextFingerprint,
    });

    expect(envelope.contractVersion).toBe(
      CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT,
    );
    expect(envelope.candidateFingerprint).toBe("candidate-version@1");
    expect(envelope.candidateObservationFingerprint).toBe(
      "observation-current",
    );
    expect(candidateRecommendationKey(envelope)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects invented Evidence, Subjects, duplicate Candidates, and invalid confidence", () => {
    expect(() =>
      validateCandidateTriageRecommendationOutput(
        {
          recommendation: "promote",
          rationale: "Grounded enough.",
          evidenceVersionIds: ["evidence:invented@1"],
          confidence: "probable",
          priority: "medium",
        },
        context,
      ),
    ).toThrow(CandidateRecommendationValidationError);
    expect(() =>
      validateCandidateTriageRecommendationOutput(
        {
          recommendation: "promote",
          rationale: "Grounded enough.",
          evidenceVersionIds: ["evidence:guard@1"],
          confidence: "probable",
          priority: "medium",
          proposedSubjectBindings: [
            {
              kind: "endpoint",
              identityKey: "endpoint:http:POST:/invented",
              role: "endpoint",
            },
          ],
        },
        context,
      ),
    ).toThrow(/not grounded/);
    expect(() =>
      validateCandidateTriageRecommendationOutput(
        {
          recommendation: "promote",
          rationale: "Ambiguous result.",
          evidenceVersionIds: [],
          confidence: "ambiguous",
          priority: "low",
        },
        context,
      ),
    ).toThrow(/ambiguous recommendations must use decision defer/);
    expect(() =>
      validateCandidateTriageRecommendationOutput(
        {
          recommendation: "defer",
          rationale: "Duplicate candidate.",
          evidenceVersionIds: [],
          confidence: "ambiguous",
          priority: "low",
          duplicateOfCandidateId: context.candidateId,
        },
        context,
      ),
    ).toThrow(/another current Candidate/);
  });

  it("rejects unknown output fields through the closed contract", () => {
    expect(() =>
      validateCandidateTriageRecommendationOutput(
        {
          recommendation: "defer",
          rationale: "No grounded decision.",
          evidenceVersionIds: [],
          confidence: "ambiguous",
          priority: "low",
          providerPayload: "must not cross the boundary",
        },
        context,
      ),
    ).toThrow(/providerPayload is not supported/);
  });

  it("builds the provider schema from the configured Evidence limit", () => {
    expect(
      createCandidateTriageRecommendationSchema(2).properties.evidenceVersionIds
        .maxItems,
    ).toBe(2);
    expect(
      createCandidateTriageRecommendationSchema(12).properties
        .evidenceVersionIds.maxItems,
    ).toBe(12);
    expect(() => createCandidateTriageRecommendationSchema(0)).toThrow(
      "maxEvidenceVersionIds must be a positive integer",
    );
  });
});
