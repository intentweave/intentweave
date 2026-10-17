// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import {
  StructuredInferenceService,
  type LLMProvider,
  isReusableStructuredOutcome,
  type StructuredInferenceResult,
} from "@intentweave/core";
import {
  CandidateInferenceStore,
  CandidateStore,
  ClaimsStore,
  canonicalJson,
  fingerprint,
  subjectIdentity,
  type CandidateDetails,
  type CandidateInferenceDetails,
  type PersistedCandidate,
} from "@intentweave/index";
import type Database from "@intentweave/sqlite-compat";
import {
  SEMANTIC_CORRELATION_CONTEXT_CONTRACT,
  applyGroundedCorrelation,
  groundCorrelationProposal,
  SemanticCorrelationRegistry,
  type CorrelationWorkItem,
  type GroundedCorrelationProposalV1,
  type SemanticCorrelationAdapterV1,
  type SemanticCorrelationContextV1,
} from "./semanticCorrelationRegistry.js";
import type { PublicSymbolContinuityAlternative } from "./publicSymbolContinuity.js";

export const SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_ID =
  "semantic-public-symbol-continuity";
export const SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_CONTRACT_VERSION = "1";
export const SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_PROMPT_VERSION = "1";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "selectedPredecessorCandidateIdentityKey",
    "selectedPredecessorSubjectIdentityKey",
    "evidenceVersionIds",
    "confidence",
    "rationale",
  ],
  properties: {
    selectedPredecessorCandidateIdentityKey: { type: "string", minLength: 1 },
    selectedPredecessorSubjectIdentityKey: { type: "string", minLength: 1 },
    evidenceVersionIds: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string" },
    },
    confidence: { enum: ["probable", "ambiguous"] },
    rationale: { type: "string", minLength: 1 },
  },
} satisfies Record<string, unknown>;

const SYSTEM_PROMPT = `You resolve an ambiguous public Symbol refactor continuity proposal.
Choose exactly one supplied historical predecessor only when the current Symbol Evidence and the predecessor continuity Evidence identify the same logical Symbol.
Do not invent Candidate, Subject, or EvidenceVersion IDs.
If multiple predecessors remain plausible, return confidence ambiguous.
A probable result may preserve the historical Subject identity; it never creates a new Claim.
Output only the requested JSON object.`;

interface SemanticPublicSymbolContinuityOutput {
  selectedPredecessorCandidateIdentityKey: string;
  selectedPredecessorSubjectIdentityKey: string;
  evidenceVersionIds: string[];
  confidence: "probable" | "ambiguous";
  rationale: string;
}

interface EvidenceRow {
  id: string;
  normalized_value: string | null;
}

interface PublicSymbolContinuityGroup {
  candidate: CandidateDetails;
  alternatives: PublicSymbolContinuityAlternative[];
  evidenceVersionIds: string[];
  input: unknown;
  inputFingerprint: string;
  inferenceIdentityKey: string;
}

export interface AppliedPublicSymbolContinuity {
  continuityId: string;
  aliasCreated: boolean;
  supersededCandidate: PersistedCandidate;
}

export interface SemanticPublicSymbolContinuityResult {
  status: "evaluated" | "not_applicable" | "failed";
  groups: number;
  providerCalls: number;
  cacheHits: number;
  inferenceIds: string[];
  correlatedCandidateIds: string[];
  ambiguousCandidateIds: string[];
  continuityIds: string[];
  supersededCandidateIds: string[];
  failures: Array<{
    evidenceKey: string;
    kind: string;
    message: string;
    retryable: boolean;
  }>;
}

export const SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_DEFINITION = {
  id: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_ID,
  contractVersion: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_CONTRACT_VERSION,
  mode: "model" as const,
  inputSchemaVersion: "1" as const,
  outputSchemaVersion: "1" as const,
  supportedClaimTypes: ["CLM-PUBLIC-SYMBOL-DOCUMENTED"],
  supportedCandidateKinds: ["public-symbol-documentation"],
  supportedSubjectRoles: { subject: ["symbol" as const] },
  priority: 250,
  promptVersion: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_PROMPT_VERSION,
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function continuityAlternatives(
  value: unknown,
): PublicSymbolContinuityAlternative[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    const candidateIdentityKey = stringValue(record?.candidateIdentityKey);
    const subjectIdentityKey = stringValue(record?.subjectIdentityKey);
    const subjectDisplayName = stringValue(record?.subjectDisplayName);
    const filePath = stringValue(record?.filePath);
    if (
      !candidateIdentityKey ||
      !subjectIdentityKey ||
      !subjectDisplayName ||
      !filePath
    ) {
      return [];
    }
    return [
      {
        candidateIdentityKey,
        subjectIdentityKey,
        subjectDisplayName,
        filePath,
        normalizedValue: record?.normalizedValue ?? null,
      },
    ];
  });
}

function cachedResult(
  inference: CandidateInferenceDetails,
): StructuredInferenceResult<SemanticPublicSymbolContinuityOutput> | undefined {
  const provenance = objectValue(inference.provenance);
  const result = objectValue(provenance?.structuredInference);
  if (typeof result?.ok !== "boolean") return undefined;
  if (
    !isReusableStructuredOutcome(result as { ok: boolean; failure?: unknown })
  )
    return undefined;
  return result as unknown as StructuredInferenceResult<SemanticPublicSymbolContinuityOutput>;
}

function continuityGroups(
  database: Database.Database,
  limit: number,
): PublicSymbolContinuityGroup[] {
  const evidenceStatement = database.prepare(
    `SELECT id, normalized_value
     FROM evidence_versions WHERE id = ?`,
  );
  return new CandidateStore(database)
    .listCurrent()
    .filter(
      (candidate) =>
        candidate.candidateKind === "public-symbol-documentation" &&
        candidate.proposedClaimType === "CLM-PUBLIC-SYMBOL-DOCUMENTED" &&
        ["discovered", "correlated"].includes(candidate.state),
    )
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey))
    .flatMap((candidate): PublicSymbolContinuityGroup[] => {
      const provenance = objectValue(candidate.provenance);
      const alternatives = continuityAlternatives(
        provenance?.continuityAlternatives,
      ).sort((left, right) =>
        left.candidateIdentityKey.localeCompare(right.candidateIdentityKey),
      );
      if (alternatives.length < 2) return [];
      const evidenceVersionIds = candidate.evidence.flatMap((evidence) =>
        evidence.evidenceVersionId ? [evidence.evidenceVersionId] : [],
      );
      if (evidenceVersionIds.length !== candidate.evidence.length) return [];
      const evidence = evidenceVersionIds.flatMap((evidenceVersionId) => {
        const version = evidenceStatement.get(evidenceVersionId) as
          | EvidenceRow
          | undefined;
        const link = candidate.evidence.find(
          (item) => item.evidenceVersionId === evidenceVersionId,
        );
        return version && link
          ? [
              {
                id: version.id,
                role: link.role,
                sourceKind: link.sourceKind,
                normalizedValue: version.normalized_value
                  ? (JSON.parse(version.normalized_value) as unknown)
                  : null,
              },
            ]
          : [];
      });
      if (evidence.length !== evidenceVersionIds.length) return [];
      const input = {
        candidate: {
          identityKey: candidate.identityKey,
          observationFingerprint: candidate.observationFingerprint,
          proposedClaimType: candidate.proposedClaimType,
          normalizedStatement: candidate.normalizedStatement,
        },
        alternatives,
        evidence,
        currentSubjects: candidate.subjects.map((subject) => ({
          identityKey: subject.identityKey,
          kind: subject.kind,
          role: subject.role,
        })),
      };
      return [
        {
          candidate,
          alternatives,
          evidenceVersionIds: [...evidenceVersionIds].sort(),
          input,
          inputFingerprint: fingerprint(input),
          inferenceIdentityKey: `${SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_ID}:${candidate.identityKey}`,
        },
      ];
    })
    .slice(0, limit);
}

function continuityWorkItem(
  group: PublicSymbolContinuityGroup,
): CorrelationWorkItem {
  return {
    key: group.inferenceIdentityKey,
    candidateIdentityKeys: [group.candidate.identityKey],
    candidateObservationFingerprints: [group.candidate.observationFingerprint],
    evidenceVersionIds: group.evidenceVersionIds,
    allowedClaimTypes: [group.candidate.proposedClaimType],
    allowedSubjectBindings: group.candidate.subjects.map((subject) => ({
      identityKey: subject.identityKey,
      kind: subject.kind,
      roles: [subject.role],
    })),
    requiredSubjectRoles: [
      ...new Set(group.candidate.subjects.map((subject) => subject.role)),
    ],
    contextFingerprint: group.inputFingerprint,
    metadata: group,
  };
}

function groundedContinuityOutput(
  item: CorrelationWorkItem,
  output: unknown,
): GroundedCorrelationProposalV1 | undefined {
  const value = objectValue(output);
  const group = item.metadata as PublicSymbolContinuityGroup;
  const predecessorCandidateIdentityKey = stringValue(
    value?.selectedPredecessorCandidateIdentityKey,
  );
  const predecessorSubjectIdentityKey = stringValue(
    value?.selectedPredecessorSubjectIdentityKey,
  );
  const evidenceVersionIds = value?.evidenceVersionIds;
  const confidence = value?.confidence;
  const rationale = stringValue(value?.rationale);
  if (
    !predecessorCandidateIdentityKey ||
    !predecessorSubjectIdentityKey ||
    !Array.isArray(evidenceVersionIds) ||
    !evidenceVersionIds.every((id) => typeof id === "string") ||
    (confidence !== "probable" && confidence !== "ambiguous") ||
    !rationale
  ) {
    return undefined;
  }
  if (
    !group.evidenceVersionIds.every((evidenceVersionId) =>
      evidenceVersionIds.includes(evidenceVersionId),
    )
  ) {
    return undefined;
  }
  const selected = group.alternatives.find(
    (alternative) =>
      alternative.candidateIdentityKey === predecessorCandidateIdentityKey &&
      alternative.subjectIdentityKey === predecessorSubjectIdentityKey,
  );
  if (!selected) return undefined;
  try {
    return groundCorrelationProposal(item, {
      candidateIdentityKey: group.candidate.identityKey,
      candidateObservationFingerprint: group.candidate.observationFingerprint,
      evidenceVersionIds,
      proposedClaimType: group.candidate.proposedClaimType,
      subjectBindings: group.candidate.subjects.map((subject) => ({
        subjectIdentityKey: subject.identityKey,
        role: subject.role,
      })),
      confidence,
      rationale,
      continuity: {
        candidateIdentityKey: selected.candidateIdentityKey,
        subjectIdentityKey: selected.subjectIdentityKey,
        confidence,
      },
    });
  } catch {
    return undefined;
  }
}

export function createSemanticPublicSymbolContinuityAdapter(
  database: Database.Database,
  limit = 20,
): SemanticCorrelationAdapterV1 {
  return {
    definition: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_DEFINITION,
    select: () => continuityGroups(database, limit).map(continuityWorkItem),
    buildContext: (item): SemanticCorrelationContextV1 => {
      const group = item.metadata as PublicSymbolContinuityGroup;
      const input = group.input as {
        candidate: {
          identityKey: string;
          observationFingerprint: string;
          proposedClaimType: string;
          normalizedStatement: unknown;
        };
        alternatives: PublicSymbolContinuityAlternative[];
        evidence: Array<{
          id: string;
          role: string;
          sourceKind: string;
          normalizedValue: unknown;
        }>;
        currentSubjects: Array<{
          identityKey: string;
          kind: "parameter" | "symbol" | "module" | "endpoint";
          role: string;
        }>;
      };
      return {
        contractVersion: SEMANTIC_CORRELATION_CONTEXT_CONTRACT,
        workItem: item,
        candidates: [
          {
            identityKey: input.candidate.identityKey,
            observationFingerprint: input.candidate.observationFingerprint,
            proposedClaimType: input.candidate.proposedClaimType,
            normalizedStatement: {
              candidate: input.candidate.normalizedStatement,
              predecessorAlternatives: input.alternatives,
            },
          },
        ],
        evidence: input.evidence.map((evidence) => ({
          id: evidence.id,
          role: evidence.role,
          sourceKind: evidence.sourceKind,
          normalizedValue: evidence.normalizedValue,
        })),
        availableSubjects: input.currentSubjects.map((subject) => ({
          identityKey: subject.identityKey,
          kind: subject.kind,
          allowedRoles: [subject.role],
        })),
        repositoryPolicies: [],
        security: {
          repositoryContentIsUntrusted: true,
          toolExecutionAllowed: false,
          contentBoundary: "repository-data-only",
          redactionCount: 0,
        },
      };
    },
    outputSchema: OUTPUT_SCHEMA,
    ground: groundedContinuityOutput,
  };
}

export function applyGroundedPublicSymbolContinuity(input: {
  database: Database.Database;
  candidate: CandidateDetails;
  inferenceId: string;
  proposal: GroundedCorrelationProposalV1;
  provenance: unknown;
}): AppliedPublicSymbolContinuity {
  const continuity = input.proposal.continuity;
  if (!continuity || continuity.confidence !== "probable") {
    throw new Error("Only probable Symbol continuity can be applied");
  }
  const observedSubject = input.candidate.subjects.find(
    (subject) => subject.kind === "symbol" && subject.role === "subject",
  );
  if (!observedSubject) {
    throw new Error("Symbol continuity requires the observed Symbol Subject");
  }
  const observedSubjectId = subjectIdentity(
    "symbol",
    observedSubject.identityKey,
    observedSubject.displayName,
  );
  const canonicalSubjectId = subjectIdentity(
    "symbol",
    continuity.subjectIdentityKey,
  );
  if (observedSubjectId.id === canonicalSubjectId.id) {
    throw new Error(
      "Symbol continuity requires distinct predecessor identities",
    );
  }
  const symbolId = observedSubject.identityKey.slice("symbol:".length);
  if (!symbolId) throw new Error("Observed Symbol Subject is missing its ID");

  const apply = input.database.transaction(() => {
    const attached = applyGroundedCorrelation({
      database: input.database,
      candidate: input.candidate,
      inferenceId: input.inferenceId,
      adapterId: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_ID,
      adapterContractVersion:
        SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_CONTRACT_VERSION,
      proposal: input.proposal,
      provenance: input.provenance,
    });
    const claims = new ClaimsStore(input.database);
    const continuityVersion = claims.persistSubjectContinuity({
      fromSubjectIdentityId: canonicalSubjectId.id,
      toSubjectIdentityId: observedSubjectId.id,
      basis: "semantic-public-symbol-continuity",
      confidence: continuity.confidence,
      provenance: {
        ...((input.provenance &&
        typeof input.provenance === "object" &&
        !Array.isArray(input.provenance)
          ? input.provenance
          : { input: input.provenance }) as Record<string, unknown>),
        predecessorCandidateIdentityKey: continuity.candidateIdentityKey,
        predecessorSubjectIdentityKey: continuity.subjectIdentityKey,
      },
    });
    const aliasCreated = claims.persistSubjectAlias({
      subjectIdentityId: canonicalSubjectId.id,
      aliasKind: "cari-symbol-id",
      aliasKey: symbolId,
    });
    const supersededCandidate = new CandidateStore(input.database).transition(
      attached.id,
      "superseded",
      {
        basis: "semantic-public-symbol-continuity",
        continuityId: continuityVersion.id,
        predecessorCandidateIdentityKey: continuity.candidateIdentityKey,
      },
    );
    return {
      continuityId: continuityVersion.id,
      aliasCreated,
      supersededCandidate,
    };
  });
  return apply();
}

export async function runSemanticPublicSymbolContinuity(input: {
  database: Database.Database;
  provider: LLMProvider;
  model?: string;
  limit?: number;
}): Promise<SemanticPublicSymbolContinuityResult> {
  const limit = input.limit ?? 20;
  const adapter = createSemanticPublicSymbolContinuityAdapter(
    input.database,
    limit,
  );
  const registry = new SemanticCorrelationRegistry([adapter]);
  const correlationItems = registry
    .select({
      candidates: new CandidateStore(input.database).listCurrent(),
      enabledPolicyIds: [],
    })
    .flatMap(({ items }) => items);
  const groups = correlationItems
    .map((item) => item.metadata)
    .filter((metadata): metadata is PublicSymbolContinuityGroup =>
      Boolean(metadata),
    );
  const result: SemanticPublicSymbolContinuityResult = {
    status: groups.length === 0 ? "not_applicable" : "evaluated",
    groups: groups.length,
    providerCalls: 0,
    cacheHits: 0,
    inferenceIds: [],
    correlatedCandidateIds: [],
    ambiguousCandidateIds: [],
    continuityIds: [],
    supersededCandidateIds: [],
    failures: [],
  };
  if (groups.length === 0) return result;

  const inferences = new CandidateInferenceStore(input.database);
  const candidates = new CandidateStore(input.database);
  const service = new StructuredInferenceService(input.provider);
  const modelId =
    input.model ?? input.provider.getModelName?.() ?? "provider-default";
  let providerAvailable: boolean | undefined;

  for (const group of groups) {
    const workItem = correlationItems.find(
      (item) => item.key === group.inferenceIdentityKey,
    );
    if (!workItem) continue;
    const cacheKey = {
      identityKey: group.inferenceIdentityKey,
      adapterId: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_ID,
      contractVersion: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_CONTRACT_VERSION,
      providerId: input.provider.name,
      modelId,
      promptVersion: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_PROMPT_VERSION,
      inputFingerprint: group.inputFingerprint,
    };
    let inference = inferences.findReusable(cacheKey);
    let structured = inference ? cachedResult(inference) : undefined;
    if (
      inference &&
      structured &&
      !structured.ok &&
      structured.failure.retryable
    ) {
      inference = undefined;
      structured = undefined;
    }
    if (inference && structured) {
      result.cacheHits += 1;
    } else {
      providerAvailable ??= await input.provider.isAvailable();
      if (!providerAvailable) {
        result.status = "failed";
        result.failures.push({
          evidenceKey: group.inferenceIdentityKey,
          kind: "provider",
          message: `LLM provider ${input.provider.name} is not available`,
          retryable: false,
        });
        continue;
      }
      result.providerCalls += 1;
      structured = await service.infer<SemanticPublicSymbolContinuityOutput>({
        schemaName: "semantic_public_symbol_continuity",
        responseSchema: OUTPUT_SCHEMA,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: canonicalJson(adapter.buildContext(workItem)),
          },
        ],
        model: input.model,
        temperature: 0,
      });
      const grounded = structured.ok
        ? adapter.ground(workItem, structured.value)
        : undefined;
      inference = inferences.persist({
        ...cacheKey,
        normalizedOutput: structured.ok
          ? structured.value
          : { failure: structured.failure },
        evidenceVersionIds: group.evidenceVersionIds,
        proposedSubjectBindings: grounded?.subjectBindings ?? [],
        confidence:
          grounded?.confidence === "probable" ? "probable" : "ambiguous",
        rationale: structured.ok
          ? structured.value.rationale
          : structured.failure.message,
        provenance: {
          structuredInference: structured,
          adapterId: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_ID,
          contractVersion: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_CONTRACT_VERSION,
          promptVersion: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_PROMPT_VERSION,
          predecessorAlternatives: group.alternatives,
        },
      });
    }

    result.inferenceIds.push(inference.id);
    const grounded = structured.ok
      ? adapter.ground(workItem, structured.value)
      : undefined;
    const current = candidates.current(group.candidate.identityKey);
    if (!current) continue;
    if (grounded?.confidence === "probable" && grounded.continuity) {
      const applied = applyGroundedPublicSymbolContinuity({
        database: input.database,
        candidate: candidates.details(current.id)!,
        inferenceId: inference.id,
        proposal: grounded,
        provenance: {
          candidateIdentityKey: grounded.candidateIdentityKey,
          predecessorCandidateIdentityKey:
            grounded.continuity.candidateIdentityKey,
          predecessorSubjectIdentityKey: grounded.continuity.subjectIdentityKey,
          predecessorAlternatives: group.alternatives,
        },
      });
      result.correlatedCandidateIds.push(applied.supersededCandidate.id);
      result.continuityIds.push(applied.continuityId);
      result.supersededCandidateIds.push(applied.supersededCandidate.id);
    } else {
      const attached = candidates.attachInference(current.id, {
        inferenceId: inference.id,
        confidence: "ambiguous",
        basis: SEMANTIC_PUBLIC_SYMBOL_CONTINUITY_ADAPTER_ID,
        provenance: {
          predecessorAlternatives: group.alternatives,
          selectedPredecessorSubjectIdentityKey:
            grounded?.continuity?.subjectIdentityKey ?? null,
        },
      });
      if (grounded?.confidence === "ambiguous") {
        result.ambiguousCandidateIds.push(attached.id);
      }
    }
    if (!structured.ok) {
      result.status = "failed";
      result.failures.push({
        evidenceKey: group.inferenceIdentityKey,
        kind: structured.failure.kind,
        message: structured.failure.message,
        retryable: structured.failure.retryable,
      });
    } else if (!grounded) {
      result.status = "failed";
      result.failures.push({
        evidenceKey: group.inferenceIdentityKey,
        kind: "ungrounded_output",
        message:
          "Model output did not select a grounded historical Symbol predecessor",
        retryable: false,
      });
    }
  }
  result.inferenceIds.sort();
  result.correlatedCandidateIds.sort();
  result.ambiguousCandidateIds.sort();
  result.continuityIds.sort();
  result.supersededCandidateIds.sort();
  return result;
}
