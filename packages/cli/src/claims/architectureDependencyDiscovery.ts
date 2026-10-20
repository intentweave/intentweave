// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  rulesCheckFromDb,
  type CandidateConfidence,
  type PersistedCandidate,
  type RuleDefinition,
  type RuleForbidden,
  type RulesConfig,
} from "@intentweave/index";

export const ARCHITECTURE_DEPENDENCY_ADAPTER_ID =
  "cari-architecture-dependency-conformance";
export const ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION = "1";

export interface ArchitectureDependencyCandidateResult extends PersistedCandidate {
  proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE";
  confidence: CandidateConfidence;
  sourceKinds: string[];
  surfaced: boolean;
}

interface ArchitecturePolicyObservation {
  rule: RuleDefinition;
  clause: RuleForbidden & {
    type: "import_pattern";
    in: string;
    pattern: string;
  };
  sourcePattern: string;
  targetPattern: string;
  ambiguous: boolean;
  alternativeRuleIds: string[];
}

interface FileRow {
  path: string;
  indexed: number;
  skip_reason: string | null;
}

interface ImportRow {
  source_file: string;
  module_specifier: string;
  target_file: string | null;
  line: number | null;
}

function statementRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseArchitectureRulesConfig(value: unknown): RulesConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rules.yaml must contain an object");
  }
  const config = value as Record<string, unknown>;
  if (!Number.isInteger(config.version) || !Array.isArray(config.rules)) {
    throw new Error("rules.yaml must contain integer version and rules array");
  }
  for (const [index, ruleValue] of config.rules.entries()) {
    if (
      !ruleValue ||
      typeof ruleValue !== "object" ||
      Array.isArray(ruleValue)
    ) {
      throw new Error(`rules.yaml rule ${index} must be an object`);
    }
    const rule = ruleValue as Record<string, unknown>;
    if (
      typeof rule.id !== "string" ||
      rule.id.trim().length === 0 ||
      !Array.isArray(rule.forbidden)
    ) {
      throw new Error(
        `rules.yaml rule ${index} requires id and forbidden array`,
      );
    }
  }
  return value as RulesConfig;
}

function inScope(filePath: string, clause: RuleForbidden): boolean {
  if (clause.in && !minimatch(filePath, clause.in)) return false;
  const exceptions = clause.except
    ? Array.isArray(clause.except)
      ? clause.except
      : [clause.except]
    : [];
  return !exceptions.some((exception) => minimatch(filePath, exception));
}

function policyKey(sourcePattern: string, targetPattern: string): string {
  return fingerprint({ sourcePattern, targetPattern });
}

function candidateIdentity(
  sourcePattern: string,
  targetPattern: string,
): string {
  return `dependency-conformance:${policyKey(sourcePattern, targetPattern)}`;
}

function sourceSubject(sourcePattern: string) {
  return {
    kind: "module" as const,
    identityKey: `module:architecture-scope:${fingerprint(sourcePattern)}`,
    displayName: sourcePattern,
    role: "source",
    basis: "rules-yaml-import-scope",
    confidence: "certain" as const,
  };
}

function targetSubject(targetPattern: string) {
  return {
    kind: "module" as const,
    identityKey: `module:architecture-target:${fingerprint(targetPattern)}`,
    displayName: targetPattern,
    role: "target",
    basis: "rules-yaml-import-pattern",
    confidence: "certain" as const,
  };
}

function importPolicyObservations(
  config: RulesConfig | undefined,
): ArchitecturePolicyObservation[] {
  if (!config) return [];
  const observations = config.rules.flatMap((rule) => {
    if ((rule.domain ?? "structural") !== "structural") return [];
    return rule.forbidden.flatMap((clause) => {
      if (
        clause.type !== "import_pattern" ||
        typeof clause.in !== "string" ||
        clause.in.length === 0 ||
        typeof clause.pattern !== "string" ||
        clause.pattern.length === 0
      ) {
        return [];
      }
      return [
        {
          rule,
          clause: clause as ArchitecturePolicyObservation["clause"],
          sourcePattern: clause.in,
          targetPattern: clause.pattern,
          ambiguous: false,
          alternativeRuleIds: [rule.id],
        },
      ];
    });
  });
  const grouped = new Map<string, ArchitecturePolicyObservation[]>();
  for (const observation of observations) {
    const key = policyKey(observation.sourcePattern, observation.targetPattern);
    const group = grouped.get(key) ?? [];
    group.push(observation);
    grouped.set(key, group);
  }
  return [...grouped.values()].map((group) => ({
    ...group[0]!,
    ambiguous: group.length > 1,
    alternativeRuleIds: group.map((observation) => observation.rule.id).sort(),
  }));
}

function persistObservation(
  database: Database.Database,
  repositoryRevision: string,
  workspaceRoot: string,
  observation: ArchitecturePolicyObservation,
): ArchitectureDependencyCandidateResult {
  const claims = new ClaimsStore(database);
  const candidates = new CandidateStore(database);
  const candidateKey = candidateIdentity(
    observation.sourcePattern,
    observation.targetPattern,
  );
  const source = sourceSubject(observation.sourcePattern);
  const target = targetSubject(observation.targetPattern);
  const subjects = [source, target];
  const policyValue = {
    active: true,
    ruleId: observation.rule.id,
    description: observation.rule.description ?? null,
    adr: observation.rule.adr ?? null,
    severity: observation.rule.severity,
    mode: observation.rule.mode ?? "error",
    domain: observation.rule.domain ?? "structural",
    clause: {
      type: observation.clause.type,
      in: observation.clause.in,
      pattern: observation.clause.pattern,
      regex: observation.clause.regex ?? false,
      targetLayer: observation.clause.target_layer ?? null,
      except: observation.clause.except ?? [],
    },
  };
  const policyVersion = claims.persistGenericEvidence({
    subjects,
    sourceKind: "architecture-rule-definition",
    identityKey: `${candidateKey}:policy`,
    fingerprint: fingerprint(policyValue),
    materialFingerprint: fingerprint(policyValue),
    normalizedValue: policyValue,
    semanticLocation: `${source.identityKey}->${target.identityKey}`,
    provenance: {
      adapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
      contractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
      repositoryRevision,
      configPath: ".iw/rules.yaml",
    },
    filePath: ".iw/rules.yaml",
    repositoryRevision,
  });

  const files = database
    .prepare(`SELECT path, indexed, skip_reason FROM files ORDER BY path`)
    .all() as FileRow[];
  const scopeFiles = files.filter(
    (file) =>
      existsSync(path.resolve(workspaceRoot, file.path)) &&
      inScope(file.path, observation.clause),
  );
  const skippedScopeFiles = scopeFiles
    .filter((file) => file.indexed !== 1 || file.skip_reason !== null)
    .map((file) => ({
      path: file.path,
      reason: file.skip_reason ?? "not-indexed",
    }));
  const importRows = database
    .prepare(
      `SELECT source_file, module_specifier, target_file, line
       FROM imports ORDER BY source_file, line, module_specifier`,
    )
    .all() as ImportRow[];
  const scopeImports = importRows.filter((row) =>
    inScope(row.source_file, observation.clause),
  );
  const singleRuleConfig: RulesConfig = {
    version: 1,
    rules: [
      {
        ...observation.rule,
        forbidden: [observation.clause],
      },
    ],
  };
  const check = rulesCheckFromDb(database, singleRuleConfig, {
    domain: "structural",
    ruleId: observation.rule.id,
  });
  const scopeWarning =
    check.scopeWarnings?.some(
      (warning) => warning.ruleId === observation.rule.id,
    ) ?? false;
  const applicable = scopeFiles.length > 0 && !scopeWarning;
  const complete = applicable && skippedScopeFiles.length === 0;
  const inventoryValue = {
    sourcePattern: observation.sourcePattern,
    imports: scopeImports,
    scopeFiles: scopeFiles.map((file) => file.path),
  };
  const violationSignatures = check.violations
    .map((violation) => violation.detail)
    .sort();
  const resultValue = {
    executed: true,
    applicable,
    complete,
    scopeFileCount: scopeFiles.length,
    skippedScopeFiles,
    scopeWarnings: check.scopeWarnings ?? [],
    violationCount: check.totalViolations,
    violations: check.violations.map((violation) => ({
      filePath: violation.filePath,
      line: violation.line,
      detail: violation.detail,
    })),
  };
  const resultMaterial = {
    applicable,
    complete,
    skippedReasons: skippedScopeFiles.map((file) => file.reason).sort(),
    scopeWarning,
    violationCount: check.totalViolations,
    violationSignatures,
  };
  const inventoryVersion = claims.persistGenericEvidence({
    subjects,
    sourceKind: "architecture-import-inventory",
    identityKey: `${candidateKey}:imports`,
    fingerprint: fingerprint(inventoryValue),
    materialFingerprint: fingerprint(resultMaterial),
    normalizedValue: inventoryValue,
    semanticLocation: `${source.identityKey}.imports`,
    provenance: {
      adapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
      contractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
      repositoryRevision,
      substrate: "cari-imports",
    },
    repositoryRevision,
  });
  const resultVersion = claims.persistGenericEvidence({
    subjects,
    sourceKind: "architecture-rule-check",
    identityKey: `${candidateKey}:result`,
    fingerprint: fingerprint({
      resultValue,
      repositoryRevision,
    }),
    materialFingerprint: fingerprint(resultMaterial),
    normalizedValue: resultValue,
    semanticLocation: `${source.identityKey}->${target.identityKey}.conformance`,
    provenance: {
      adapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
      contractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
      repositoryRevision,
      evaluator: "rulesCheckFromDb",
      architectureRuleId: observation.rule.id,
    },
    repositoryRevision,
  });
  const confidence: CandidateConfidence = observation.ambiguous
    ? "ambiguous"
    : complete
      ? "certain"
      : "probable";
  const candidate = candidates.persist({
    identityKey: candidateKey,
    candidateKind: "architecture-dependency-conformance",
    proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE",
    discoveryMode: "deterministic",
    discoveryAdapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
    discoveryContractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
    confidence,
    normalizedStatement: {
      source: observation.sourcePattern,
      target: observation.targetPattern,
      ruleId: observation.rule.id,
      requirement: "source-must-not-depend-on-target",
    },
    provenance: {
      repositoryRevision,
      adapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
      contractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
      alternativeRuleIds: observation.alternativeRuleIds,
    },
    evidence: [
      {
        evidenceKey: `${candidateKey}:policy`,
        evidenceVersionId: policyVersion.id,
        sourceKind: "architecture-rule-definition",
        role: "policy",
        provenance: { normalizedValue: policyValue },
      },
      {
        evidenceKey: `${candidateKey}:imports`,
        evidenceVersionId: inventoryVersion.id,
        sourceKind: "architecture-import-inventory",
        role: "imports",
        provenance: { normalizedValue: inventoryValue },
      },
      {
        evidenceKey: `${candidateKey}:result`,
        evidenceVersionId: resultVersion.id,
        sourceKind: "architecture-rule-check",
        role: "result",
        provenance: { normalizedValue: resultValue },
      },
    ],
    subjects,
  });
  return {
    ...candidate,
    proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE",
    confidence,
    sourceKinds: [
      "architecture-import-inventory",
      "architecture-rule-check",
      "architecture-rule-definition",
    ],
    surfaced: true,
  };
}

function persistRetiredCandidate(
  database: Database.Database,
  repositoryRevision: string,
  candidate: ReturnType<CandidateStore["listCurrent"]>[number],
): ArchitectureDependencyCandidateResult[] {
  const source = candidate.subjects.find(
    (subject) => subject.role === "source",
  );
  const target = candidate.subjects.find(
    (subject) => subject.role === "target",
  );
  if (!source || !target) return [];
  const claims = new ClaimsStore(database);
  const candidates = new CandidateStore(database);
  const policyValue = {
    active: false,
    reason: "architecture-policy-no-longer-present",
  };
  const resultValue = {
    executed: false,
    applicable: false,
    complete: true,
    scopeFileCount: 0,
    skippedScopeFiles: [],
    scopeWarnings: [],
    violationCount: 0,
    violations: [],
  };
  const policyVersion = claims.persistGenericEvidence({
    subjects: [source, target],
    sourceKind: "architecture-rule-definition",
    identityKey: `${candidate.identityKey}:policy`,
    fingerprint: fingerprint(policyValue),
    materialFingerprint: fingerprint(policyValue),
    normalizedValue: policyValue,
    semanticLocation: `${source.identityKey}->${target.identityKey}`,
    provenance: {
      adapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
      contractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
      repositoryRevision,
      transition: "policy-removed",
    },
    filePath: ".iw/rules.yaml",
    repositoryRevision,
  });
  const resultVersion = claims.persistGenericEvidence({
    subjects: [source, target],
    sourceKind: "architecture-rule-check",
    identityKey: `${candidate.identityKey}:result`,
    fingerprint: fingerprint(resultValue),
    materialFingerprint: fingerprint(resultValue),
    normalizedValue: resultValue,
    semanticLocation: `${source.identityKey}->${target.identityKey}.conformance`,
    provenance: {
      adapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
      contractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
      repositoryRevision,
      transition: "policy-removed",
    },
    repositoryRevision,
  });
  const persisted = candidates.persist({
    identityKey: candidate.identityKey,
    candidateKind: candidate.candidateKind,
    proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE",
    discoveryMode: "deterministic",
    discoveryAdapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
    discoveryContractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
    confidence: "certain",
    normalizedStatement: candidate.normalizedStatement,
    provenance: {
      repositoryRevision,
      adapterId: ARCHITECTURE_DEPENDENCY_ADAPTER_ID,
      contractVersion: ARCHITECTURE_DEPENDENCY_CONTRACT_VERSION,
      transition: "policy-removed",
    },
    evidence: [
      {
        evidenceKey: `${candidate.identityKey}:policy`,
        evidenceVersionId: policyVersion.id,
        sourceKind: "architecture-rule-definition",
        role: "policy",
        provenance: { normalizedValue: policyValue },
      },
      {
        evidenceKey: `${candidate.identityKey}:result`,
        evidenceVersionId: resultVersion.id,
        sourceKind: "architecture-rule-check",
        role: "result",
        provenance: { normalizedValue: resultValue },
      },
    ],
    subjects: [source, target],
  });
  return [
    {
      ...persisted,
      proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE",
      confidence: "certain",
      sourceKinds: ["architecture-rule-check", "architecture-rule-definition"],
      surfaced: true,
    },
  ];
}

export function persistArchitectureDependencyCandidates(
  database: Database.Database,
  repositoryRevision: string,
  workspaceRoot: string,
  config: RulesConfig | undefined,
): ArchitectureDependencyCandidateResult[] {
  const observations = importPolicyObservations(config);
  const discovered = observations.map((observation) =>
    persistObservation(
      database,
      repositoryRevision,
      workspaceRoot,
      observation,
    ),
  );
  const activeIdentityKeys = new Set(
    discovered.map((candidate) => candidate.identityKey),
  );
  const candidates = new CandidateStore(database);
  const retired = candidates
    .listCurrent({ subjectKind: "module" })
    .filter(
      (candidate) =>
        candidate.discoveryAdapterId === ARCHITECTURE_DEPENDENCY_ADAPTER_ID &&
        candidate.candidateKind === "architecture-dependency-conformance" &&
        !activeIdentityKeys.has(candidate.identityKey) &&
        database
          .prepare(
            `SELECT 1 AS present
             FROM candidate_reviews review
             JOIN claim_candidates observed ON observed.id = review.candidate_id
             WHERE observed.identity_key = ?
               AND review.decision = 'promote'
               AND review.effect = 'effective'
               AND review.promoted_claim_identity_id IS NOT NULL
             LIMIT 1`,
          )
          .get(candidate.identityKey),
    )
    .flatMap((candidate) =>
      persistRetiredCandidate(database, repositoryRevision, candidate),
    );
  return [...discovered, ...retired];
}
