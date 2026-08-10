// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import { canonicalJson, fingerprint, ruleResultFingerprint } from "./canonical.js";
import type {
  PersistEvidenceInput,
  PersistedVersion,
  PersistRuleResultInput,
} from "./types.js";

function idFor(kind: string, identityKey: string): string {
  return `${kind}:${fingerprint(identityKey)}`;
}

function nextOrdinal(
  db: Database.Database,
  table: "evidence_versions" | "rule_result_versions",
  identityColumn: "evidence_identity_id" | "rule_result_identity_id",
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

      const existing = this.db
        .prepare(
          `SELECT id, version_ordinal FROM evidence_versions
           WHERE evidence_identity_id = ? AND fingerprint = ?`,
        )
        .get(evidenceIdentityId, input.fingerprint) as
        | { id: string; version_ordinal: number }
        | undefined;
      if (existing) {
        return { id: existing.id, ordinal: existing.version_ordinal, created: false };
      }

      const ordinal = nextOrdinal(
        this.db,
        "evidence_versions",
        "evidence_identity_id",
        evidenceIdentityId,
      );
      const id = `${evidenceIdentityId}@${ordinal}`;
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
          input.fingerprint,
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
           VALUES (?, ?, ?, 'explicit', 'high', ?)`,
        )
        .run(`${parameterId}:${id}`, parameterId, id, now);

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
      const identityKey = `${input.ruleId}:${input.scope ?? ""}`;
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
      const existing = this.db
        .prepare(
          `SELECT id, version_ordinal FROM rule_result_versions
           WHERE rule_result_identity_id = ? AND fingerprint = ?`,
        )
        .get(identityId, resultFingerprint) as
        | { id: string; version_ordinal: number }
        | undefined;
      if (existing) {
        return { id: existing.id, ordinal: existing.version_ordinal, created: false };
      }

      const ordinal = nextOrdinal(
        this.db,
        "rule_result_versions",
        "rule_result_identity_id",
        identityId,
      );
      const id = `${identityId}@${ordinal}`;
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
          resultFingerprint,
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
}