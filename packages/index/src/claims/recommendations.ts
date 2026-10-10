// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, fingerprint } from "./canonical.js";
import type { SubjectKind } from "./subjects.js";

export const CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT =
  "candidate-triage-recommendation@1" as const;
export const CANDIDATE_TRIAGE_RECOMMENDATION_ADAPTER_ID =
  "candidate-triage-recommendation" as const;
export const CANDIDATE_TRIAGE_RECOMMENDATION_ADAPTER_CONTRACT_VERSION =
  "1" as const;
export const CANDIDATE_TRIAGE_RECOMMENDATION_PROMPT_VERSION = "1" as const;

export type CandidateTriageRecommendationDecision =
  | "promote"
  | "reject"
  | "suppress"
  | "defer";
export type CandidateTriageRecommendationConfidence = "probable" | "ambiguous";
export type CandidateTriageRecommendationPriority =
  | "critical"
  | "high"
  | "medium"
  | "low";

export interface CandidateTriageRecommendationSubjectBinding {
  kind: SubjectKind;
  identityKey: string;
  role: string;
}

export interface CandidateTriageRecommendationOutputV1 {
  recommendation: CandidateTriageRecommendationDecision;
  rationale: string;
  evidenceVersionIds: string[];
  confidence: CandidateTriageRecommendationConfidence;
  priority: CandidateTriageRecommendationPriority;
  duplicateOfCandidateId?: string;
  proposedClaimType?: string;
  proposedSubjectBindings?: CandidateTriageRecommendationSubjectBinding[];
}

export interface CandidateTriageRecommendationV1 extends CandidateTriageRecommendationOutputV1 {
  contractVersion: typeof CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT;
  inferenceId: string;
  candidateId: string;
  candidateFingerprint: string;
  candidateObservationFingerprint: string;
  contextFingerprint: string;
}

export interface RecommendationGroundingSubject {
  kind: SubjectKind;
  identityKey: string;
  roles: string[];
}

export interface RecommendationGroundingContext {
  candidateId: string;
  candidateFingerprint?: string;
  candidateObservationFingerprint: string;
  contextFingerprint: string;
  candidateClaimType: string;
  evidenceVersionIds: string[];
  subjects: RecommendationGroundingSubject[];
  requiredSubjectRoles?: string[];
  allowedClaimTypes?: string[];
  currentCandidateIds?: string[];
  maxEvidenceVersionIds?: number;
}

function buildCandidateTriageRecommendationSchema(
  maxEvidenceVersionIds: number,
) {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: [
      "recommendation",
      "rationale",
      "evidenceVersionIds",
      "confidence",
      "priority",
    ],
    properties: {
      recommendation: {
        type: "string",
        enum: ["promote", "reject", "suppress", "defer"],
      },
      rationale: { type: "string", minLength: 1, maxLength: 2000 },
      evidenceVersionIds: {
        type: "array",
        items: { type: "string", minLength: 1 },
        uniqueItems: true,
        maxItems: maxEvidenceVersionIds,
      },
      confidence: { type: "string", enum: ["probable", "ambiguous"] },
      priority: {
        type: "string",
        enum: ["critical", "high", "medium", "low"],
      },
      duplicateOfCandidateId: { type: "string", minLength: 1 },
      proposedClaimType: { type: "string", minLength: 1 },
      proposedSubjectBindings: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "identityKey", "role"],
          properties: {
            kind: {
              type: "string",
              enum: ["parameter", "symbol", "module", "endpoint"],
            },
            identityKey: { type: "string", minLength: 1 },
            role: { type: "string", minLength: 1 },
          },
        },
      },
    },
  } as const;
}

export const CANDIDATE_TRIAGE_RECOMMENDATION_SCHEMA =
  buildCandidateTriageRecommendationSchema(8);

export function createCandidateTriageRecommendationSchema(
  maxEvidenceVersionIds: number,
) {
  if (!Number.isInteger(maxEvidenceVersionIds) || maxEvidenceVersionIds <= 0) {
    throw new CandidateRecommendationValidationError(
      "maxEvidenceVersionIds must be a positive integer",
    );
  }
  return buildCandidateTriageRecommendationSchema(maxEvidenceVersionIds);
}

export class CandidateRecommendationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateRecommendationValidationError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CandidateRecommendationValidationError(
      `${path} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CandidateRecommendationValidationError(
      `${path} must be a non-empty string`,
    );
  }
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new CandidateRecommendationValidationError(
      `${path} must be one of: ${values.join(", ")}`,
    );
  }
  return value as T;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  path: string,
  keys: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new CandidateRecommendationValidationError(
        `${path}.${key} is not supported`,
      );
    }
  }
}

function uniqueStrings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new CandidateRecommendationValidationError(
      `${path} must be an array`,
    );
  }
  const values = value.map((item, index) =>
    requiredString(item, `${path}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    throw new CandidateRecommendationValidationError(
      `${path} must not contain duplicates`,
    );
  }
  return values;
}

function validateSubjectBindings(
  value: unknown,
  context: RecommendationGroundingContext,
): CandidateTriageRecommendationSubjectBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CandidateRecommendationValidationError(
      "proposedSubjectBindings must be an array",
    );
  }
  const allowed = new Map(
    context.subjects.map((subject) => [subject.identityKey, subject]),
  );
  const seen = new Set<string>();
  const bindings = value.map((item, index) => {
    const binding = record(item, `proposedSubjectBindings[${index}]`);
    assertOnlyKeys(binding, `proposedSubjectBindings[${index}]`, [
      "kind",
      "identityKey",
      "role",
    ]);
    const kind = enumValue(
      binding.kind,
      `proposedSubjectBindings[${index}].kind`,
      ["parameter", "symbol", "module", "endpoint"],
    );
    const identityKey = requiredString(
      binding.identityKey,
      `proposedSubjectBindings[${index}].identityKey`,
    );
    const role = requiredString(
      binding.role,
      `proposedSubjectBindings[${index}].role`,
    );
    const subject = allowed.get(identityKey);
    if (!subject || subject.kind !== kind || !subject.roles.includes(role)) {
      throw new CandidateRecommendationValidationError(
        `proposedSubjectBindings[${index}] is not grounded in the supplied context`,
      );
    }
    const key = canonicalJson([kind, identityKey, role]);
    if (seen.has(key)) {
      throw new CandidateRecommendationValidationError(
        `proposedSubjectBindings[${index}] duplicates an earlier binding`,
      );
    }
    seen.add(key);
    return { kind, identityKey, role };
  });
  return bindings;
}

/** Validate closed recommendation output and ground every repository reference. */
export function validateCandidateTriageRecommendationOutput(
  value: unknown,
  context: RecommendationGroundingContext,
): CandidateTriageRecommendationOutputV1 {
  const output = record(value, "Recommendation");
  assertOnlyKeys(output, "Recommendation", [
    "recommendation",
    "rationale",
    "evidenceVersionIds",
    "confidence",
    "priority",
    "duplicateOfCandidateId",
    "proposedClaimType",
    "proposedSubjectBindings",
  ]);
  const recommendation = enumValue(output.recommendation, "recommendation", [
    "promote",
    "reject",
    "suppress",
    "defer",
  ]);
  const rationale = requiredString(output.rationale, "rationale");
  if (rationale.length > 2000) {
    throw new CandidateRecommendationValidationError(
      "rationale must be at most 2000 characters",
    );
  }
  const evidenceVersionIds = uniqueStrings(
    output.evidenceVersionIds,
    "evidenceVersionIds",
  );
  const maxEvidence = context.maxEvidenceVersionIds ?? 8;
  if (evidenceVersionIds.length > maxEvidence) {
    throw new CandidateRecommendationValidationError(
      `evidenceVersionIds must contain at most ${maxEvidence} items`,
    );
  }
  for (const evidenceVersionId of evidenceVersionIds) {
    if (!context.evidenceVersionIds.includes(evidenceVersionId)) {
      throw new CandidateRecommendationValidationError(
        `evidenceVersionIds contains ungrounded EvidenceVersion ${evidenceVersionId}`,
      );
    }
  }
  const confidence = enumValue(output.confidence, "confidence", [
    "probable",
    "ambiguous",
  ]);
  const priority = enumValue(output.priority, "priority", [
    "critical",
    "high",
    "medium",
    "low",
  ]);
  if (confidence === "ambiguous" && recommendation !== "defer") {
    throw new CandidateRecommendationValidationError(
      "ambiguous recommendations must use decision defer",
    );
  }
  const proposedClaimType =
    output.proposedClaimType === undefined
      ? undefined
      : requiredString(output.proposedClaimType, "proposedClaimType");
  if (
    proposedClaimType &&
    context.allowedClaimTypes &&
    !context.allowedClaimTypes.includes(proposedClaimType)
  ) {
    throw new CandidateRecommendationValidationError(
      `proposedClaimType ${proposedClaimType} is not registered in the supplied context`,
    );
  }
  const proposedSubjectBindings = validateSubjectBindings(
    output.proposedSubjectBindings,
    context,
  );
  if (confidence === "probable") {
    if (evidenceVersionIds.length === 0) {
      throw new CandidateRecommendationValidationError(
        "probable recommendations require at least one grounded EvidenceVersion",
      );
    }
    const requiredRoles = context.requiredSubjectRoles ?? [];
    const roles = new Set(
      (proposedSubjectBindings ?? []).map((binding) => binding.role),
    );
    for (const role of requiredRoles) {
      if (!roles.has(role)) {
        throw new CandidateRecommendationValidationError(
          `probable recommendations require grounded Subject role ${role}`,
        );
      }
    }
  }
  const duplicateOfCandidateId =
    output.duplicateOfCandidateId === undefined
      ? undefined
      : requiredString(output.duplicateOfCandidateId, "duplicateOfCandidateId");
  if (duplicateOfCandidateId !== undefined) {
    if (
      duplicateOfCandidateId === context.candidateId ||
      !context.currentCandidateIds?.includes(duplicateOfCandidateId)
    ) {
      throw new CandidateRecommendationValidationError(
        "duplicateOfCandidateId must name another current Candidate",
      );
    }
  }
  return {
    recommendation,
    rationale,
    evidenceVersionIds,
    confidence,
    priority,
    ...(duplicateOfCandidateId === undefined ? {} : { duplicateOfCandidateId }),
    ...(proposedClaimType === undefined ? {} : { proposedClaimType }),
    ...(proposedSubjectBindings === undefined
      ? {}
      : { proposedSubjectBindings }),
  };
}

export function validateCandidateTriageRecommendation(
  value: unknown,
  context: RecommendationGroundingContext,
): CandidateTriageRecommendationV1 {
  const envelope = record(value, "Recommendation envelope");
  assertOnlyKeys(envelope, "Recommendation envelope", [
    "contractVersion",
    "recommendation",
    "rationale",
    "evidenceVersionIds",
    "confidence",
    "priority",
    "duplicateOfCandidateId",
    "proposedClaimType",
    "proposedSubjectBindings",
    "inferenceId",
    "candidateId",
    "candidateFingerprint",
    "candidateObservationFingerprint",
    "contextFingerprint",
  ]);
  if (envelope.contractVersion !== CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT) {
    throw new CandidateRecommendationValidationError(
      `contractVersion must be ${CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT}`,
    );
  }
  const outputValue: Record<string, unknown> = {};
  for (const key of [
    "recommendation",
    "rationale",
    "evidenceVersionIds",
    "confidence",
    "priority",
    "duplicateOfCandidateId",
    "proposedClaimType",
    "proposedSubjectBindings",
  ]) {
    if (key in envelope) outputValue[key] = envelope[key];
  }
  const output = validateCandidateTriageRecommendationOutput(
    outputValue,
    context,
  );
  const inferenceId = requiredString(
    envelope.inferenceId,
    "Recommendation envelope.inferenceId",
  );
  const candidateId = requiredString(
    envelope.candidateId,
    "Recommendation envelope.candidateId",
  );
  const candidateFingerprint = requiredString(
    envelope.candidateFingerprint,
    "Recommendation envelope.candidateFingerprint",
  );
  const candidateObservationFingerprint = requiredString(
    envelope.candidateObservationFingerprint,
    "Recommendation envelope.candidateObservationFingerprint",
  );
  const contextFingerprint = requiredString(
    envelope.contextFingerprint,
    "Recommendation envelope.contextFingerprint",
  );
  if (candidateId !== context.candidateId) {
    throw new CandidateRecommendationValidationError(
      "Recommendation envelope candidateId is not grounded in the supplied context",
    );
  }
  if (
    context.candidateFingerprint !== undefined &&
    candidateFingerprint !== context.candidateFingerprint
  ) {
    throw new CandidateRecommendationValidationError(
      "Recommendation envelope candidateFingerprint is not grounded in the supplied context",
    );
  }
  if (
    candidateObservationFingerprint !== context.candidateObservationFingerprint
  ) {
    throw new CandidateRecommendationValidationError(
      "Recommendation envelope candidateObservationFingerprint is not grounded in the supplied context",
    );
  }
  if (contextFingerprint !== context.contextFingerprint) {
    throw new CandidateRecommendationValidationError(
      "Recommendation envelope contextFingerprint is not grounded in the supplied context",
    );
  }
  return {
    contractVersion: CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT,
    ...output,
    inferenceId,
    candidateId,
    candidateFingerprint,
    candidateObservationFingerprint,
    contextFingerprint,
  };
}

/** Attach authoritative local identity and fingerprint metadata to validated output. */
export function createCandidateTriageRecommendation(
  output: CandidateTriageRecommendationOutputV1,
  input: {
    inferenceId: string;
    candidateId: string;
    candidateFingerprint: string;
    candidateObservationFingerprint: string;
    contextFingerprint: string;
  },
): CandidateTriageRecommendationV1 {
  return {
    contractVersion: CANDIDATE_TRIAGE_RECOMMENDATION_CONTRACT,
    ...output,
    ...input,
  };
}

export function candidateRecommendationOutputFingerprint(
  output: CandidateTriageRecommendationOutputV1,
): string {
  return fingerprint({
    recommendation: output.recommendation,
    rationale: output.rationale,
    evidenceVersionIds: output.evidenceVersionIds,
    confidence: output.confidence,
    priority: output.priority,
    ...(output.duplicateOfCandidateId === undefined
      ? {}
      : { duplicateOfCandidateId: output.duplicateOfCandidateId }),
    ...(output.proposedClaimType === undefined
      ? {}
      : { proposedClaimType: output.proposedClaimType }),
    ...(output.proposedSubjectBindings === undefined
      ? {}
      : { proposedSubjectBindings: output.proposedSubjectBindings }),
  });
}

export function candidateRecommendationKey(
  recommendation: CandidateTriageRecommendationV1,
): string {
  return fingerprint({
    contractVersion: recommendation.contractVersion,
    outputFingerprint: candidateRecommendationOutputFingerprint(recommendation),
    candidateObservationFingerprint:
      recommendation.candidateObservationFingerprint,
    contextFingerprint: recommendation.contextFingerprint,
  });
}
