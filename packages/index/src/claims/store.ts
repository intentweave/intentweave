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
  PersistedAssessment,
  PersistedVersion,
  PersistRuleResultInput,
} from "./types.js";

function idFor(kind: string, identityKey: string): string {
  return `${kind}:${fingerprint(identityKey)}`;
}

function nextOrdinal(
  db: Database.Database,
  table: "evidence_versions" | "rule_result_versions" | "claim_versions",
  identityColumn:
    | "evidence_identity_id"
    | "rule_result_identity_id"
    | "claim_identity_id",
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
      const parameterId = idFor("parameter", input.parameterKey);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO parameter_identities (id, canonical_key, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(parameterId, input.parameterKey, now);

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
      const parameterId = idFor("parameter", input.parameterKey);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO parameter_identities (id, canonical_key, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(parameterId, input.parameterKey, now);

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

      const statementJson = canonicalJson(input.normalizedStatement);
      const latestVersion = this.db
        .prepare(
          `SELECT id, version_ordinal, normalized_statement_json,
                  assessment_policy_id, assessment_policy_version
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
          }
        | undefined;
      const unchangedClaim =
        latestVersion &&
        latestVersion.normalized_statement_json === statementJson &&
        latestVersion.assessment_policy_id === input.assessmentPolicyId &&
        latestVersion.assessment_policy_version ===
          input.assessmentPolicyVersion;
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
               assessment_policy_id, assessment_policy_version, repository_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            claimVersionId,
            claimIdentityId,
            Number(claimVersionId.slice(claimVersionId.lastIndexOf("@") + 1)),
            statementJson,
            input.assessmentPolicyId,
            input.assessmentPolicyVersion,
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
    });

    return persist();
  }
}
