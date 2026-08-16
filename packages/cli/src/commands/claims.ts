// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import Database from "@intentweave/sqlite-compat";
import {
  ClaimsEngine,
  ClaimsReviewStore,
  ClaimsStore,
  claimsExitCode,
  fingerprint,
  materialFingerprint,
  migrateSchema14To15,
} from "@intentweave/index";
import type {
  ClaimScalar,
  ClaimsContractVersions,
  PersistedVersion,
} from "@intentweave/index";
import {
  ClaimsBindingError,
  extractBoundCodeEvidence,
  extractDiscoveredCodeEvidence,
  extractDocumentationAssertions,
  extractScopeConfigEvidence,
  extractScopeRegistryEvidence,
  loadOptionalClaimsBindings,
  parseClaimsBindings,
  parseScopeRegistry,
} from "../claims/discovery.js";
import { load as yamlLoad } from "js-yaml";
import { ClaimsGit, ClaimsGitError } from "../claims/git.js";
import type { GitRename } from "../claims/git.js";

const defaultContracts: ClaimsContractVersions = {
  r1RuleContractVersion: "r1-v1",
  r3RuleContractVersion: "r3-v1",
  r7RuleContractVersion: "r7-v1",
  implementationFingerprint: "claims-engine-v1",
  literalPolicyVersion: "literal-binding-v1",
  defaultPolicyVersion: "default-contract-v1",
  runtimePolicyVersion: "runtime-resolution-v1",
  documentationPolicyVersion: "documentation-conformance-v1",
};

function resolveContracts(
  overrides: Partial<ClaimsContractVersions> = {},
): ClaimsContractVersions {
  return { ...defaultContracts, ...overrides };
}

interface PersistedObservation {
  version: PersistedVersion;
  value: ClaimScalar;
}

interface EvidenceVersionMetadata {
  source_kind: string;
  semantic_location: string;
  file_path: string | null;
  normalized_value: string;
}

const CLAIM_CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const CLAIM_CODE_IGNORES = [
  "/node_modules/",
  "/dist/",
  "/coverage/",
  "/.git/",
  "/.iw/",
  "/fixtures/",
  "/__tests__/",
];

function isClaimCodeFile(filePath: string): boolean {
  const normalized = `/${filePath.replaceAll("\\", "/")}`;
  return (
    CLAIM_CODE_EXTENSIONS.some((extension) => normalized.endsWith(extension)) &&
    !CLAIM_CODE_IGNORES.some((ignored) => normalized.includes(ignored)) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

async function discoverWorkingTreeCodeFiles(workspaceRoot: string): Promise<string[]> {
  const { glob } = await import("tinyglobby");
  return (
    await glob(["**/*.{ts,tsx,js,jsx}"], {
      cwd: workspaceRoot,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        ".git/**",
        ".iw/**",
        "**/fixtures/**",
        "**/__tests__/**",
        "**/*.test.*",
        "**/*.spec.*",
      ],
    })
  ).filter(isClaimCodeFile).sort();
}

function currentRevision(workspaceRoot: string): string {
  const headPath = path.join(workspaceRoot, ".git", "HEAD");
  try {
    return fs.readFileSync(headPath, "utf-8").trim();
  } catch {
    return "working-tree";
  }
}

function persistObservation(
  store: ClaimsStore,
  input: {
    parameterKey: string;
    sourceKind: string;
    identityKey: string;
    semanticLocation: string;
    value: ClaimScalar;
    filePath?: string;
    symbolId?: string;
    line?: number;
    bindingBasis?: string;
    bindingConfidence?: string;
    revision: string;
  },
): PersistedObservation {
  const provenance = {
    filePath: input.filePath ?? null,
    symbolId: input.symbolId ?? null,
    line: input.line ?? null,
    repositoryRevision: input.revision,
  };
  return {
    version: store.persistEvidence({
      parameterKey: input.parameterKey,
      sourceKind: input.sourceKind,
      identityKey: input.identityKey,
      fingerprint: fingerprint({
        sourceKind: input.sourceKind,
        value: input.value,
        semanticLocation: input.semanticLocation,
        filePath: input.filePath ?? null,
        symbolId: input.symbolId ?? null,
        line: input.line ?? null,
      }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: input.parameterKey,
        semanticLocation: input.semanticLocation,
        normalizedValue: input.value,
      }),
      normalizedValue: input.value,
      semanticLocation: input.semanticLocation,
      provenance,
      filePath: input.filePath,
      symbolId: input.symbolId,
      spanStartLine: input.line,
      spanEndLine: input.line,
      repositoryRevision: input.revision,
      bindingBasis: input.bindingBasis,
      bindingConfidence: input.bindingConfidence,
    }),
    value: input.value,
  };
}

function persistSnapshotEvidence(
  store: ClaimsStore,
  bindings: NonNullable<ReturnType<typeof loadOptionalClaimsBindings>>,
  scopes: ReturnType<typeof parseScopeRegistry>,
  readBoundFile: (filePath: string) => string,
  readScopeConfig: (scope: string) => string | undefined,
  revision: string,
  discoveredCode: ReturnType<typeof extractDiscoveredCodeEvidence> = [],
): Map<string, PersistedObservation> {
  const observations = new Map<string, PersistedObservation>();
  const persist = (identityKey: string, input: Parameters<typeof persistObservation>[1]) => {
    observations.set(identityKey, persistObservation(store, input));
  };
  for (const observation of [
    ...extractBoundCodeEvidence(bindings, readBoundFile),
    ...discoveredCode,
  ]) {
    if (!("identityKey" in observation)) continue;
    persist(observation.identityKey, {
      parameterKey: observation.parameterKey,
      sourceKind: observation.sourceKind,
      identityKey: observation.identityKey,
      semanticLocation: observation.semanticLocation,
      value: observation.normalizedValue,
      filePath: observation.filePath,
      symbolId: observation.symbolId,
      line: observation.line,
      bindingBasis: observation.bindingBasis,
      bindingConfidence: observation.bindingConfidence,
      revision,
    });
  }
  for (const observation of extractDocumentationAssertions(bindings, readBoundFile)) {
    if (observation.kind !== "evidence") continue;
    persist(observation.identityKey, {
      parameterKey: observation.parameterKey,
      sourceKind: "documentation",
      identityKey: observation.identityKey,
      semanticLocation: observation.semanticLocation,
      value: observation.normalizedValue,
      filePath: observation.filePath,
      line: observation.line,
      revision,
    });
  }
  for (const observation of extractScopeRegistryEvidence(scopes)) {
    persist(observation.identityKey, {
      parameterKey: "scope.registry",
      sourceKind: observation.sourceKind,
      identityKey: observation.identityKey,
      semanticLocation: observation.semanticLocation,
      value: observation.normalizedValue,
      filePath: "config/environments.yaml",
      revision,
    });
  }
  for (const observation of extractScopeConfigEvidence(bindings, scopes, readScopeConfig)) {
    if (observation.kind !== "evidence") continue;
    persist(observation.identityKey, {
      parameterKey: observation.parameterKey,
      sourceKind: observation.sourceKind,
      identityKey: observation.identityKey,
      semanticLocation: observation.semanticLocation,
      value: observation.normalizedValue,
      filePath: observation.filePath,
      revision,
    });
  }
  return observations;
}

function formatText(result: {
  claims: Array<{
    parameterKey: string;
    claimType: string;
    ruleStatuses: string[];
    assessmentStatuses: string[];
  }>;
  scopes: Array<{
    scope: string;
    ruleStatuses: string[];
    assessmentStatuses: string[];
  }>;
}): string {
  const lines: string[] = [];
  for (const claim of result.claims) {
    lines.push(`Claim: ${claim.parameterKey} (${claim.claimType})`);
    lines.push(`  Rule results: ${claim.ruleStatuses.join(", ")}`);
    lines.push(`  Assessments: ${claim.assessmentStatuses.join(", ") || "none"}`);
  }
  for (const scope of result.scopes) {
    lines.push(`Scope: ${scope.scope}`);
    lines.push(`  Rule results: ${scope.ruleStatuses.join(", ")}`);
    lines.push(`  Assessments: ${scope.assessmentStatuses.join(", ") || "none"}`);
  }
  return lines.join("\n");
}

function claimsDatabase(workspaceRoot: string): Database.Database {
  const dbPath = path.join(workspaceRoot, ".iw", "index.db");
  if (!fs.existsSync(dbPath)) {
    throw new ClaimsBindingError(
      `Index not found at ${dbPath}. Run \`iw index build\` first.`,
    );
  }
  const database = new Database(dbPath);
  migrateSchema14To15(database);
  return database;
}

function isMaterialChange(
  database: Database.Database,
  fromEvidenceVersionId: string,
  toEvidenceVersionId: string,
): boolean {
  const versions = database
    .prepare(
      `SELECT id, material_fingerprint FROM evidence_versions WHERE id IN (?, ?)`,
    )
    .all(fromEvidenceVersionId, toEvidenceVersionId) as Array<{
    id: string;
    material_fingerprint: string;
  }>;
  const from = versions.find((version) => version.id === fromEvidenceVersionId);
  const to = versions.find((version) => version.id === toEvidenceVersionId);
  return !from || !to || from.material_fingerprint !== to.material_fingerprint;
}

function evidenceVersionMetadata(
  database: Database.Database,
  versionId: string,
): EvidenceVersionMetadata | undefined {
  return database
    .prepare(
      `SELECT identity.source_kind, version.semantic_location, version.file_path,
              version.normalized_value
       FROM evidence_versions version
       JOIN evidence_identities identity ON identity.id = version.evidence_identity_id
       WHERE version.id = ?`,
    )
    .get(versionId) as EvidenceVersionMetadata | undefined;
}

function renamedPredecessor(
  database: Database.Database,
  previousEvidence: Map<string, PersistedObservation>,
  current: PersistedObservation,
  renames: GitRename[],
): { identityKey: string; observation: PersistedObservation; rename: GitRename } | undefined {
  const currentMetadata = evidenceVersionMetadata(database, current.version.id);
  if (!currentMetadata?.file_path) return undefined;
  const matchingRenames = renames.filter((rename) => rename.toPath === currentMetadata.file_path);
  if (matchingRenames.length !== 1) return undefined;
  const rename = matchingRenames[0]!;
  const matches = [...previousEvidence.entries()].filter(([_, previous]) => {
    const previousMetadata = evidenceVersionMetadata(database, previous.version.id);
    return (
      previousMetadata?.file_path === rename.fromPath &&
      previousMetadata.source_kind === currentMetadata.source_kind &&
      previousMetadata.semantic_location === currentMetadata.semantic_location
    );
  });
  if (matches.length !== 1) return undefined;
  const [identityKey, observation] = matches[0]!;
  return { identityKey, observation, rename };
}

function reopenEvidenceChanges(
  database: Database.Database,
  reviews: ClaimsReviewStore,
  evidenceVersionId: string,
  reason: "material-change" | "continuity-uncertain",
  provenance: unknown,
): string[] {
  const impacted = database
    .prepare(
      `SELECT DISTINCT ci.id AS claim_identity_id, ca.id AS assessment_id,
              dependency.dependency_kind, dependency.dependency_version_id
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       JOIN claim_identities ci ON ci.id = cv.claim_identity_id
       JOIN claim_assessment_dependencies dependency
         ON dependency.claim_assessment_id = ca.id
       WHERE ca.is_current = 1 AND (
         (dependency.dependency_kind = 'evidence_version'
          AND dependency.dependency_version_id = ?)
         OR
         (dependency.dependency_kind = 'rule_result_version'
          AND EXISTS (
            SELECT 1 FROM rule_result_evidence rule_evidence
            WHERE rule_evidence.rule_result_version_id = dependency.dependency_version_id
              AND rule_evidence.evidence_version_id = ?
          ))
       )`,
    )
    .all(evidenceVersionId, evidenceVersionId) as Array<{
    claim_identity_id: string;
    assessment_id: string;
    dependency_kind: "evidence_version" | "rule_result_version";
    dependency_version_id: string;
  }>;
  const reopenedClaims: string[] = [];
  for (const assessment of impacted) {
    const reopened = reviews.reopen({
      claimIdentityId: assessment.claim_identity_id,
      basisAssessmentId: assessment.assessment_id,
      dependencyKind: assessment.dependency_kind,
      dependencyVersionId: assessment.dependency_version_id,
      reason,
      secondaryProvenance: provenance,
    });
    if (reopened?.created) reopenedClaims.push(assessment.claim_identity_id);
  }
  return reopenedClaims;
}

function reopenBrokenContinuity(
  database: Database.Database,
  reviews: ClaimsReviewStore,
  previousEvidenceVersionId: string,
  assessmentIds: string[],
  provenance: unknown,
): string[] {
  if (assessmentIds.length === 0) return [];
  const evidence = database
    .prepare(
      `SELECT source_kind, semantic_location FROM evidence_versions evidence
       JOIN evidence_identities identity ON identity.id = evidence.evidence_identity_id
       WHERE evidence.id = ?`,
    )
    .get(previousEvidenceVersionId) as
    | { source_kind: string; semantic_location: string | null }
    | undefined;
  if (!evidence) return [];
  const claimTypes =
    evidence.source_kind === "code-default" || evidence.source_kind === "code-annotation"
      ? ["CLM-DEFAULT"]
      : evidence.source_kind === "documentation"
        ? evidence.semantic_location?.endsWith(".default")
          ? ["CLM-DEFAULT"]
          : ["CLM-DOC-CONFORMANCE"]
        : ["CLM-EFFECTIVE", "CLM-DOC-CONFORMANCE"];
  const placeholders = assessmentIds.map(() => "?").join(", ");
  const claimTypePlaceholders = claimTypes.map(() => "?").join(", ");
  const impacted = database
    .prepare(
      `SELECT ci.id AS claim_identity_id, ca.id AS assessment_id
       FROM evidence_versions evidence
       JOIN evidence_identities evidence_identity
         ON evidence_identity.id = evidence.evidence_identity_id
       JOIN claim_identities ci
         ON ci.parameter_identity_id = evidence_identity.parameter_identity_id
       JOIN claim_versions cv ON cv.claim_identity_id = ci.id
       JOIN claim_assessments ca ON ca.claim_version_id = cv.id
       WHERE evidence.id = ? AND ca.is_current = 1
        AND ca.id IN (${placeholders})
        AND ci.claim_type IN (${claimTypePlaceholders})`,
    )
     .all(previousEvidenceVersionId, ...assessmentIds, ...claimTypes) as Array<{
    claim_identity_id: string;
    assessment_id: string;
  }>;
  const reopenedClaims: string[] = [];
  for (const assessment of impacted) {
    const reopened = reviews.reopen({
      claimIdentityId: assessment.claim_identity_id,
      basisAssessmentId: assessment.assessment_id,
      dependencyKind: "evidence_version",
      dependencyVersionId: previousEvidenceVersionId,
      reason: "continuity-broken",
      secondaryProvenance: provenance,
    });
    if (reopened?.created) reopenedClaims.push(assessment.claim_identity_id);
  }
  return reopenedClaims;
}

interface RuleDependencySnapshot {
  dependency_version_id: string;
  epistemic_role: string;
  warrant_polarity: string | null;
  assessment_effect: string;
  identity_key: string;
  rule_contract_version: string;
  implementation_fingerprint: string;
  normalized_status: string;
  normalized_output_json: string;
  normalized_reasons_json: string;
}

function ruleDependencySnapshots(
  database: Database.Database,
  assessmentId: string,
): Map<string, RuleDependencySnapshot> {
  const rows = database
    .prepare(
      `SELECT dependency.dependency_version_id, dependency.epistemic_role,
              dependency.warrant_polarity, dependency.assessment_effect,
              identity.identity_key, result.rule_contract_version,
              result.implementation_fingerprint, result.normalized_status,
              result.normalized_output_json, result.normalized_reasons_json
       FROM claim_assessment_dependencies dependency
       JOIN rule_result_versions result
         ON result.id = dependency.dependency_version_id
       JOIN rule_result_identities identity
         ON identity.id = result.rule_result_identity_id
       WHERE dependency.claim_assessment_id = ?
         AND dependency.dependency_kind = 'rule_result_version'
       ORDER BY identity.identity_key`,
    )
    .all(assessmentId) as RuleDependencySnapshot[];
  return new Map(rows.map((row) => [row.identity_key, row]));
}

function contractReferenceAssessmentId(
  database: Database.Database,
  claimIdentityId: string,
  baseRevision?: string,
  currentAssessmentId?: string,
  preRunReferenceAssessmentIds?: ReadonlySet<string>,
): string | undefined {
  if (baseRevision) {
    const anchored = database
      .prepare(
        `SELECT ca.id
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         WHERE cv.claim_identity_id = ? AND ca.reference_key = ?
           AND ca.id != ?`,
      )
      .get(
        claimIdentityId,
        `${claimIdentityId}:${baseRevision}`,
        currentAssessmentId ?? "",
      ) as
      | { id: string }
      | undefined;
    if (
      anchored &&
      (!preRunReferenceAssessmentIds || preRunReferenceAssessmentIds.has(anchored.id))
    ) {
      return anchored.id;
    }
  }
  const reviewed = database
    .prepare(
      `SELECT basis_assessment_id
       FROM review_decisions
       WHERE claim_identity_id = ? AND is_current = 1`,
    )
    .get(claimIdentityId) as { basis_assessment_id: string } | undefined;
  if (reviewed) return reviewed.basis_assessment_id;
  if (baseRevision) {
    const observedAtBase = database
      .prepare(
        `SELECT ca.id
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         WHERE cv.claim_identity_id = ? AND ca.repository_revision = ?
           AND ca.id != ?
         ORDER BY ca.created_at DESC
         LIMIT 1`,
      )
      .get(claimIdentityId, baseRevision, currentAssessmentId ?? "") as
      | { id: string }
      | undefined;
    if (observedAtBase) return observedAtBase.id;
  }
  return undefined;
}

function semanticContractDrift(
  database: Database.Database,
  currentAssessmentId: string,
  referenceAssessmentId: string,
  baseRevision?: string,
): { dependencyVersionId: string; provenance: Record<string, unknown> } | undefined {
  const assessmentRow = (assessmentId: string) =>
    database
      .prepare(
        `SELECT cv.id AS claim_version_id, cv.assessment_policy_id,
                cv.assessment_policy_version, cv.normalized_statement_json
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         WHERE ca.id = ?`,
      )
      .get(assessmentId) as
      | {
          claim_version_id: string;
          assessment_policy_id: string;
          assessment_policy_version: string;
          normalized_statement_json: string;
        }
      | undefined;
  const current = assessmentRow(currentAssessmentId);
  const reference = assessmentRow(referenceAssessmentId);
  if (!current || !reference) return undefined;

  const currentRules = ruleDependencySnapshots(database, currentAssessmentId);
  const referenceRules = ruleDependencySnapshots(database, referenceAssessmentId);
  const changedRules: Array<Record<string, unknown>> = [];
  for (const identityKey of [
    ...new Set([...currentRules.keys(), ...referenceRules.keys()]),
  ].sort()) {
    const currentRule = currentRules.get(identityKey);
    const referenceRule = referenceRules.get(identityKey);
    if (!currentRule || !referenceRule) {
      changedRules.push({
        identityKey,
        from: referenceRule?.dependency_version_id ?? null,
        to: currentRule?.dependency_version_id ?? null,
        reason: "rule-dependency-set",
      });
      continue;
    }
    const differs =
      currentRule.epistemic_role !== referenceRule.epistemic_role ||
      currentRule.warrant_polarity !== referenceRule.warrant_polarity ||
      currentRule.assessment_effect !== referenceRule.assessment_effect ||
      currentRule.rule_contract_version !== referenceRule.rule_contract_version ||
      currentRule.normalized_status !== referenceRule.normalized_status ||
      currentRule.normalized_output_json !== referenceRule.normalized_output_json ||
      currentRule.normalized_reasons_json !== referenceRule.normalized_reasons_json;
    if (differs) {
      changedRules.push({
        identityKey,
        from: {
          dependencyVersionId: referenceRule.dependency_version_id,
          ruleContractVersion: referenceRule.rule_contract_version,
          implementationFingerprint: referenceRule.implementation_fingerprint,
          normalizedStatus: referenceRule.normalized_status,
          normalizedOutput: referenceRule.normalized_output_json,
          normalizedReasons: referenceRule.normalized_reasons_json,
          assessmentEffect: referenceRule.assessment_effect,
        },
        to: {
          dependencyVersionId: currentRule.dependency_version_id,
          ruleContractVersion: currentRule.rule_contract_version,
          implementationFingerprint: currentRule.implementation_fingerprint,
          normalizedStatus: currentRule.normalized_status,
          normalizedOutput: currentRule.normalized_output_json,
          normalizedReasons: currentRule.normalized_reasons_json,
          assessmentEffect: currentRule.assessment_effect,
        },
      });
    }
  }

  const policyChanged =
    current.assessment_policy_id !== reference.assessment_policy_id ||
    current.assessment_policy_version !== reference.assessment_policy_version;
  if (changedRules.length === 0 && !policyChanged) return undefined;

  const changedDependency = changedRules.find((rule) => {
    const to = rule.to;
    return Boolean(
      to &&
        typeof to === "object" &&
        "dependencyVersionId" in to &&
        typeof to.dependencyVersionId === "string",
    );
  });
  const dependencyVersionId =
    changedDependency &&
    typeof changedDependency.to === "object" &&
    changedDependency.to !== null &&
    "dependencyVersionId" in changedDependency.to
      ? String(changedDependency.to.dependencyVersionId)
      : [...currentRules.values()][0]?.dependency_version_id;
  if (!dependencyVersionId) return undefined;

  return {
    dependencyVersionId,
    provenance: {
      baseRevision: baseRevision ?? null,
      referenceAssessmentId,
      currentAssessmentId,
      policy: policyChanged
        ? {
            from: {
              id: reference.assessment_policy_id,
              version: reference.assessment_policy_version,
            },
            to: {
              id: current.assessment_policy_id,
              version: current.assessment_policy_version,
            },
          }
        : null,
      changedRules,
    },
  };
}

function reopenContractChange(
  database: Database.Database,
  reviews: ClaimsReviewStore,
  assessmentId: string,
  baseRevision?: string,
  preRunReferenceAssessmentIds?: ReadonlySet<string>,
): string | undefined {
  const current = database
    .prepare(
      `SELECT ci.id AS claim_identity_id, ci.claim_type, ci.scope
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       JOIN claim_identities ci ON ci.id = cv.claim_identity_id
       WHERE ca.id = ?`,
    )
    .get(assessmentId) as
    | { claim_identity_id: string; claim_type: string; scope: string | null }
    | undefined;
  if (!current) return undefined;
  const referenceAssessmentId = contractReferenceAssessmentId(
    database,
    current.claim_identity_id,
    baseRevision,
    assessmentId,
    preRunReferenceAssessmentIds,
  );
  if (!referenceAssessmentId || referenceAssessmentId === assessmentId) {
    return undefined;
  }
  const drift = semanticContractDrift(
    database,
    assessmentId,
    referenceAssessmentId,
    baseRevision,
  );
  if (!drift) return undefined;
  const reopened = reviews.reopen({
    claimIdentityId: current.claim_identity_id,
    basisAssessmentId: assessmentId,
    dependencyKind: "rule_result_version",
    dependencyVersionId: drift.dependencyVersionId,
    reason: "warrant-changed",
    secondaryProvenance: drift.provenance,
  });
  return reopened?.created ? current.claim_identity_id : undefined;
}

function promoteDiscoveredClaim(
  database: Database.Database,
  reviews: ClaimsReviewStore,
  codeDefault: Extract<ReturnType<typeof extractBoundCodeEvidence>[number], { identityKey: string }>,
  targetClaimIdentityId: string,
  targetAssessmentId: string,
  dependencyVersionId: string,
): void {
  if (codeDefault.bindingBasis !== "explicit-map") return;
  const inferredClaims = database
    .prepare(
      `SELECT DISTINCT ci.id
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       JOIN claim_identities ci ON ci.id = cv.claim_identity_id
       JOIN parameter_identities parameter ON parameter.id = ci.parameter_identity_id
       JOIN evidence_identities evidence_identity
         ON evidence_identity.parameter_identity_id = parameter.id
       JOIN evidence_versions evidence ON evidence.evidence_identity_id = evidence_identity.id
       WHERE ca.is_current = 1
         AND parameter.canonical_key LIKE 'code:%'
         AND evidence_identity.source_kind = 'code-default'
         AND evidence.symbol_id = ?
         AND ci.id != ?`,
    )
    .all(codeDefault.symbolId, targetClaimIdentityId) as Array<{ id: string }>;
  for (const inferred of inferredClaims) {
    reviews.promoteDiscoveryClaim(
      inferred.id,
      targetClaimIdentityId,
      targetAssessmentId,
      dependencyVersionId,
    );
  }
}

export async function runClaimsCheck(options: {
  scope?: string;
  since?: string;
  format: string;
  contracts?: Partial<ClaimsContractVersions>;
}): Promise<void> {
  const workspaceRoot = process.cwd();
  const contracts = resolveContracts(options.contracts);
  try {
    const claimsGit = options.since ? new ClaimsGit(workspaceRoot) : undefined;
    const headRevision = claimsGit?.head();
    const baseRevision = options.since ? claimsGit!.mergeBase(options.since) : undefined;
    const readOptionalCurrentFile = (filePath: string): string | undefined => {
      if (claimsGit && headRevision) return claimsGit.show(headRevision, filePath);
      const absolutePath = path.join(workspaceRoot, filePath);
      return fs.existsSync(absolutePath)
        ? fs.readFileSync(absolutePath, "utf-8")
        : undefined;
    };
    const readCurrentFile = (filePath: string): string => {
      const content = readOptionalCurrentFile(filePath);
      if (content === undefined) {
        throw new ClaimsBindingError(`Configured Claims source not found: ${filePath}`);
      }
      return content;
    };
    const bindingsText = readOptionalCurrentFile("intentweave.bindings.yaml");
    const bindings = bindingsText
      ? parseClaimsBindings(yamlLoad(bindingsText))
      : { parameters: {} };
    const registryText = readOptionalCurrentFile("config/environments.yaml");
    const registryPath = "config/environments.yaml";
    const scopes = registryText ? parseScopeRegistry(yamlLoad(registryText)) : [];
    if (options.scope && scopes.length === 0) {
      throw new ClaimsBindingError(
        `Scope ${options.scope} cannot be evaluated because no scope registry was discovered`,
      );
    }
    const currentCodeFiles = claimsGit && headRevision
      ? claimsGit.listFiles(headRevision).filter(isClaimCodeFile)
      : await discoverWorkingTreeCodeFiles(workspaceRoot);
    const discoveredCode = extractDiscoveredCodeEvidence(
      currentCodeFiles,
      readCurrentFile,
      bindings,
    );
    const database = claimsDatabase(workspaceRoot);
    try {
      const store = new ClaimsStore(database);
      const engine = new ClaimsEngine(store);
      const reviews = new ClaimsReviewStore(database);
      const preRunReferenceAssessmentIds = new Set(
        (
          database
            .prepare(
              `SELECT id FROM claim_assessments WHERE reference_key IS NOT NULL`,
            )
            .all() as Array<{ id: string }>
        ).map((row) => row.id),
      );
      const revision = headRevision ?? currentRevision(workspaceRoot);
      const readBoundFile = (filePath: string) =>
        readOptionalCurrentFile(filePath) ?? "";
      const code = [
        ...extractBoundCodeEvidence(bindings, readBoundFile),
        ...discoveredCode,
      ];
      const docs = extractDocumentationAssertions(bindings, readBoundFile);
      const previousEvidence = (() => {
        if (!claimsGit || !baseRevision) return new Map<string, PersistedObservation>();
        const baseRegistry = claimsGit.show(baseRevision, "config/environments.yaml");
        const baseBindingsText = claimsGit.show(baseRevision, "intentweave.bindings.yaml");
        const baseBindings = baseBindingsText
          ? parseClaimsBindings(yamlLoad(baseBindingsText))
          : { parameters: {} };
        const baseCodeFiles = claimsGit.listFiles(baseRevision).filter(isClaimCodeFile);
        const readBaseFile = (filePath: string) =>
          claimsGit.show(baseRevision, filePath) ?? "";
        const baseDiscoveredCode = extractDiscoveredCodeEvidence(
          baseCodeFiles,
          readBaseFile,
          baseBindings,
        );
        return persistSnapshotEvidence(
          store,
          baseBindings,
          baseRegistry ? parseScopeRegistry(yamlLoad(baseRegistry)) : [],
          readBaseFile,
          (scope) => claimsGit.show(baseRevision, `config/${scope}.yaml`),
          baseRevision,
          baseDiscoveredCode,
        );
      })();
      const currentEvidence = new Map<string, PersistedObservation>();
      const scopeEvidence = new Map(
        extractScopeRegistryEvidence(scopes).map((observation) => {
          const persisted = persistObservation(store, {
            parameterKey: "scope.registry",
            sourceKind: observation.sourceKind,
            identityKey: observation.identityKey,
            semanticLocation: observation.semanticLocation,
            value: observation.normalizedValue,
            filePath: registryPath,
            revision,
          });
          currentEvidence.set(observation.identityKey, persisted);
          return [observation.scope, persisted] as const;
        }),
      );
      const config = extractScopeConfigEvidence(
        bindings,
        scopes,
        (scope) => {
          if (claimsGit && headRevision) {
            return claimsGit.show(headRevision, `config/${scope}.yaml`);
          }
          const filePath = path.join(workspaceRoot, "config", `${scope}.yaml`);
          return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : undefined;
        },
        options.scope,
      );
      const selectedScopes = options.scope
        ? scopes.filter((scope) => scope.name === options.scope)
        : scopes;
      const output = {
        claims: [] as Array<{
          parameterKey: string;
          claimType: string;
          ruleStatuses: string[];
          assessmentStatuses: string[];
        }>,
        scopes: [] as Array<{
          scope: string;
          ruleStatuses: string[];
          assessmentStatuses: string[];
        }>,
      };
      const allRuleStatuses: Array<"passed" | "failed" | "inconclusive" | "not_applicable"> = [];
      const allAssessmentStatuses: Array<"supported" | "refuted" | "contested" | "inconclusive"> = [];
      const assessmentIds: string[] = [];
      const reopenedClaimIds = new Set<string>();

      const unscopedParameterKeys = new Set(
        (scopes.length === 0 ? code : discoveredCode).map(
          (observation) => observation.parameterKey,
        ),
      );
      for (const parameterKey of [...unscopedParameterKeys].sort()) {
        const codeDefault = code.find(
          (observation) =>
            observation.parameterKey === parameterKey &&
            observation.sourceKind === "code-default" &&
            "identityKey" in observation,
        );
        const codeAnnotation = code.find(
          (observation) =>
            observation.parameterKey === parameterKey &&
            observation.sourceKind === "code-annotation" &&
            "identityKey" in observation,
        );
        if (!codeDefault || !("identityKey" in codeDefault)) continue;
        const persistedCodeDefault = persistObservation(store, {
          parameterKey,
          sourceKind: codeDefault.sourceKind,
          identityKey: codeDefault.identityKey,
          semanticLocation: codeDefault.semanticLocation,
          value: codeDefault.normalizedValue,
          filePath: codeDefault.filePath,
          symbolId: codeDefault.symbolId,
          line: codeDefault.line,
          bindingBasis: codeDefault.bindingBasis,
          bindingConfidence: codeDefault.bindingConfidence,
          revision,
        });
        currentEvidence.set(codeDefault.identityKey, persistedCodeDefault);
        const persistedAnnotation =
          codeAnnotation && "identityKey" in codeAnnotation
            ? persistObservation(store, {
                parameterKey,
                sourceKind: codeAnnotation.sourceKind,
                identityKey: codeAnnotation.identityKey,
                semanticLocation: codeAnnotation.semanticLocation,
                value: codeAnnotation.normalizedValue,
                filePath: codeAnnotation.filePath,
                symbolId: codeAnnotation.symbolId,
                line: codeAnnotation.line,
                bindingBasis: codeAnnotation.bindingBasis,
                bindingConfidence: codeAnnotation.bindingConfidence,
                revision,
              })
            : undefined;
        if (persistedAnnotation && codeAnnotation && "identityKey" in codeAnnotation) {
          currentEvidence.set(codeAnnotation.identityKey, persistedAnnotation);
        }
        const documentedDefault = docs.find(
          (observation) =>
            observation.parameterKey === parameterKey &&
            observation.kind === "evidence" &&
            observation.semanticLocation === `${parameterKey}.default`,
        );
        const persistedDocumentedDefault =
          documentedDefault && documentedDefault.kind === "evidence"
            ? persistObservation(store, {
                parameterKey,
                sourceKind: "documentation",
                identityKey: documentedDefault.identityKey,
                semanticLocation: documentedDefault.semanticLocation,
                value: documentedDefault.normalizedValue,
                filePath: documentedDefault.filePath,
                line: documentedDefault.line,
                revision,
              })
            : undefined;
        if (documentedDefault && documentedDefault.kind === "evidence" && persistedDocumentedDefault) {
          currentEvidence.set(documentedDefault.identityKey, persistedDocumentedDefault);
        }
        const result = engine.evaluateDefault({
          parameterKey,
          claimType: codeDefault.claimType,
          repositoryRevision: revision,
          codeDefault: {
            versionId: persistedCodeDefault.version.id,
            value: persistedCodeDefault.value,
          },
          codeAnnotation: persistedAnnotation && {
            versionId: persistedAnnotation.version.id,
            value: persistedAnnotation.value,
          },
          documentedDefault: persistedDocumentedDefault && {
            versionId: persistedDocumentedDefault.version.id,
            value: persistedDocumentedDefault.value,
          },
          contracts,
        });
        promoteDiscoveredClaim(
          database,
          reviews,
          codeDefault,
          result.assessments[0]!.claimIdentityId,
          result.assessments[0]!.id,
          result.ruleResults[0]!.id,
        );
        const ruleStatuses = result.ruleResults.map((rule) =>
          (database.prepare(`SELECT normalized_status FROM rule_result_versions WHERE id = ?`).get(rule.id) as { normalized_status: "passed" | "failed" | "inconclusive" | "not_applicable" }).normalized_status,
        );
        const assessmentStatuses = result.assessments.map((assessment) =>
          (database.prepare(`SELECT epistemic_status FROM claim_assessments WHERE id = ?`).get(assessment.id) as { epistemic_status: "supported" | "refuted" | "contested" | "inconclusive" }).epistemic_status,
        );
        allRuleStatuses.push(...ruleStatuses);
        allAssessmentStatuses.push(...assessmentStatuses);
        assessmentIds.push(...result.assessments.map((assessment) => assessment.id));
        output.claims.push({
          parameterKey,
          claimType: codeDefault.claimType,
          ruleStatuses,
          assessmentStatuses,
        });
      }

      for (const scope of selectedScopes) {
        for (const [parameterKey] of Object.entries(bindings.parameters)) {
          const codeDefault = code.find(
            (observation) =>
              observation.parameterKey === parameterKey && observation.sourceKind === "code-default" && "identityKey" in observation,
          );
          const codeAnnotation = code.find(
            (observation) =>
              observation.parameterKey === parameterKey && observation.sourceKind === "code-annotation" && "identityKey" in observation,
          );
          const configValue = config.find(
            (observation) =>
              observation.parameterKey === parameterKey && observation.scope === scope.name && observation.kind === "evidence",
          );
          const documentedValue = docs.find(
            (observation) =>
              observation.parameterKey === parameterKey && observation.kind === "evidence" && observation.semanticLocation === `${parameterKey}.override[${scope.name}]`,
          );
          const persistedCodeDefault =
            codeDefault && "identityKey" in codeDefault
              ? persistObservation(store, {
                  parameterKey,
                  sourceKind: codeDefault.sourceKind,
                  identityKey: codeDefault.identityKey,
                  semanticLocation: codeDefault.semanticLocation,
                  value: codeDefault.normalizedValue,
                  filePath: codeDefault.filePath,
                  symbolId: codeDefault.symbolId,
                  line: codeDefault.line,
                  bindingBasis: codeDefault.bindingBasis,
                  bindingConfidence: codeDefault.bindingConfidence,
                  revision,
                })
              : undefined;
          if (codeDefault && "identityKey" in codeDefault && persistedCodeDefault) {
            currentEvidence.set(codeDefault.identityKey, persistedCodeDefault);
          }
          const persistedAnnotation =
            codeAnnotation && "identityKey" in codeAnnotation
              ? persistObservation(store, {
                  parameterKey,
                  sourceKind: codeAnnotation.sourceKind,
                  identityKey: codeAnnotation.identityKey,
                  semanticLocation: codeAnnotation.semanticLocation,
                  value: codeAnnotation.normalizedValue,
                  filePath: codeAnnotation.filePath,
                  symbolId: codeAnnotation.symbolId,
                  line: codeAnnotation.line,
                  bindingBasis: codeAnnotation.bindingBasis,
                  bindingConfidence: codeAnnotation.bindingConfidence,
                  revision,
                })
              : undefined;
          if (codeAnnotation && "identityKey" in codeAnnotation && persistedAnnotation) {
            currentEvidence.set(codeAnnotation.identityKey, persistedAnnotation);
          }
          const persistedConfig =
            configValue && configValue.kind === "evidence"
              ? persistObservation(store, {
                  parameterKey,
                  sourceKind: configValue.sourceKind,
                  identityKey: configValue.identityKey,
                  semanticLocation: configValue.semanticLocation,
                  value: configValue.normalizedValue,
                  filePath: configValue.filePath,
                  revision,
                })
              : undefined;
          if (configValue && configValue.kind === "evidence" && persistedConfig) {
            currentEvidence.set(configValue.identityKey, persistedConfig);
          }
          const persistedDocumentation =
            documentedValue && documentedValue.kind === "evidence"
              ? persistObservation(store, {
                  parameterKey,
                  sourceKind: "documentation",
                  identityKey: documentedValue.identityKey,
                  semanticLocation: documentedValue.semanticLocation,
                  value: documentedValue.normalizedValue,
                  filePath: documentedValue.filePath,
                  line: documentedValue.line,
                  revision,
                })
              : undefined;
          if (documentedValue && documentedValue.kind === "evidence" && persistedDocumentation) {
            currentEvidence.set(documentedValue.identityKey, persistedDocumentation);
          }
          const documentedDefaultValue = docs.find(
            (observation) =>
              observation.parameterKey === parameterKey &&
              observation.kind === "evidence" &&
              observation.semanticLocation === `${parameterKey}.default`,
          );
          const persistedDocumentedDefault =
            documentedDefaultValue && documentedDefaultValue.kind === "evidence"
              ? persistObservation(store, {
                  parameterKey,
                  sourceKind: "documentation",
                  identityKey: documentedDefaultValue.identityKey,
                  semanticLocation: documentedDefaultValue.semanticLocation,
                  value: documentedDefaultValue.normalizedValue,
                  filePath: documentedDefaultValue.filePath,
                  line: documentedDefaultValue.line,
                  revision,
                })
              : undefined;
          if (documentedDefaultValue && documentedDefaultValue.kind === "evidence" && persistedDocumentedDefault) {
            currentEvidence.set(documentedDefaultValue.identityKey, persistedDocumentedDefault);
          }
          const result = engine.evaluateScope({
            parameterKey,
            scope: scope.name,
            repositoryRevision: revision,
            codeDefault: persistedCodeDefault && {
              versionId: persistedCodeDefault.version.id,
              value: persistedCodeDefault.value,
            },
            codeAnnotation: persistedAnnotation && {
              versionId: persistedAnnotation.version.id,
              value: persistedAnnotation.value,
            },
            documentedDefault: persistedDocumentedDefault && {
              versionId: persistedDocumentedDefault.version.id,
              value: persistedDocumentedDefault.value,
            },
            configOverride: persistedConfig && {
              versionId: persistedConfig.version.id,
              value: persistedConfig.value,
            },
            documentedOverride: persistedDocumentation && {
              versionId: persistedDocumentation.version.id,
              value: persistedDocumentation.value,
            },
            scopeEvidence: {
              versionId: scopeEvidence.get(scope.name)!.version.id,
              capabilities: scope.capabilities,
            },
            contracts,
          });
          if (codeDefault && "identityKey" in codeDefault) {
            promoteDiscoveredClaim(
              database,
              reviews,
              codeDefault,
              result.assessments[0]!.claimIdentityId,
              result.assessments[0]!.id,
              result.ruleResults[0]!.id,
            );
          }
          const ruleStatuses = result.ruleResults.map((rule) =>
            (database.prepare(`SELECT normalized_status FROM rule_result_versions WHERE id = ?`).get(rule.id) as { normalized_status: "passed" | "failed" | "inconclusive" | "not_applicable" }).normalized_status,
          );
          const assessmentStatuses = result.assessments.map((assessment) =>
            (database.prepare(`SELECT epistemic_status FROM claim_assessments WHERE id = ?`).get(assessment.id) as { epistemic_status: "supported" | "refuted" | "contested" | "inconclusive" }).epistemic_status,
          );
          allRuleStatuses.push(...ruleStatuses);
          allAssessmentStatuses.push(...assessmentStatuses);
          assessmentIds.push(...result.assessments.map((assessment) => assessment.id));
          output.scopes.push({ scope: scope.name, ruleStatuses, assessmentStatuses });
        }
      }
      if (claimsGit && baseRevision && headRevision) {
        const changedPaths = claimsGit.changedPaths(baseRevision, headRevision);
        const renames = claimsGit.renames(baseRevision, headRevision);
        const continuedPreviousIdentityKeys = new Set<string>();
        for (const [identityKey, current] of currentEvidence) {
          const matchedRename = previousEvidence.has(identityKey)
            ? undefined
            : renamedPredecessor(database, previousEvidence, current, renames);
          const previous = previousEvidence.get(identityKey) ?? matchedRename?.observation;
          if (!previous) {
            const provenance = {
              baseRevision,
              headRevision,
              changedPaths,
              missingPredecessorIdentity: identityKey,
            };
            const reopened = reopenEvidenceChanges(
              database,
              reviews,
              current.version.id,
              "continuity-uncertain",
              provenance,
            );
            for (const claimIdentityId of reopened) {
              reopenedClaimIds.add(claimIdentityId);
            }
            continue;
          }
          if (matchedRename) continuedPreviousIdentityKeys.add(matchedRename.identityKey);
          if (previous.version.id === current.version.id) continue;
          const materialChange = isMaterialChange(
            database,
            previous.version.id,
            current.version.id,
          );
          const provenance = {
            baseRevision,
            headRevision,
            changedPaths,
            materialChange,
            ...(matchedRename
              ? {
                  rename: matchedRename.rename,
                  continuityBasis: "git-file-rename",
                  continuityConfidence: materialChange ? "probable" : "certain",
                }
              : {}),
          };
          store.persistEvidenceContinuity({
            fromEvidenceVersionId: previous.version.id,
            toEvidenceVersionId: current.version.id,
            basis: matchedRename ? "git-file-rename" : "git-merge-base",
            confidence: matchedRename
              ? materialChange
                ? "probable"
                : "certain"
              : "high",
            provenance,
          });
          if (materialChange) {
            const reopened = reopenEvidenceChanges(
              database,
              reviews,
              current.version.id,
              "material-change",
              provenance,
            );
            for (const claimIdentityId of reopened) {
              reopenedClaimIds.add(claimIdentityId);
            }
          }
        }
        for (const [identityKey, previous] of previousEvidence) {
          if (currentEvidence.has(identityKey) || continuedPreviousIdentityKeys.has(identityKey)) continue;
          const reopened = reopenBrokenContinuity(
            database,
            reviews,
            previous.version.id,
            assessmentIds,
            {
              baseRevision,
              headRevision,
              changedPaths,
              missingCurrentIdentity: identityKey,
            },
          );
          for (const claimIdentityId of reopened) {
            reopenedClaimIds.add(claimIdentityId);
          }
        }
      }
      for (const assessmentId of assessmentIds) {
        const reopenedClaimId = reopenContractChange(
          database,
          reviews,
          assessmentId,
          baseRevision,
          preRunReferenceAssessmentIds,
        );
        if (reopenedClaimId) reopenedClaimIds.add(reopenedClaimId);
      }
      for (const assessmentId of assessmentIds) {
        const assessment = database
          .prepare(
            `SELECT ci.id AS claim_identity_id, ca.epistemic_status
             FROM claim_assessments ca
             JOIN claim_versions cv ON cv.id = ca.claim_version_id
             JOIN claim_identities ci ON ci.id = cv.claim_identity_id
             WHERE ca.id = ?`,
          )
          .get(assessmentId) as
          | { claim_identity_id: string; epistemic_status: string }
          | undefined;
        if (
          assessment &&
          assessment.epistemic_status !== "inconclusive" &&
          !reopenedClaimIds.has(assessment.claim_identity_id)
        ) {
          const openReopen = database
            .prepare(
              `SELECT 1 AS present
               FROM review_decision_reopens
               WHERE claim_identity_id = ? AND status = 'open'
               LIMIT 1`,
            )
            .get(assessment.claim_identity_id) as { present: number } | undefined;
          if (!openReopen) {
            reviews.carryForward(assessment.claim_identity_id, assessmentId);
          }
        }
      }
      const reviewRequired = assessmentIds.some((assessmentId) => {
        const row = database.prepare(
          `SELECT ca.epistemic_status,
                  EXISTS(
                    SELECT 1 FROM review_decisions rd
                    WHERE rd.basis_assessment_id = ca.id AND rd.is_current = 1
                  ) AS reviewed,
                  EXISTS(
                    SELECT 1 FROM review_decision_reopens reopen
                    JOIN claim_versions cv ON cv.id = ca.claim_version_id
                    WHERE reopen.claim_identity_id = cv.claim_identity_id
                      AND reopen.status = 'open'
                  ) AS open_reopen
           FROM claim_assessments ca WHERE ca.id = ?`,
        ).get(assessmentId) as {
          epistemic_status: string;
          reviewed: number;
          open_reopen: number;
        };
        return (
          row.epistemic_status !== "inconclusive" &&
          (row.reviewed === 0 || row.open_reopen === 1)
        );
      });
      console.log(options.format === "json" ? JSON.stringify(output, null, 2) : formatText(output));
      process.exitCode = claimsExitCode({
        discoveryEmpty: output.claims.length === 0 && output.scopes.length === 0,
        ruleStatuses: allRuleStatuses,
        assessmentStatuses: allAssessmentStatuses,
        reviewRequired,
      });
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof ClaimsBindingError || error instanceof ClaimsGitError ? 64 : 1;
  }
}

export async function runClaimsReview(options: {
  claim: string;
  actor: string;
  decision: string;
  format: string;
}): Promise<void> {
  try {
    const database = claimsDatabase(process.cwd());
    try {
      const assessment = database
        .prepare(
          `SELECT ca.id
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           WHERE cv.claim_identity_id = ? AND ca.is_current = 1`,
        )
        .get(options.claim) as { id: string } | undefined;
      if (!assessment) {
        throw new ClaimsBindingError(`No current assessment for claim ${options.claim}`);
      }
      const result = new ClaimsReviewStore(database).record({
        claimIdentityId: options.claim,
        basisAssessmentId: assessment.id,
        decision: options.decision,
        actor: options.actor,
      });
      const output = { claimIdentityId: options.claim, assessmentId: assessment.id, ...result };
      console.log(options.format === "json" ? JSON.stringify(output, null, 2) : `Review recorded: ${result.id}`);
      process.exitCode = 0;
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode =
      error instanceof ClaimsBindingError
        ? 64
        : message.includes("Inconclusive")
          ? 2
          : 1;
  }
}

export async function runClaimsExplain(options: {
  claim?: string;
  format: string;
}): Promise<void> {
  try {
    const database = claimsDatabase(process.cwd());
    try {
      const assessments = database
        .prepare(
          `SELECT ci.id AS claim_identity_id, ci.claim_type, ci.scope,
                  ca.id AS assessment_id, ca.epistemic_status,
                  cv.normalized_statement_json
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           JOIN claim_identities ci ON ci.id = cv.claim_identity_id
           WHERE ca.is_current = 1 AND (? IS NULL OR ci.id = ?)
           ORDER BY ci.claim_type, ci.scope`,
        )
        .all(options.claim ?? null, options.claim ?? null) as Array<{
        claim_identity_id: string;
        claim_type: string;
        scope: string | null;
        assessment_id: string;
        epistemic_status: string;
        normalized_statement_json: string;
      }>;
      if (options.claim && assessments.length === 0) {
        throw new ClaimsBindingError(`No current assessment for claim ${options.claim}`);
      }
      const output = assessments.map((assessment) => ({
        claimIdentityId: assessment.claim_identity_id,
        claimType: assessment.claim_type,
        scope: assessment.scope,
        assessmentId: assessment.assessment_id,
        status: assessment.epistemic_status,
        statement: JSON.parse(assessment.normalized_statement_json),
        dependencies: database
          .prepare(
            `SELECT dependency_kind, dependency_version_id, epistemic_role,
                    warrant_polarity, assessment_effect
             FROM claim_assessment_dependencies WHERE claim_assessment_id = ?`,
          )
          .all(assessment.assessment_id),
        review: database
          .prepare(
            `SELECT id, basis_assessment_id, decision, actor, decision_origin,
                    carried_forward_from_decision_id, created_at
             FROM review_decisions
             WHERE claim_identity_id = ? AND is_current = 1`,
          )
          .get(assessment.claim_identity_id),
        reopens: database
          .prepare(
            `SELECT reason, dependency_kind, dependency_version_id,
                    secondary_provenance_json, status
             FROM review_decision_reopens WHERE claim_identity_id = ?`,
          )
          .all(assessment.claim_identity_id),
      }));
      if (options.format === "json") {
        console.log(JSON.stringify(output, null, 2));
      } else if (output.length === 0) {
        console.log("No current claims.");
      } else {
        for (const claim of output) {
          console.log(`${claim.claimType}${claim.scope ? ` (${claim.scope})` : ""}: ${claim.status}`);
          console.log(`  Claim: ${claim.claimIdentityId}`);
          console.log(`  Assessment: ${claim.assessmentId}`);
          if (claim.review) {
            console.log(`  Review: ${(claim.review as { decision: string }).decision}`);
          }
        }
      }
      process.exitCode = output.length === 0 ? 2 : 0;
    } finally {
      database.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ClaimsBindingError ? 64 : 1;
  }
}

export const claimsCommand = new Command("claims")
  .description("Discover, assess, explain, and review repository claims")
  .addCommand(
    new Command("check")
      .description("Discover and evaluate claims, optionally for a registered scope")
      .option("--scope <scope>", "Registered scope to evaluate")
      .option("--since <ref>", "Compare immutable HEAD evidence with the merge-base of a Git ref")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsCheck),
  )
  .addCommand(
    new Command("review")
      .description("Record a human decision against a claim's current assessment")
      .requiredOption("--claim <claimIdentityId>", "Claim identity ID from claims explain")
      .requiredOption("--actor <name>", "Review decision actor")
      .requiredOption("--decision <decision>", "Review disposition")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsReview),
  )
  .addCommand(
    new Command("explain")
      .description("Show current claims with their versioned dependencies and reopens")
      .option("--claim <claimIdentityId>", "Restrict explanation to one claim identity")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsExplain),
  );
