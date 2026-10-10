// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import {
  StructuredInferenceService,
  type LLMProvider,
  type StructuredInferenceResult,
} from "@intentweave/core";
import {
  CandidateInferenceStore,
  CandidateStore,
  canonicalJson,
  fingerprint,
  type CandidateDetails,
  type CandidateInferenceDetails,
} from "@intentweave/index";
import type Database from "@intentweave/sqlite-compat";
import {
  CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION,
  discoverCrossArtifactCohorts,
  type CrossArtifactCohort,
} from "./crossArtifactCorrelation.js";
import {
  SEMANTIC_CORRELATION_CONTEXT_CONTRACT,
  applyGroundedCorrelation,
  groundCorrelationProposal,
  SemanticCorrelationRegistry,
  type CorrelationWorkItem,
  type SemanticCorrelationAdapterV1,
  type SemanticCorrelationContextV1,
} from "./semanticCorrelationRegistry.js";

export const SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_ID =
  "semantic-cross-artifact-correlation";
export const SEMANTIC_CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION = "1";
export const SEMANTIC_CROSS_ARTIFACT_CORRELATION_PROMPT_VERSION = "1";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "selectedCandidateIdentityKey",
    "evidenceVersionIds",
    "subjectBindings",
    "confidence",
    "rationale",
  ],
  properties: {
    selectedCandidateIdentityKey: { type: ["string", "null"] },
    evidenceVersionIds: {
      type: "array",
      minItems: 2,
      uniqueItems: true,
      items: { type: "string" },
    },
    subjectBindings: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subjectIdentityKey", "role"],
        properties: {
          subjectIdentityKey: { type: "string", minLength: 1 },
          role: { type: "string", minLength: 1 },
        },
      },
    },
    confidence: { enum: ["probable", "ambiguous"] },
    rationale: { type: "string", minLength: 1 },
  },
} satisfies Record<string, unknown>;

const SYSTEM_PROMPT = `You correlate one unresolved Claim Candidate inside a cross-artifact cohort.
Use only the supplied Candidate, peer Candidates, durable Subject bindings, and EvidenceVersion references.
A probable proposal must cite all Evidence for the selected Candidate and at least one EvidenceVersion from a peer Candidate in another artifact family.
Bind only Subjects already supplied for the selected Candidate. Do not invent a Claim, Candidate, Subject, or EvidenceVersion.
If the cross-artifact relationship remains uncertain, return confidence ambiguous.
Output only the requested JSON object.`;

interface SemanticCrossArtifactOutput {
  selectedCandidateIdentityKey: string | null;
  evidenceVersionIds: string[];
  subjectBindings: Array<{
    subjectIdentityKey: string;
    role: string;
  }>;
  confidence: "probable" | "ambiguous";
  rationale: string;
}

interface EvidenceRow {
  id: string;
  normalized_value: string | null;
}

interface CrossArtifactCorrelationGroup {
  cohort: CrossArtifactCohort;
  candidate: CandidateDetails;
  candidateEvidenceVersionIds: string[];
  requiredEvidenceVersionIds: string[];
  evidenceVersionIds: string[];
  input: unknown;
  inputFingerprint: string;
  inferenceIdentityKey: string;
}

export interface SemanticCrossArtifactCorrelationResult {
  status: "evaluated" | "not_applicable" | "failed";
  groups: number;
  providerCalls: number;
  cacheHits: number;
  inferenceIds: string[];
  correlatedCandidateIds: string[];
  ambiguousCandidateIds: string[];
  failures: Array<{
    evidenceKey: string;
    kind: string;
    message: string;
    retryable: boolean;
  }>;
}

export const SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_DEFINITION = {
  id: SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_ID,
  contractVersion: SEMANTIC_CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION,
  mode: "model" as const,
  inputSchemaVersion: "1" as const,
  outputSchemaVersion: "1" as const,
  supportedClaimTypes: [
    "CLM-DEFAULT",
    "CLM-LITERAL",
    "CLM-PUBLIC-SYMBOL-DOCUMENTED",
    "CLM-ENDPOINT-AUTHENTICATED",
    "CLM-DEPENDENCY-CONFORMANCE",
  ],
  supportedCandidateKinds: [
    "r1-code-value",
    "public-symbol-documentation",
    "public-symbol-documentation-correlation",
    "endpoint-authentication",
    "architecture-dependency-conformance",
  ],
  supportedSubjectRoles: {
    subject: [
      "parameter" as const,
      "symbol" as const,
      "module" as const,
      "endpoint" as const,
    ],
    source: ["module" as const, "symbol" as const, "parameter" as const],
    target: ["module" as const, "symbol" as const, "parameter" as const],
    handler: ["symbol" as const],
    guard: ["symbol" as const, "module" as const],
  },
  priority: 300,
  promptVersion: SEMANTIC_CROSS_ARTIFACT_CORRELATION_PROMPT_VERSION,
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseNormalizedValue(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function cachedResult(
  inference: CandidateInferenceDetails,
): StructuredInferenceResult<SemanticCrossArtifactOutput> | undefined {
  const provenance = objectValue(inference.provenance);
  const result = objectValue(provenance?.structuredInference);
  if (typeof result?.ok !== "boolean") return undefined;
  return result as unknown as StructuredInferenceResult<SemanticCrossArtifactOutput>;
}

function candidateDetailsByIdentity(
  database: Database.Database,
): Map<string, CandidateDetails> {
  return new Map(
    new CandidateStore(database)
      .listCurrent()
      .map((candidate) => [candidate.identityKey, candidate]),
  );
}

function crossArtifactGroups(
  database: Database.Database,
  limit: number,
): CrossArtifactCorrelationGroup[] {
  const details = candidateDetailsByIdentity(database);
  const evidenceStatement = database.prepare(
    `SELECT id, normalized_value
     FROM evidence_versions WHERE id = ?`,
  );
  return discoverCrossArtifactCohorts(database, { limit })
    .flatMap((cohort) => {
      const cohortCandidates = cohort.candidateIdentityKeys
        .map((identityKey) => details.get(identityKey))
        .filter((candidate): candidate is CandidateDetails =>
          Boolean(candidate),
        );
      if (cohortCandidates.length !== cohort.candidateIdentityKeys.length) {
        return [];
      }
      const peerCandidates = cohortCandidates.sort((left, right) =>
        left.identityKey.localeCompare(right.identityKey),
      );
      return peerCandidates
        .filter(
          (candidate) =>
            candidate.confidence === "ambiguous" &&
            ["discovered", "correlated"].includes(candidate.state),
        )
        .flatMap((candidate): CrossArtifactCorrelationGroup[] => {
          const candidateEvidenceVersionIds = candidate.evidence.flatMap(
            (evidence) =>
              evidence.evidenceVersionId ? [evidence.evidenceVersionId] : [],
          );
          const peerEvidenceVersionIds = peerCandidates
            .filter((peer) => peer.identityKey !== candidate.identityKey)
            .flatMap((peer) =>
              [...peer.evidence]
                .filter((evidence) => evidence.evidenceVersionId)
                .sort((left, right) =>
                  left.evidenceVersionId!.localeCompare(
                    right.evidenceVersionId!,
                  ),
                )
                .slice(0, 1)
                .map((evidence) => evidence.evidenceVersionId!),
            );
          const requiredEvidenceVersionIds = [
            ...new Set([
              ...candidateEvidenceVersionIds,
              ...peerEvidenceVersionIds,
            ]),
          ].sort();
          const evidenceVersionIds = [
            ...new Set(cohort.evidenceVersionIds),
          ].sort();
          const evidence = evidenceVersionIds.flatMap((evidenceVersionId) => {
            const version = evidenceStatement.get(evidenceVersionId) as
              | EvidenceRow
              | undefined;
            const link = cohortCandidates
              .flatMap((peer) => peer.evidence)
              .find((item) => item.evidenceVersionId === evidenceVersionId);
            return version && link
              ? [
                  {
                    evidenceVersionId,
                    role: link.role,
                    sourceKind: link.sourceKind,
                    normalizedValue: parseNormalizedValue(
                      version.normalized_value,
                    ),
                  },
                ]
              : [];
          });
          if (
            evidence.length !== evidenceVersionIds.length ||
            requiredEvidenceVersionIds.some(
              (evidenceVersionId) =>
                !evidenceVersionIds.includes(evidenceVersionId),
            )
          ) {
            return [];
          }
          const input = {
            cohort: {
              contractVersion: cohort.contractVersion,
              cohortFingerprint: cohort.cohortFingerprint,
              artifactFamilies: cohort.artifactFamilies,
              continuity: cohort.continuity,
            },
            candidates: peerCandidates.map((peer) => ({
              identityKey: peer.identityKey,
              observationFingerprint: peer.observationFingerprint,
              proposedClaimType: peer.proposedClaimType,
              normalizedStatement: peer.normalizedStatement,
              confidence: peer.confidence,
              artifactFamilies:
                cohort.candidates.find(
                  (reference) => reference.identityKey === peer.identityKey,
                )?.artifactFamilies ?? [],
              evidenceVersionIds: peer.evidence.flatMap((item) =>
                item.evidenceVersionId ? [item.evidenceVersionId] : [],
              ),
              subjects: peer.subjects.map((subject) => ({
                identityKey: subject.identityKey,
                kind: subject.kind,
                role: subject.role,
              })),
            })),
            evidence,
          };
          return [
            {
              cohort,
              candidate,
              candidateEvidenceVersionIds,
              requiredEvidenceVersionIds,
              evidenceVersionIds,
              input,
              inputFingerprint: fingerprint(input),
              inferenceIdentityKey: `${SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_ID}:${cohort.cohortFingerprint}:${candidate.identityKey}`,
            },
          ];
        });
    })
    .sort((left, right) =>
      left.inferenceIdentityKey.localeCompare(right.inferenceIdentityKey),
    )
    .slice(0, limit);
}

function crossArtifactWorkItem(
  group: CrossArtifactCorrelationGroup,
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

function groundedCrossArtifactOutput(
  item: CorrelationWorkItem,
  output: unknown,
): ReturnType<typeof groundCorrelationProposal> | undefined {
  const value = objectValue(output) as
    | Partial<SemanticCrossArtifactOutput>
    | undefined;
  const group = item.metadata as CrossArtifactCorrelationGroup;
  if (!value || !value.selectedCandidateIdentityKey) return undefined;
  if (
    !Array.isArray(value.evidenceVersionIds) ||
    !group.requiredEvidenceVersionIds.every((evidenceVersionId) =>
      value.evidenceVersionIds!.includes(evidenceVersionId),
    )
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.subjectBindings) ||
    (value.confidence !== "probable" && value.confidence !== "ambiguous") ||
    typeof value.rationale !== "string"
  ) {
    return undefined;
  }
  try {
    return groundCorrelationProposal(item, {
      candidateIdentityKey: value.selectedCandidateIdentityKey,
      candidateObservationFingerprint: group.candidate.observationFingerprint,
      evidenceVersionIds: value.evidenceVersionIds.filter((evidenceVersionId) =>
        group.candidateEvidenceVersionIds.includes(evidenceVersionId),
      ),
      proposedClaimType: group.candidate.proposedClaimType,
      subjectBindings: value.subjectBindings,
      confidence: value.confidence,
      rationale: value.rationale,
    });
  } catch {
    return undefined;
  }
}

export function createSemanticCrossArtifactCorrelationAdapter(
  database: Database.Database,
  limit = 20,
): SemanticCorrelationAdapterV1 {
  return {
    definition: SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_DEFINITION,
    select: () =>
      crossArtifactGroups(database, limit).map(crossArtifactWorkItem),
    buildContext: (item): SemanticCorrelationContextV1 => {
      const group = item.metadata as CrossArtifactCorrelationGroup;
      const input = group.input as {
        cohort: {
          contractVersion: string;
          cohortFingerprint: string;
          artifactFamilies: string[];
          continuity: unknown[];
        };
        candidates: Array<{
          identityKey: string;
          observationFingerprint: string;
          proposedClaimType: string;
          normalizedStatement: unknown;
          subjects: Array<{
            identityKey: string;
            kind: "parameter" | "symbol" | "module" | "endpoint";
            role: string;
          }>;
        }>;
        evidence: Array<{
          evidenceVersionId: string;
          role: string;
          sourceKind: string;
          normalizedValue: unknown;
        }>;
      };
      return {
        contractVersion: SEMANTIC_CORRELATION_CONTEXT_CONTRACT,
        workItem: item,
        candidates: input.candidates.map((candidate) => ({
          identityKey: candidate.identityKey,
          observationFingerprint: candidate.observationFingerprint,
          proposedClaimType: candidate.proposedClaimType,
          normalizedStatement: candidate.normalizedStatement,
        })),
        evidence: input.evidence.map((evidence) => ({
          id: evidence.evidenceVersionId,
          role: evidence.role,
          sourceKind: evidence.sourceKind,
          normalizedValue: evidence.normalizedValue,
        })),
        availableSubjects: input.candidates.flatMap((candidate) =>
          candidate.subjects.map((subject) => ({
            identityKey: subject.identityKey,
            kind: subject.kind,
            allowedRoles: [subject.role],
          })),
        ),
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
    ground: groundedCrossArtifactOutput,
  };
}

export async function runSemanticCrossArtifactCorrelation(input: {
  database: Database.Database;
  provider: LLMProvider;
  model?: string;
  limit?: number;
}): Promise<SemanticCrossArtifactCorrelationResult> {
  const limit = input.limit ?? 20;
  const adapter = createSemanticCrossArtifactCorrelationAdapter(
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
    .filter((metadata): metadata is CrossArtifactCorrelationGroup =>
      Boolean(metadata),
    );
  const result: SemanticCrossArtifactCorrelationResult = {
    status: groups.length === 0 ? "not_applicable" : "evaluated",
    groups: groups.length,
    providerCalls: 0,
    cacheHits: 0,
    inferenceIds: [],
    correlatedCandidateIds: [],
    ambiguousCandidateIds: [],
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
      adapterId: SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_ID,
      contractVersion: SEMANTIC_CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION,
      providerId: input.provider.name,
      modelId,
      promptVersion: SEMANTIC_CROSS_ARTIFACT_CORRELATION_PROMPT_VERSION,
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
      structured = await service.infer<SemanticCrossArtifactOutput>({
        schemaName: "semantic_cross_artifact_correlation",
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
          adapterId: SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_ID,
          contractVersion: SEMANTIC_CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION,
          promptVersion: SEMANTIC_CROSS_ARTIFACT_CORRELATION_PROMPT_VERSION,
          cohortFingerprint: group.cohort.cohortFingerprint,
          crossArtifactEvidenceVersionIds: group.evidenceVersionIds,
        },
      });
    }

    result.inferenceIds.push(inference.id);
    const grounded = structured.ok
      ? adapter.ground(workItem, structured.value)
      : undefined;
    const current = candidates.current(group.candidate.identityKey);
    if (!current) continue;
    const attached =
      grounded?.confidence === "probable"
        ? applyGroundedCorrelation({
            database: input.database,
            candidate: candidates.details(current.id)!,
            inferenceId: inference.id,
            adapterId: SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_ID,
            adapterContractVersion:
              SEMANTIC_CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION,
            proposal: grounded,
            provenance: {
              cohortFingerprint: group.cohort.cohortFingerprint,
              crossArtifactEvidenceVersionIds: group.evidenceVersionIds,
              evidenceVersionIds: grounded.evidenceVersionIds,
            },
          })
        : candidates.attachInference(current.id, {
            inferenceId: inference.id,
            confidence: "ambiguous",
            basis: SEMANTIC_CROSS_ARTIFACT_CORRELATION_ADAPTER_ID,
            provenance: {
              cohortFingerprint: group.cohort.cohortFingerprint,
              evidenceVersionIds: group.evidenceVersionIds,
              candidateIdentityKey: grounded?.candidateIdentityKey ?? null,
            },
          });
    if (grounded?.confidence === "probable") {
      result.correlatedCandidateIds.push(attached.id);
    } else if (grounded?.confidence === "ambiguous") {
      result.ambiguousCandidateIds.push(attached.id);
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
          "Model output did not cite the selected Candidate and cross-artifact Evidence",
        retryable: false,
      });
    }
  }
  result.inferenceIds.sort();
  result.correlatedCandidateIds.sort();
  result.ambiguousCandidateIds.sort();
  return result;
}
