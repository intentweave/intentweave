// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/** Scalar values supported by the claims slice's normalized observations. */
export type ClaimScalar = string | number | boolean | null;

export type RuleApplicability = "applicable" | "not_applicable";
export type RuleResultStatus =
  | "passed"
  | "failed"
  | "inconclusive"
  | "not_applicable";
export type ClaimAssessmentStatus =
  | "supported"
  | "refuted"
  | "contested"
  | "inconclusive";
export type ClaimDependencyKind = "evidence_version" | "rule_result_version";
export type EpistemicRole = "assertion" | "warrant";
export type WarrantPolarity = "supports" | "contradicts" | null;
export type AssessmentEffect = "supports" | "contradicts" | "neutral";

/** The typed dependency tuple persisted for an assessment and its idempotency key. */
export interface ClaimAssessmentDependencyInput {
  dependencyKind: ClaimDependencyKind;
  dependencyVersionId: string;
  epistemicRole: EpistemicRole;
  warrantPolarity: WarrantPolarity;
  assessmentEffect: AssessmentEffect;
}

/** Canonical input for a versioned, normalized rule result. */
export interface RuleResultFingerprintInput {
  applicability: RuleApplicability;
  normalizedStatus: RuleResultStatus;
  normalizedOutput: unknown;
  normalizedReasons: string[];
  evidenceVersionIds: string[];
  ruleContractVersion: string;
  implementationFingerprint: string;
}

/** Canonical input for an evidence materiality comparison. */
export interface MaterialFingerprintInput {
  parameterIdentity: string;
  semanticLocation: string;
  normalizedValue: ClaimScalar;
}

export interface PersistEvidenceInput {
  parameterKey: string;
  sourceKind: string;
  identityKey: string;
  fingerprint: string;
  materialFingerprint: string;
  normalizedValue: ClaimScalar;
  semanticLocation: string;
  provenance: unknown;
  filePath?: string;
  symbolId?: string;
  spanStartLine?: number;
  spanEndLine?: number;
  repositoryRevision?: string;
}

export interface PersistRuleResultInput extends RuleResultFingerprintInput {
  ruleId: string;
  scope?: string;
}

export interface PersistedVersion {
  id: string;
  ordinal: number;
  created: boolean;
}