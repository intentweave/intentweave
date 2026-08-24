// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  assessmentKey,
  canonicalJson,
  fingerprint,
  ruleResultFingerprint,
} from "./canonical.js";
import type {
  PersistClaimAssessmentInput,
  PersistEvidenceContinuityInput,
  PersistEvidenceInput,
  PersistGenericEvidenceInput,
  PersistGenericClaimAssessmentInput,
  PersistSubjectAliasInput,
  PersistSubjectContinuityInput,
  PersistedAssessment,
  PersistedSubjectContinuity,
  PersistedVersion,
  PersistRuleResultInput,
} from "./types.js";
import { parameterSubjectIdentity, subjectIdentity } from "./subjects.js";

function idFor(kind: string, identityKey: string): string {
  return `${kind}:${fingerprint(identityKey)}`;
}

function persistParameterSubject(
  db: Database.Database,
  parameterKey: string,
  now: number,
): { parameterId: string; subjectId: string } {
  const parameterId = idFor("parameter", parameterKey);
  const subject = parameterSubjectIdentity(parameterKey);
  db.prepare(
    `INSERT OR IGNORE INTO subject_identities (
       id, kind, identity_key, display_name, lifecycle_state,
       contract_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    subject.id,
    subject.kind,
    subject.identityKey,
    subject.displayName,
    subject.lifecycleState,
    subject.contractVersion,
    now,
  );
  db.prepare(
    `INSERT OR IGNORE INTO subject_aliases (
       subject_identity_id, alias_kind, alias_key, created_at
     ) VALUES (?, 'parameter-key', ?, ?)`,
  ).run(subject.id, parameterKey, now);
  db.prepare(
    `INSERT INTO parameter_identities (
       id, canonical_key, subject_identity_id, created_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       subject_identity_id = COALESCE(parameter_identities.subject_identity_id, excluded.subject_identity_id)`,
  ).run(parameterId, parameterKey, subject.id, now);
  return { parameterId, subjectId: subject.id };
}

function nextOrdinal(
  db: Database.Database,
  table:
    | "evidence_versions"
    | "rule_result_versions"
    | "claim_versions"
    | "subject_continuity",
  identityColumn:
    | "evidence_identity_id"
    | "rule_result_identity_id"
    | "claim_identity_id"
    | "continuity_identity_key",
  identityId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(version_ordinal), 0) AS max_ordinal
       FROM ${table} WHERE ${identityColumn} = ?`,
    )
    .get(identityId) as { max_ordinal: number };
  return row.max_ordinal + 1;
}

const REOBSERVED_MARKER = "#reobserved:";

function logicalFingerprint(value: string): string {
  return value.split(REOBSERVED_MARKER, 1)[0] ?? value;
}

function reobservedFingerprint(value: string, ordinal: number): string {
  return `${value}${REOBSERVED_MARKER}${ordinal}`;
}

export class ClaimsStore {
  constructor(private readonly db: Database.Database) {}

  persistEvidence(input: PersistEvidenceInput): PersistedVersion {
    const persist = this.db.transaction(() => {
      const now = Date.now();
      const { parameterId, subjectId } = persistParameterSubject(
        this.db,
        input.parameterKey,
        now,
      );

      const evidenceIdentityId = idFor("evidence", input.identityKey);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO evidence_identities
             (id, parameter_identity_id, source_kind, identity_key, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          evidenceIdentityId,
          parameterId,
          input.sourceKind,
          input.identityKey,
          now,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO evidence_subjects (
             evidence_identity_id, subject_identity_id, subject_role,
             basis, confidence, created_at
           ) VALUES (?, ?, 'subject', 'parameter-compatibility', 'certain', ?)`,
        )
        .run(evidenceIdentityId, subjectId, now);

      const versions = this.db
        .prepare(
          `SELECT id, version_ordinal, fingerprint FROM evidence_versions
           WHERE evidence_identity_id = ? ORDER BY version_ordinal DESC`,
        )
        .all(evidenceIdentityId) as Array<{
        id: string;
        version_ordinal: number;
        fingerprint: string;
      }>;
      const current = versions[0];
      if (
        current &&
        logicalFingerprint(current.fingerprint) === input.fingerprint
      ) {
        return {
          id: current.id,
          ordinal: current.version_ordinal,
          created: false,
        };
      }
      const returning = versions.find(
        (version) =>
          logicalFingerprint(version.fingerprint) === input.fingerprint,
      );

      const ordinal = nextOrdinal(
        this.db,
        "evidence_versions",
        "evidence_identity_id",
        evidenceIdentityId,
      );
      const id = `${evidenceIdentityId}@${ordinal}`;
      const storedFingerprint = returning
        ? reobservedFingerprint(input.fingerprint, ordinal)
        : input.fingerprint;
      this.db
        .prepare(
          `INSERT INTO evidence_versions (
             id, evidence_identity_id, version_ordinal, fingerprint, material_fingerprint,
             normalized_value, semantic_location, file_path, symbol_id,
             span_start_line, span_end_line, repository_revision, provenance_json, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          evidenceIdentityId,
          ordinal,
          storedFingerprint,
          input.materialFingerprint,
          canonicalJson(input.normalizedValue),
          input.semanticLocation,
          input.filePath ?? null,
          input.symbolId ?? null,
          input.spanStartLine ?? null,
          input.spanEndLine ?? null,
          input.repositoryRevision ?? null,
          canonicalJson(input.provenance),
          now,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO parameter_evidence_bindings
             (id, parameter_identity_id, evidence_version_id, basis, confidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${parameterId}:${id}`,
          parameterId,
          id,
          input.bindingBasis ?? "explicit",
          input.bindingConfidence ?? "certain",
          now,
        );

      return { id, ordinal, created: true };
    });

    return persist();
  }

  persistGenericEvidence(input: PersistGenericEvidenceInput): PersistedVersion {
    if (input.subjects.length === 0) {
      throw new Error("Generic Evidence requires at least one Subject");
    }
    const persist = this.db.transaction(() => {
      const now = Date.now();
      const evidenceIdentityId = idFor("evidence", input.identityKey);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO evidence_identities
             (id, parameter_identity_id, source_kind, identity_key, created_at)
           VALUES (?, NULL, ?, ?, ?)`,
        )
        .run(evidenceIdentityId, input.sourceKind, input.identityKey, now);
      for (const subjectInput of input.subjects) {
        const subject = subjectIdentity(
          subjectInput.kind,
          subjectInput.identityKey,
          subjectInput.displayName,
        );
        this.db
          .prepare(
            `INSERT OR IGNORE INTO subject_identities (
               id, kind, identity_key, display_name, lifecycle_state,
               contract_version, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            subject.id,
            subject.kind,
            subject.identityKey,
            subject.displayName,
            subject.lifecycleState,
            subject.contractVersion,
            now,
          );
        this.db
          .prepare(
            `INSERT OR IGNORE INTO evidence_subjects (
               evidence_identity_id, subject_identity_id, subject_role,
               basis, confidence, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evidenceIdentityId,
            subject.id,
            subjectInput.role,
            subjectInput.basis,
            subjectInput.confidence,
            now,
          );
      }

      const versions = this.db
        .prepare(
          `SELECT id, version_ordinal, fingerprint FROM evidence_versions
           WHERE evidence_identity_id = ? ORDER BY version_ordinal DESC`,
        )
        .all(evidenceIdentityId) as Array<{
        id: string;
        version_ordinal: number;
        fingerprint: string;
      }>;
      const current = versions[0];
      if (
        current &&
        logicalFingerprint(current.fingerprint) === input.fingerprint
      ) {
        return {
          id: current.id,
          ordinal: current.version_ordinal,
          created: false,
        };
      }
      const returning = versions.find(
        (version) =>
          logicalFingerprint(version.fingerprint) === input.fingerprint,
      );
      const ordinal = nextOrdinal(
        this.db,
        "evidence_versions",
        "evidence_identity_id",
        evidenceIdentityId,
      );
      const id = `${evidenceIdentityId}@${ordinal}`;
      const storedFingerprint = returning
        ? reobservedFingerprint(input.fingerprint, ordinal)
        : input.fingerprint;
      this.db
        .prepare(
          `INSERT INTO evidence_versions (
             id, evidence_identity_id, version_ordinal, fingerprint,
             material_fingerprint, normalized_value, semantic_location,
             file_path, symbol_id, span_start_line, span_end_line,
             repository_revision, provenance_json, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          evidenceIdentityId,
          ordinal,
          storedFingerprint,
          input.materialFingerprint,
          canonicalJson(input.normalizedValue),
          input.semanticLocation,
          input.filePath ?? null,
          input.symbolId ?? null,
          input.spanStartLine ?? null,
          input.spanEndLine ?? null,
          input.repositoryRevision ?? null,
          canonicalJson(input.provenance),
          now,
        );
      return { id, ordinal, created: true };
    });
    return persist();
  }

  persistEvidenceContinuity(input: PersistEvidenceContinuityInput): boolean {
    const persist = this.db.transaction(() => {
      const id = `continuity:${fingerprint({
        fromEvidenceVersionId: input.fromEvidenceVersionId,
        toEvidenceVersionId: input.toEvidenceVersionId,
        basis: input.basis,
      })}`;
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO evidence_continuity (
             id, from_evidence_version_id, to_evidence_version_id,
             basis, confidence, provenance_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.fromEvidenceVersionId,
          input.toEvidenceVersionId,
          input.basis,
          input.confidence,
          canonicalJson(input.provenance),
          Date.now(),
        );
      if (result.changes === 0) return false;

      const predecessor = this.db
        .prepare(
          `SELECT id FROM parameter_evidence_bindings WHERE evidence_version_id = ?`,
        )
        .get(input.fromEvidenceVersionId) as { id: string } | undefined;
      if (predecessor) {
        this.db
          .prepare(
            `UPDATE parameter_evidence_bindings
             SET predecessor_binding_id = ? WHERE evidence_version_id = ?`,
          )
          .run(predecessor.id, input.toEvidenceVersionId);
      }
      return true;
    });

    return persist();
  }

  persistSubjectAlias(input: PersistSubjectAliasInput): boolean {
    if (
      input.aliasKind.trim().length === 0 ||
      input.aliasKey.trim().length === 0
    ) {
      throw new Error("A Subject alias requires a non-empty kind and key");
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO subject_aliases (
           subject_identity_id, alias_kind, alias_key, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.subjectIdentityId,
        input.aliasKind,
        input.aliasKey,
        Date.now(),
      );
    if (result.changes !== 0) return true;
    const existing = this.db
      .prepare(
        `SELECT subject_identity_id FROM subject_aliases
         WHERE alias_kind = ? AND alias_key = ?`,
      )
      .get(input.aliasKind, input.aliasKey) as
      | { subject_identity_id: string }
      | undefined;
    if (existing?.subject_identity_id !== input.subjectIdentityId) {
      throw new Error(
        `Subject alias ${input.aliasKind}:${input.aliasKey} already belongs to another Subject`,
      );
    }
    return false;
  }

  persistSubjectContinuity(
    input: PersistSubjectContinuityInput,
  ): PersistedSubjectContinuity {
    if (input.fromSubjectIdentityId === input.toSubjectIdentityId) {
      throw new Error("Subject continuity requires two different identities");
    }
    if (
      input.basis.trim().length === 0 ||
      input.confidence.trim().length === 0
    ) {
      throw new Error(
        "Subject continuity requires a non-empty basis and confidence",
      );
    }
    const identityKey = canonicalJson({
      fromSubjectIdentityId: input.fromSubjectIdentityId,
      toSubjectIdentityId: input.toSubjectIdentityId,
      basis: input.basis,
    });
    const observationFingerprint = fingerprint({
      confidence: input.confidence,
      provenance: input.provenance,
    });
    const persist = this.db.transaction(() => {
      const versions = this.db
        .prepare(
          `SELECT id, version_ordinal, fingerprint
           FROM subject_continuity
           WHERE continuity_identity_key = ?
           ORDER BY version_ordinal DESC`,
        )
        .all(identityKey) as Array<{
        id: string;
        version_ordinal: number;
        fingerprint: string;
      }>;
      const current = versions[0];
      if (
        current &&
        logicalFingerprint(current.fingerprint) === observationFingerprint
      ) {
        return {
          id: current.id,
          ordinal: current.version_ordinal,
          created: false,
        };
      }
      const ordinal = nextOrdinal(
        this.db,
        "subject_continuity",
        "continuity_identity_key",
        identityKey,
      );
      const returning = versions.some(
        (version) =>
          logicalFingerprint(version.fingerprint) === observationFingerprint,
      );
      const storedFingerprint = returning
        ? reobservedFingerprint(observationFingerprint, ordinal)
        : observationFingerprint;
      const id = `subject-continuity:${fingerprint(identityKey)}@${ordinal}`;
      this.db
        .prepare(
          `INSERT INTO subject_continuity (
             id, continuity_identity_key, version_ordinal, fingerprint,
             from_subject_identity_id, to_subject_identity_id,
             basis, confidence, provenance_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          identityKey,
          ordinal,
          storedFingerprint,
          input.fromSubjectIdentityId,
          input.toSubjectIdentityId,
          input.basis,
          input.confidence,
          canonicalJson(input.provenance),
          Date.now(),
        );
      return { id, ordinal, created: true };
    });
    return persist();
  }

  persistRuleResult(
    input: PersistRuleResultInput,
    evidenceVersionIds: string[],
  ): PersistedVersion {
    const persist = this.db.transaction(() => {
      const now = Date.now();
      const identityKey = [
        input.ruleId,
        input.subjectKey ?? "",
        input.scope ?? "",
      ].join(":");
      const identityId = idFor("rule-result", identityKey);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO rule_result_identities
             (id, rule_id, scope, identity_key, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(identityId, input.ruleId, input.scope ?? null, identityKey, now);

      const resultFingerprint = ruleResultFingerprint({
        applicability: input.applicability,
        normalizedStatus: input.normalizedStatus,
        normalizedOutput: input.normalizedOutput,
        normalizedReasons: input.normalizedReasons,
        evidenceVersionIds,
        ruleContractVersion: input.ruleContractVersion,
        implementationFingerprint: input.implementationFingerprint,
      });
      const versions = this.db
        .prepare(
          `SELECT id, version_ordinal, fingerprint FROM rule_result_versions
           WHERE rule_result_identity_id = ? ORDER BY version_ordinal DESC`,
        )
        .all(identityId) as Array<{
        id: string;
        version_ordinal: number;
        fingerprint: string;
      }>;
      const current = versions[0];
      if (
        current &&
        logicalFingerprint(current.fingerprint) === resultFingerprint
      ) {
        return {
          id: current.id,
          ordinal: current.version_ordinal,
          created: false,
        };
      }
      const returning = versions.find(
        (version) =>
          logicalFingerprint(version.fingerprint) === resultFingerprint,
      );

      const ordinal = nextOrdinal(
        this.db,
        "rule_result_versions",
        "rule_result_identity_id",
        identityId,
      );
      const id = `${identityId}@${ordinal}`;
      const storedFingerprint = returning
        ? reobservedFingerprint(resultFingerprint, ordinal)
        : resultFingerprint;
      this.db
        .prepare(
          `INSERT INTO rule_result_versions (
             id, rule_result_identity_id, version_ordinal, fingerprint, applicability,
             normalized_status, normalized_output_json, normalized_reasons_json,
             rule_contract_version, implementation_fingerprint, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          identityId,
          ordinal,
          storedFingerprint,
          input.applicability,
          input.normalizedStatus,
          canonicalJson(input.normalizedOutput),
          canonicalJson([...input.normalizedReasons].sort()),
          input.ruleContractVersion,
          input.implementationFingerprint,
          now,
        );
      const insertEvidence = this.db.prepare(
        `INSERT OR IGNORE INTO rule_result_evidence
           (rule_result_version_id, evidence_version_id) VALUES (?, ?)`,
      );
      for (const evidenceVersionId of [...evidenceVersionIds].sort()) {
        insertEvidence.run(id, evidenceVersionId);
      }

      return { id, ordinal, created: true };
    });

    return persist();
  }

  persistClaimAssessment(
    input: PersistClaimAssessmentInput,
  ): PersistedAssessment {
    const persist = this.db.transaction(() => {
      const now = Date.now();
      const { parameterId, subjectId } = persistParameterSubject(
        this.db,
        input.parameterKey,
        now,
      );

      const identityKey = [
        input.parameterKey,
        input.claimType,
        input.scope ?? "",
      ].join(":");
      const claimIdentityId = idFor("claim", identityKey);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO claim_identities
             (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claimIdentityId,
          parameterId,
          input.claimType,
          input.scope ?? null,
          identityKey,
          now,
        );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO claim_subjects (
             claim_identity_id, subject_identity_id, subject_role, created_at
           ) VALUES (?, ?, 'subject', ?)`,
        )
        .run(claimIdentityId, subjectId, now);

      return this.persistAssessmentForClaimIdentity(
        claimIdentityId,
        input,
        now,
      );
    });

    return persist();
  }

  /**
   * Persist a generic Claim whose identity is anchored in role-based Subjects
   * (G1b). No ParameterIdentity is created; `claim_subjects` is authoritative.
   */
  persistGenericClaimAssessment(
    input: PersistGenericClaimAssessmentInput,
  ): PersistedAssessment {
    if (input.subjects.length === 0) {
      throw new Error("A generic Claim requires at least one Subject");
    }
    const identityRoles = input.identitySubjectRoles
      ? new Set(input.identitySubjectRoles)
      : undefined;
    const identitySubjects = identityRoles
      ? input.subjects.filter((subject) => identityRoles.has(subject.role))
      : input.subjects;
    if (identitySubjects.length === 0) {
      throw new Error("A generic Claim identity requires at least one Subject");
    }
    if (
      identityRoles &&
      [...identityRoles].some(
        (role) => !input.subjects.some((subject) => subject.role === role),
      )
    ) {
      throw new Error(
        "A generic Claim identity role is not attached to the Claim",
      );
    }
    const subjectKeys = identitySubjects.map((subject) => ({
      role: subject.role,
      identityKey: subject.identityKey,
    }));
    const seen = new Set<string>();
    for (const subject of subjectKeys) {
      if (subject.role.trim().length === 0) {
        throw new Error("A Claim Subject requires a non-empty role");
      }
      const key = canonicalJson([subject.role, subject.identityKey]);
      if (seen.has(key)) {
        throw new Error(
          `Duplicate Claim Subject ${subject.role}:${subject.identityKey}`,
        );
      }
      seen.add(key);
    }
    for (const [name, contract] of [
      ["identity", input.identityContract],
      ["materiality", input.materialityContract],
    ] as const) {
      if (
        contract.id.trim().length === 0 ||
        contract.version.trim().length === 0
      ) {
        throw new Error(
          `A generic Claim requires a versioned ${name} contract`,
        );
      }
    }
    const persist = this.db.transaction(() => {
      const now = Date.now();
      const identityKey = canonicalJson({
        claimType: input.claimType,
        identityContract: input.identityContract,
        scope: input.scope ?? "",
        subjects: [...subjectKeys].sort(
          (left, right) =>
            left.role.localeCompare(right.role) ||
            left.identityKey.localeCompare(right.identityKey),
        ),
      });
      const claimIdentityId = idFor("claim", identityKey);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO claim_identities
             (id, parameter_identity_id, claim_type, scope, identity_key,
              identity_contract_id, identity_contract_version, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claimIdentityId,
          input.claimType,
          input.scope ?? null,
          identityKey,
          input.identityContract.id,
          input.identityContract.version,
          now,
        );
      const insertSubject = this.db.prepare(
        `INSERT OR IGNORE INTO subject_identities (
           id, kind, identity_key, display_name, lifecycle_state,
           contract_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertClaimSubject = this.db.prepare(
        `INSERT OR IGNORE INTO claim_subjects (
           claim_identity_id, subject_identity_id, subject_role, created_at
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const subjectInput of input.subjects) {
        const subject = subjectIdentity(
          subjectInput.kind,
          subjectInput.identityKey,
          subjectInput.displayName,
        );
        insertSubject.run(
          subject.id,
          subject.kind,
          subject.identityKey,
          subject.displayName,
          subject.lifecycleState,
          subject.contractVersion,
          now,
        );
        insertClaimSubject.run(
          claimIdentityId,
          subject.id,
          subjectInput.role,
          now,
        );
      }

      return this.persistAssessmentForClaimIdentity(
        claimIdentityId,
        input,
        now,
      );
    });

    return persist();
  }

  private persistAssessmentForClaimIdentity(
    claimIdentityId: string,
    input: {
      normalizedStatement: unknown;
      assessmentPolicyId: string;
      assessmentPolicyVersion: string;
      materialityContract?: {
        id: string;
        version: string;
      };
      repositoryRevision: string;
      status: PersistClaimAssessmentInput["status"];
      dependencies: PersistClaimAssessmentInput["dependencies"];
    },
    now: number,
  ): PersistedAssessment {
    {
      const statementJson = canonicalJson(input.normalizedStatement);
      const materialityContractId = input.materialityContract?.id ?? null;
      const materialityContractVersion =
        input.materialityContract?.version ?? null;
      const latestVersion = this.db
        .prepare(
          `SELECT id, version_ordinal, normalized_statement_json,
                  assessment_policy_id, assessment_policy_version,
                  materiality_contract_id, materiality_contract_version
           FROM claim_versions
           WHERE claim_identity_id = ?
           ORDER BY version_ordinal DESC LIMIT 1`,
        )
        .get(claimIdentityId) as
        | {
            id: string;
            version_ordinal: number;
            normalized_statement_json: string;
            assessment_policy_id: string;
            assessment_policy_version: string;
            materiality_contract_id: string | null;
            materiality_contract_version: string | null;
          }
        | undefined;
      const unchangedClaim =
        latestVersion &&
        latestVersion.normalized_statement_json === statementJson &&
        latestVersion.assessment_policy_id === input.assessmentPolicyId &&
        latestVersion.assessment_policy_version ===
          input.assessmentPolicyVersion &&
        latestVersion.materiality_contract_id === materialityContractId &&
        latestVersion.materiality_contract_version ===
          materialityContractVersion;
      const claimVersionId = unchangedClaim
        ? latestVersion.id
        : `${claimIdentityId}@${nextOrdinal(
            this.db,
            "claim_versions",
            "claim_identity_id",
            claimIdentityId,
          )}`;
      if (!unchangedClaim) {
        this.db
          .prepare(
            `INSERT INTO claim_versions (
               id, claim_identity_id, version_ordinal, normalized_statement_json,
               assessment_policy_id, assessment_policy_version,
               materiality_contract_id, materiality_contract_version,
               repository_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            claimVersionId,
            claimIdentityId,
            Number(claimVersionId.slice(claimVersionId.lastIndexOf("@") + 1)),
            statementJson,
            input.assessmentPolicyId,
            input.assessmentPolicyVersion,
            materialityContractId,
            materialityContractVersion,
            input.repositoryRevision,
            now,
          );
      }

      const key = assessmentKey(claimVersionId, input.dependencies);
      const ensureReferenceAnchor = (assessmentId: string): void => {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO claim_assessment_references (
               claim_identity_id, repository_revision, assessment_id, created_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(claimIdentityId, input.repositoryRevision, assessmentId, now);
      };
      const assessments = this.db
        .prepare(
          `SELECT ca.id, ca.assessment_key, ca.is_current
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           WHERE cv.claim_identity_id = ?`,
        )
        .all(claimIdentityId) as Array<{
        id: string;
        assessment_key: string;
        is_current: number;
      }>;
      const current = assessments.find(
        (assessment) => assessment.is_current === 1,
      );
      if (current && logicalFingerprint(current.assessment_key) === key) {
        ensureReferenceAnchor(current.id);
        return {
          id: current.id,
          claimIdentityId,
          claimVersionId,
          created: false,
        };
      }
      const returningCount = assessments.filter(
        (assessment) => logicalFingerprint(assessment.assessment_key) === key,
      ).length;
      const storedKey =
        returningCount > 0
          ? reobservedFingerprint(key, returningCount + 1)
          : key;

      const assessmentId = `assessment:${storedKey}`;
      this.db
        .prepare(
          `INSERT INTO claim_assessments (
             id, claim_version_id, assessment_key, epistemic_status,
             repository_revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assessmentId,
          claimVersionId,
          storedKey,
          input.status,
          input.repositoryRevision,
          now,
        );
      const insertDependency = this.db.prepare(
        `INSERT INTO claim_assessment_dependencies (
           claim_assessment_id, dependency_kind, dependency_version_id,
           epistemic_role, warrant_polarity, assessment_effect
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const dependency of input.dependencies) {
        insertDependency.run(
          assessmentId,
          dependency.dependencyKind,
          dependency.dependencyVersionId,
          dependency.epistemicRole,
          dependency.warrantPolarity,
          dependency.assessmentEffect,
        );
      }
      this.db
        .prepare(
          `UPDATE claim_assessments
           SET is_current = 0, superseded_by_assessment_id = ?
           WHERE is_current = 1
             AND id != ?
             AND claim_version_id IN (
               SELECT id FROM claim_versions WHERE claim_identity_id = ?
             )`,
        )
        .run(assessmentId, assessmentId, claimIdentityId);
      ensureReferenceAnchor(assessmentId);

      return {
        id: assessmentId,
        claimIdentityId,
        claimVersionId,
        created: true,
      };
    }
  }
}
