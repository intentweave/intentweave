// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import { fingerprint } from "./canonical.js";

export const SUBJECT_IDENTITY_CONTRACT_VERSION = "1" as const;

export type SubjectKind = "parameter" | "symbol" | "module" | "endpoint";

const SUBJECT_KINDS: readonly SubjectKind[] = [
  "parameter",
  "symbol",
  "module",
  "endpoint",
];

export interface SubjectIdentityV1 {
  id: string;
  kind: SubjectKind;
  identityKey: string;
  displayName: string;
  lifecycleState: "active" | "retired";
  contractVersion: typeof SUBJECT_IDENTITY_CONTRACT_VERSION;
}

export interface SubjectImpactAssessment {
  claimIdentityId: string;
  assessmentId: string;
}

/** Map a legacy ParameterIdentity to its deterministic G1 SubjectIdentity. */
export function parameterSubjectIdentity(
  parameterKey: string,
): SubjectIdentityV1 {
  if (parameterKey.trim().length === 0) {
    throw new Error("Parameter Subject identity requires a non-empty key");
  }
  return subjectIdentity(
    "parameter",
    `parameter:${parameterKey}`,
    parameterKey,
  );
}

/**
 * Deterministic SubjectIdentityV1 for any G1-reserved Subject kind.
 * Paths, spans, symbols, and local database ordinals are not valid inputs.
 */
export function subjectIdentity(
  kind: SubjectKind,
  identityKey: string,
  displayName?: string,
): SubjectIdentityV1 {
  if (!SUBJECT_KINDS.includes(kind)) {
    throw new Error(`Subject kind ${kind} is not reserved in G1`);
  }
  if (identityKey.trim().length === 0) {
    throw new Error(`Subject identity requires a non-empty identity key`);
  }
  if (!identityKey.startsWith(`${kind}:`)) {
    throw new Error(`Subject identity key must be namespaced as ${kind}:<key>`);
  }
  return {
    id: `subject:${fingerprint(identityKey)}`,
    kind,
    identityKey,
    displayName: displayName ?? identityKey,
    lifecycleState: "active",
    contractVersion: SUBJECT_IDENTITY_CONTRACT_VERSION,
  };
}

function affectedCurrentAssessments(
  db: Database.Database,
  subjectIdentityIds: readonly string[],
): SubjectImpactAssessment[] {
  if (subjectIdentityIds.length === 0) return [];
  const placeholders = subjectIdentityIds.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `SELECT DISTINCT link.claim_identity_id, assessment.id AS assessment_id
         FROM claim_subjects link
         JOIN claim_versions version
           ON version.claim_identity_id = link.claim_identity_id
         JOIN claim_assessments assessment
           ON assessment.claim_version_id = version.id
          AND assessment.is_current = 1
         WHERE link.subject_identity_id IN (${placeholders})
         ORDER BY link.claim_identity_id, assessment.id`,
      )
      .all(...subjectIdentityIds) as Array<{
      claim_identity_id: string;
      assessment_id: string;
    }>
  ).map((row) => ({
    claimIdentityId: row.claim_identity_id,
    assessmentId: row.assessment_id,
  }));
}

/** Resolve current Assessments directly linked to a changed Subject identity. */
export function affectedCurrentAssessmentsForSubject(
  db: Database.Database,
  subjectIdentityId: string,
): SubjectImpactAssessment[] {
  return affectedCurrentAssessments(db, [subjectIdentityId]);
}

/** Resolve current Assessments through a changed persisted Subject alias. */
export function affectedCurrentAssessmentsForSubjectAlias(
  db: Database.Database,
  aliasKind: string,
  aliasKey: string,
): SubjectImpactAssessment[] {
  const alias = db
    .prepare(
      `SELECT subject_identity_id FROM subject_aliases
       WHERE alias_kind = ? AND alias_key = ?`,
    )
    .get(aliasKind, aliasKey) as { subject_identity_id: string } | undefined;
  return alias
    ? affectedCurrentAssessments(db, [alias.subject_identity_id])
    : [];
}

/** Resolve current Assessments at both ends of a changed continuity record. */
export function affectedCurrentAssessmentsForSubjectContinuity(
  db: Database.Database,
  continuityId: string,
): SubjectImpactAssessment[] {
  const continuity = db
    .prepare(
      `SELECT from_subject_identity_id, to_subject_identity_id
       FROM subject_continuity WHERE id = ?`,
    )
    .get(continuityId) as
    | {
        from_subject_identity_id: string;
        to_subject_identity_id: string;
      }
    | undefined;
  return continuity
    ? affectedCurrentAssessments(db, [
        continuity.from_subject_identity_id,
        continuity.to_subject_identity_id,
      ])
    : [];
}
