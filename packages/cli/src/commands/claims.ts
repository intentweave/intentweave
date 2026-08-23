// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsEngine,
  ClaimsReviewStore,
  ClaimsStore,
  claimsExitCode,
  fingerprint,
  materialFingerprint,
  openMigratedDatabase,
} from "@intentweave/index";
import type {
  CandidateReviewDecision,
  CandidateState,
  ClaimScalar,
  ClaimsContractVersions,
  PersistedVersion,
  PortableClaimsState,
  SubjectKind,
} from "@intentweave/index";
import {
  applyCandidatePolicy,
  linkCandidatePolicyPromotion,
  persistPortableCandidateDecision,
  reviewCandidate,
} from "../claims/candidateGovernance.js";
import {
  persistR1Candidates,
  R1_DISCOVERY_ADAPTER_ID,
  R1_DISCOVERY_CONTRACT_VERSION,
} from "../claims/candidateDiscovery.js";
import {
  persistPublicSymbolCandidates,
  PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
  PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
} from "../claims/publicSymbolDiscovery.js";
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
import {
  CLAIMS_PORTABLE_STATE_RELATIVE_PATH,
  ClaimsPortableStateFileError,
  claimsPortableStatePath,
  loadPortableClaimsState,
  parsePortableClaimsStateYaml,
} from "../claims/portableState.js";
import {
  persistPortableAssessmentReview,
  projectPortableAssessmentReviews,
  type PortableReviewProjectionIssue,
} from "../claims/portableReviewProjection.js";

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

async function discoverWorkingTreeCodeFiles(
  workspaceRoot: string,
): Promise<string[]> {
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
  )
    .filter(isClaimCodeFile)
    .sort();
}

function currentRevision(workspaceRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
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
  const persist = (
    identityKey: string,
    input: Parameters<typeof persistObservation>[1],
  ) => {
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
  for (const observation of extractDocumentationAssertions(
    bindings,
    readBoundFile,
  )) {
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
  for (const observation of extractScopeConfigEvidence(
    bindings,
    scopes,
    readScopeConfig,
  )) {
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
    claimIdentityId?: string;
    parameterKey: string | null;
    claimType: string;
    ruleStatuses: string[];
    assessmentStatuses: string[];
  }>;
  scopes: Array<{
    scope: string;
    ruleStatuses: string[];
    assessmentStatuses: string[];
  }>;
  retiredClaims: Array<{
    claimIdentityId: string;
    parameterKey: string;
    claimType: string;
    scope: string | null;
    reviewReopened: boolean;
  }>;
  portableStateIssues: PortableReviewProjectionIssue[];
}): string {
  const lines: string[] = [];
  for (const claim of result.claims) {
    lines.push(
      `Claim: ${claim.parameterKey ?? claim.claimIdentityId} (${claim.claimType})`,
    );
    lines.push(`  Rule results: ${claim.ruleStatuses.join(", ")}`);
    lines.push(
      `  Assessments: ${claim.assessmentStatuses.join(", ") || "none"}`,
    );
  }
  for (const scope of result.scopes) {
    lines.push(`Scope: ${scope.scope}`);
    lines.push(`  Rule results: ${scope.ruleStatuses.join(", ")}`);
    lines.push(
      `  Assessments: ${scope.assessmentStatuses.join(", ") || "none"}`,
    );
  }
  for (const claim of result.retiredClaims) {
    lines.push(
      `Retired: ${claim.parameterKey} (${claim.claimType}${claim.scope ? `, ${claim.scope}` : ""})`,
    );
    lines.push(`  Claim: ${claim.claimIdentityId}`);
    lines.push(
      `  Review: ${claim.reviewReopened ? "reopened" : "not previously reviewed"}`,
    );
  }
  for (const issue of result.portableStateIssues) {
    lines.push(`Portable state: ${issue.kind} (${issue.claimIdentityId})`);
    lines.push(`  ${issue.message}`);
  }
  return lines.join("\n");
}

function documentationAssertionContext(
  bindings: ReturnType<typeof parseClaimsBindings>,
  parameterKey: string,
  assertionId: string,
): { scope?: string; pattern?: string } {
  for (const document of bindings.parameters[parameterKey]?.documentation ??
    []) {
    const assertion = document.assertions.find(
      (candidate) => candidate.id === assertionId,
    );
    if (assertion)
      return { scope: assertion.scope, pattern: assertion.pattern };
  }
  return {};
}

function claimsDatabase(workspaceRoot: string): Database.Database {
  const dbPath = path.join(workspaceRoot, ".iw", "index.db");
  if (!fs.existsSync(dbPath)) {
    throw new ClaimsBindingError(
      `Index not found at ${dbPath}. Run \`iw index build\` first.`,
    );
  }
  return openMigratedDatabase(dbPath);
}

export async function runClaimsDiscover(options: {
  all?: boolean;
  format: string;
}): Promise<void> {
  const workspaceRoot = process.cwd();
  try {
    const bindings = loadOptionalClaimsBindings(workspaceRoot) ?? {
      parameters: {},
    };
    const files = await discoverWorkingTreeCodeFiles(workspaceRoot);
    const readCode = (filePath: string) =>
      fs.readFileSync(path.join(workspaceRoot, filePath), "utf-8");
    const observations = extractDiscoveredCodeEvidence(
      files,
      readCode,
      bindings,
    );
    const boundObservations = extractBoundCodeEvidence(
      bindings,
      readCode,
    ).filter((observation) => "identityKey" in observation);
    const database = claimsDatabase(workspaceRoot);
    try {
      const store = new CandidateStore(database);
      const existingCompatibilityKeys = currentR1ClaimCandidateKeys(database);
      const existingPromotedKeys = promotedCandidateIdentityKeys(database);
      const portableState = loadPortableClaimsState(workspaceRoot);
      const revision = currentRevision(workspaceRoot);
      const r1Candidates = persistR1Candidates(
        store,
        [...observations, ...boundObservations],
        revision,
      );
      const publicSymbolCandidates = persistPublicSymbolCandidates(
        database,
        revision,
      );
      const discovered = [...r1Candidates, ...publicSymbolCandidates];
      const explicitBindingKeys = new Set(
        boundObservations.map(
          (observation) =>
            `r1:${observation.parameterKey}:${observation.claimType}`,
        ),
      );
      const projectionIssues = applyEffectiveCandidateDecisions(
        database,
        discovered.map((candidate) => candidate.identityKey),
        existingCompatibilityKeys,
        existingPromotedKeys,
        portableState,
        resolveContracts(),
        explicitBindingKeys,
      );
      const candidates = discovered.map((candidate) => ({
        ...candidate,
        ...store.current(candidate.identityKey)!,
      }));
      const surfaced = candidates.filter(
        (candidate) => options.all || candidate.surfaced,
      );
      const output = {
        adapter: {
          id: R1_DISCOVERY_ADAPTER_ID,
          contractVersion: R1_DISCOVERY_CONTRACT_VERSION,
          mode: "deterministic",
        },
        adapters: [
          {
            id: R1_DISCOVERY_ADAPTER_ID,
            contractVersion: R1_DISCOVERY_CONTRACT_VERSION,
            mode: "deterministic",
          },
          {
            id: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
            contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
            mode: "deterministic",
          },
        ],
        semanticDiscovery: "not_run",
        discoveredCount: candidates.length,
        surfacedCount: candidates.filter((candidate) => candidate.surfaced)
          .length,
        hiddenCount: candidates.filter((candidate) => !candidate.surfaced)
          .length,
        projectionIssues,
        candidates: surfaced,
      };
      if (options.format === "json") {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(
          `Discovered ${output.discoveredCount} Candidate${output.discoveredCount === 1 ? "" : "s"} ` +
            `(${output.surfacedCount} surfaced, ${output.hiddenCount} visible with --all).`,
        );
        console.log("Semantic discovery was not run.");
        for (const candidate of surfaced) {
          console.log(
            `${candidate.id}  ${candidate.proposedClaimType}  ${candidate.state}`,
          );
          console.log(`  Sources: ${candidate.sourceKinds.join(", ")}`);
        }
      }
      process.exitCode = 0;
    } finally {
      database.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode =
      error instanceof ClaimsBindingError ||
      error instanceof ClaimsPortableStateFileError
        ? 64
        : 1;
  }
}

const CANDIDATE_STATES: readonly CandidateState[] = [
  "discovered",
  "correlated",
  "triaged",
  "promoted",
  "rejected",
  "suppressed",
  "superseded",
];
const SUBJECT_KINDS: readonly SubjectKind[] = [
  "parameter",
  "symbol",
  "module",
  "endpoint",
];
const CANDIDATE_DECISIONS: readonly CandidateReviewDecision[] = [
  "promote",
  "reject",
  "suppress",
  "defer",
];

interface CandidateProjectionIssue {
  identityKey: string;
  reason: "stale-portable-decision" | "closed-candidate-conflict";
}

function currentR1ClaimCandidateKeys(database: Database.Database): Set<string> {
  return new Set(
    (
      database
        .prepare(
          `SELECT DISTINCT parameter.canonical_key, claim.claim_type
           FROM claim_identities claim
           JOIN parameter_identities parameter
             ON parameter.id = claim.parameter_identity_id
           JOIN claim_versions version ON version.claim_identity_id = claim.id
           JOIN claim_assessments assessment
             ON assessment.claim_version_id = version.id
            AND assessment.is_current = 1
           WHERE claim.claim_type IN ('CLM-DEFAULT', 'CLM-LITERAL')`,
        )
        .all() as Array<{ canonical_key: string; claim_type: string }>
    ).map((row) => `r1:${row.canonical_key}:${row.claim_type}`),
  );
}

function promotedCandidateIdentityKeys(
  database: Database.Database,
): Set<string> {
  return new Set(
    (
      database
        .prepare(
          `SELECT DISTINCT candidate.identity_key
           FROM candidate_reviews review
           JOIN claim_candidates candidate ON candidate.id = review.candidate_id
           WHERE review.decision = 'promote'
             AND review.effect = 'effective'
             AND review.promoted_claim_identity_id IS NOT NULL`,
        )
        .all() as Array<{ identity_key: string }>
    ).map((row) => row.identity_key),
  );
}

function applyEffectiveCandidateDecisions(
  database: Database.Database,
  identityKeys: readonly string[],
  existingCompatibilityKeys: ReadonlySet<string>,
  existingPromotedKeys: ReadonlySet<string>,
  portableState: PortableClaimsState | undefined,
  contracts: ClaimsContractVersions,
  explicitBindingKeys: ReadonlySet<string>,
): CandidateProjectionIssue[] {
  const store = new CandidateStore(database);
  const issues: CandidateProjectionIssue[] = [];
  const continuousPolicy =
    portableState?.policies["r1-continuous-auto-promote"];
  for (const identityKey of identityKeys) {
    const current = store.current(identityKey);
    if (!current) continue;
    let candidate = store.details(current.id)!;
    const portableDecision = portableState?.candidateDecisions[identityKey];
    if (explicitBindingKeys.has(identityKey)) continue;
    if (portableDecision) {
      if (
        portableDecision.candidateFingerprint !==
        candidate.observationFingerprint
      ) {
        if (
          !existingCompatibilityKeys.has(identityKey) &&
          !existingPromotedKeys.has(identityKey)
        ) {
          issues.push({ identityKey, reason: "stale-portable-decision" });
          continue;
        }
      } else {
        const targetState =
          portableDecision.decision === "promote"
            ? "promoted"
            : portableDecision.decision === "reject"
              ? "rejected"
              : "suppressed";
        if (candidate.state === targetState) continue;
        if (
          !["discovered", "correlated", "triaged"].includes(candidate.state)
        ) {
          issues.push({ identityKey, reason: "closed-candidate-conflict" });
          continue;
        }
        candidate = store.details(
          store.triage(candidate.id, {
            basis: "portable-candidate-decision",
          }).id,
        )!;
        if (portableDecision.actor.kind === "policy") {
          applyCandidatePolicy(database, {
            candidateId: candidate.id,
            policyId: portableDecision.actor.id,
            policyVersion: portableDecision.actor.version!,
            decision: portableDecision.decision,
            rationale: portableDecision.rationale,
            provenance: { source: CLAIMS_PORTABLE_STATE_RELATIVE_PATH },
            contracts,
          });
        } else {
          reviewCandidate(database, {
            candidateId: candidate.id,
            actor: portableDecision.actor.id,
            decision: portableDecision.decision,
            rationale: portableDecision.rationale,
            provenance: { source: CLAIMS_PORTABLE_STATE_RELATIVE_PATH },
            contracts,
          });
        }
        continue;
      }
    }

    const policy = existingPromotedKeys.has(identityKey)
      ? {
          id: "promoted-claim-continuity",
          version: "1",
        }
      : existingCompatibilityKeys.has(identityKey)
        ? {
            id:
              candidate.ordinal === 1
                ? "r1-compatibility"
                : "promoted-claim-continuity",
            version: "1",
          }
        : identityKey.startsWith("r1:") && continuousPolicy?.enabled
          ? {
              id: "r1-continuous-auto-promote",
              version: continuousPolicy.version,
            }
          : undefined;
    if (!policy || candidate.state === "promoted") continue;
    if (!["discovered", "correlated", "triaged"].includes(candidate.state)) {
      issues.push({ identityKey, reason: "closed-candidate-conflict" });
      continue;
    }
    candidate = store.details(
      store.triage(candidate.id, { basis: policy.id }).id,
    )!;
    applyCandidatePolicy(database, {
      candidateId: candidate.id,
      policyId: policy.id,
      policyVersion: policy.version,
      decision: "promote",
      rationale:
        policy.id === "r1-compatibility"
          ? "Preserve a Claim active before Candidate migration"
          : policy.id === "promoted-claim-continuity"
            ? "Continue governance for an already active Claim identity"
            : "Continuous R1 auto-promotion is explicitly enabled",
      provenance: { source: "candidate-policy" },
      contracts,
    });
  }
  return issues;
}

function candidateState(value: string | undefined): CandidateState | undefined {
  if (!value) return undefined;
  if (!CANDIDATE_STATES.includes(value as CandidateState)) {
    throw new ClaimsBindingError(
      `Candidate state must be one of: ${CANDIDATE_STATES.join(", ")}`,
    );
  }
  return value as CandidateState;
}

function candidateSubjectKind(
  value: string | undefined,
): SubjectKind | undefined {
  if (!value) return undefined;
  if (!SUBJECT_KINDS.includes(value as SubjectKind)) {
    throw new ClaimsBindingError(
      `Subject kind must be one of: ${SUBJECT_KINDS.join(", ")}`,
    );
  }
  return value as SubjectKind;
}

export async function runClaimsCandidatesList(options: {
  state?: string;
  subjectKind?: string;
  all?: boolean;
  format: string;
}): Promise<void> {
  try {
    const database = claimsDatabase(process.cwd());
    try {
      const store = new CandidateStore(database);
      const state = candidateState(options.state);
      const candidates = store
        .listCurrent({
          ...(state ? { state } : {}),
          ...(options.subjectKind
            ? { subjectKind: candidateSubjectKind(options.subjectKind)! }
            : {}),
        })
        .filter(
          (candidate) =>
            options.all ||
            state !== undefined ||
            ["discovered", "correlated", "triaged"].includes(candidate.state),
        );
      if (options.format === "json") {
        console.log(JSON.stringify({ candidates }, null, 2));
      } else if (candidates.length === 0) {
        console.log("No matching Candidates.");
      } else {
        for (const candidate of candidates) {
          console.log(
            `${candidate.id}  ${candidate.proposedClaimType}  ${candidate.state}`,
          );
          console.log(
            `  Subjects: ${candidate.subjects.map((subject) => `${subject.role}=${subject.identityKey}`).join(", ")}`,
          );
        }
      }
      process.exitCode = 0;
    } finally {
      database.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ClaimsBindingError ? 64 : 1;
  }
}

export async function runClaimsCandidatesTriage(options: {
  candidate?: string;
  subjectKind?: string;
  claimType?: string;
  format: string;
}): Promise<void> {
  try {
    const database = claimsDatabase(process.cwd());
    try {
      const store = new CandidateStore(database);
      const candidates = store
        .listCurrent({
          ...(options.subjectKind
            ? { subjectKind: candidateSubjectKind(options.subjectKind)! }
            : {}),
        })
        .filter(
          (candidate) =>
            (!options.candidate || candidate.id === options.candidate) &&
            (!options.claimType ||
              candidate.proposedClaimType === options.claimType) &&
            ["discovered", "correlated", "triaged"].includes(candidate.state),
        );
      if (options.candidate && candidates.length === 0) {
        throw new ClaimsBindingError(
          `No triageable current Candidate matches ${options.candidate}`,
        );
      }
      const triaged = database.transaction(() =>
        candidates.map((candidate) =>
          store.triage(candidate.id, {
            basis: "manual-triage",
            semanticInduction: "not_run",
          }),
        ),
      )();
      console.log(
        options.format === "json"
          ? JSON.stringify({ candidates: triaged }, null, 2)
          : `Triaged ${triaged.length} Candidate${triaged.length === 1 ? "" : "s"}.`,
      );
      process.exitCode = 0;
    } finally {
      database.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ClaimsBindingError ? 64 : 1;
  }
}

export async function runClaimsCandidateReview(options: {
  candidate: string;
  actor: string;
  decision: string;
  rationale: string;
  format: string;
}): Promise<void> {
  try {
    if (
      !CANDIDATE_DECISIONS.includes(options.decision as CandidateReviewDecision)
    ) {
      throw new ClaimsBindingError(
        `Candidate decision must be one of: ${CANDIDATE_DECISIONS.join(", ")}`,
      );
    }
    const decision = options.decision as CandidateReviewDecision;
    if (options.actor.trim().length === 0) {
      throw new ClaimsBindingError("Candidate Review actor must not be empty");
    }
    if (options.rationale.trim().length === 0) {
      throw new ClaimsBindingError(
        "Candidate Review rationale must not be empty",
      );
    }
    const workspaceRoot = process.cwd();
    const database = claimsDatabase(workspaceRoot);
    try {
      const store = new CandidateStore(database);
      const candidate = store.details(options.candidate);
      if (
        !candidate ||
        store.current(candidate.identityKey)?.id !== candidate.id
      ) {
        throw new ClaimsBindingError(
          `Candidate ${options.candidate} is not a current Candidate`,
        );
      }
      if (candidate.state !== "triaged") {
        throw new ClaimsBindingError(
          `Candidate ${candidate.id} must be triaged before Review`,
        );
      }
      const decidedAt = new Date().toISOString();
      const portableStatePath =
        decision === "defer"
          ? undefined
          : claimsPortableStatePath(workspaceRoot);
      const apply = database.transaction(() => {
        const result = reviewCandidate(database, {
          candidateId: candidate.id,
          actor: options.actor,
          decision,
          rationale: options.rationale,
          provenance: {
            decidedAt,
            portableStatePath: portableStatePath ?? null,
          },
          contracts: resolveContracts(),
        });
        if (decision !== "defer") {
          persistPortableCandidateDecision(workspaceRoot, candidate, {
            decision,
            actor: { kind: "human", id: options.actor },
            decidedAt,
            rationale: options.rationale,
          });
        }
        return result;
      });
      const result = apply();
      const output = {
        ...result,
        portableStatePath: portableStatePath ?? null,
      };
      console.log(
        options.format === "json"
          ? JSON.stringify(output, null, 2)
          : `Candidate Review recorded: ${result.review.id}${result.assessment ? `\nPromoted Claim: ${result.assessment.claimIdentityId}` : ""}${portableStatePath ? `\nPortable state: ${portableStatePath}` : ""}`,
      );
      process.exitCode = 0;
    } finally {
      database.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ClaimsBindingError ? 64 : 1;
  }
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
):
  | {
      identityKey: string;
      observation: PersistedObservation;
      rename: GitRename;
    }
  | undefined {
  const currentMetadata = evidenceVersionMetadata(database, current.version.id);
  if (!currentMetadata?.file_path) return undefined;
  const matchingRenames = renames.filter(
    (rename) => rename.toPath === currentMetadata.file_path,
  );
  if (matchingRenames.length !== 1) return undefined;
  const rename = matchingRenames[0]!;
  const matches = [...previousEvidence.entries()].filter(([_, previous]) => {
    const previousMetadata = evidenceVersionMetadata(
      database,
      previous.version.id,
    );
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
    evidence.source_kind === "code-default" ||
    evidence.source_kind === "code-annotation"
      ? ["CLM-DEFAULT"]
      : evidence.source_kind === "documentation"
        ? evidence.semantic_location?.endsWith(".default")
          ? ["CLM-DEFAULT"]
          : ["CLM-DOC-CONFORMANCE"]
        : ["CLM-EFFECTIVE", "CLM-DOC-CONFORMANCE"];
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
        AND ci.claim_type IN (${claimTypePlaceholders})`,
    )
    .all(previousEvidenceVersionId, ...claimTypes) as Array<{
    claim_identity_id: string;
    assessment_id: string;
  }>;
  const reopenedClaims: string[] = [];
  for (const assessment of impacted) {
    database
      .prepare(
        `UPDATE claim_assessments
         SET is_current = 0
         WHERE id = ?`,
      )
      .run(assessment.assessment_id);
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

interface RefreshedRetiredClaim {
  claimIdentityId: string;
  parameterKey: string;
  claimType: string;
  scope: string | null;
  reviewReopened: boolean;
}

function reconcileDiscoveredClaims(
  database: Database.Database,
  reviews: ClaimsReviewStore,
  discoveredParameterKeys: ReadonlySet<string>,
  repositoryRevision: string,
): RefreshedRetiredClaim[] {
  const currentDiscoveredClaims = database
    .prepare(
      `SELECT ci.id AS claim_identity_id,
              parameter.canonical_key AS parameter_key,
              ci.claim_type, ci.scope, ca.id AS assessment_id,
              EXISTS(
                SELECT 1 FROM review_decisions review
                WHERE review.claim_identity_id = ci.id
                  AND review.is_current = 1
              ) AS has_current_review,
              (
                SELECT binding.evidence_version_id
                FROM parameter_evidence_bindings binding
                JOIN evidence_versions evidence
                  ON evidence.id = binding.evidence_version_id
                WHERE binding.parameter_identity_id = parameter.id
                  AND binding.basis = 'r1-discovery'
                ORDER BY evidence.version_ordinal DESC, binding.created_at DESC
                LIMIT 1
              ) AS evidence_version_id
       FROM claim_assessments ca
       JOIN claim_versions cv ON cv.id = ca.claim_version_id
       JOIN claim_identities ci ON ci.id = cv.claim_identity_id
       JOIN parameter_identities parameter
         ON parameter.id = ci.parameter_identity_id
       WHERE ca.is_current = 1
         AND parameter.canonical_key LIKE 'code:%'
         AND EXISTS (
           SELECT 1 FROM parameter_evidence_bindings binding
           WHERE binding.parameter_identity_id = parameter.id
             AND binding.basis = 'r1-discovery'
         )
       ORDER BY parameter.canonical_key, ci.claim_type, ci.scope`,
    )
    .all() as Array<{
    claim_identity_id: string;
    parameter_key: string;
    claim_type: string;
    scope: string | null;
    assessment_id: string;
    has_current_review: number;
    evidence_version_id: string | null;
  }>;

  const retired: RefreshedRetiredClaim[] = [];
  for (const claim of currentDiscoveredClaims) {
    if (discoveredParameterKeys.has(claim.parameter_key)) continue;
    if (claim.has_current_review && !claim.evidence_version_id) {
      throw new ClaimsBindingError(
        `Cannot refresh reviewed claim ${claim.claim_identity_id}: discovery evidence is missing`,
      );
    }
    const reopened = claim.evidence_version_id
      ? reviews.reopen({
          claimIdentityId: claim.claim_identity_id,
          basisAssessmentId: claim.assessment_id,
          dependencyKind: "evidence_version",
          dependencyVersionId: claim.evidence_version_id,
          reason: "continuity-broken",
          secondaryProvenance: {
            trigger: "refresh-reconciliation",
            repositoryRevision,
            parameterKey: claim.parameter_key,
          },
        })
      : null;
    database
      .prepare(
        `UPDATE claim_assessments
         SET is_current = 0
         WHERE id = ?`,
      )
      .run(claim.assessment_id);
    retired.push({
      claimIdentityId: claim.claim_identity_id,
      parameterKey: claim.parameter_key,
      claimType: claim.claim_type,
      scope: claim.scope,
      reviewReopened: reopened !== null,
    });
  }
  return retired;
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
        `SELECT reference.assessment_id AS id
         FROM claim_assessment_references reference
         WHERE reference.claim_identity_id = ? AND reference.repository_revision = ?`,
      )
      .get(claimIdentityId, baseRevision) as { id: string } | undefined;
    if (
      anchored &&
      (!preRunReferenceAssessmentIds ||
        preRunReferenceAssessmentIds.has(anchored.id))
    ) {
      return anchored.id;
    }
  } else {
    const reviewed = database
      .prepare(
        `SELECT basis_assessment_id
         FROM review_decisions
         WHERE claim_identity_id = ? AND is_current = 1`,
      )
      .get(claimIdentityId) as { basis_assessment_id: string } | undefined;
    if (reviewed && reviewed.basis_assessment_id !== currentAssessmentId) {
      return reviewed.basis_assessment_id;
    }
  }
  return undefined;
}

function semanticContractDrift(
  database: Database.Database,
  currentAssessmentId: string,
  referenceAssessmentId: string,
  baseRevision?: string,
):
  | {
      dependencyKind: "rule_result_version" | "claim_version";
      dependencyVersionId: string;
      provenance: Record<string, unknown>;
    }
  | undefined {
  const assessmentRow = (assessmentId: string) =>
    database
      .prepare(
        `SELECT cv.id AS claim_version_id, cv.assessment_policy_id,
                cv.assessment_policy_version, cv.normalized_statement_json,
                cv.materiality_contract_id, cv.materiality_contract_version
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
          materiality_contract_id: string | null;
          materiality_contract_version: string | null;
        }
      | undefined;
  const current = assessmentRow(currentAssessmentId);
  const reference = assessmentRow(referenceAssessmentId);
  if (!current || !reference) return undefined;

  const currentRules = ruleDependencySnapshots(database, currentAssessmentId);
  const referenceRules = ruleDependencySnapshots(
    database,
    referenceAssessmentId,
  );
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
      currentRule.rule_contract_version !==
        referenceRule.rule_contract_version ||
      currentRule.normalized_status !== referenceRule.normalized_status ||
      currentRule.normalized_output_json !==
        referenceRule.normalized_output_json ||
      currentRule.normalized_reasons_json !==
        referenceRule.normalized_reasons_json;
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
  const materialityContractChanged =
    current.materiality_contract_id !== reference.materiality_contract_id ||
    current.materiality_contract_version !==
      reference.materiality_contract_version;
  if (
    changedRules.length === 0 &&
    !policyChanged &&
    !materialityContractChanged
  ) {
    return undefined;
  }

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
      : ([...currentRules.values()][0]?.dependency_version_id ??
        current.claim_version_id);
  const dependencyKind =
    changedDependency || currentRules.size > 0
      ? "rule_result_version"
      : "claim_version";

  return {
    dependencyKind,
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
      materialityContract: materialityContractChanged
        ? {
            from: {
              id: reference.materiality_contract_id,
              version: reference.materiality_contract_version,
            },
            to: {
              id: current.materiality_contract_id,
              version: current.materiality_contract_version,
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
    dependencyKind: drift.dependencyKind,
    dependencyVersionId: drift.dependencyVersionId,
    reason: "warrant-changed",
    secondaryProvenance: drift.provenance,
  });
  return reopened?.created ? current.claim_identity_id : undefined;
}

function promoteDiscoveredClaim(
  database: Database.Database,
  reviews: ClaimsReviewStore,
  codeDefault: Extract<
    ReturnType<typeof extractBoundCodeEvidence>[number],
    { identityKey: string }
  >,
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

function linkExplicitBindingPromotion(
  database: Database.Database,
  codeDefault: Extract<
    ReturnType<typeof extractBoundCodeEvidence>[number],
    { identityKey: string }
  >,
  promotedClaimIdentityId: string,
): void {
  if (codeDefault.bindingBasis !== "explicit-map") return;
  linkCandidatePolicyPromotion(database, {
    candidateIdentityKey: `r1:${codeDefault.parameterKey}:${codeDefault.claimType}`,
    promotedClaimIdentityId,
    policyId: "explicit-binding",
    policyVersion: "1",
    rationale: "Activate the Claim selected by an explicit Parameter binding",
    provenance: {
      source: "intentweave.bindings.yaml",
      bindingBasis: codeDefault.bindingBasis,
      bindingConfidence: codeDefault.bindingConfidence,
      evidenceIdentityKey: codeDefault.identityKey,
    },
  });
}

export async function runClaimsCheck(options: {
  scope?: string;
  since?: string;
  refresh?: boolean;
  format: string;
  contracts?: Partial<ClaimsContractVersions>;
}): Promise<void> {
  const workspaceRoot = process.cwd();
  const contracts = resolveContracts(options.contracts);
  try {
    const claimsGit = options.since ? new ClaimsGit(workspaceRoot) : undefined;
    const headRevision = claimsGit?.head();
    const baseRevision = options.since
      ? claimsGit!.mergeBase(options.since)
      : undefined;
    const readOptionalCurrentFile = (filePath: string): string | undefined => {
      if (claimsGit && headRevision)
        return claimsGit.show(headRevision, filePath);
      const absolutePath = path.join(workspaceRoot, filePath);
      return fs.existsSync(absolutePath)
        ? fs.readFileSync(absolutePath, "utf-8")
        : undefined;
    };
    const readCurrentFile = (filePath: string): string => {
      const content = readOptionalCurrentFile(filePath);
      if (content === undefined) {
        throw new ClaimsBindingError(
          `Configured Claims source not found: ${filePath}`,
        );
      }
      return content;
    };
    const bindingsText = readOptionalCurrentFile("intentweave.bindings.yaml");
    const bindings = bindingsText
      ? parseClaimsBindings(yamlLoad(bindingsText))
      : { parameters: {} };
    const portableStateText = readOptionalCurrentFile(
      CLAIMS_PORTABLE_STATE_RELATIVE_PATH,
    );
    const portableState = portableStateText
      ? parsePortableClaimsStateYaml(portableStateText)
      : undefined;
    const registryText = readOptionalCurrentFile("config/environments.yaml");
    const registryPath = "config/environments.yaml";
    const scopes = registryText
      ? parseScopeRegistry(yamlLoad(registryText))
      : [];
    if (options.scope && scopes.length === 0) {
      throw new ClaimsBindingError(
        `Scope ${options.scope} cannot be evaluated because no scope registry was discovered`,
      );
    }
    const currentCodeFiles =
      claimsGit && headRevision
        ? claimsGit.listFiles(headRevision).filter(isClaimCodeFile)
        : await discoverWorkingTreeCodeFiles(workspaceRoot);
    const discoveredCode = extractDiscoveredCodeEvidence(
      currentCodeFiles,
      readCurrentFile,
      bindings,
    );
    const database = claimsDatabase(workspaceRoot);
    try {
      const runCheck = database.transaction(() => {
        const store = new ClaimsStore(database);
        const engine = new ClaimsEngine(store);
        const reviews = new ClaimsReviewStore(database);
        const preRunReferenceAssessmentIds = new Set(
          (
            database
              .prepare(
                `SELECT assessment_id AS id FROM claim_assessment_references`,
              )
              .all() as Array<{ id: string }>
          ).map((row) => row.id),
        );
        const revision = headRevision ?? currentRevision(workspaceRoot);
        const readBoundFile = (filePath: string) =>
          readOptionalCurrentFile(filePath) ?? "";
        const boundCode = extractBoundCodeEvidence(bindings, readBoundFile);
        const boundCandidateEvidence = boundCode.filter(
          (observation) => "identityKey" in observation,
        );
        const explicitBindingKeys = new Set(
          boundCandidateEvidence.map(
            (observation) =>
              `r1:${observation.parameterKey}:${observation.claimType}`,
          ),
        );
        const existingCompatibilityKeys = currentR1ClaimCandidateKeys(database);
        const existingPromotedKeys = promotedCandidateIdentityKeys(database);
        const candidateStore = new CandidateStore(database);
        const r1Candidates = persistR1Candidates(
          candidateStore,
          [...discoveredCode, ...boundCandidateEvidence],
          revision,
        );
        const publicSymbolCandidates = persistPublicSymbolCandidates(
          database,
          revision,
        );
        const discoveredCandidates = [
          ...r1Candidates,
          ...publicSymbolCandidates,
        ];
        const candidateProjectionIssues = applyEffectiveCandidateDecisions(
          database,
          discoveredCandidates.map((candidate) => candidate.identityKey),
          existingCompatibilityKeys,
          existingPromotedKeys,
          portableState,
          contracts,
          explicitBindingKeys,
        );
        const activeCandidateKeys = new Set(
          discoveredCandidates.flatMap((candidate) =>
            candidateStore.current(candidate.identityKey)?.state === "promoted"
              ? [candidate.identityKey]
              : [],
          ),
        );
        const activeDiscoveredCode = discoveredCode.filter((observation) =>
          activeCandidateKeys.has(
            `r1:${observation.parameterKey}:${observation.claimType}`,
          ),
        );
        const code = [...boundCode, ...activeDiscoveredCode];
        const docs = extractDocumentationAssertions(bindings, readBoundFile);
        const documentationInconclusive = docs.filter(
          (observation) => observation.kind === "inconclusive",
        );
        for (const observation of documentationInconclusive) {
          const assertion = documentationAssertionContext(
            bindings,
            observation.parameterKey,
            observation.assertionId,
          );
          store.persistRuleResult(
            {
              ruleId: "R3.doc-conformance",
              subjectKey: observation.parameterKey,
              scope: assertion.scope,
              applicability: "applicable",
              normalizedStatus: "inconclusive",
              normalizedOutput: {
                assertionId: observation.assertionId,
                filePath: observation.filePath,
                reason: observation.reason,
              },
              normalizedReasons: [observation.reason],
              evidenceVersionIds: [],
              ruleContractVersion: contracts.r3RuleContractVersion,
              implementationFingerprint:
                contracts.r3ImplementationFingerprint ??
                contracts.implementationFingerprint,
            },
            [],
          );
        }
        const previousEvidence = (() => {
          if (!claimsGit || !baseRevision)
            return new Map<string, PersistedObservation>();
          const baseRegistry = claimsGit.show(
            baseRevision,
            "config/environments.yaml",
          );
          const baseBindingsText = claimsGit.show(
            baseRevision,
            "intentweave.bindings.yaml",
          );
          const baseBindings = baseBindingsText
            ? parseClaimsBindings(yamlLoad(baseBindingsText))
            : { parameters: {} };
          const baseCodeFiles = claimsGit
            .listFiles(baseRevision)
            .filter(isClaimCodeFile);
          const readBaseFile = (filePath: string) =>
            claimsGit.show(baseRevision, filePath) ?? "";
          const baseDiscoveredCode = extractDiscoveredCodeEvidence(
            baseCodeFiles,
            readBaseFile,
            baseBindings,
          ).filter((observation) =>
            activeCandidateKeys.has(
              `r1:${observation.parameterKey}:${observation.claimType}`,
            ),
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
            const filePath = path.join(
              workspaceRoot,
              "config",
              `${scope}.yaml`,
            );
            return fs.existsSync(filePath)
              ? fs.readFileSync(filePath, "utf-8")
              : undefined;
          },
          options.scope,
        );
        const selectedScopes = options.scope
          ? scopes.filter((scope) => scope.name === options.scope)
          : scopes;
        const output = {
          gateStatus: "evaluated",
          claims: [] as Array<{
            claimIdentityId?: string;
            parameterKey: string | null;
            claimType: string;
            ruleStatuses: string[];
            assessmentStatuses: string[];
          }>,
          scopes: [] as Array<{
            scope: string;
            ruleStatuses: string[];
            assessmentStatuses: string[];
          }>,
          retiredClaims: [] as RefreshedRetiredClaim[],
          portableStateIssues: [] as PortableReviewProjectionIssue[],
          candidates: {
            discovered: discoveredCandidates.length,
            active: activeCandidateKeys.size,
            issues: candidateProjectionIssues,
          },
        };
        const allRuleStatuses: Array<
          "passed" | "failed" | "inconclusive" | "not_applicable"
        > = [];
        const allAssessmentStatuses: Array<
          "supported" | "refuted" | "contested" | "inconclusive"
        > = [];
        allAssessmentStatuses.push(
          ...candidateProjectionIssues.map(() => "inconclusive" as const),
        );
        const assessmentIds: string[] = [];
        const reopenedClaimIds = new Set<string>();
        allRuleStatuses.push(
          ...documentationInconclusive.map(() => "inconclusive" as const),
        );

        const unscopedParameterKeys = new Set(
          (scopes.length === 0 ? code : activeDiscoveredCode).map(
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
          if (
            persistedAnnotation &&
            codeAnnotation &&
            "identityKey" in codeAnnotation
          ) {
            currentEvidence.set(
              codeAnnotation.identityKey,
              persistedAnnotation,
            );
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
          if (
            documentedDefault &&
            documentedDefault.kind === "evidence" &&
            persistedDocumentedDefault
          ) {
            currentEvidence.set(
              documentedDefault.identityKey,
              persistedDocumentedDefault,
            );
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
          linkExplicitBindingPromotion(
            database,
            codeDefault,
            result.assessments[0]!.claimIdentityId,
          );
          promoteDiscoveredClaim(
            database,
            reviews,
            codeDefault,
            result.assessments[0]!.claimIdentityId,
            result.assessments[0]!.id,
            result.ruleResults[0]!.id,
          );
          const ruleStatuses = result.ruleResults.map(
            (rule) =>
              (
                database
                  .prepare(
                    `SELECT normalized_status FROM rule_result_versions WHERE id = ?`,
                  )
                  .get(rule.id) as {
                  normalized_status:
                    | "passed"
                    | "failed"
                    | "inconclusive"
                    | "not_applicable";
                }
              ).normalized_status,
          );
          const assessmentStatuses = result.assessments.map(
            (assessment) =>
              (
                database
                  .prepare(
                    `SELECT epistemic_status FROM claim_assessments WHERE id = ?`,
                  )
                  .get(assessment.id) as {
                  epistemic_status:
                    | "supported"
                    | "refuted"
                    | "contested"
                    | "inconclusive";
                }
              ).epistemic_status,
          );
          allRuleStatuses.push(...ruleStatuses);
          allAssessmentStatuses.push(...assessmentStatuses);
          assessmentIds.push(
            ...result.assessments.map((assessment) => assessment.id),
          );
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
            const configValue = config.find(
              (observation) =>
                observation.parameterKey === parameterKey &&
                observation.scope === scope.name &&
                observation.kind === "evidence",
            );
            const documentedValue = docs.find(
              (observation) =>
                observation.parameterKey === parameterKey &&
                observation.kind === "evidence" &&
                observation.semanticLocation ===
                  `${parameterKey}.override[${scope.name}]`,
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
            if (
              codeDefault &&
              "identityKey" in codeDefault &&
              persistedCodeDefault
            ) {
              currentEvidence.set(
                codeDefault.identityKey,
                persistedCodeDefault,
              );
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
            if (
              codeAnnotation &&
              "identityKey" in codeAnnotation &&
              persistedAnnotation
            ) {
              currentEvidence.set(
                codeAnnotation.identityKey,
                persistedAnnotation,
              );
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
            if (
              configValue &&
              configValue.kind === "evidence" &&
              persistedConfig
            ) {
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
            if (
              documentedValue &&
              documentedValue.kind === "evidence" &&
              persistedDocumentation
            ) {
              currentEvidence.set(
                documentedValue.identityKey,
                persistedDocumentation,
              );
            }
            const documentedDefaultValue = docs.find(
              (observation) =>
                observation.parameterKey === parameterKey &&
                observation.kind === "evidence" &&
                observation.semanticLocation === `${parameterKey}.default`,
            );
            const persistedDocumentedDefault =
              documentedDefaultValue &&
              documentedDefaultValue.kind === "evidence"
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
            if (
              documentedDefaultValue &&
              documentedDefaultValue.kind === "evidence" &&
              persistedDocumentedDefault
            ) {
              currentEvidence.set(
                documentedDefaultValue.identityKey,
                persistedDocumentedDefault,
              );
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
              linkExplicitBindingPromotion(
                database,
                codeDefault,
                result.assessments[0]!.claimIdentityId,
              );
              promoteDiscoveredClaim(
                database,
                reviews,
                codeDefault,
                result.assessments[0]!.claimIdentityId,
                result.assessments[0]!.id,
                result.ruleResults[0]!.id,
              );
            }
            const ruleStatuses = result.ruleResults.map(
              (rule) =>
                (
                  database
                    .prepare(
                      `SELECT normalized_status FROM rule_result_versions WHERE id = ?`,
                    )
                    .get(rule.id) as {
                    normalized_status:
                      | "passed"
                      | "failed"
                      | "inconclusive"
                      | "not_applicable";
                  }
                ).normalized_status,
            );
            const assessmentStatuses = result.assessments.map(
              (assessment) =>
                (
                  database
                    .prepare(
                      `SELECT epistemic_status FROM claim_assessments WHERE id = ?`,
                    )
                    .get(assessment.id) as {
                    epistemic_status:
                      | "supported"
                      | "refuted"
                      | "contested"
                      | "inconclusive";
                  }
                ).epistemic_status,
            );
            allRuleStatuses.push(...ruleStatuses);
            allAssessmentStatuses.push(...assessmentStatuses);
            assessmentIds.push(
              ...result.assessments.map((assessment) => assessment.id),
            );
            output.scopes.push({
              scope: scope.name,
              ruleStatuses,
              assessmentStatuses,
            });
          }
        }
        if (options.refresh) {
          output.retiredClaims.push(
            ...reconcileDiscoveredClaims(
              database,
              reviews,
              new Set(
                discoveredCode.map((observation) => observation.parameterKey),
              ),
              revision,
            ),
          );
        }
        const genericClaims = database
          .prepare(
            `SELECT claim.id AS claim_identity_id, claim.claim_type,
                    assessment.id AS assessment_id,
                    assessment.epistemic_status
             FROM claim_identities claim
             JOIN claim_versions version ON version.claim_identity_id = claim.id
             JOIN claim_assessments assessment
               ON assessment.claim_version_id = version.id
              AND assessment.is_current = 1
             WHERE claim.parameter_identity_id IS NULL
             ORDER BY claim.claim_type, claim.id`,
          )
          .all() as Array<{
          claim_identity_id: string;
          claim_type: string;
          assessment_id: string;
          epistemic_status:
            | "supported"
            | "refuted"
            | "contested"
            | "inconclusive";
        }>;
        for (const claim of genericClaims) {
          const ruleStatuses = (
            database
              .prepare(
                `SELECT result.normalized_status
                 FROM claim_assessment_dependencies dependency
                 JOIN rule_result_versions result
                   ON result.id = dependency.dependency_version_id
                 WHERE dependency.claim_assessment_id = ?
                   AND dependency.dependency_kind = 'rule_result_version'
                 ORDER BY result.id`,
              )
              .all(claim.assessment_id) as Array<{
              normalized_status:
                | "passed"
                | "failed"
                | "inconclusive"
                | "not_applicable";
            }>
          ).map((result) => result.normalized_status);
          output.claims.push({
            claimIdentityId: claim.claim_identity_id,
            parameterKey: null,
            claimType: claim.claim_type,
            ruleStatuses,
            assessmentStatuses: [claim.epistemic_status],
          });
          allRuleStatuses.push(...ruleStatuses);
          allAssessmentStatuses.push(claim.epistemic_status);
          assessmentIds.push(claim.assessment_id);
        }
        if (claimsGit && baseRevision && headRevision) {
          const changedPaths = claimsGit.changedPaths(
            baseRevision,
            headRevision,
          );
          const renames = claimsGit.renames(baseRevision, headRevision);
          const continuedPreviousIdentityKeys = new Set<string>();
          for (const [identityKey, current] of currentEvidence) {
            const matchedRename = renamedPredecessor(
              database,
              previousEvidence,
              current,
              renames,
            );
            const previous =
              previousEvidence.get(identityKey) ?? matchedRename?.observation;
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
            if (matchedRename)
              continuedPreviousIdentityKeys.add(matchedRename.identityKey);
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
                    continuityConfidence: materialChange
                      ? "probable"
                      : "certain",
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
            if (
              currentEvidence.has(identityKey) ||
              continuedPreviousIdentityKeys.has(identityKey)
            )
              continue;
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
        if (baseRevision) {
          for (const assessmentId of assessmentIds) {
            const assessment = database
              .prepare(
                `SELECT cv.claim_identity_id
               FROM claim_assessments ca
               JOIN claim_versions cv ON cv.id = ca.claim_version_id
               WHERE ca.id = ?`,
              )
              .get(assessmentId) as { claim_identity_id: string } | undefined;
            if (
              assessment &&
              !contractReferenceAssessmentId(
                database,
                assessment.claim_identity_id,
                baseRevision,
                assessmentId,
                preRunReferenceAssessmentIds,
              )
            ) {
              allRuleStatuses.push("inconclusive");
            }
          }
        }
        if (portableState) {
          const projection = projectPortableAssessmentReviews(
            database,
            portableState,
          );
          output.portableStateIssues.push(...projection.issues);
          allAssessmentStatuses.push(
            ...projection.issues.map(() => "inconclusive" as const),
          );
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
              .get(assessment.claim_identity_id) as
              | { present: number }
              | undefined;
            if (!openReopen) {
              reviews.carryForward(assessment.claim_identity_id, assessmentId);
            }
          }
        }
        const reviewRequired =
          output.retiredClaims.some((claim) => claim.reviewReopened) ||
          assessmentIds.some((assessmentId) => {
            const row = database
              .prepare(
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
              )
              .get(assessmentId) as {
              epistemic_status: string;
              reviewed: number;
              open_reopen: number;
            };
            return (
              row.epistemic_status !== "inconclusive" &&
              (row.reviewed === 0 || row.open_reopen === 1)
            );
          });
        output.candidates.active = candidateStore.listCurrent({
          state: "promoted",
        }).length;
        if (output.claims.length === 0 && output.scopes.length === 0) {
          output.gateStatus = "no_active_claims";
        }
        return {
          output,
          exitCode: claimsExitCode({
            discoveryEmpty:
              output.claims.length === 0 && output.scopes.length === 0,
            ruleStatuses: allRuleStatuses,
            assessmentStatuses: allAssessmentStatuses,
            reviewRequired,
          }),
        };
      });
      const result = runCheck();
      console.log(
        options.format === "json"
          ? JSON.stringify(result.output, null, 2)
          : formatText(result.output),
      );
      process.exitCode = result.exitCode;
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode =
      error instanceof ClaimsBindingError ||
      error instanceof ClaimsGitError ||
      error instanceof ClaimsPortableStateFileError
        ? 64
        : 1;
  }
}

interface ClaimSelectorOptions {
  claim?: string;
  type?: string;
  scope?: string;
}

interface ClaimIdentitySelection {
  id: string;
  parameter_key: string | null;
  claim_type: string;
  scope: string | null;
}

function promotedClaimForCandidate(
  database: Database.Database,
  candidateId: string,
): string {
  const selected = database
    .prepare(
      `SELECT identity_key, version_ordinal
       FROM claim_candidates WHERE id = ?`,
    )
    .get(candidateId) as
    | { identity_key: string; version_ordinal: number }
    | undefined;
  if (!selected) {
    throw new ClaimsBindingError(`Candidate ${candidateId} does not exist`);
  }
  const cycle = database
    .prepare(
      `SELECT MAX(version_ordinal) AS start_ordinal
       FROM claim_candidates
       WHERE identity_key = ? AND state = 'discovered'
         AND version_ordinal <= ?`,
    )
    .get(selected.identity_key, selected.version_ordinal) as {
    start_ordinal: number;
  };
  const nextCycle = database
    .prepare(
      `SELECT MIN(version_ordinal) AS start_ordinal
       FROM claim_candidates
       WHERE identity_key = ? AND state = 'discovered'
         AND version_ordinal > ?`,
    )
    .get(selected.identity_key, cycle.start_ordinal) as {
    start_ordinal: number | null;
  };
  const promotion = database
    .prepare(
      `SELECT review.promoted_claim_identity_id
       FROM candidate_reviews review
       JOIN claim_candidates candidate ON candidate.id = review.candidate_id
       WHERE candidate.identity_key = ?
         AND candidate.version_ordinal >= ?
         AND (? IS NULL OR candidate.version_ordinal < ?)
         AND review.decision = 'promote'
         AND review.effect = 'effective'
         AND review.promoted_claim_identity_id IS NOT NULL
       ORDER BY candidate.version_ordinal DESC, review.created_at DESC
       LIMIT 1`,
    )
    .get(
      selected.identity_key,
      cycle.start_ordinal,
      nextCycle.start_ordinal,
      nextCycle.start_ordinal,
    ) as { promoted_claim_identity_id: string } | undefined;
  if (!promotion) {
    throw new ClaimsBindingError(
      `Candidate ${candidateId} has no effective promotion`,
    );
  }
  return promotion.promoted_claim_identity_id;
}

function matchingClaimIdentities(
  database: Database.Database,
  options: ClaimSelectorOptions,
): ClaimIdentitySelection[] {
  const claimId = options.claim?.startsWith("claim:") ? options.claim : null;
  const parameterKey = options.claim && !claimId ? options.claim : null;
  return database
    .prepare(
      `SELECT ci.id, parameter.canonical_key AS parameter_key,
              ci.claim_type, ci.scope
       FROM claim_identities ci
       LEFT JOIN parameter_identities parameter
         ON parameter.id = ci.parameter_identity_id
       WHERE ((? IS NULL AND ? IS NULL)
              OR ci.id = ? OR parameter.canonical_key = ?)
         AND (? IS NULL OR ci.claim_type = ?)
         AND (? IS NULL OR ci.scope = ?)
       ORDER BY parameter.canonical_key, ci.claim_type, ci.scope`,
    )
    .all(
      claimId,
      parameterKey,
      claimId,
      parameterKey,
      options.type ?? null,
      options.type ?? null,
      options.scope ?? null,
      options.scope ?? null,
    ) as ClaimIdentitySelection[];
}

function resolveSingleClaimIdentity(
  database: Database.Database,
  options: ClaimSelectorOptions & { claim: string },
): ClaimIdentitySelection {
  const resolvedOptions = options.claim.startsWith("candidate:")
    ? { ...options, claim: promotedClaimForCandidate(database, options.claim) }
    : options;
  const matches = matchingClaimIdentities(database, resolvedOptions);
  if (matches.length === 0) {
    throw new ClaimsBindingError(
      `No claim matches ${options.claim}${options.type ? ` with type ${options.type}` : ""}${options.scope ? ` in scope ${options.scope}` : ""}`,
    );
  }
  if (matches.length > 1) {
    const candidates = matches
      .map(
        (match) =>
          `${match.claim_type}${match.scope ? ` (${match.scope})` : " (unscoped)"}`,
      )
      .join(", ");
    throw new ClaimsBindingError(
      `Claim selector ${options.claim} is ambiguous: ${candidates}. Add --type and, when needed, --scope.`,
    );
  }
  return matches[0]!;
}

export async function runClaimsReview(options: {
  claim: string;
  type?: string;
  scope?: string;
  actor: string;
  decision: string;
  rationale?: string;
  format: string;
}): Promise<void> {
  try {
    if (options.decision !== "accepted" && options.decision !== "rejected") {
      throw new ClaimsBindingError(
        "Review decision must be accepted or rejected",
      );
    }
    const workspaceRoot = process.cwd();
    const database = claimsDatabase(workspaceRoot);
    try {
      const claim = resolveSingleClaimIdentity(database, options);
      const assessment = database
        .prepare(
          `SELECT ca.id
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           WHERE cv.claim_identity_id = ? AND ca.is_current = 1`,
        )
        .get(claim.id) as { id: string } | undefined;
      const openReopenBasis = assessment
        ? undefined
        : (database
            .prepare(
              `SELECT basis_assessment_id
               FROM review_decision_reopens
               WHERE claim_identity_id = ? AND status = 'open'
               ORDER BY created_at DESC
               LIMIT 1`,
            )
            .get(claim.id) as { basis_assessment_id: string } | undefined);
      const basisAssessmentId =
        assessment?.id ?? openReopenBasis?.basis_assessment_id;
      if (!basisAssessmentId) {
        throw new ClaimsBindingError(
          `No reviewable assessment for claim ${claim.id}`,
        );
      }
      const decidedAt = new Date();
      const portableStatePath = persistPortableAssessmentReview(
        workspaceRoot,
        database,
        {
          claimIdentityId: claim.id,
          basisAssessmentId,
          decision: options.decision,
          actor: options.actor,
          rationale:
            options.rationale ??
            `Recorded via iw claims review (${options.decision})`,
          decidedAt: decidedAt.toISOString(),
        },
      );
      const result = new ClaimsReviewStore(database).record({
        claimIdentityId: claim.id,
        basisAssessmentId,
        decision: options.decision,
        actor: options.actor,
        createdAt: decidedAt.getTime(),
      });
      const output = {
        claimIdentityId: claim.id,
        parameterKey: claim.parameter_key,
        claimType: claim.claim_type,
        scope: claim.scope,
        assessmentId: basisAssessmentId,
        portableStatePath,
        ...result,
      };
      console.log(
        options.format === "json"
          ? JSON.stringify(output, null, 2)
          : `Review recorded: ${result.id}\nPortable state: ${portableStatePath}`,
      );
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
  type?: string;
  scope?: string;
  format: string;
}): Promise<void> {
  try {
    const database = claimsDatabase(process.cwd());
    try {
      const claimId = options.claim?.startsWith("candidate:")
        ? promotedClaimForCandidate(database, options.claim)
        : options.claim?.startsWith("claim:")
          ? options.claim
          : null;
      const parameterKey = options.claim && !claimId ? options.claim : null;
      const assessments = database
        .prepare(
          `WITH current_assessments AS (
             SELECT cv.claim_identity_id, ca.id AS assessment_id
             FROM claim_assessments ca
             JOIN claim_versions cv ON cv.id = ca.claim_version_id
             WHERE ca.is_current = 1
           ),
           open_reopens AS (
             SELECT claim_identity_id, basis_assessment_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY claim_identity_id
                      ORDER BY created_at DESC
                    ) AS row_number
             FROM review_decision_reopens
             WHERE status = 'open'
           )
           SELECT ci.id AS claim_identity_id,
                  parameter.canonical_key AS parameter_key,
                  ci.claim_type, ci.scope,
                  ci.identity_contract_id, ci.identity_contract_version,
                  ca.id AS assessment_id, ca.epistemic_status,
                  cv.normalized_statement_json,
                  cv.materiality_contract_id, cv.materiality_contract_version
           FROM claim_identities ci
           LEFT JOIN parameter_identities parameter
             ON parameter.id = ci.parameter_identity_id
           LEFT JOIN current_assessments current_assessment
             ON current_assessment.claim_identity_id = ci.id
           LEFT JOIN open_reopens open_reopen
             ON open_reopen.claim_identity_id = ci.id
            AND open_reopen.row_number = 1
           JOIN claim_assessments ca
             ON ca.id = COALESCE(current_assessment.assessment_id, open_reopen.basis_assessment_id)
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           WHERE ((? IS NULL AND ? IS NULL)
                  OR ci.id = ? OR parameter.canonical_key = ?)
             AND (? IS NULL OR ci.claim_type = ?)
             AND (? IS NULL OR ci.scope = ?)
           ORDER BY parameter.canonical_key, ci.claim_type, ci.scope`,
        )
        .all(
          claimId,
          parameterKey,
          claimId,
          parameterKey,
          options.type ?? null,
          options.type ?? null,
          options.scope ?? null,
          options.scope ?? null,
        ) as Array<{
        claim_identity_id: string;
        parameter_key: string | null;
        claim_type: string;
        scope: string | null;
        identity_contract_id: string | null;
        identity_contract_version: string | null;
        assessment_id: string;
        epistemic_status: string;
        normalized_statement_json: string;
        materiality_contract_id: string | null;
        materiality_contract_version: string | null;
      }>;
      if (options.claim && assessments.length === 0) {
        throw new ClaimsBindingError(
          `No current assessment matches ${options.claim}${options.type ? ` with type ${options.type}` : ""}${options.scope ? ` in scope ${options.scope}` : ""}`,
        );
      }
      const output = assessments.map((assessment) => ({
        claimIdentityId: assessment.claim_identity_id,
        parameterKey: assessment.parameter_key,
        claimType: assessment.claim_type,
        scope: assessment.scope,
        identityContract:
          assessment.identity_contract_id &&
          assessment.identity_contract_version
            ? {
                id: assessment.identity_contract_id,
                version: assessment.identity_contract_version,
              }
            : null,
        materialityContract:
          assessment.materiality_contract_id &&
          assessment.materiality_contract_version
            ? {
                id: assessment.materiality_contract_id,
                version: assessment.materiality_contract_version,
              }
            : null,
        subjects: (
          database
            .prepare(
              `SELECT subject.identity_key, subject.kind, link.subject_role
               FROM claim_subjects link
               JOIN subject_identities subject
                 ON subject.id = link.subject_identity_id
               WHERE link.claim_identity_id = ?
               ORDER BY link.subject_role, subject.identity_key`,
            )
            .all(assessment.claim_identity_id) as Array<{
            identity_key: string;
            kind: string;
            subject_role: string;
          }>
        ).map((subject) => ({
          role: subject.subject_role,
          kind: subject.kind,
          identityKey: subject.identity_key,
        })),
        promotion:
          database
            .prepare(
              `SELECT review.actor_kind, review.actor_id, review.decision,
                    candidate.identity_key AS candidate_identity_key,
                    candidate.observation_fingerprint,
                    policy.policy_id, policy.policy_version,
                    policy.rationale AS policy_rationale
             FROM candidate_reviews review
             JOIN claim_candidates candidate ON candidate.id = review.candidate_id
             LEFT JOIN candidate_policy_decisions policy
               ON policy.candidate_id = review.candidate_id
              AND policy.promoted_claim_identity_id = review.promoted_claim_identity_id
             WHERE review.promoted_claim_identity_id = ?
               AND review.decision = 'promote'
               AND review.effect = 'effective'
             ORDER BY candidate.version_ordinal DESC, review.created_at DESC
             LIMIT 1`,
            )
            .get(assessment.claim_identity_id) ?? null,
        assessmentId: assessment.assessment_id,
        status: assessment.epistemic_status,
        statement: JSON.parse(assessment.normalized_statement_json),
        dependencies: (
          database
            .prepare(
              `SELECT dependency.dependency_kind,
                      dependency.dependency_version_id,
                      dependency.epistemic_role,
                      dependency.warrant_polarity,
                      dependency.assessment_effect,
                      rule.normalized_status AS rule_status,
                      rule.normalized_output_json AS rule_output_json,
                      rule.normalized_reasons_json AS rule_reasons_json,
                      rule.rule_contract_version,
                      rule.implementation_fingerprint
               FROM claim_assessment_dependencies dependency
               LEFT JOIN rule_result_versions rule
                 ON dependency.dependency_kind = 'rule_result_version'
                AND rule.id = dependency.dependency_version_id
               WHERE dependency.claim_assessment_id = ?`,
            )
            .all(assessment.assessment_id) as Array<{
            dependency_kind: string;
            dependency_version_id: string;
            epistemic_role: string;
            warrant_polarity: string | null;
            assessment_effect: string;
            rule_status: string | null;
            rule_output_json: string | null;
            rule_reasons_json: string | null;
            rule_contract_version: string | null;
            implementation_fingerprint: string | null;
          }>
        ).map((dependency) => ({
          dependency_kind: dependency.dependency_kind,
          dependency_version_id: dependency.dependency_version_id,
          epistemic_role: dependency.epistemic_role,
          warrant_polarity: dependency.warrant_polarity,
          assessment_effect: dependency.assessment_effect,
          rule_status: dependency.rule_status,
          rule_output: dependency.rule_output_json
            ? JSON.parse(dependency.rule_output_json)
            : null,
          rule_reasons: dependency.rule_reasons_json
            ? JSON.parse(dependency.rule_reasons_json)
            : null,
          rule_contract_version: dependency.rule_contract_version,
          implementation_fingerprint: dependency.implementation_fingerprint,
        })),
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
          console.log(
            `${claim.claimType}${claim.scope ? ` (${claim.scope})` : ""}: ${claim.status}`,
          );
          if (claim.parameterKey) {
            console.log(`  Parameter: ${claim.parameterKey}`);
          }
          for (const subject of claim.subjects) {
            console.log(
              `  Subject: ${subject.role}=${subject.identityKey} (${subject.kind})`,
            );
          }
          if (claim.identityContract) {
            console.log(
              `  Identity contract: ${claim.identityContract.id}@${claim.identityContract.version}`,
            );
          }
          if (claim.materialityContract) {
            console.log(
              `  Materiality contract: ${claim.materialityContract.id}@${claim.materialityContract.version}`,
            );
          }
          if (claim.promotion) {
            const promotion = claim.promotion as {
              actor_kind: string;
              actor_id: string;
              candidate_identity_key: string;
              policy_id: string | null;
              policy_version: string | null;
            };
            console.log(
              `  Promoted from: ${promotion.candidate_identity_key} by ${
                promotion.policy_id && promotion.policy_version
                  ? `policy ${promotion.policy_id}@${promotion.policy_version}`
                  : `${promotion.actor_kind}:${promotion.actor_id}`
              }`,
            );
          }
          console.log(`  Statement: ${JSON.stringify(claim.statement)}`);
          console.log(`  Claim: ${claim.claimIdentityId}`);
          console.log(`  Assessment: ${claim.assessmentId}`);
          for (const dependency of claim.dependencies as Array<{
            dependency_kind: string;
            dependency_version_id: string;
            rule_status: string | null;
            rule_reasons: string[] | null;
          }>) {
            if (!dependency.rule_status) continue;
            console.log(
              `  Rule result: ${dependency.rule_status} (${dependency.dependency_version_id})`,
            );
            for (const reason of dependency.rule_reasons ?? []) {
              console.log(`    Reason: ${reason}`);
            }
          }
          if (claim.review) {
            console.log(
              `  Review: ${(claim.review as { decision: string }).decision}`,
            );
          }
          for (const reopen of claim.reopens as Array<{
            reason: string;
            status: string;
            dependency_kind: string;
            dependency_version_id: string;
            secondary_provenance_json: string | null;
          }>) {
            console.log(`  Reopen: ${reopen.reason} (${reopen.status})`);
            console.log(
              `    Dependency: ${reopen.dependency_kind}:${reopen.dependency_version_id}`,
            );
            if (reopen.secondary_provenance_json) {
              console.log(
                `    Provenance: ${reopen.secondary_provenance_json}`,
              );
            }
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

const claimsCandidatesCommand = new Command("candidates")
  .description("Triage and govern discovered Claim Candidates")
  .addCommand(
    new Command("list")
      .description("List the current Candidate inbox")
      .option("--state <state>", "Restrict by Candidate state")
      .option("--subject-kind <kind>", "Restrict by Subject kind")
      .option("--all", "Include promoted and closed Candidates")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsCandidatesList),
  )
  .addCommand(
    new Command("triage")
      .description("Move deterministic Candidates into the reviewable inbox")
      .option("--candidate <id>", "Restrict triage to one current Candidate")
      .option("--subject-kind <kind>", "Restrict by Subject kind")
      .option("--claim-type <type>", "Restrict by proposed Claim type")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsCandidatesTriage),
  )
  .addCommand(
    new Command("review")
      .description("Record an effective human Candidate decision")
      .requiredOption("--candidate <id>", "Current triaged Candidate ID")
      .requiredOption("--actor <name>", "Decision actor")
      .requiredOption(
        "--decision <decision>",
        "promote, reject, suppress, or defer",
      )
      .requiredOption("--rationale <text>", "Reason for the decision")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsCandidateReview),
  );

export const claimsCommand = new Command("claims")
  .description("Discover, assess, explain, and review repository claims")
  .addCommand(
    new Command("discover")
      .description(
        "Persist deterministic findings as Candidates without activating Claims",
      )
      .option("--all", "Include low-confidence and annotation-only Candidates")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsDiscover),
  )
  .addCommand(claimsCandidatesCommand)
  .addCommand(
    new Command("check")
      .description(
        "Discover and evaluate claims, optionally for a registered scope",
      )
      .option("--scope <scope>", "Registered scope to evaluate")
      .option(
        "--since <ref>",
        "Compare immutable HEAD evidence with the merge-base of a Git ref",
      )
      .option(
        "--refresh",
        "Reconcile current auto-discovered claims and retire stale entries",
      )
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsCheck),
  )
  .addCommand(
    new Command("review")
      .description(
        "Record a human decision against a claim's current assessment",
      )
      .requiredOption(
        "--claim <claimIdentityIdOrParameterKey>",
        "Claim identity ID or canonical parameter key",
      )
      .option("--type <claimType>", "Claim type used to resolve a parameter")
      .option("--scope <scope>", "Claim scope used to resolve a parameter")
      .requiredOption("--actor <name>", "Review decision actor")
      .requiredOption("--decision <decision>", "Review disposition")
      .option("--rationale <text>", "Reason for the review decision")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsReview),
  )
  .addCommand(
    new Command("explain")
      .description(
        "Show current claims with their versioned dependencies and reopens",
      )
      .option(
        "--claim <claimIdentityIdOrParameterKey>",
        "Restrict explanation by claim identity or canonical parameter key",
      )
      .option("--type <claimType>", "Restrict explanation to one claim type")
      .option("--scope <scope>", "Restrict explanation to one claim scope")
      .option("-f, --format <format>", "Output format: text or json", "text")
      .action(runClaimsExplain),
  );
