// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateCandidateRecommendations,
  parseCandidateRecommendationEvaluationDataset,
  selectCandidateRecommendationEvaluationDataset,
} from "./candidateRecommendationEvaluation.js";

describe("Candidate Recommendation evaluation", () => {
  it("reports relevance, duplicate, priority, and first-screen metrics", () => {
    const dataset = parseCandidateRecommendationEvaluationDataset({
      schemaVersion: "1",
      repositories: [
        {
          id: "fixture",
          labels: [
            {
              candidateIdentityKey: "candidate:a",
              relevant: true,
              expectedPriority: "high",
            },
            {
              candidateIdentityKey: "candidate:b",
              relevant: false,
              duplicateOfIdentityKey: "candidate:a",
            },
            { candidateIdentityKey: "candidate:c", relevant: true },
          ],
        },
      ],
    });
    const report = evaluateCandidateRecommendations(dataset, [
      {
        candidateIdentityKey: "candidate:a",
        recommendation: "promote",
        priority: "high",
      },
      {
        candidateIdentityKey: "candidate:b",
        recommendation: "promote",
        priority: "low",
        duplicateOfIdentityKey: "candidate:a",
      },
    ]);

    expect(report).toMatchObject({
      repositories: 1,
      labeledCandidates: 3,
      measuredPredictions: 2,
      precision: 0.5,
      recall: 0.5,
      duplicateUsefulness: 1,
      priorityCalibration: 1,
      firstScreenNoise: 0.5,
    });
  });

  it("rejects duplicate labels", () => {
    expect(() =>
      parseCandidateRecommendationEvaluationDataset({
        schemaVersion: "1",
        repositories: [
          {
            id: "fixture",
            labels: [
              { candidateIdentityKey: "same", relevant: true },
              { candidateIdentityKey: "same", relevant: false },
            ],
          },
        ],
      }),
    ).toThrow("duplicates same");
  });

  it("requires explicit repository selection for multi-repository datasets", () => {
    const dataset = parseCandidateRecommendationEvaluationDataset({
      schemaVersion: "1",
      repositories: [
        { id: "one", labels: [] },
        { id: "two", labels: [] },
      ],
    });

    expect(() =>
      selectCandidateRecommendationEvaluationDataset(dataset),
    ).toThrow("multiple repositories");
    expect(
      selectCandidateRecommendationEvaluationDataset(dataset, "two")
        .repositories,
    ).toEqual([{ id: "two", labels: [] }]);
  });

  it("rejects duplicate repository IDs", () => {
    expect(() =>
      parseCandidateRecommendationEvaluationDataset({
        schemaVersion: "1",
        repositories: [
          { id: "same", labels: [] },
          { id: "same", labels: [] },
        ],
      }),
    ).toThrow("duplicates same");
  });
});
