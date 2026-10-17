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
  canonicalJson,
  fingerprint,
  type CandidateDetails,
  type CandidateInferenceDetails,
} from "@intentweave/index";
import type Database from "@intentweave/sqlite-compat";
import {
  SEMANTIC_CORRELATION_CONTEXT_CONTRACT,
  applyGroundedCorrelation,
  groundCorrelationProposal,
  SemanticCorrelationRegistry,
  type CorrelationWorkItem,
  type SemanticCorrelationAdapterV1,
  type SemanticCorrelationContextV1,
} from "./semanticCorrelationRegistry.js";

export const SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_ID =
  "semantic-endpoint-authentication-correlation";
export const SEMANTIC_ENDPOINT_CORRELATION_CONTRACT_VERSION = "1";
export const SEMANTIC_ENDPOINT_CORRELATION_PROMPT_VERSION = "1";

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
      minItems: 3,
      uniqueItems: true,
      items: { type: "string" },
    },
    subjectBindings: {
      type: "array",
      minItems: 3,
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

const SYSTEM_PROMPT = `You correlate unresolved Endpoint authentication Candidates from repository Evidence.
Use only the supplied Candidate, Route Evidence, handler Evidence, and protection Evidence.
A probable correlation must bind the Endpoint, handler, and protection Subject and cite all three required Evidence anchors.
Protection may be a Guard, middleware, wrapper, or project-specific authentication helper, but it must be represented by a supplied Subject and Evidence reference.
If the route-to-protection relationship remains uncertain, return confidence ambiguous.
Do not invent IDs. Output only the requested JSON object.`;

interface SemanticEndpointCorrelationOutput {
  selectedCandidateIdentityKey: string | null;
  evidenceVersionIds: string[];
  subjectBindings: Array<{
    subjectIdentityKey: string;
    role: string;
  }>;
  confidence: "probable" | "ambiguous";
  rationale: string;
}

interface EndpointEvidenceRow {
  id: string;
  normalized_value: string | null;
}

interface EndpointCorrelationGroup {
  candidate: CandidateDetails;
  evidenceVersionIds: string[];
  requiredEvidenceVersionIds: string[];
  input: unknown;
  inputFingerprint: string;
  inferenceIdentityKey: string;
}

export interface SemanticEndpointCorrelationResult {
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

export const SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_DEFINITION = {
  id: SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_ID,
  contractVersion: SEMANTIC_ENDPOINT_CORRELATION_CONTRACT_VERSION,
  mode: "model" as const,
  inputSchemaVersion: "1" as const,
  outputSchemaVersion: "1" as const,
  supportedClaimTypes: ["CLM-ENDPOINT-AUTHENTICATED"],
  supportedCandidateKinds: ["endpoint-authentication"],
  supportedSubjectRoles: {
    endpoint: ["endpoint" as const],
    handler: ["symbol" as const],
    guard: ["symbol" as const, "module" as const],
  },
  priority: 200,
  promptVersion: SEMANTIC_ENDPOINT_CORRELATION_PROMPT_VERSION,
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
): StructuredInferenceResult<SemanticEndpointCorrelationOutput> | undefined {
  const provenance = objectValue(inference.provenance);
  const result = objectValue(provenance?.structuredInference);
  if (typeof result?.ok !== "boolean") return undefined;
  if (
    !isReusableStructuredOutcome(result as { ok: boolean; failure?: unknown })
  )
    return undefined;
  return result as unknown as StructuredInferenceResult<SemanticEndpointCorrelationOutput>;
}

function endpointCorrelationGroups(
  database: Database.Database,
  limit: number,
): EndpointCorrelationGroup[] {
  const candidates = new CandidateStore(database)
    .listCurrent()
    .filter(
      (candidate) =>
        candidate.candidateKind === "endpoint-authentication" &&
        candidate.proposedClaimType === "CLM-ENDPOINT-AUTHENTICATED" &&
        candidate.confidence === "ambiguous" &&
        ["discovered", "correlated"].includes(candidate.state),
    )
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey));
  const evidenceStatement = database.prepare(
    `SELECT id, normalized_value
     FROM evidence_versions WHERE id = ?`,
  );

  return candidates.slice(0, limit).flatMap((candidate) => {
    const requiredEvidence = ["route", "handler", "guard"].map((role) =>
      candidate.evidence.find((evidence) => evidence.role === role),
    );
    if (requiredEvidence.some((evidence) => !evidence?.evidenceVersionId)) {
      return [];
    }
    const requiredSubjectRoles = ["endpoint", "handler", "guard"];
    if (
      requiredSubjectRoles.some(
        (role) => !candidate.subjects.some((subject) => subject.role === role),
      )
    ) {
      return [];
    }
    const evidence = candidate.evidence
      .filter((item) => item.evidenceVersionId)
      .sort((left, right) =>
        left.evidenceVersionId!.localeCompare(right.evidenceVersionId!),
      )
      .flatMap((item) => {
        const version = evidenceStatement.get(item.evidenceVersionId!) as
          | EndpointEvidenceRow
          | undefined;
        return version
          ? [
              {
                evidenceVersionId: version.id,
                role: item.role,
                sourceKind: item.sourceKind,
                normalizedValue: parseNormalizedValue(version.normalized_value),
              },
            ]
          : [];
      });
    if (evidence.length < 3) return [];
    const requiredEvidenceVersionIds = requiredEvidence.map(
      (item) => item!.evidenceVersionId!,
    );
    const input = {
      candidate: {
        identityKey: candidate.identityKey,
        observationFingerprint: candidate.observationFingerprint,
        proposedClaimType: candidate.proposedClaimType,
        normalizedStatement: candidate.normalizedStatement,
      },
      evidence,
      subjects: [...candidate.subjects]
        .sort((left, right) =>
          canonicalJson([left.identityKey, left.role]).localeCompare(
            canonicalJson([right.identityKey, right.role]),
          ),
        )
        .map((subject) => ({
          identityKey: subject.identityKey,
          kind: subject.kind,
          role: subject.role,
          displayName: subject.displayName,
        })),
    };
    return [
      {
        candidate,
        evidenceVersionIds: evidence.map((item) => item.evidenceVersionId),
        requiredEvidenceVersionIds,
        input,
        inputFingerprint: fingerprint(input),
        inferenceIdentityKey: `${SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_ID}:${candidate.identityKey}`,
      },
    ];
  });
}

function endpointWorkItem(
  group: EndpointCorrelationGroup,
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
    requiredSubjectRoles: ["endpoint", "handler", "guard"],
    contextFingerprint: group.inputFingerprint,
    metadata: group,
  };
}

function groundedEndpointOutput(
  item: CorrelationWorkItem,
  output: unknown,
): ReturnType<typeof groundCorrelationProposal> | undefined {
  const value = objectValue(output) as
    | Partial<SemanticEndpointCorrelationOutput>
    | undefined;
  const group = item.metadata as EndpointCorrelationGroup;
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
      evidenceVersionIds: value.evidenceVersionIds,
      proposedClaimType: group.candidate.proposedClaimType,
      subjectBindings: value.subjectBindings,
      confidence: value.confidence,
      rationale: value.rationale,
    });
  } catch {
    return undefined;
  }
}

export function createSemanticEndpointCorrelationAdapter(
  database: Database.Database,
  limit = 20,
): SemanticCorrelationAdapterV1 {
  return {
    definition: SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_DEFINITION,
    select: () =>
      endpointCorrelationGroups(database, limit).map(endpointWorkItem),
    buildContext: (item): SemanticCorrelationContextV1 => {
      const group = item.metadata as EndpointCorrelationGroup;
      const input = group.input as {
        candidate: {
          identityKey: string;
          observationFingerprint: string;
          proposedClaimType: string;
          normalizedStatement: unknown;
        };
        evidence: Array<{
          evidenceVersionId: string;
          role: string;
          sourceKind: string;
          normalizedValue: unknown;
        }>;
        subjects: Array<{
          identityKey: string;
          kind: "parameter" | "symbol" | "module" | "endpoint";
          role: string;
          displayName: string;
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
            normalizedStatement: input.candidate.normalizedStatement,
          },
        ],
        evidence: input.evidence.map((evidence) => ({
          id: evidence.evidenceVersionId,
          role: evidence.role,
          sourceKind: evidence.sourceKind,
          normalizedValue: evidence.normalizedValue,
        })),
        availableSubjects: input.subjects.map((subject) => ({
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
    ground: groundedEndpointOutput,
  };
}

export async function runSemanticEndpointCorrelation(input: {
  database: Database.Database;
  provider: LLMProvider;
  model?: string;
  limit?: number;
}): Promise<SemanticEndpointCorrelationResult> {
  const limit = input.limit ?? 20;
  const adapter = createSemanticEndpointCorrelationAdapter(
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
    .filter((metadata): metadata is EndpointCorrelationGroup =>
      Boolean(metadata),
    );
  const result: SemanticEndpointCorrelationResult = {
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
      adapterId: SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_ID,
      contractVersion: SEMANTIC_ENDPOINT_CORRELATION_CONTRACT_VERSION,
      providerId: input.provider.name,
      modelId,
      promptVersion: SEMANTIC_ENDPOINT_CORRELATION_PROMPT_VERSION,
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
      structured = await service.infer<SemanticEndpointCorrelationOutput>({
        schemaName: "semantic_endpoint_authentication_correlation",
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
          adapterId: SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_ID,
          contractVersion: SEMANTIC_ENDPOINT_CORRELATION_CONTRACT_VERSION,
          promptVersion: SEMANTIC_ENDPOINT_CORRELATION_PROMPT_VERSION,
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
            adapterId: SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_ID,
            adapterContractVersion:
              SEMANTIC_ENDPOINT_CORRELATION_CONTRACT_VERSION,
            proposal: grounded,
            provenance: {
              evidenceVersionIds: grounded.evidenceVersionIds,
              candidateIdentityKey: grounded.candidateIdentityKey,
            },
          })
        : candidates.attachInference(current.id, {
            inferenceId: inference.id,
            confidence: "ambiguous",
            basis: SEMANTIC_ENDPOINT_CORRELATION_ADAPTER_ID,
            provenance: {
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
          "Model output did not cite grounded route, handler, and protection Evidence",
        retryable: false,
      });
    }
  }
  result.inferenceIds.sort();
  result.correlatedCandidateIds.sort();
  result.ambiguousCandidateIds.sort();
  return result;
}
