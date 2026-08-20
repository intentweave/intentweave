// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

export const CLAIMS_PORTABLE_STATE_SCHEMA_VERSION = "1" as const;

export type PortableJsonValue =
  | null
  | boolean
  | number
  | string
  | PortableJsonValue[]
  | { [key: string]: PortableJsonValue };

export interface PortableClaimsActor {
  kind: "human" | "policy";
  id: string;
  version?: string;
}

export interface PortableClaimsPolicy {
  version: string;
  enabled: boolean;
  configuration: Record<string, PortableJsonValue>;
}

export interface PortableCandidateDecision {
  decision: "promote" | "reject" | "suppress";
  candidateFingerprint: string;
  actor: PortableClaimsActor;
  decidedAt: string;
  rationale: string;
}

export interface PortableSubjectBinding {
  subjectIdentity: string;
  subjectRole: string;
  evidenceIdentity: string;
  confidence: "certain" | "probable";
  basis: "explicit" | "deterministic" | "policy" | "inference";
  actor: PortableClaimsActor;
  boundAt: string;
  rationale: string;
  inferenceFingerprint?: string;
}

export interface PortableAssessmentReview {
  decision: "accepted" | "rejected";
  assessmentFingerprint: string;
  assessmentPolicyId: string;
  assessmentPolicyVersion: string;
  actor: PortableClaimsActor;
  decidedAt: string;
  rationale: string;
}

export interface PortableBaselineAcceptance {
  repositoryRevision: string;
  claims: Record<string, string>;
  actor: PortableClaimsActor;
  acceptedAt: string;
  rationale: string;
}

export interface PortableClaimsState {
  schemaVersion: typeof CLAIMS_PORTABLE_STATE_SCHEMA_VERSION;
  policies: Record<string, PortableClaimsPolicy>;
  candidateDecisions: Record<string, PortableCandidateDecision>;
  subjectBindings: Record<string, PortableSubjectBinding>;
  assessmentReviews: Record<string, PortableAssessmentReview>;
  baselineAcceptances: Record<string, PortableBaselineAcceptance>;
}

export class ClaimsPortableStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsPortableStateError";
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimsPortableStateError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new ClaimsPortableStateError(`${path}.${key} is not supported`);
    }
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClaimsPortableStateError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ClaimsPortableStateError(`${path} must be a boolean`);
  }
  return value;
}

function requireEnum<const T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ClaimsPortableStateError(
      `${path} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function requireFingerprint(value: unknown, path: string): string {
  const fingerprint = requireString(value, path);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new ClaimsPortableStateError(
      `${path} must be a lowercase SHA-256 fingerprint`,
    );
  }
  return fingerprint;
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireString(value, path);
  const parsed = Date.parse(timestamp);
  const normalized = timestamp.includes(".")
    ? timestamp
    : timestamp.replace("Z", ".000Z");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== normalized
  ) {
    throw new ClaimsPortableStateError(
      `${path} must be an RFC 3339 UTC timestamp`,
    );
  }
  return timestamp;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

function parseActor(value: unknown, path: string): PortableClaimsActor {
  const actor = requireRecord(value, path);
  assertOnlyKeys(actor, path, ["kind", "id", "version"]);
  const kind = requireEnum(actor.kind, `${path}.kind`, ["human", "policy"]);
  const version = optionalString(actor.version, `${path}.version`);
  if (kind === "policy" && version === undefined) {
    throw new ClaimsPortableStateError(
      `${path}.version is required for a policy actor`,
    );
  }
  if (kind === "human" && version !== undefined) {
    throw new ClaimsPortableStateError(
      `${path}.version is only valid for a policy actor`,
    );
  }
  return {
    kind,
    id: requireString(actor.id, `${path}.id`),
    ...(version === undefined ? {} : { version }),
  };
}

function parseJsonValue(value: unknown, path: string): PortableJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ClaimsPortableStateError(`${path} must be a finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      parseJsonValue(item, `${path}[${index}]`),
    );
  }
  const object = requireRecord(value, path);
  return sortRecord(
    Object.fromEntries(
      Object.entries(object).map(([key, item]) => [
        key,
        parseJsonValue(item, `${path}.${key}`),
      ]),
    ),
  );
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseMap<T>(
  value: unknown,
  path: string,
  parseEntry: (value: unknown, path: string, key: string) => T,
): Record<string, T> {
  const record = requireRecord(value, path);
  const parsed: Array<[string, T]> = [];
  for (const [key, entry] of Object.entries(record)) {
    requireString(key, `${path} key`);
    parsed.push([key, parseEntry(entry, `${path}.${key}`, key)]);
  }
  return Object.fromEntries(
    parsed.sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parsePolicy(value: unknown, path: string): PortableClaimsPolicy {
  const policy = requireRecord(value, path);
  assertOnlyKeys(policy, path, ["version", "enabled", "configuration"]);
  const configuration =
    policy.configuration === undefined
      ? {}
      : requireRecord(
          parseJsonValue(policy.configuration, `${path}.configuration`),
          `${path}.configuration`,
        );
  return {
    version: requireString(policy.version, `${path}.version`),
    enabled: requireBoolean(policy.enabled, `${path}.enabled`),
    configuration: configuration as Record<string, PortableJsonValue>,
  };
}

function parseCandidateDecision(
  value: unknown,
  path: string,
): PortableCandidateDecision {
  const decision = requireRecord(value, path);
  assertOnlyKeys(decision, path, [
    "decision",
    "candidateFingerprint",
    "actor",
    "decidedAt",
    "rationale",
  ]);
  const actor = parseActor(decision.actor, `${path}.actor`);
  return {
    decision: requireEnum(decision.decision, `${path}.decision`, [
      "promote",
      "reject",
      "suppress",
    ]),
    candidateFingerprint: requireFingerprint(
      decision.candidateFingerprint,
      `${path}.candidateFingerprint`,
    ),
    actor,
    decidedAt: requireTimestamp(decision.decidedAt, `${path}.decidedAt`),
    rationale: requireString(decision.rationale, `${path}.rationale`),
  };
}

function parseSubjectBinding(
  value: unknown,
  path: string,
): PortableSubjectBinding {
  const binding = requireRecord(value, path);
  assertOnlyKeys(binding, path, [
    "subjectIdentity",
    "subjectRole",
    "evidenceIdentity",
    "confidence",
    "basis",
    "actor",
    "boundAt",
    "rationale",
    "inferenceFingerprint",
  ]);
  const actor = parseActor(binding.actor, `${path}.actor`);
  const basis = requireEnum(binding.basis, `${path}.basis`, [
    "explicit",
    "deterministic",
    "policy",
    "inference",
  ]);
  const inferenceFingerprint =
    binding.inferenceFingerprint === undefined
      ? undefined
      : requireFingerprint(
          binding.inferenceFingerprint,
          `${path}.inferenceFingerprint`,
        );
  if (basis === "inference" && inferenceFingerprint === undefined) {
    throw new ClaimsPortableStateError(
      `${path}.inferenceFingerprint is required for inference basis`,
    );
  }
  if (basis !== "inference" && inferenceFingerprint !== undefined) {
    throw new ClaimsPortableStateError(
      `${path}.inferenceFingerprint is only valid for inference basis`,
    );
  }
  return {
    subjectIdentity: requireString(
      binding.subjectIdentity,
      `${path}.subjectIdentity`,
    ),
    subjectRole: requireString(binding.subjectRole, `${path}.subjectRole`),
    evidenceIdentity: requireString(
      binding.evidenceIdentity,
      `${path}.evidenceIdentity`,
    ),
    confidence: requireEnum(binding.confidence, `${path}.confidence`, [
      "certain",
      "probable",
    ]),
    basis,
    actor,
    boundAt: requireTimestamp(binding.boundAt, `${path}.boundAt`),
    rationale: requireString(binding.rationale, `${path}.rationale`),
    ...(inferenceFingerprint === undefined ? {} : { inferenceFingerprint }),
  };
}

function parseAssessmentReview(
  value: unknown,
  path: string,
): PortableAssessmentReview {
  const review = requireRecord(value, path);
  assertOnlyKeys(review, path, [
    "decision",
    "assessmentFingerprint",
    "assessmentPolicyId",
    "assessmentPolicyVersion",
    "actor",
    "decidedAt",
    "rationale",
  ]);
  return {
    decision: requireEnum(review.decision, `${path}.decision`, [
      "accepted",
      "rejected",
    ]),
    assessmentFingerprint: requireFingerprint(
      review.assessmentFingerprint,
      `${path}.assessmentFingerprint`,
    ),
    assessmentPolicyId: requireString(
      review.assessmentPolicyId,
      `${path}.assessmentPolicyId`,
    ),
    assessmentPolicyVersion: requireString(
      review.assessmentPolicyVersion,
      `${path}.assessmentPolicyVersion`,
    ),
    actor: parseActor(review.actor, `${path}.actor`),
    decidedAt: requireTimestamp(review.decidedAt, `${path}.decidedAt`),
    rationale: requireString(review.rationale, `${path}.rationale`),
  };
}

function parseBaselineAcceptance(
  value: unknown,
  path: string,
): PortableBaselineAcceptance {
  const baseline = requireRecord(value, path);
  assertOnlyKeys(baseline, path, [
    "repositoryRevision",
    "claims",
    "actor",
    "acceptedAt",
    "rationale",
  ]);
  const claims = parseMap(
    baseline.claims,
    `${path}.claims`,
    (entry, claimPath) => requireFingerprint(entry, claimPath),
  );
  if (Object.keys(claims).length === 0) {
    throw new ClaimsPortableStateError(`${path}.claims must not be empty`);
  }
  return {
    repositoryRevision: requireString(
      baseline.repositoryRevision,
      `${path}.repositoryRevision`,
    ),
    claims,
    actor: parseActor(baseline.actor, `${path}.actor`),
    acceptedAt: requireTimestamp(baseline.acceptedAt, `${path}.acceptedAt`),
    rationale: requireString(baseline.rationale, `${path}.rationale`),
  };
}

function assertNoSubjectBindingConflicts(
  bindings: Record<string, PortableSubjectBinding>,
): void {
  const effectiveSlots = new Map<string, string>();
  for (const [bindingId, binding] of Object.entries(bindings)) {
    const slot = JSON.stringify([
      binding.evidenceIdentity,
      binding.subjectRole,
    ]);
    const previous = effectiveSlots.get(slot);
    if (previous !== undefined) {
      throw new ClaimsPortableStateError(
        `subjectBindings.${bindingId} conflicts with subjectBindings.${previous} for the same evidence identity and role`,
      );
    }
    effectiveSlots.set(slot, bindingId);
  }
}

function assertNoBaselineConflicts(
  baselines: Record<string, PortableBaselineAcceptance>,
): void {
  const acceptedClaims = new Map<string, string>();
  for (const [baselineId, baseline] of Object.entries(baselines)) {
    for (const claimIdentity of Object.keys(baseline.claims)) {
      const previous = acceptedClaims.get(claimIdentity);
      if (previous !== undefined) {
        throw new ClaimsPortableStateError(
          `baselineAcceptances.${baselineId} conflicts with baselineAcceptances.${previous} for claim ${claimIdentity}`,
        );
      }
      acceptedClaims.set(claimIdentity, baselineId);
    }
  }
}

/** Validate and canonicalize the repository-portable effective Claims state. */
export function parsePortableClaimsState(value: unknown): PortableClaimsState {
  const state = requireRecord(value, "Claims portable state");
  assertOnlyKeys(state, "Claims portable state", [
    "schemaVersion",
    "policies",
    "candidateDecisions",
    "subjectBindings",
    "assessmentReviews",
    "baselineAcceptances",
  ]);
  if (state.schemaVersion !== CLAIMS_PORTABLE_STATE_SCHEMA_VERSION) {
    throw new ClaimsPortableStateError(
      `Claims portable state schemaVersion must be ${CLAIMS_PORTABLE_STATE_SCHEMA_VERSION}`,
    );
  }

  const parsed: PortableClaimsState = {
    schemaVersion: CLAIMS_PORTABLE_STATE_SCHEMA_VERSION,
    policies: parseMap(state.policies, "policies", parsePolicy),
    candidateDecisions: parseMap(
      state.candidateDecisions,
      "candidateDecisions",
      parseCandidateDecision,
    ),
    subjectBindings: parseMap(
      state.subjectBindings,
      "subjectBindings",
      parseSubjectBinding,
    ),
    assessmentReviews: parseMap(
      state.assessmentReviews,
      "assessmentReviews",
      parseAssessmentReview,
    ),
    baselineAcceptances: parseMap(
      state.baselineAcceptances,
      "baselineAcceptances",
      parseBaselineAcceptance,
    ),
  };
  assertNoSubjectBindingConflicts(parsed.subjectBindings);
  assertNoBaselineConflicts(parsed.baselineAcceptances);
  return parsed;
}

export function emptyPortableClaimsState(): PortableClaimsState {
  return {
    schemaVersion: CLAIMS_PORTABLE_STATE_SCHEMA_VERSION,
    policies: {},
    candidateDecisions: {},
    subjectBindings: {},
    assessmentReviews: {},
    baselineAcceptances: {},
  };
}
