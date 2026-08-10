// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/** Values supported by the claims slice's normalized observations. */
export type ClaimScalar = string | number | boolean | null | string[];

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

export interface PersistEvidenceContinuityInput {
  fromEvidenceVersionId: string;
  toEvidenceVersionId: string;
  basis: string;
  confidence: string;
  provenance: unknown;
}

export interface AssessmentRuleInput {
  ruleResultVersionId: string;
  epistemicRole: EpistemicRole;
  status: RuleResultStatus;
}

export interface AssessmentResult {
  status: ClaimAssessmentStatus;
  dependencies: ClaimAssessmentDependencyInput[];
}

export interface PersistClaimAssessmentInput {
  parameterKey: string;
  claimType: string;
  scope?: string;
  normalizedStatement: unknown;
  assessmentPolicyId: string;
  assessmentPolicyVersion: string;
  repositoryRevision: string;
  status: ClaimAssessmentStatus;
  dependencies: ClaimAssessmentDependencyInput[];
}

export interface PersistedAssessment {
  id: string;
  claimIdentityId: string;
  claimVersionId: string;
  created: boolean;
}

export type ReopenReason =
  | "material-change"
  | "continuity-uncertain"
  | "continuity-broken"
  | "warrant-changed";

export interface RecordReviewInput {
  claimIdentityId: string;
  basisAssessmentId: string;
  decision: string;
  actor: string;
}

export interface ReopenReviewInput {
  claimIdentityId: string;
  basisAssessmentId: string;
  dependencyKind: ClaimDependencyKind;
  dependencyVersionId: string;
  reason: ReopenReason;
  secondaryProvenance?: unknown;
}

export interface PersistedReviewDecision {
  id: string;
  carriedForward: boolean;
}

export interface PersistedReopen {
  id: string;
  created: boolean;
}

export interface ClaimsExitInput {
  invalidInput?: boolean;
  discoveryEmpty?: boolean;
  ruleStatuses: RuleResultStatus[];
  assessmentStatuses: ClaimAssessmentStatus[];
  reviewRequired: boolean;
}

export interface NormalizedRuleResult {
  applicability: RuleApplicability;
  status: RuleResultStatus;
  output: unknown;
  reasons: string[];
}

export interface ClaimPolicyDependencyInput {
  dependencyKind: ClaimDependencyKind;
  dependencyVersionId: string;
  epistemicRole: EpistemicRole;
  authoritative: boolean;
  assertionValue?: ClaimScalar;
  claimValue?: ClaimScalar;
  ruleStatus?: RuleResultStatus;
}

export interface VersionedClaimValue {
  versionId: string;
  value: ClaimScalar;
}

export interface VersionedScopeEvidence {
  versionId: string;
  capabilities: string[];
}

export interface ClaimsContractVersions {
  r1RuleContractVersion: string;
  r3RuleContractVersion: string;
  r7RuleContractVersion: string;
  implementationFingerprint: string;
  defaultPolicyVersion: string;
  runtimePolicyVersion: string;
  documentationPolicyVersion: string;
}

export interface ClaimsScopeEvaluationInput {
  parameterKey: string;
  scope: string;
  repositoryRevision: string;
  codeDefault?: VersionedClaimValue;
  codeAnnotation?: VersionedClaimValue;
  configOverride?: VersionedClaimValue;
  documentedOverride?: VersionedClaimValue;
  scopeEvidence: VersionedScopeEvidence;
  contracts: ClaimsContractVersions;
}

export interface ClaimsScopeEvaluation {
  ruleResults: PersistedVersion[];
  assessments: PersistedAssessment[];
}