// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type {
  AssessmentResult,
  AssessmentRuleInput,
  ClaimAssessmentDependencyInput,
} from "./types.js";

function dependencyFor(
  input: AssessmentRuleInput,
): ClaimAssessmentDependencyInput {
  switch (input.status) {
    case "passed":
      return {
        dependencyKind: "rule_result_version",
        dependencyVersionId: input.ruleResultVersionId,
        epistemicRole: input.epistemicRole,
        warrantPolarity: input.epistemicRole === "warrant" ? "supports" : null,
        assessmentEffect: "supports",
      };
    case "failed":
      return {
        dependencyKind: "rule_result_version",
        dependencyVersionId: input.ruleResultVersionId,
        epistemicRole: input.epistemicRole,
        warrantPolarity:
          input.epistemicRole === "warrant" ? "contradicts" : null,
        assessmentEffect: "contradicts",
      };
    case "inconclusive":
    case "not_applicable":
      return {
        dependencyKind: "rule_result_version",
        dependencyVersionId: input.ruleResultVersionId,
        epistemicRole: input.epistemicRole,
        warrantPolarity: null,
        assessmentEffect: "neutral",
      };
  }
}

/**
 * Evaluate normalized rule outputs without treating absent findings as success.
 *
 * A claim cannot be supported until at least one applicable result supports it
 * and no applicable result is inconclusive. Failed inputs are contrary evidence;
 * when both directions are present, the result is explicitly contested.
 */
export function assessRuleResults(
  inputs: AssessmentRuleInput[],
): AssessmentResult {
  const dependencies = inputs.map(dependencyFor);
  const effects = dependencies.map((dependency) => dependency.assessmentEffect);
  const supports = effects.includes("supports");
  const contradicts = effects.includes("contradicts");
  const inconclusive = inputs.some((input) => input.status === "inconclusive");

  if (supports && contradicts) return { status: "contested", dependencies };
  if (contradicts) return { status: "refuted", dependencies };
  if (inconclusive || !supports) return { status: "inconclusive", dependencies };
  return { status: "supported", dependencies };
}