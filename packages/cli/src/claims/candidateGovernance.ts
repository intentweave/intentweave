// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsEngine,
  ClaimsReviewStore,
  ClaimsStore,
  assessClaimPolicy,
  emptyPortableClaimsState,
  fingerprint,
  materialFingerprint,
  type CandidateDetails,
  type CandidatePolicyDecisionInput,
  type CandidateReviewDecision,
  type ClaimAssessmentDependencyInput,
  type ClaimsContractVersions,
  type ClaimScalar,
  type PersistedAssessment,
  type PersistedCandidateReview,
  type PortableClaimsActor,
} from "@intentweave/index";
import {
  loadPortableClaimsState,
  writePortableClaimsState,
} from "./portableState.js";

export interface CandidateGovernanceResult {
  review: PersistedCandidateReview;
  assessment?: PersistedAssessment;
}

interface GenericCandidatePromotionContract {
  identity: { id: string; version: string };
  materiality: { id: string; version: string };
  assessmentPolicy: { id: string; version: string };
}

const GENERIC_CANDIDATE_PROMOTION_CONTRACTS: Record<
  string,
  GenericCandidatePromotionContract
> = {
  "CLM-PUBLIC-SYMBOL-DOCUMENTED": {
    identity: { id: "symbol-doc-identity", version: "1" },
    materiality: { id: "symbol-doc-materiality", version: "1" },
    assessmentPolicy: { id: "symbol-documentation", version: "1" },
  },
  "CLM-ENDPOINT-AUTHENTICATED": {
    identity: { id: "endpoint-authentication-identity", version: "1" },
    materiality: { id: "endpoint-authentication-materiality", version: "1" },
    assessmentPolicy: { id: "endpoint-authentication", version: "1" },
  },
  "CLM-DEPENDENCY-CONFORMANCE": {
    identity: { id: "dependency-claim-identity", version: "1" },
    materiality: { id: "dependency-claim-materiality", version: "1" },
    assessmentPolicy: { id: "dependency-conformance", version: "1" },
  },
};

function claimScalar(value: unknown): ClaimScalar {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  ) {
    return value;
  }
  throw new Error("R1 Candidate value is not a supported Claim scalar");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function evidenceNormalizedValue(
  database: Database.Database,
  evidenceVersionId: string | undefined,
): unknown {
  if (!evidenceVersionId) return undefined;
  const row = database
    .prepare(`SELECT normalized_value FROM evidence_versions WHERE id = ?`)
    .get(evidenceVersionId) as { normalized_value: string } | undefined;
  return row ? (JSON.parse(row.normalized_value) as unknown) : undefined;
}

function evidenceMaterialInputs(
  database: Database.Database,
  evidenceVersionIds: readonly string[],
): Array<{ sourceKind: string; materialFingerprint: string }> {
  if (evidenceVersionIds.length === 0) return [];
  const placeholders = evidenceVersionIds.map(() => "?").join(", ");
  return (
    database
      .prepare(
        `SELECT identity.source_kind, evidence.material_fingerprint
         FROM evidence_versions evidence
         JOIN evidence_identities identity
           ON identity.id = evidence.evidence_identity_id
         WHERE evidence.id IN (${placeholders})
         ORDER BY identity.source_kind, evidence.material_fingerprint`,
      )
      .all(...evidenceVersionIds) as Array<{
      source_kind: string;
      material_fingerprint: string;
    }>
  ).map((evidence) => ({
    sourceKind: evidence.source_kind,
    materialFingerprint: evidence.material_fingerprint,
  }));
}

function ruleWarrantMaterialFingerprint(
  database: Database.Database,
  input: {
    ruleId: string;
    applicability: string;
    normalizedStatus: string;
    normalizedOutput: unknown;
    normalizedReasons: string[];
    evidenceVersionIds: string[];
    ruleContractVersion: string;
    implementationFingerprint: string;
  },
): string {
  return fingerprint({
    applicability: input.applicability,
    normalizedStatus: input.normalizedStatus,
    normalizedOutput: projectRuleWarrantMaterialOutput(
      input.ruleId,
      input.normalizedOutput,
    ),
    normalizedReasons: input.normalizedReasons,
    evidence: evidenceMaterialInputs(database, input.evidenceVersionIds),
    ruleContractVersion: input.ruleContractVersion,
    // Implementation-only drift versions the RuleResult but is not semantic warrant material.
  });
}

export function projectRuleWarrantMaterialOutput(
  ruleId: string,
  value: unknown,
): unknown {
  if (
    ruleId !== "R.endpoint-authentication" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  const {
    handler: _handler,
    controller: _controller,
    ...material
  } = value as Record<string, unknown>;
  return material;
}

function currentRuleWarrantMaterialFingerprint(
  database: Database.Database,
  ruleId: string,
  subjectKey: string | undefined,
): string | undefined {
  const current = database
    .prepare(
      `SELECT result.applicability, result.normalized_status,
              result.normalized_output_json, result.normalized_reasons_json,
              result.rule_contract_version,
              result.implementation_fingerprint, result.id
       FROM rule_result_versions result
       JOIN rule_result_identities identity
         ON identity.id = result.rule_result_identity_id
       WHERE identity.rule_id = ? AND identity.identity_key = ?
       ORDER BY result.version_ordinal DESC LIMIT 1`,
    )
    .get(ruleId, [ruleId, subjectKey ?? "", ""].join(":")) as
    | {
        applicability: string;
        normalized_status: string;
        normalized_output_json: string;
        normalized_reasons_json: string;
        rule_contract_version: string;
        implementation_fingerprint: string;
        id: string;
      }
    | undefined;
  if (!current) return undefined;
  const evidenceVersionIds = (
    database
      .prepare(
        `SELECT evidence_version_id
         FROM rule_result_evidence
         WHERE rule_result_version_id = ?
         ORDER BY evidence_version_id`,
      )
      .all(current.id) as Array<{ evidence_version_id: string }>
  ).map((evidence) => evidence.evidence_version_id);
  return ruleWarrantMaterialFingerprint(database, {
    ruleId,
    applicability: current.applicability,
    normalizedStatus: current.normalized_status,
    normalizedOutput: JSON.parse(current.normalized_output_json) as unknown,
    normalizedReasons: JSON.parse(current.normalized_reasons_json) as string[],
    evidenceVersionIds,
    ruleContractVersion: current.rule_contract_version,
    implementationFingerprint: current.implementation_fingerprint,
  });
}

function promoteR1Candidate(
  database: Database.Database,
  candidate: CandidateDetails,
  contracts: ClaimsContractVersions,
): PersistedAssessment {
  if (candidate.discoveryAdapterId !== "r1-code-values") {
    throw new Error(
      `Candidate adapter ${candidate.discoveryAdapterId} has no promotion evaluator`,
    );
  }
  const statement = record(
    candidate.normalizedStatement,
    "R1 Candidate statement",
  );
  const parameterKey = optionalString(statement.subject);
  if (!parameterKey) {
    throw new Error("R1 Candidate statement is missing its Parameter subject");
  }
  const value = claimScalar(statement.value);
  const discovery = record(candidate.provenance, "R1 Candidate provenance");
  const repositoryRevision =
    optionalString(discovery.repositoryRevision) ?? "working-tree";
  const store = new ClaimsStore(database);
  const persisted = candidate.evidence.map((evidence) => {
    const provenance = record(
      evidence.provenance,
      `Candidate Evidence ${evidence.evidenceKey}`,
    );
    const evidenceValue = claimScalar(provenance.normalizedValue);
    const semanticLocation =
      optionalString(provenance.semanticLocation) ?? parameterKey;
    const filePath = optionalString(provenance.filePath);
    const symbolId = optionalString(provenance.symbolId);
    const line = optionalNumber(provenance.line);
    return {
      sourceKind: evidence.sourceKind,
      value: evidenceValue,
      version: store.persistEvidence({
        parameterKey,
        sourceKind: evidence.sourceKind,
        identityKey: evidence.evidenceKey,
        fingerprint: fingerprint({
          sourceKind: evidence.sourceKind,
          value: evidenceValue,
          semanticLocation,
          filePath: filePath ?? null,
          symbolId: symbolId ?? null,
          line: line ?? null,
        }),
        materialFingerprint: materialFingerprint({
          parameterIdentity: parameterKey,
          semanticLocation,
          normalizedValue: evidenceValue,
        }),
        normalizedValue: evidenceValue,
        semanticLocation,
        provenance: {
          filePath: filePath ?? null,
          symbolId: symbolId ?? null,
          line: line ?? null,
          repositoryRevision,
          candidateId: candidate.id,
        },
        filePath,
        symbolId,
        spanStartLine: line,
        spanEndLine: line,
        repositoryRevision,
        bindingBasis: optionalString(provenance.bindingBasis),
        bindingConfidence: optionalString(provenance.bindingConfidence),
      }),
    };
  });
  const codeDefault = persisted.find(
    (evidence) => evidence.sourceKind === "code-default",
  );
  if (!codeDefault) {
    throw new Error(
      "R1 Candidate cannot be promoted without code-default Evidence",
    );
  }
  const annotation = persisted.find(
    (evidence) => evidence.sourceKind === "code-annotation",
  );
  const result = new ClaimsEngine(store).evaluateDefault({
    parameterKey,
    claimType:
      candidate.proposedClaimType === "CLM-LITERAL"
        ? "CLM-LITERAL"
        : "CLM-DEFAULT",
    repositoryRevision,
    codeDefault: {
      versionId: codeDefault.version.id,
      value: codeDefault.value,
    },
    codeAnnotation: annotation
      ? { versionId: annotation.version.id, value: annotation.value }
      : undefined,
    contracts,
  });
  return result.assessments[0]!;
}

function promoteGenericCandidate(
  database: Database.Database,
  candidate: CandidateDetails,
): PersistedAssessment {
  const contract =
    GENERIC_CANDIDATE_PROMOTION_CONTRACTS[candidate.proposedClaimType];
  if (!contract) {
    throw new Error(
      `Claim type ${candidate.proposedClaimType} has no registered promotion contract`,
    );
  }
  const provenance = record(candidate.provenance, "Candidate provenance");
  const repositoryRevision =
    optionalString(provenance.repositoryRevision) ?? "working-tree";
  let dependencies = candidate.evidence.flatMap(
    (evidence): ClaimAssessmentDependencyInput[] =>
      evidence.evidenceVersionId
        ? [
            {
              dependencyKind: "evidence_version",
              dependencyVersionId: evidence.evidenceVersionId,
              epistemicRole: "assertion",
              warrantPolarity: null,
              assessmentEffect: "neutral",
            },
          ]
        : [],
  );
  let status: "supported" | "refuted" | "contested" | "inconclusive" =
    "inconclusive";
  let changedWarrantVersionId: string | undefined;
  let warrantMaterialChanged = true;
  if (candidate.proposedClaimType === "CLM-PUBLIC-SYMBOL-DOCUMENTED") {
    const documentation = candidate.evidence.find(
      (evidence) => evidence.role === "documentation",
    );
    const definition = candidate.evidence.find(
      (evidence) => evidence.role === "definition",
    );
    const documentationValue = evidenceNormalizedValue(
      database,
      documentation?.evidenceVersionId,
    );
    const definitionValue = evidenceNormalizedValue(
      database,
      definition?.evidenceVersionId,
    );
    const normalizedDocumentation =
      documentationValue &&
      typeof documentationValue === "object" &&
      !Array.isArray(documentationValue)
        ? (documentationValue as Record<string, unknown>)
        : undefined;
    const documented =
      typeof normalizedDocumentation?.present === "boolean"
        ? normalizedDocumentation.present
        : undefined;
    const normalizedDefinition =
      definitionValue &&
      typeof definitionValue === "object" &&
      !Array.isArray(definitionValue)
        ? (definitionValue as Record<string, unknown>)
        : undefined;
    const definitionKnown = typeof normalizedDefinition?.exported === "boolean";
    const ambiguousAssignment =
      candidate.confidence === "ambiguous" ||
      normalizedDocumentation?.ambiguousAssignment === true;
    const applicable =
      definitionKnown && normalizedDefinition.exported !== false;
    const ruleStatus: "passed" | "failed" | "inconclusive" | "not_applicable" =
      ambiguousAssignment || !definitionKnown
        ? "inconclusive"
        : !applicable
          ? "not_applicable"
          : documented === undefined
            ? "inconclusive"
            : documented
              ? "passed"
              : "failed";
    const evidenceVersionIds = [definition, documentation].flatMap(
      (evidence) =>
        evidence?.evidenceVersionId ? [evidence.evidenceVersionId] : [],
    );
    const ruleInput = {
      ruleId: "R.public-symbol-documentation",
      subjectKey: candidate.subjects[0]?.identityKey,
      applicability: applicable
        ? ("applicable" as const)
        : ("not_applicable" as const),
      normalizedStatus: ruleStatus,
      normalizedOutput: {
        symbolName: normalizedDefinition?.name ?? null,
        symbolKind: normalizedDefinition?.kind ?? null,
        signature: normalizedDefinition?.signature ?? null,
        exported: normalizedDefinition?.exported ?? null,
        documented: documented ?? null,
        summary: normalizedDocumentation?.summary ?? null,
        ambiguousAssignment,
      },
      normalizedReasons: [
        ambiguousAssignment
          ? "symbol-documentation-assignment-ambiguous"
          : !definitionKnown
            ? "symbol-definition-evidence-missing"
            : !applicable
              ? "public-symbol-no-longer-applicable"
              : documented === undefined
                ? "symbol-documentation-evidence-missing"
                : documented
                  ? "public-symbol-documentation-present"
                  : "public-symbol-documentation-missing",
      ],
      evidenceVersionIds,
      ruleContractVersion: "public-symbol-documentation-v2",
      implementationFingerprint: "public-symbol-documentation-impl-v2",
    };
    const previousWarrantMaterialFingerprint =
      currentRuleWarrantMaterialFingerprint(
        database,
        ruleInput.ruleId,
        ruleInput.subjectKey,
      );
    const nextWarrantMaterialFingerprint = ruleWarrantMaterialFingerprint(
      database,
      ruleInput,
    );
    warrantMaterialChanged =
      previousWarrantMaterialFingerprint === undefined ||
      previousWarrantMaterialFingerprint !== nextWarrantMaterialFingerprint;
    const rule = new ClaimsStore(database).persistRuleResult(
      ruleInput,
      evidenceVersionIds,
    );
    const assessment = assessClaimPolicy([
      {
        dependencyKind: "rule_result_version",
        dependencyVersionId: rule.id,
        epistemicRole: "warrant",
        authoritative: true,
        ruleStatus,
      },
    ]);
    status = assessment.status;
    dependencies = assessment.dependencies;
    changedWarrantVersionId = rule.id;
  } else if (candidate.proposedClaimType === "CLM-ENDPOINT-AUTHENTICATED") {
    const route = candidate.evidence.find(
      (evidence) => evidence.role === "route",
    );
    const handler = candidate.evidence.find(
      (evidence) => evidence.role === "handler",
    );
    const guard = candidate.evidence.find(
      (evidence) => evidence.role === "guard",
    );
    const documentation = candidate.evidence.find(
      (evidence) => evidence.role === "documentation",
    );
    const framework = candidate.evidence.find(
      (evidence) => evidence.role === "framework",
    );
    const routeValue = record(
      evidenceNormalizedValue(database, route?.evidenceVersionId),
      "Endpoint Route Evidence",
    );
    const handlerValue = handler?.evidenceVersionId
      ? record(
          evidenceNormalizedValue(database, handler.evidenceVersionId),
          "Endpoint Handler Evidence",
        )
      : {};
    const guardValue = guard?.evidenceVersionId
      ? record(
          evidenceNormalizedValue(database, guard.evidenceVersionId),
          "Endpoint Guard Evidence",
        )
      : {};
    const documentationValue = documentation?.evidenceVersionId
      ? record(
          evidenceNormalizedValue(database, documentation.evidenceVersionId),
          "Endpoint Security Documentation Evidence",
        )
      : {};
    const frameworkValue = framework?.evidenceVersionId
      ? record(
          evidenceNormalizedValue(database, framework.evidenceVersionId),
          "Endpoint Framework Evidence",
        )
      : {};
    const active = routeValue.active === true;
    const routeKnown = routeValue.pathKnown === true;
    const frameworkKnown =
      frameworkValue.recognized === true &&
      frameworkValue.framework === "nestjs";
    const guardPresent = guardValue.present === true;
    const publicExemption = guardValue.publicExemption === true;
    const documentationRequirement = optionalString(
      documentationValue.requirement,
    );
    const ambiguous = candidate.confidence === "ambiguous";
    const documentationConflict =
      (documentationRequirement === "required" && publicExemption) ||
      (documentationRequirement === "public" && guardPresent);
    const applicable = active && (!publicExemption || documentationConflict);
    const ruleStatus: "passed" | "failed" | "inconclusive" | "not_applicable" =
      !active
        ? "not_applicable"
        : ambiguous || !frameworkKnown || !routeKnown
          ? "inconclusive"
          : documentationConflict
            ? "failed"
            : publicExemption
              ? "not_applicable"
              : guardPresent
                ? "passed"
                : documentationRequirement === "required"
                  ? "failed"
                  : "inconclusive";
    const reason = !active
      ? "endpoint-route-no-longer-present"
      : ambiguous
        ? "endpoint-route-correlation-ambiguous"
        : !frameworkKnown
          ? "endpoint-framework-configuration-unknown"
          : !routeKnown
            ? "endpoint-route-path-not-statically-known"
            : documentationConflict
              ? "endpoint-security-contract-contradiction"
              : publicExemption
                ? "endpoint-explicitly-public"
                : guardPresent
                  ? "endpoint-authentication-guard-present"
                  : documentationRequirement === "required"
                    ? "required-endpoint-authentication-guard-missing"
                    : "endpoint-authentication-evidence-missing";
    const evidenceVersionIds = [
      route,
      handler,
      guard,
      documentation,
      framework,
    ].flatMap((evidence) =>
      evidence?.evidenceVersionId ? [evidence.evidenceVersionId] : [],
    );
    const ruleInput = {
      ruleId: "R.endpoint-authentication",
      subjectKey: candidate.subjects.find(
        (subject) => subject.role === "endpoint",
      )?.identityKey,
      applicability: applicable
        ? ("applicable" as const)
        : ("not_applicable" as const),
      normalizedStatus: ruleStatus,
      normalizedOutput: {
        framework: frameworkValue.framework ?? routeValue.framework ?? null,
        method: routeValue.method ?? null,
        path: routeValue.path ?? null,
        pathKnown: routeKnown,
        active,
        controller: handlerValue.controller ?? null,
        handler: handlerValue.handler ?? null,
        guards: Array.isArray(guardValue.guards) ? guardValue.guards : [],
        guardSource: guardValue.source ?? null,
        publicExemption,
        documentationRequirement: documentationRequirement ?? null,
      },
      normalizedReasons: [reason],
      evidenceVersionIds,
      ruleContractVersion: "endpoint-authentication-nestjs-v1",
      implementationFingerprint: "endpoint-authentication-nestjs-impl-v1",
    };
    const previousWarrantMaterialFingerprint =
      currentRuleWarrantMaterialFingerprint(
        database,
        ruleInput.ruleId,
        ruleInput.subjectKey,
      );
    const nextWarrantMaterialFingerprint = ruleWarrantMaterialFingerprint(
      database,
      ruleInput,
    );
    warrantMaterialChanged =
      previousWarrantMaterialFingerprint === undefined ||
      previousWarrantMaterialFingerprint !== nextWarrantMaterialFingerprint;
    const rule = new ClaimsStore(database).persistRuleResult(
      ruleInput,
      evidenceVersionIds,
    );
    const assessment = assessClaimPolicy([
      {
        dependencyKind: "rule_result_version",
        dependencyVersionId: rule.id,
        epistemicRole: "warrant",
        authoritative: true,
        ruleStatus,
      },
    ]);
    status = assessment.status;
    dependencies = assessment.dependencies;
    changedWarrantVersionId = rule.id;
  }
  const persisted = new ClaimsStore(database).persistGenericClaimAssessment({
    subjects: candidate.subjects.map((subject) => ({
      kind: subject.kind,
      identityKey: subject.identityKey,
      displayName: subject.displayName,
      role: subject.role,
    })),
    identitySubjectRoles:
      candidate.proposedClaimType === "CLM-ENDPOINT-AUTHENTICATED"
        ? ["endpoint"]
        : undefined,
    claimType: candidate.proposedClaimType,
    identityContract: contract.identity,
    materialityContract: contract.materiality,
    normalizedStatement: candidate.normalizedStatement,
    assessmentPolicyId: contract.assessmentPolicy.id,
    assessmentPolicyVersion: contract.assessmentPolicy.version,
    repositoryRevision,
    status,
    dependencies,
  });
  if (persisted.created && changedWarrantVersionId && warrantMaterialChanged) {
    const previous = database
      .prepare(
        `SELECT id, epistemic_status
         FROM claim_assessments
         WHERE superseded_by_assessment_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(persisted.id) as
      | { id: string; epistemic_status: string }
      | undefined;
    if (previous) {
      new ClaimsReviewStore(database).reopen({
        claimIdentityId: persisted.claimIdentityId,
        basisAssessmentId: persisted.id,
        dependencyKind: "rule_result_version",
        dependencyVersionId: changedWarrantVersionId,
        reason: "warrant-changed",
        secondaryProvenance: {
          candidateId: candidate.id,
          previousStatus: previous.epistemic_status,
          currentStatus: status,
        },
      });
    }
  }
  return persisted;
}

function promoteCandidate(
  database: Database.Database,
  candidate: CandidateDetails,
  contracts: ClaimsContractVersions,
): PersistedAssessment {
  return candidate.discoveryAdapterId === "r1-code-values"
    ? promoteR1Candidate(database, candidate, contracts)
    : promoteGenericCandidate(database, candidate);
}

export function reviewCandidate(
  database: Database.Database,
  input: {
    candidateId: string;
    actor: string;
    decision: CandidateReviewDecision;
    rationale: string;
    provenance: unknown;
    contracts: ClaimsContractVersions;
  },
): CandidateGovernanceResult {
  const apply = database.transaction(() => {
    const candidates = new CandidateStore(database);
    const candidate = candidates.details(input.candidateId);
    if (!candidate)
      throw new Error(`Candidate ${input.candidateId} does not exist`);
    const assessment =
      input.decision === "promote"
        ? promoteCandidate(database, candidate, input.contracts)
        : undefined;
    const review = candidates.review({
      candidateId: input.candidateId,
      actorKind: "human",
      actorId: input.actor,
      decision: input.decision,
      effect: "effective",
      rationale: input.rationale,
      provenance: input.provenance,
      promotedClaimIdentityId: assessment?.claimIdentityId,
    });
    return { review, ...(assessment ? { assessment } : {}) };
  });
  return apply();
}

export function applyCandidatePolicy(
  database: Database.Database,
  input: CandidatePolicyDecisionInput & { contracts: ClaimsContractVersions },
): CandidateGovernanceResult {
  const apply = database.transaction(() => {
    const candidates = new CandidateStore(database);
    const candidate = candidates.details(input.candidateId);
    if (!candidate)
      throw new Error(`Candidate ${input.candidateId} does not exist`);
    const assessment =
      input.decision === "promote"
        ? promoteCandidate(database, candidate, input.contracts)
        : undefined;
    const review = candidates.applyPolicyDecision({
      ...input,
      promotedClaimIdentityId: assessment?.claimIdentityId,
    });
    return { review, ...(assessment ? { assessment } : {}) };
  });
  return apply();
}

export function linkCandidatePolicyPromotion(
  database: Database.Database,
  input: {
    candidateIdentityKey: string;
    promotedClaimIdentityId: string;
    policyId: string;
    policyVersion: string;
    rationale: string;
    provenance: unknown;
  },
): PersistedCandidateReview | undefined {
  const link = database.transaction(() => {
    const candidates = new CandidateStore(database);
    const current = candidates.current(input.candidateIdentityKey);
    if (!current) {
      throw new Error(`Candidate ${input.candidateIdentityKey} does not exist`);
    }
    const cycle = database
      .prepare(
        `SELECT MAX(version_ordinal) AS start_ordinal
         FROM claim_candidates
         WHERE identity_key = ? AND state = 'discovered'`,
      )
      .get(input.candidateIdentityKey) as { start_ordinal: number };
    const existing = database
      .prepare(
        `SELECT decision.id, decision.promoted_claim_identity_id
         FROM candidate_policy_decisions decision
         JOIN claim_candidates candidate ON candidate.id = decision.candidate_id
         WHERE candidate.identity_key = ?
           AND candidate.version_ordinal >= ?
           AND decision.policy_id = ?
           AND decision.policy_version = ?
         ORDER BY candidate.version_ordinal DESC LIMIT 1`,
      )
      .get(
        input.candidateIdentityKey,
        cycle.start_ordinal,
        input.policyId,
        input.policyVersion,
      ) as
      | { id: string; promoted_claim_identity_id: string | null }
      | undefined;
    if (existing) {
      if (
        existing.promoted_claim_identity_id !== input.promotedClaimIdentityId
      ) {
        throw new Error(
          `Candidate Policy ${input.policyId}@${input.policyVersion} is linked to a different Claim`,
        );
      }
      return undefined;
    }
    const triaged = candidates.triage(current.id, {
      basis: input.policyId,
      policyVersion: input.policyVersion,
    });
    return candidates.applyPolicyDecision({
      candidateId: triaged.id,
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      decision: "promote",
      rationale: input.rationale,
      provenance: input.provenance,
      promotedClaimIdentityId: input.promotedClaimIdentityId,
    });
  });
  return link();
}

export function persistPortableCandidateDecision(
  workspaceRoot: string,
  candidate: CandidateDetails,
  input: {
    decision: Exclude<CandidateReviewDecision, "defer">;
    actor: PortableClaimsActor;
    rationale: string;
    decidedAt: string;
  },
): string {
  const state =
    loadPortableClaimsState(workspaceRoot) ?? emptyPortableClaimsState();
  state.candidateDecisions[candidate.identityKey] = {
    decision: input.decision,
    candidateFingerprint: candidate.observationFingerprint,
    actor: input.actor,
    decidedAt: input.decidedAt,
    rationale: input.rationale,
  };
  return writePortableClaimsState(workspaceRoot, state);
}
