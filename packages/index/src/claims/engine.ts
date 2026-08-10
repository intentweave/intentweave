// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { assessClaimPolicy } from "./policies.js";
import {
  r1LiteralBinding,
  r3ConfigResolution,
  r3DocumentationConformance,
  r7ScopeOverride,
} from "./rules.js";
import { ClaimsStore } from "./store.js";
import type {
  ClaimsScopeEvaluation,
  ClaimsScopeEvaluationInput,
  ClaimScalar,
  NormalizedRuleResult,
  PersistedVersion,
} from "./types.js";

function resultVersion(
  store: ClaimsStore,
  ruleId: string,
  scope: string | undefined,
  result: NormalizedRuleResult,
  evidenceVersionIds: string[],
  ruleContractVersion: string,
  implementationFingerprint: string,
): PersistedVersion {
  return store.persistRuleResult(
    {
      ruleId,
      scope,
      applicability: result.applicability,
      normalizedStatus: result.status,
      normalizedOutput: result.output,
      normalizedReasons: result.reasons,
      evidenceVersionIds,
      ruleContractVersion,
      implementationFingerprint,
    },
    evidenceVersionIds,
  );
}

function outputValue(output: unknown): ClaimScalar | undefined {
  if (!output || typeof output !== "object" || !("value" in output)) {
    return undefined;
  }
  const value = output.value;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  ) {
    return value;
  }
  return undefined;
}

/**
 * Materialize the first slice's three policies from already persisted evidence.
 * The CLI discovers and versions evidence first; this layer owns only durable
 * rule, claim, and assessment derivation.
 */
export class ClaimsEngine {
  constructor(private readonly store: ClaimsStore) {}

  evaluateScope(input: ClaimsScopeEvaluationInput): ClaimsScopeEvaluation {
    const ruleResults: PersistedVersion[] = [];
    const assessments = [];
    const codeEvidenceIds = [input.codeDefault, input.codeAnnotation]
      .flatMap((evidence) => (evidence ? [evidence.versionId] : []));
    const r1 = r1LiteralBinding(input.codeDefault?.value);
    const r1Version = resultVersion(
      this.store,
      "R1.literal-binding",
      undefined,
      r1,
      codeEvidenceIds,
      input.contracts.r1RuleContractVersion,
      input.contracts.implementationFingerprint,
    );
    ruleResults.push(r1Version);

    const defaultAssessment = assessClaimPolicy([
      ...(input.codeDefault
        ? [
            {
              dependencyKind: "evidence_version" as const,
              dependencyVersionId: input.codeDefault.versionId,
              epistemicRole: "assertion" as const,
              authoritative: true,
              assertionValue: input.codeDefault.value,
              claimValue: input.codeDefault.value,
            },
          ]
        : []),
      ...(input.codeAnnotation && input.codeDefault
        ? [
            {
              dependencyKind: "evidence_version" as const,
              dependencyVersionId: input.codeAnnotation.versionId,
              epistemicRole: "assertion" as const,
              authoritative: true,
              assertionValue: input.codeAnnotation.value,
              claimValue: input.codeDefault.value,
            },
          ]
        : []),
      {
        dependencyKind: "rule_result_version" as const,
        dependencyVersionId: r1Version.id,
        epistemicRole: "warrant" as const,
        authoritative: true,
        ruleStatus: r1.status,
      },
    ]);
    assessments.push(
      this.store.persistClaimAssessment({
        parameterKey: input.parameterKey,
        claimType: "CLM-DEFAULT",
        normalizedStatement: { value: input.codeDefault?.value ?? null },
        assessmentPolicyId: "default-contract",
        assessmentPolicyVersion: input.contracts.defaultPolicyVersion,
        repositoryRevision: input.repositoryRevision,
        status: defaultAssessment.status,
        dependencies: defaultAssessment.dependencies,
      }),
    );

    const r7 = r7ScopeOverride(
      input.scopeEvidence.capabilities,
      input.configOverride?.value,
    );
    const r7Version = resultVersion(
      this.store,
      "R7.scope-override",
      input.scope,
      r7,
      [input.scopeEvidence.versionId, input.configOverride?.versionId].filter(
        (id): id is string => Boolean(id),
      ),
      input.contracts.r7RuleContractVersion,
      input.contracts.implementationFingerprint,
    );
    ruleResults.push(r7Version);
    if (r7.status === "not_applicable") return { ruleResults, assessments };

    const r3 = r3ConfigResolution(
      input.codeDefault?.value,
      input.configOverride?.value,
    );
    const r3Version = resultVersion(
      this.store,
      "R3.effective",
      input.scope,
      r3,
      [input.codeDefault?.versionId, input.configOverride?.versionId].filter(
        (id): id is string => Boolean(id),
      ),
      input.contracts.r3RuleContractVersion,
      input.contracts.implementationFingerprint,
    );
    ruleResults.push(r3Version);
    const effectiveValue = outputValue(r3.output);
    const effectiveAssessment = assessClaimPolicy([
      {
        dependencyKind: "rule_result_version",
        dependencyVersionId: r7Version.id,
        epistemicRole: "warrant",
        authoritative: true,
        ruleStatus: r7.status,
      },
      {
        dependencyKind: "rule_result_version",
        dependencyVersionId: r3Version.id,
        epistemicRole: "warrant",
        authoritative: true,
        ruleStatus: r3.status,
      },
    ]);
    assessments.push(
      this.store.persistClaimAssessment({
        parameterKey: input.parameterKey,
        claimType: "CLM-EFFECTIVE",
        scope: input.scope,
        normalizedStatement: { value: effectiveValue ?? null },
        assessmentPolicyId: "runtime-resolution",
        assessmentPolicyVersion: input.contracts.runtimePolicyVersion,
        repositoryRevision: input.repositoryRevision,
        status: effectiveAssessment.status,
        dependencies: effectiveAssessment.dependencies,
      }),
    );

    if (input.documentedOverride) {
      const r3Doc = r3DocumentationConformance(
        input.documentedOverride.value,
        effectiveValue,
      );
      const r3DocVersion = resultVersion(
        this.store,
        "R3.doc-conformance",
        input.scope,
        r3Doc,
        [
          input.documentedOverride.versionId,
          input.codeDefault?.versionId,
          input.configOverride?.versionId,
        ].filter((id): id is string => Boolean(id)),
        input.contracts.r3RuleContractVersion,
        input.contracts.implementationFingerprint,
      );
      ruleResults.push(r3DocVersion);
      const documentationAssessment = assessClaimPolicy([
        {
          dependencyKind: "rule_result_version",
          dependencyVersionId: r3DocVersion.id,
          epistemicRole: "warrant",
          authoritative: true,
          ruleStatus: r3Doc.status,
        },
      ]);
      assessments.push(
        this.store.persistClaimAssessment({
          parameterKey: input.parameterKey,
          claimType: "CLM-DOC-CONFORMANCE",
          scope: input.scope,
          normalizedStatement: {
            documentedValue: input.documentedOverride.value,
            effectiveValue,
          },
          assessmentPolicyId: "documentation-conformance",
          assessmentPolicyVersion: input.contracts.documentationPolicyVersion,
          repositoryRevision: input.repositoryRevision,
          status: documentationAssessment.status,
          dependencies: documentationAssessment.dependencies,
        }),
      );
    }

    return { ruleResults, assessments };
  }
}