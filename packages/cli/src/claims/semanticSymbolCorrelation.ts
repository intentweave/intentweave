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

export const SEMANTIC_SYMBOL_CORRELATION_ADAPTER_ID =
  "semantic-symbol-documentation-correlation";
export const SEMANTIC_SYMBOL_CORRELATION_CONTRACT_VERSION = "1";
export const SEMANTIC_SYMBOL_CORRELATION_PROMPT_VERSION = "1";

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selectedCandidateIdentityKey", "evidenceVersionIds", "rationale"],
  properties: {
    selectedCandidateIdentityKey: { type: ["string", "null"] },
    evidenceVersionIds: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string" },
    },
    rationale: { type: "string", minLength: 1 },
  },
} satisfies Record<string, unknown>;

const SYSTEM_PROMPT = `You correlate an existing documentation reference to one of several public Symbol Candidates.
Choose a Candidate only when the supplied documentation text, source path, Symbol signature, and Symbol file provide a clear grounding.
Do not invent IDs. Return the supplied EvidenceVersion ID verbatim.
If the Evidence does not distinguish one alternative, return null for selectedCandidateIdentityKey.
Output only the requested JSON object.`;

interface SemanticCorrelationOutput {
  selectedCandidateIdentityKey: string | null;
  evidenceVersionIds: string[];
  rationale: string;
}

interface EvidenceRow {
  id: string;
  normalized_value: string | null;
  file_path: string | null;
  span_start_line: number | null;
  span_end_line: number | null;
}

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  signature: string | null;
  file_path: string;
  line: number;
}

interface CorrelationGroup {
  evidenceKey: string;
  evidence: EvidenceRow;
  candidates: CandidateDetails[];
  input: unknown;
  inputFingerprint: string;
  inferenceIdentityKey: string;
}

export interface SemanticSymbolCorrelationResult {
  status: "evaluated" | "not_applicable" | "failed";
  groups: number;
  providerCalls: number;
  cacheHits: number;
  inferenceIds: string[];
  correlatedCandidateIds: string[];
  failures: Array<{
    evidenceKey: string;
    kind: string;
    message: string;
    retryable: boolean;
  }>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cachedResult(
  inference: CandidateInferenceDetails,
): StructuredInferenceResult<SemanticCorrelationOutput> | undefined {
  const provenance = objectValue(inference.provenance);
  const result = objectValue(provenance?.structuredInference);
  if (typeof result?.ok !== "boolean") return undefined;
  return result as unknown as StructuredInferenceResult<SemanticCorrelationOutput>;
}

function evidenceGroups(
  database: Database.Database,
  limit: number,
): CorrelationGroup[] {
  const candidates = new CandidateStore(database)
    .listCurrent()
    .filter(
      (candidate) =>
        candidate.candidateKind === "public-symbol-documentation-correlation" &&
        ["discovered", "correlated"].includes(candidate.state),
    );
  const grouped = new Map<string, CandidateDetails[]>();
  for (const candidate of candidates) {
    const evidence = candidate.evidence.find(
      (item) =>
        item.sourceKind === "documentation-reference" && item.evidenceVersionId,
    );
    if (!evidence?.evidenceVersionId) continue;
    const key = canonicalJson([
      evidence.evidenceKey,
      evidence.evidenceVersionId,
    ]);
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .filter((group) => group.length > 1)
    .sort((left, right) =>
      left[0]!.evidence[0]!.evidenceKey.localeCompare(
        right[0]!.evidence[0]!.evidenceKey,
      ),
    )
    .slice(0, limit)
    .flatMap((group): CorrelationGroup[] => {
      const evidenceLink = group[0]!.evidence.find(
        (item) => item.sourceKind === "documentation-reference",
      )!;
      const evidence = database
        .prepare(
          `SELECT id, normalized_value, file_path, span_start_line, span_end_line
           FROM evidence_versions WHERE id = ?`,
        )
        .get(evidenceLink.evidenceVersionId!) as EvidenceRow | undefined;
      if (!evidence) return [];
      const alternatives = group
        .map((candidate) => {
          const subject = candidate.subjects.find(
            (item) => item.kind === "symbol" && item.role === "subject",
          );
          const symbolId = subject?.identityKey.startsWith("symbol:")
            ? subject.identityKey.slice("symbol:".length)
            : undefined;
          const symbol = symbolId
            ? (database
                .prepare(
                  `SELECT id, name, kind, signature, file_path, line
                   FROM symbols WHERE id = ?`,
                )
                .get(symbolId) as SymbolRow | undefined)
            : undefined;
          return {
            candidateIdentityKey: candidate.identityKey,
            subjectIdentityKey: subject?.identityKey ?? null,
            statement: candidate.normalizedStatement,
            symbol: symbol
              ? {
                  name: symbol.name,
                  kind: symbol.kind,
                  signature: symbol.signature,
                  filePath: symbol.file_path,
                  line: symbol.line,
                }
              : null,
          };
        })
        .sort((left, right) =>
          left.candidateIdentityKey.localeCompare(right.candidateIdentityKey),
        );
      const input = {
        evidence: {
          evidenceVersionId: evidence.id,
          normalizedValue: evidence.normalized_value
            ? (JSON.parse(evidence.normalized_value) as unknown)
            : null,
          filePath: evidence.file_path,
          startLine: evidence.span_start_line,
          endLine: evidence.span_end_line,
        },
        alternatives,
      };
      return [
        {
          evidenceKey: evidenceLink.evidenceKey,
          evidence,
          candidates: group,
          input,
          inputFingerprint: fingerprint(input),
          inferenceIdentityKey: `${SEMANTIC_SYMBOL_CORRELATION_ADAPTER_ID}:${evidenceLink.evidenceKey}`,
        },
      ];
    });
}

function validatedSelection(
  group: CorrelationGroup,
  output: SemanticCorrelationOutput,
): {
  selected?: CandidateDetails;
  grounded: boolean;
} {
  const selected = output.selectedCandidateIdentityKey
    ? group.candidates.find(
        (candidate) =>
          candidate.identityKey === output.selectedCandidateIdentityKey,
      )
    : undefined;
  return {
    ...(selected ? { selected } : {}),
    grounded:
      output.evidenceVersionIds.length === 1 &&
      output.evidenceVersionIds[0] === group.evidence.id &&
      (output.selectedCandidateIdentityKey === null || Boolean(selected)),
  };
}

export async function runSemanticSymbolCorrelation(input: {
  database: Database.Database;
  provider: LLMProvider;
  model?: string;
  limit?: number;
}): Promise<SemanticSymbolCorrelationResult> {
  const limit = input.limit ?? 20;
  const groups = evidenceGroups(input.database, limit);
  const result: SemanticSymbolCorrelationResult = {
    status: groups.length === 0 ? "not_applicable" : "evaluated",
    groups: groups.length,
    providerCalls: 0,
    cacheHits: 0,
    inferenceIds: [],
    correlatedCandidateIds: [],
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
    const cacheKey = {
      identityKey: group.inferenceIdentityKey,
      adapterId: SEMANTIC_SYMBOL_CORRELATION_ADAPTER_ID,
      contractVersion: SEMANTIC_SYMBOL_CORRELATION_CONTRACT_VERSION,
      providerId: input.provider.name,
      modelId,
      promptVersion: SEMANTIC_SYMBOL_CORRELATION_PROMPT_VERSION,
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
          evidenceKey: group.evidenceKey,
          kind: "provider",
          message: `LLM provider ${input.provider.name} is not available`,
          retryable: false,
        });
        continue;
      }
      result.providerCalls += 1;
      structured = await service.infer<SemanticCorrelationOutput>({
        schemaName: "semantic_symbol_documentation_correlation",
        responseSchema: OUTPUT_SCHEMA,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: canonicalJson(group.input) }],
        model: input.model,
        temperature: 0,
      });
      const selection = structured.ok
        ? validatedSelection(group, structured.value)
        : { grounded: false };
      const confidence =
        structured.ok && selection.grounded && selection.selected
          ? "probable"
          : "ambiguous";
      const normalizedOutput = structured.ok
        ? structured.value
        : { failure: structured.failure };
      inference = inferences.persist({
        ...cacheKey,
        normalizedOutput,
        evidenceVersionIds: [group.evidence.id],
        proposedSubjectBindings: selection.selected
          ? selection.selected.subjects.map((subject) => ({
              kind: subject.kind,
              identityKey: subject.identityKey,
              role: subject.role,
            }))
          : [],
        confidence,
        rationale: structured.ok
          ? structured.value.rationale
          : structured.failure.message,
        provenance: {
          structuredInference: structured,
          adapterId: SEMANTIC_SYMBOL_CORRELATION_ADAPTER_ID,
          contractVersion: SEMANTIC_SYMBOL_CORRELATION_CONTRACT_VERSION,
          promptVersion: SEMANTIC_SYMBOL_CORRELATION_PROMPT_VERSION,
        },
      });
    }

    result.inferenceIds.push(inference.id);
    const selection = structured.ok
      ? validatedSelection(group, structured.value)
      : undefined;
    const selected =
      selection && selection.grounded ? selection.selected : undefined;
    for (const candidate of group.candidates) {
      const current = candidates.current(candidate.identityKey)!;
      const attached = candidates.attachInference(current.id, {
        inferenceId: inference.id,
        confidence:
          selected?.identityKey === candidate.identityKey
            ? "probable"
            : "ambiguous",
        basis: SEMANTIC_SYMBOL_CORRELATION_ADAPTER_ID,
        provenance: {
          evidenceVersionId: group.evidence.id,
          selectedCandidateIdentityKey: selected?.identityKey ?? null,
        },
      });
      if (selected?.identityKey === candidate.identityKey) {
        result.correlatedCandidateIds.push(attached.id);
      }
    }
    if (!structured.ok) {
      result.status = "failed";
      result.failures.push({
        evidenceKey: group.evidenceKey,
        kind: structured.failure.kind,
        message: structured.failure.message,
        retryable: structured.failure.retryable,
      });
    } else if (!selection?.grounded) {
      result.status = "failed";
      result.failures.push({
        evidenceKey: group.evidenceKey,
        kind: "ungrounded_output",
        message:
          "Model output referenced an unknown Candidate or EvidenceVersion",
        retryable: false,
      });
    }
  }
  result.inferenceIds.sort();
  result.correlatedCandidateIds.sort();
  return result;
}
