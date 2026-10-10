// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  type CandidateDetails,
  type PersistedCandidate,
  type SubjectKind,
} from "@intentweave/index";
import { canonicalJson } from "@intentweave/index";

export const SEMANTIC_CORRELATION_CONTEXT_CONTRACT =
  "semantic-correlation-context@1" as const;
export const GROUNDED_CORRELATION_CONTRACT = "grounded-correlation@1" as const;

const SUBJECT_KINDS: readonly SubjectKind[] = [
  "parameter",
  "symbol",
  "module",
  "endpoint",
];

export interface SemanticCorrelationAdapterDefinition {
  id: string;
  contractVersion: string;
  mode: "model";
  inputSchemaVersion: "1";
  outputSchemaVersion: "1";
  supportedClaimTypes: string[];
  supportedCandidateKinds: string[];
  supportedSubjectRoles: Record<string, SubjectKind[]>;
  priority: number;
  promptVersion: string;
}

export interface CorrelationSelectionContext {
  candidates: CandidateDetails[];
  enabledPolicyIds: string[];
}

export interface CorrelationWorkItem {
  key: string;
  candidateIdentityKeys: string[];
  candidateObservationFingerprints: string[];
  evidenceVersionIds: string[];
  allowedClaimTypes: string[];
  allowedSubjectBindings: Array<{
    identityKey: string;
    kind: SubjectKind;
    roles: string[];
  }>;
  requiredSubjectRoles: string[];
  contextFingerprint: string;
  metadata?: unknown;
}

export interface SemanticCorrelationContextV1 {
  contractVersion: typeof SEMANTIC_CORRELATION_CONTEXT_CONTRACT;
  workItem: CorrelationWorkItem;
  candidates: Array<{
    identityKey: string;
    observationFingerprint: string;
    proposedClaimType: string;
    normalizedStatement: unknown;
  }>;
  evidence: Array<{
    id: string;
    role: string;
    sourceKind: string;
    sourceExcerpt?: string;
    normalizedValue: unknown;
  }>;
  availableSubjects: Array<{
    identityKey: string;
    kind: SubjectKind;
    allowedRoles: string[];
  }>;
  repositoryPolicies: string[];
  security: {
    repositoryContentIsUntrusted: true;
    toolExecutionAllowed: false;
    contentBoundary: "repository-data-only";
    redactionCount: number;
  };
}

export interface GroundedCorrelationProposalV1 {
  contractVersion: typeof GROUNDED_CORRELATION_CONTRACT;
  candidateIdentityKey: string;
  candidateObservationFingerprint: string;
  evidenceVersionIds: string[];
  proposedClaimType: string;
  subjectBindings: Array<{
    subjectIdentityKey: string;
    role: string;
    confidence: "probable" | "ambiguous";
  }>;
  confidence: "probable" | "ambiguous";
  rationale: string;
}

export interface SemanticCorrelationAdapterV1 {
  definition: SemanticCorrelationAdapterDefinition;
  select(input: CorrelationSelectionContext): CorrelationWorkItem[];
  buildContext(item: CorrelationWorkItem): SemanticCorrelationContextV1;
  outputSchema: Record<string, unknown>;
  ground(
    item: CorrelationWorkItem,
    output: unknown,
  ): GroundedCorrelationProposalV1 | undefined;
}

export class SemanticCorrelationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticCorrelationRegistryError";
  }
}

export interface ApplyGroundedCorrelationInput {
  database: Database.Database;
  candidate: CandidateDetails;
  inferenceId: string;
  adapterId: string;
  adapterContractVersion: string;
  proposal: GroundedCorrelationProposalV1;
  provenance: unknown;
}

export interface GroundedCorrelationResolution {
  status: "applied" | "ambiguous";
  proposal?: GroundedCorrelationProposalV1;
  conflictReason?: string;
}

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new SemanticCorrelationRegistryError(`${label} must not be empty`);
  }
}

function assertSubjectKind(value: SubjectKind, label: string): void {
  if (!SUBJECT_KINDS.includes(value)) {
    throw new SemanticCorrelationRegistryError(
      `${label} must be a supported Subject kind`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new SemanticCorrelationRegistryError(
      `${label} must not contain duplicates`,
    );
  }
}

function validateDefinition(
  definition: SemanticCorrelationAdapterDefinition,
): void {
  requireText(definition.id, "Adapter ID");
  requireText(definition.contractVersion, "Adapter contract version");
  requireText(definition.promptVersion, "Adapter prompt version");
  if (definition.mode !== "model") {
    throw new SemanticCorrelationRegistryError(
      `Adapter ${definition.id} must be model-backed`,
    );
  }
  if (definition.inputSchemaVersion !== "1") {
    throw new SemanticCorrelationRegistryError(
      `Adapter ${definition.id} has unsupported input schema ${definition.inputSchemaVersion}`,
    );
  }
  if (definition.outputSchemaVersion !== "1") {
    throw new SemanticCorrelationRegistryError(
      `Adapter ${definition.id} has unsupported output schema ${definition.outputSchemaVersion}`,
    );
  }
  if (!Number.isInteger(definition.priority) || definition.priority < 0) {
    throw new SemanticCorrelationRegistryError(
      `Adapter ${definition.id} priority must be a non-negative integer`,
    );
  }
  assertUnique(
    definition.supportedClaimTypes,
    `${definition.id}.supportedClaimTypes`,
  );
  assertUnique(
    definition.supportedCandidateKinds,
    `${definition.id}.supportedCandidateKinds`,
  );
  if (definition.supportedClaimTypes.length === 0) {
    throw new SemanticCorrelationRegistryError(
      `Adapter ${definition.id} must support at least one Claim family`,
    );
  }
  for (const [role, kinds] of Object.entries(
    definition.supportedSubjectRoles,
  )) {
    requireText(role, `${definition.id} Subject role`);
    assertUnique(kinds, `${definition.id}.${role}`);
    for (const kind of kinds)
      assertSubjectKind(kind, `${definition.id}.${role}`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SemanticCorrelationRegistryError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SemanticCorrelationRegistryError(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new SemanticCorrelationRegistryError(
      `${label} must be an array of non-empty strings`,
    );
  }
  const values = [...value] as string[];
  assertUnique(values, label);
  return values;
}

export function groundCorrelationProposal(
  item: CorrelationWorkItem,
  output: unknown,
): GroundedCorrelationProposalV1 {
  const value = objectValue(output, "Correlation output");
  const candidateIdentityKey = textValue(
    value.candidateIdentityKey,
    "candidateIdentityKey",
  );
  if (!item.candidateIdentityKeys.includes(candidateIdentityKey)) {
    throw new SemanticCorrelationRegistryError(
      `candidateIdentityKey ${candidateIdentityKey} is not grounded in the work item`,
    );
  }
  const candidateIndex =
    item.candidateIdentityKeys.indexOf(candidateIdentityKey);
  const candidateObservationFingerprint = textValue(
    value.candidateObservationFingerprint,
    "candidateObservationFingerprint",
  );
  if (
    candidateObservationFingerprint !==
    item.candidateObservationFingerprints[candidateIndex]
  ) {
    throw new SemanticCorrelationRegistryError(
      "candidateObservationFingerprint does not match the work item",
    );
  }
  const evidenceVersionIds = stringArray(
    value.evidenceVersionIds,
    "evidenceVersionIds",
  );
  if (evidenceVersionIds.length === 0) {
    throw new SemanticCorrelationRegistryError(
      "evidenceVersionIds must contain at least one EvidenceVersion",
    );
  }
  if (evidenceVersionIds.some((id) => !item.evidenceVersionIds.includes(id))) {
    throw new SemanticCorrelationRegistryError(
      "evidenceVersionIds contains an ungrounded EvidenceVersion",
    );
  }
  const proposedClaimType = textValue(
    value.proposedClaimType,
    "proposedClaimType",
  );
  if (!item.allowedClaimTypes.includes(proposedClaimType)) {
    throw new SemanticCorrelationRegistryError(
      `proposedClaimType ${proposedClaimType} is not allowed for the work item`,
    );
  }
  const rawBindings = value.subjectBindings;
  if (!Array.isArray(rawBindings)) {
    throw new SemanticCorrelationRegistryError(
      "subjectBindings must be an array",
    );
  }
  const bindings = rawBindings.map((raw, index) => {
    const binding = objectValue(raw, `subjectBindings[${index}]`);
    const subjectIdentityKey = textValue(
      binding.subjectIdentityKey,
      `subjectBindings[${index}].subjectIdentityKey`,
    );
    const role = textValue(binding.role, `subjectBindings[${index}].role`);
    const allowed = item.allowedSubjectBindings.find(
      (subject) =>
        subject.identityKey === subjectIdentityKey &&
        subject.roles.includes(role),
    );
    if (!allowed) {
      throw new SemanticCorrelationRegistryError(
        `subject binding ${subjectIdentityKey}/${role} is not grounded in the work item`,
      );
    }
    return {
      subjectIdentityKey,
      role,
      confidence: "probable" as const,
    };
  });
  assertUnique(
    bindings.map((binding) =>
      canonicalJson([binding.subjectIdentityKey, binding.role]),
    ),
    "subjectBindings",
  );
  const confidence = value.confidence;
  if (confidence !== "probable" && confidence !== "ambiguous") {
    throw new SemanticCorrelationRegistryError(
      "confidence must be probable or ambiguous",
    );
  }
  if (confidence === "probable") {
    const roles = new Set(bindings.map((binding) => binding.role));
    for (const role of item.requiredSubjectRoles) {
      if (!roles.has(role)) {
        throw new SemanticCorrelationRegistryError(
          `probable correlation is missing required Subject role ${role}`,
        );
      }
    }
  }
  return {
    contractVersion: GROUNDED_CORRELATION_CONTRACT,
    candidateIdentityKey,
    candidateObservationFingerprint,
    evidenceVersionIds,
    proposedClaimType,
    subjectBindings: bindings,
    confidence,
    rationale: textValue(value.rationale, "rationale"),
  };
}

export function resolveGroundedCorrelationProposals(
  proposals: readonly GroundedCorrelationProposalV1[],
): GroundedCorrelationResolution {
  if (proposals.length === 0) {
    return { status: "ambiguous", conflictReason: "no grounded proposals" };
  }
  const canonical = canonicalJson({
    candidateIdentityKey: proposals[0]!.candidateIdentityKey,
    candidateObservationFingerprint:
      proposals[0]!.candidateObservationFingerprint,
    evidenceVersionIds: [...proposals[0]!.evidenceVersionIds].sort(),
    proposedClaimType: proposals[0]!.proposedClaimType,
    subjectBindings: [...proposals[0]!.subjectBindings].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
    confidence: proposals[0]!.confidence,
  });
  const conflicts = proposals.some(
    (proposal) =>
      canonicalJson({
        candidateIdentityKey: proposal.candidateIdentityKey,
        candidateObservationFingerprint:
          proposal.candidateObservationFingerprint,
        evidenceVersionIds: [...proposal.evidenceVersionIds].sort(),
        proposedClaimType: proposal.proposedClaimType,
        subjectBindings: [...proposal.subjectBindings].sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
        confidence: proposal.confidence,
      }) !== canonical,
  );
  if (conflicts) {
    return {
      status: "ambiguous",
      conflictReason: "grounded proposals disagree for the same Candidate",
    };
  }
  const proposal = [...proposals].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  )[0]!;
  return { status: "applied", proposal };
}

export function applyGroundedCorrelation(
  input: ApplyGroundedCorrelationInput,
): PersistedCandidate {
  if (input.proposal.contractVersion !== GROUNDED_CORRELATION_CONTRACT) {
    throw new SemanticCorrelationRegistryError(
      `Unsupported grounded correlation contract ${input.proposal.contractVersion}`,
    );
  }
  if (input.proposal.confidence !== "probable") {
    throw new SemanticCorrelationRegistryError(
      "Only probable grounded correlations can be applied",
    );
  }
  if (input.proposal.candidateIdentityKey !== input.candidate.identityKey) {
    throw new SemanticCorrelationRegistryError(
      "Grounded correlation Candidate identity does not match the target Candidate",
    );
  }
  if (
    input.proposal.candidateObservationFingerprint !==
    input.candidate.observationFingerprint
  ) {
    throw new SemanticCorrelationRegistryError(
      "Grounded correlation observation does not match the target Candidate",
    );
  }
  if (input.proposal.proposedClaimType !== input.candidate.proposedClaimType) {
    throw new SemanticCorrelationRegistryError(
      "Grounded correlation Claim type does not match the target Candidate",
    );
  }
  if (input.proposal.evidenceVersionIds.length === 0) {
    throw new SemanticCorrelationRegistryError(
      "Grounded correlation must reference at least one EvidenceVersion",
    );
  }
  const candidateEvidenceVersionIds = new Set(
    input.candidate.evidence.flatMap((evidence) =>
      evidence.evidenceVersionId ? [evidence.evidenceVersionId] : [],
    ),
  );
  if (
    input.proposal.evidenceVersionIds.some(
      (evidenceVersionId) =>
        !candidateEvidenceVersionIds.has(evidenceVersionId),
    )
  ) {
    throw new SemanticCorrelationRegistryError(
      "Grounded correlation EvidenceVersion does not belong to the target Candidate",
    );
  }
  const candidateSubjects = new Set(
    input.candidate.subjects.map((subject) =>
      canonicalJson([subject.identityKey, subject.role]),
    ),
  );
  if (
    input.proposal.subjectBindings.some(
      (binding) =>
        !candidateSubjects.has(
          canonicalJson([binding.subjectIdentityKey, binding.role]),
        ),
    )
  ) {
    throw new SemanticCorrelationRegistryError(
      "Grounded correlation Subject binding does not belong to the target Candidate",
    );
  }
  const store = new CandidateStore(input.database);
  const current = store.current(input.candidate.identityKey);
  if (!current || current.id !== input.candidate.id) {
    throw new SemanticCorrelationRegistryError(
      "Grounded correlation target Candidate is not current",
    );
  }
  return store.attachInference(current.id, {
    inferenceId: input.inferenceId,
    confidence: "probable",
    basis: `inference:${input.adapterId}@${input.adapterContractVersion}`,
    provenance: {
      ...((input.provenance &&
      typeof input.provenance === "object" &&
      !Array.isArray(input.provenance)
        ? input.provenance
        : { input: input.provenance }) as Record<string, unknown>),
      groundedCorrelation: input.proposal,
    },
  });
}

export class SemanticCorrelationRegistry {
  private readonly adapters: SemanticCorrelationAdapterV1[];

  constructor(adapters: readonly SemanticCorrelationAdapterV1[]) {
    const seen = new Set<string>();
    for (const adapter of adapters) {
      validateDefinition(adapter.definition);
      if (seen.has(adapter.definition.id)) {
        throw new SemanticCorrelationRegistryError(
          `Duplicate semantic correlation adapter ${adapter.definition.id}`,
        );
      }
      seen.add(adapter.definition.id);
    }
    this.adapters = [...adapters].sort(
      (left, right) =>
        left.definition.priority - right.definition.priority ||
        left.definition.id.localeCompare(right.definition.id),
    );
  }

  list(): readonly SemanticCorrelationAdapterV1[] {
    return this.adapters;
  }

  select(input: CorrelationSelectionContext): Array<{
    adapter: SemanticCorrelationAdapterV1;
    items: CorrelationWorkItem[];
  }> {
    return this.adapters.flatMap((adapter) => {
      const items = adapter.select(input);
      return items.length > 0 ? [{ adapter, items }] : [];
    });
  }
}
