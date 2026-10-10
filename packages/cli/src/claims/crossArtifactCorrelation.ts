// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  fingerprint,
  type CandidateConfidence,
  type CandidateDetails,
  type CandidateState,
  type SubjectKind,
} from "@intentweave/index";

export const CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION =
  "cross-artifact-correlation@1" as const;
export const CROSS_ARTIFACT_CORRELATION_ADAPTER_ID =
  "cari-cross-artifact-cohort";

export type CrossArtifactFamily =
  | "code"
  | "configuration"
  | "documentation"
  | "adr"
  | "architecture-rule"
  | "endpoint";

export interface CrossArtifactCandidateReference {
  id: string;
  identityKey: string;
  candidateKind: string;
  proposedClaimType: string;
  state: CandidateState;
  confidence: CandidateConfidence;
  artifactFamilies: CrossArtifactFamily[];
  sourceKinds: string[];
  evidenceVersionIds: string[];
}

export interface CrossArtifactContinuityReference {
  id: string;
  basis: string;
  confidence: string;
  fromSubjectIdentityKey: string;
  toSubjectIdentityKey: string;
}

export interface CrossArtifactCohort {
  contractVersion: typeof CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION;
  cohortFingerprint: string;
  subjectIdentityKeys: string[];
  subjectKinds: SubjectKind[];
  candidateIdentityKeys: string[];
  candidates: CrossArtifactCandidateReference[];
  artifactFamilies: CrossArtifactFamily[];
  evidenceVersionIds: string[];
  continuity: CrossArtifactContinuityReference[];
}

interface SubjectRow {
  id: string;
  identity_key: string;
  kind: SubjectKind;
}

interface ContinuityRow {
  id: string;
  from_subject_identity_id: string;
  to_subject_identity_id: string;
  basis: string;
  confidence: string;
}

interface EligibleCandidate {
  candidate: CandidateDetails;
  subjectIds: string[];
  subjectIdentityKeys: string[];
  subjectKinds: SubjectKind[];
  artifactFamilies: CrossArtifactFamily[];
  sourceKinds: string[];
  evidenceVersionIds: string[];
}

interface CohortAccumulator {
  subjectIds: Set<string>;
  candidates: Map<string, CrossArtifactCandidateReference>;
}

const FAMILY_ORDER: readonly CrossArtifactFamily[] = [
  "code",
  "configuration",
  "documentation",
  "adr",
  "architecture-rule",
  "endpoint",
];

export function crossArtifactFamilyForSourceKind(
  sourceKind: string,
): CrossArtifactFamily | undefined {
  if (
    sourceKind === "code-symbol" ||
    sourceKind === "code-documentation" ||
    sourceKind === "code-definition" ||
    sourceKind === "code-default" ||
    sourceKind === "code-annotation"
  ) {
    return "code";
  }
  if (
    sourceKind === "config" ||
    sourceKind === "scope-registry" ||
    sourceKind === "framework-configuration"
  ) {
    return "configuration";
  }
  if (
    sourceKind === "documentation" ||
    sourceKind === "documentation-reference" ||
    sourceKind === "security-documentation"
  ) {
    return "documentation";
  }
  if (sourceKind === "adr" || sourceKind.startsWith("adr-")) return "adr";
  if (sourceKind.startsWith("architecture-")) return "architecture-rule";
  if (
    sourceKind === "framework-route" ||
    sourceKind === "route-handler" ||
    sourceKind === "endpoint-handler" ||
    sourceKind === "authentication-guard"
  ) {
    return "endpoint";
  }
  return undefined;
}

function sortFamilies(
  families: Iterable<CrossArtifactFamily>,
): CrossArtifactFamily[] {
  const order = new Map(FAMILY_ORDER.map((family, index) => [family, index]));
  return [...new Set(families)].sort(
    (left, right) => order.get(left)! - order.get(right)!,
  );
}

function findRoot(parent: Map<string, string>, value: string): string {
  const current = parent.get(value);
  if (!current || current === value) return value;
  const root = findRoot(parent, current);
  parent.set(value, root);
  return root;
}

function union(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = findRoot(parent, left);
  const rightRoot = findRoot(parent, right);
  if (leftRoot === rightRoot) return;
  if (leftRoot.localeCompare(rightRoot) < 0) {
    parent.set(rightRoot, leftRoot);
  } else {
    parent.set(leftRoot, rightRoot);
  }
}

function eligibleCandidates(
  database: Database.Database,
  subjectsByKey: ReadonlyMap<string, SubjectRow>,
  evidenceIds: ReadonlySet<string>,
): EligibleCandidate[] {
  return new CandidateStore(database)
    .listCurrent()
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey))
    .flatMap((candidate): EligibleCandidate[] => {
      if (candidate.evidence.length === 0 || candidate.subjects.length === 0) {
        return [];
      }
      const evidenceVersionIds = candidate.evidence.flatMap((evidence) =>
        evidence.evidenceVersionId ? [evidence.evidenceVersionId] : [],
      );
      if (
        evidenceVersionIds.length !== candidate.evidence.length ||
        evidenceVersionIds.some(
          (evidenceVersionId) => !evidenceIds.has(evidenceVersionId),
        )
      ) {
        return [];
      }
      const subjectRows = candidate.subjects.map((subject) =>
        subjectsByKey.get(subject.identityKey),
      );
      if (subjectRows.some((subject): subject is undefined => !subject)) {
        return [];
      }
      const artifactFamilies = sortFamilies(
        candidate.evidence.flatMap((evidence) => {
          const family = crossArtifactFamilyForSourceKind(evidence.sourceKind);
          return family ? [family] : [];
        }),
      );
      if (artifactFamilies.length === 0) return [];
      return [
        {
          candidate,
          subjectIds: subjectRows.map((subject) => subject!.id),
          subjectIdentityKeys: subjectRows.map(
            (subject) => subject!.identity_key,
          ),
          subjectKinds: subjectRows.map((subject) => subject!.kind),
          artifactFamilies,
          sourceKinds: [
            ...new Set(
              candidate.evidence.map((evidence) => evidence.sourceKind),
            ),
          ].sort(),
          evidenceVersionIds: [...evidenceVersionIds].sort(),
        },
      ];
    });
}

export function discoverCrossArtifactCohorts(
  database: Database.Database,
  options: {
    limit?: number;
    minimumCandidates?: number;
    minimumArtifactFamilies?: number;
  } = {},
): CrossArtifactCohort[] {
  const limit = options.limit ?? 20;
  const minimumCandidates = options.minimumCandidates ?? 2;
  const minimumArtifactFamilies = options.minimumArtifactFamilies ?? 2;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Cross-artifact cohort limit must be a positive integer");
  }
  if (!Number.isInteger(minimumCandidates) || minimumCandidates < 2) {
    throw new Error(
      "Cross-artifact cohorts require at least two Candidate identities",
    );
  }
  if (
    !Number.isInteger(minimumArtifactFamilies) ||
    minimumArtifactFamilies < 2
  ) {
    throw new Error(
      "Cross-artifact cohorts require at least two artifact families",
    );
  }

  const subjectRows = database
    .prepare(
      `SELECT id, identity_key, kind
       FROM subject_identities ORDER BY identity_key`,
    )
    .all() as SubjectRow[];
  const subjectsByKey = new Map(
    subjectRows.map((subject) => [subject.identity_key, subject]),
  );
  const evidenceRows = database
    .prepare(`SELECT id FROM evidence_versions ORDER BY id`)
    .all() as Array<{ id: string }>;
  const eligible = eligibleCandidates(
    database,
    subjectsByKey,
    new Set(evidenceRows.map((evidence) => evidence.id)),
  );
  if (eligible.length < minimumCandidates) return [];

  const parent = new Map<string, string>();
  for (const candidate of eligible) {
    for (const subjectId of candidate.subjectIds) {
      parent.set(subjectId, subjectId);
    }
  }
  const continuityRows = database
    .prepare(
      `SELECT id, from_subject_identity_id, to_subject_identity_id,
              basis, confidence
       FROM subject_continuity
       ORDER BY id`,
    )
    .all() as ContinuityRow[];
  for (const continuity of continuityRows) {
    if (
      parent.has(continuity.from_subject_identity_id) &&
      parent.has(continuity.to_subject_identity_id)
    ) {
      union(
        parent,
        continuity.from_subject_identity_id,
        continuity.to_subject_identity_id,
      );
    }
  }

  const cohorts = new Map<string, CohortAccumulator>();
  for (const eligibleCandidate of eligible) {
    const reference: CrossArtifactCandidateReference = {
      id: eligibleCandidate.candidate.id,
      identityKey: eligibleCandidate.candidate.identityKey,
      candidateKind: eligibleCandidate.candidate.candidateKind,
      proposedClaimType: eligibleCandidate.candidate.proposedClaimType,
      state: eligibleCandidate.candidate.state,
      confidence: eligibleCandidate.candidate.confidence,
      artifactFamilies: eligibleCandidate.artifactFamilies,
      sourceKinds: eligibleCandidate.sourceKinds,
      evidenceVersionIds: eligibleCandidate.evidenceVersionIds,
    };
    for (const subjectId of eligibleCandidate.subjectIds) {
      const root = findRoot(parent, subjectId);
      const cohort = cohorts.get(root) ?? {
        subjectIds: new Set<string>(),
        candidates: new Map<string, CrossArtifactCandidateReference>(),
      };
      for (const candidateSubjectId of eligibleCandidate.subjectIds) {
        if (findRoot(parent, candidateSubjectId) === root) {
          cohort.subjectIds.add(candidateSubjectId);
        }
      }
      cohort.candidates.set(reference.identityKey, reference);
      cohorts.set(root, cohort);
    }
  }

  return [...cohorts.values()]
    .map((cohort): CrossArtifactCohort | undefined => {
      const candidates = [...cohort.candidates.values()].sort((left, right) =>
        left.identityKey.localeCompare(right.identityKey),
      );
      const artifactFamilies = sortFamilies(
        candidates.flatMap((candidate) => candidate.artifactFamilies),
      );
      if (
        candidates.length < minimumCandidates ||
        artifactFamilies.length < minimumArtifactFamilies
      ) {
        return undefined;
      }
      const subjectIdentityKeys = [...cohort.subjectIds]
        .map((subjectId) =>
          subjectRows.find((subject) => subject.id === subjectId),
        )
        .filter((subject): subject is SubjectRow => Boolean(subject))
        .map((subject) => subject.identity_key)
        .sort();
      const subjectKinds = [
        ...new Set(
          subjectIdentityKeys.flatMap((identityKey) => {
            const subject = subjectsByKey.get(identityKey);
            return subject ? [subject.kind] : [];
          }),
        ),
      ].sort();
      const continuity = continuityRows
        .filter(
          (row) =>
            cohort.subjectIds.has(row.from_subject_identity_id) &&
            cohort.subjectIds.has(row.to_subject_identity_id),
        )
        .map((row) => ({
          id: row.id,
          basis: row.basis,
          confidence: row.confidence,
          fromSubjectIdentityKey:
            subjectRows.find(
              (subject) => subject.id === row.from_subject_identity_id,
            )?.identity_key ?? row.from_subject_identity_id,
          toSubjectIdentityKey:
            subjectRows.find(
              (subject) => subject.id === row.to_subject_identity_id,
            )?.identity_key ?? row.to_subject_identity_id,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const evidenceVersionIds = [
        ...new Set(
          candidates.flatMap((candidate) => candidate.evidenceVersionIds),
        ),
      ].sort();
      const cohortFingerprint = fingerprint({
        subjectIdentityKeys,
        candidateIdentityKeys: candidates.map(
          (candidate) => candidate.identityKey,
        ),
        artifactFamilies,
        evidenceVersionIds,
        continuity: continuity.map((item) => item.id),
      });
      return {
        contractVersion: CROSS_ARTIFACT_CORRELATION_CONTRACT_VERSION,
        cohortFingerprint,
        subjectIdentityKeys,
        subjectKinds,
        candidateIdentityKeys: candidates.map(
          (candidate) => candidate.identityKey,
        ),
        candidates,
        artifactFamilies,
        evidenceVersionIds,
        continuity,
      };
    })
    .filter((cohort): cohort is CrossArtifactCohort => Boolean(cohort))
    .sort((left, right) =>
      left.cohortFingerprint.localeCompare(right.cohortFingerprint),
    )
    .slice(0, limit);
}
