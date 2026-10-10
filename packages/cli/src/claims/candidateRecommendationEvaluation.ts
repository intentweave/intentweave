// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { load as yamlLoad, JSON_SCHEMA } from "js-yaml";

export type EvaluationPriority = "critical" | "high" | "medium" | "low";

export interface CandidateRecommendationLabel {
  candidateIdentityKey: string;
  relevant: boolean;
  duplicateOfIdentityKey?: string;
  expectedPriority?: EvaluationPriority;
}

export interface CandidateRecommendationEvaluationDataset {
  schemaVersion: "1";
  repositories: Array<{
    id: string;
    labels: CandidateRecommendationLabel[];
  }>;
}

export interface CandidateRecommendationPrediction {
  candidateIdentityKey: string;
  recommendation: "promote" | "reject" | "suppress" | "defer";
  priority: EvaluationPriority;
  duplicateOfIdentityKey?: string;
}

export interface CandidateRecommendationEvaluationReport {
  contract: "candidate-recommendation-evaluation@1";
  repositories: number;
  labeledCandidates: number;
  measuredPredictions: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  duplicateUsefulness: number | null;
  priorityCalibration: number | null;
  firstScreenNoise: number | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function priority(value: unknown, label: string): EvaluationPriority {
  if (!["critical", "high", "medium", "low"].includes(String(value))) {
    throw new Error(`${label} must be critical, high, medium, or low`);
  }
  return value as EvaluationPriority;
}

export function parseCandidateRecommendationEvaluationDataset(
  value: unknown,
): CandidateRecommendationEvaluationDataset {
  const root = record(value, "Evaluation dataset");
  if (root.schemaVersion !== "1") {
    throw new Error("Evaluation dataset schemaVersion must be 1");
  }
  if (!Array.isArray(root.repositories) || root.repositories.length === 0) {
    throw new Error("Evaluation dataset repositories must not be empty");
  }
  const repositories = root.repositories.map((item, repositoryIndex) => {
    const repository = record(item, `repositories[${repositoryIndex}]`);
    if (!Array.isArray(repository.labels)) {
      throw new Error(
        `repositories[${repositoryIndex}].labels must be an array`,
      );
    }
    const seen = new Set<string>();
    const labels = repository.labels.map((labelItem, labelIndex) => {
      const labelPath = `repositories[${repositoryIndex}].labels[${labelIndex}]`;
      const label = record(labelItem, labelPath);
      const candidateIdentityKey = string(
        label.candidateIdentityKey,
        `${labelPath}.candidateIdentityKey`,
      );
      if (seen.has(candidateIdentityKey)) {
        throw new Error(`${labelPath} duplicates ${candidateIdentityKey}`);
      }
      seen.add(candidateIdentityKey);
      if (typeof label.relevant !== "boolean") {
        throw new Error(`${labelPath}.relevant must be boolean`);
      }
      return {
        candidateIdentityKey,
        relevant: label.relevant,
        ...(label.duplicateOfIdentityKey === undefined
          ? {}
          : {
              duplicateOfIdentityKey: string(
                label.duplicateOfIdentityKey,
                `${labelPath}.duplicateOfIdentityKey`,
              ),
            }),
        ...(label.expectedPriority === undefined
          ? {}
          : {
              expectedPriority: priority(
                label.expectedPriority,
                `${labelPath}.expectedPriority`,
              ),
            }),
      };
    });
    return {
      id: string(repository.id, `repositories[${repositoryIndex}].id`),
      labels,
    };
  });
  return { schemaVersion: "1", repositories };
}

export function loadCandidateRecommendationEvaluationDataset(
  filePath: string,
): CandidateRecommendationEvaluationDataset {
  return parseCandidateRecommendationEvaluationDataset(
    yamlLoad(readFileSync(filePath, "utf-8"), {
      schema: JSON_SCHEMA,
      filename: filePath,
    }),
  );
}

export function selectCandidateRecommendationEvaluationDataset(
  dataset: CandidateRecommendationEvaluationDataset,
  repositoryId?: string,
): CandidateRecommendationEvaluationDataset {
  if (!repositoryId && dataset.repositories.length > 1) {
    throw new Error(
      "Evaluation dataset contains multiple repositories; select one with --repository",
    );
  }
  const repository = repositoryId
    ? dataset.repositories.find((item) => item.id === repositoryId)
    : dataset.repositories[0];
  if (!repository) {
    throw new Error(`Evaluation repository ${repositoryId} does not exist`);
  }
  return { schemaVersion: "1", repositories: [repository] };
}

const PRIORITY_ORDER: Record<EvaluationPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0
    ? null
    : Number((numerator / denominator).toFixed(4));
}

export function evaluateCandidateRecommendations(
  dataset: CandidateRecommendationEvaluationDataset,
  predictions: readonly CandidateRecommendationPrediction[],
): CandidateRecommendationEvaluationReport {
  const labels = new Map(
    dataset.repositories.flatMap((repository) =>
      repository.labels.map(
        (label) => [label.candidateIdentityKey, label] as const,
      ),
    ),
  );
  const measured = predictions.filter((prediction) =>
    labels.has(prediction.candidateIdentityKey),
  );
  const promoted = measured.filter(
    (prediction) => prediction.recommendation === "promote",
  );
  const truePositives = promoted.filter(
    (prediction) => labels.get(prediction.candidateIdentityKey)!.relevant,
  ).length;
  const falsePositives = promoted.length - truePositives;
  const predictedKeys = new Set(
    promoted.map((item) => item.candidateIdentityKey),
  );
  const relevantLabels = [...labels.values()].filter((label) => label.relevant);
  const falseNegatives = relevantLabels.filter(
    (label) => !predictedKeys.has(label.candidateIdentityKey),
  ).length;

  const duplicateLabels = [...labels.values()].filter(
    (label) => label.duplicateOfIdentityKey,
  );
  const usefulDuplicates = duplicateLabels.filter((label) => {
    const prediction = measured.find(
      (item) => item.candidateIdentityKey === label.candidateIdentityKey,
    );
    return prediction?.duplicateOfIdentityKey === label.duplicateOfIdentityKey;
  }).length;

  const priorityLabels = [...labels.values()].filter(
    (label) => label.expectedPriority,
  );
  const calibrated = priorityLabels.filter((label) => {
    const prediction = measured.find(
      (item) => item.candidateIdentityKey === label.candidateIdentityKey,
    );
    return prediction?.priority === label.expectedPriority;
  }).length;

  const firstScreen = [...measured]
    .sort(
      (left, right) =>
        PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
        left.candidateIdentityKey.localeCompare(right.candidateIdentityKey),
    )
    .slice(0, 20);
  const firstScreenNoise = firstScreen.filter(
    (prediction) => !labels.get(prediction.candidateIdentityKey)!.relevant,
  ).length;

  return {
    contract: "candidate-recommendation-evaluation@1",
    repositories: dataset.repositories.length,
    labeledCandidates: labels.size,
    measuredPredictions: measured.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    duplicateUsefulness: ratio(usefulDuplicates, duplicateLabels.length),
    priorityCalibration: ratio(calibrated, priorityLabels.length),
    firstScreenNoise: ratio(firstScreenNoise, firstScreen.length),
  };
}
