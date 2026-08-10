// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type {
  ClaimAssessmentDependencyInput,
  MaterialFingerprintInput,
  RuleResultFingerprintInput,
} from "./types.js";

/**
 * Deterministic JSON used for all claims fingerprints.
 *
 * Object keys are lexicographically sorted, array order is retained, and an
 * undefined value is rejected so callers cannot accidentally treat it as the
 * explicit JSON `null` required by the assessment dependency contract.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("Canonical JSON does not support non-finite numbers");
      }
      return JSON.stringify(value);
    case "undefined":
      throw new Error("Canonical JSON does not support undefined values");
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
    default:
      throw new Error(`Canonical JSON does not support ${typeof value} values`);
  }
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function materialFingerprint(input: MaterialFingerprintInput): string {
  return fingerprint({
    parameterIdentity: input.parameterIdentity,
    semanticLocation: input.semanticLocation,
    normalizedValue: input.normalizedValue,
  });
}

export function ruleResultFingerprint(
  input: RuleResultFingerprintInput,
): string {
  return fingerprint({
    applicability: input.applicability,
    normalizedStatus: input.normalizedStatus,
    normalizedOutput: input.normalizedOutput,
    normalizedReasons: [...input.normalizedReasons].sort(),
    evidenceVersionIds: [...input.evidenceVersionIds].sort(),
    ruleContractVersion: input.ruleContractVersion,
    implementationFingerprint: input.implementationFingerprint,
  });
}

export function assessmentKey(
  claimVersionId: string,
  dependencies: ClaimAssessmentDependencyInput[],
): string {
  const dependencyTuples = dependencies
    .map((dependency) => [
      dependency.dependencyKind,
      dependency.dependencyVersionId,
      dependency.epistemicRole,
      dependency.warrantPolarity,
      dependency.assessmentEffect,
    ])
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));

  return fingerprint({ claimVersionId, dependencies: dependencyTuples });
}