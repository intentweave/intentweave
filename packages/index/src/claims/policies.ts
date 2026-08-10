// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type {
  AssessmentResult,
  AssessmentRuleInput,
  ClaimPolicyDependencyInput,
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

function policyDependencyFor(
  input: ClaimPolicyDependencyInput,
): ClaimAssessmentDependencyInput {
  if (input.epistemicRole === "assertion") {
    const effect =
      input.assertionValue === undefined || input.claimValue === undefined
        ? "neutral"
        : input.assertionValue === input.claimValue
          ? "supports"
          : "contradicts";
    return {
      dependencyKind: input.dependencyKind,
      dependencyVersionId: input.dependencyVersionId,
      epistemicRole: "assertion",
      warrantPolarity: null,
      assessmentEffect: effect,
    };
  }

  const effect =
    input.ruleStatus === "passed"
      ? "supports"
      : input.ruleStatus === "failed"
        ? "contradicts"
        : "neutral";
  return {
    dependencyKind: input.dependencyKind,
    dependencyVersionId: input.dependencyVersionId,
    epistemicRole: "warrant",
    warrantPolarity:
      effect === "supports" ? "supports" : effect === "contradicts" ? "contradicts" : null,
    assessmentEffect: effect,
  };
}

/**
 * Evaluate one claim under its explicit authority policy.
 *
 * Non-authoritative inputs retain their derived effect for explain/history, but
 * cannot override an authoritative runtime or contract dependency by count.
 */
export function assessClaimPolicy(
  inputs: ClaimPolicyDependencyInput[],
): AssessmentResult {
  const dependencies = inputs.map(policyDependencyFor);
  const authoritative = dependencies.filter((_, index) => inputs[index].authoritative);
  const supports = authoritative.some(
    (dependency) => dependency.assessmentEffect === "supports",
  );
  const contradicts = authoritative.some(
    (dependency) => dependency.assessmentEffect === "contradicts",
  );
  const incomplete = inputs.some(
    (input, index) =>
      input.authoritative &&
      (dependencies[index].assessmentEffect === "neutral" ||
        input.ruleStatus === "inconclusive"),
  );

  if (supports && contradicts) return { status: "contested", dependencies };
  if (contradicts) return { status: "refuted", dependencies };
  if (incomplete || !supports) return { status: "inconclusive", dependencies };
  return { status: "supported", dependencies };
}