// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import { canonicalJson, fingerprint } from "./canonical.js";

export type CandidateInferenceConfidence = "probable" | "ambiguous";

export interface CandidateInferenceCacheKey {
  identityKey: string;
  adapterId: string;
  contractVersion: string;
  providerId: string;
  modelId: string;
  promptVersion: string;
  inputFingerprint: string;
}

export interface PersistCandidateInferenceInput extends CandidateInferenceCacheKey {
  normalizedOutput: unknown;
  evidenceVersionIds: string[];
  proposedSubjectBindings: unknown[];
  confidence: CandidateInferenceConfidence;
  rationale: string;
  provenance: unknown;
}

export interface CandidateInferenceDetails extends CandidateInferenceCacheKey {
  id: string;
  ordinal: number;
  mode: "model";
  outputFingerprint: string;
  evidenceVersionIds: string[];
  proposedSubjectBindings: unknown[];
  confidence: CandidateInferenceConfidence;
  rationale: string;
  provenance: unknown;
  createdAt: number;
  created: boolean;
}

interface CandidateInferenceRow {
  id: string;
  inference_identity_key: string;
  version_ordinal: number;
  adapter_id: string;
  contract_version: string;
  mode: "model";
  provider_id: string;
  model_id: string;
  prompt_version: string;
  input_fingerprint: string;
  output_fingerprint: string;
  evidence_version_ids_json: string;
  proposed_subject_bindings_json: string;
  confidence: CandidateInferenceConfidence;
  rationale: string;
  provenance_json: string;
  created_at: number;
}

const REOBSERVED_MARKER = "#reobserved:";

function logicalFingerprint(value: string): string {
  return value.split(REOBSERVED_MARKER, 1)[0] ?? value;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export class CandidateInferenceStore {
  constructor(private readonly db: Database.Database) {}

  findReusable(
    key: CandidateInferenceCacheKey,
  ): CandidateInferenceDetails | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM candidate_inferences
         WHERE inference_identity_key = ?
           AND adapter_id = ?
           AND contract_version = ?
           AND provider_id = ?
           AND model_id = ?
           AND prompt_version = ?
           AND input_fingerprint = ?
         ORDER BY version_ordinal DESC LIMIT 1`,
      )
      .get(
        key.identityKey,
        key.adapterId,
        key.contractVersion,
        key.providerId,
        key.modelId,
        key.promptVersion,
        key.inputFingerprint,
      ) as CandidateInferenceRow | undefined;
    return row ? this.detailsFromRow(row, false) : undefined;
  }

  persist(input: PersistCandidateInferenceInput): CandidateInferenceDetails {
    const persist = this.db.transaction(() => {
      this.validate(input);
      const evidenceVersionIds = sortedUnique(input.evidenceVersionIds);
      const proposedSubjectBindings = [...input.proposedSubjectBindings].sort(
        (left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
      );
      const outputFingerprint = fingerprint(input.normalizedOutput);
      const provenanceJson = canonicalJson(input.provenance);
      const rows = this.rowsForIdentity(input.identityKey);
      const current = rows[0];
      if (
        current &&
        current.adapter_id === input.adapterId &&
        current.contract_version === input.contractVersion &&
        current.provider_id === input.providerId &&
        current.model_id === input.modelId &&
        current.prompt_version === input.promptVersion &&
        current.input_fingerprint === input.inputFingerprint &&
        logicalFingerprint(current.output_fingerprint) === outputFingerprint &&
        current.evidence_version_ids_json ===
          canonicalJson(evidenceVersionIds) &&
        current.proposed_subject_bindings_json ===
          canonicalJson(proposedSubjectBindings) &&
        current.confidence === input.confidence &&
        current.rationale === input.rationale &&
        current.provenance_json === provenanceJson
      ) {
        return this.detailsFromRow(current, false);
      }

      const ordinal = (current?.version_ordinal ?? 0) + 1;
      const returning = rows.some(
        (row) =>
          logicalFingerprint(row.output_fingerprint) === outputFingerprint,
      );
      const storedOutputFingerprint = returning
        ? `${outputFingerprint}${REOBSERVED_MARKER}${ordinal}`
        : outputFingerprint;
      const id = `candidate-inference:${fingerprint(input.identityKey)}@${ordinal}`;
      const createdAt = Date.now();
      this.db
        .prepare(
          `INSERT INTO candidate_inferences (
             id, inference_identity_key, version_ordinal, adapter_id,
             contract_version, mode, provider_id, model_id, prompt_version,
             input_fingerprint, output_fingerprint,
             evidence_version_ids_json, proposed_subject_bindings_json,
             confidence, rationale, provenance_json, created_at
           ) VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.identityKey,
          ordinal,
          input.adapterId,
          input.contractVersion,
          input.providerId,
          input.modelId,
          input.promptVersion,
          input.inputFingerprint,
          storedOutputFingerprint,
          canonicalJson(evidenceVersionIds),
          canonicalJson(proposedSubjectBindings),
          input.confidence,
          input.rationale,
          provenanceJson,
          createdAt,
        );
      return { ...this.details(id)!, created: true };
    });
    return persist();
  }

  details(id: string): CandidateInferenceDetails | undefined {
    const row = this.db
      .prepare(`SELECT * FROM candidate_inferences WHERE id = ?`)
      .get(id) as CandidateInferenceRow | undefined;
    return row ? this.detailsFromRow(row, false) : undefined;
  }

  list(identityKey: string): CandidateInferenceDetails[] {
    return this.rowsForIdentity(identityKey).map((row) =>
      this.detailsFromRow(row, false),
    );
  }

  private rowsForIdentity(identityKey: string): CandidateInferenceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM candidate_inferences
         WHERE inference_identity_key = ? ORDER BY version_ordinal DESC`,
      )
      .all(identityKey) as CandidateInferenceRow[];
  }

  private detailsFromRow(
    row: CandidateInferenceRow,
    created: boolean,
  ): CandidateInferenceDetails {
    return {
      id: row.id,
      identityKey: row.inference_identity_key,
      ordinal: row.version_ordinal,
      adapterId: row.adapter_id,
      contractVersion: row.contract_version,
      mode: row.mode,
      providerId: row.provider_id,
      modelId: row.model_id,
      promptVersion: row.prompt_version,
      inputFingerprint: row.input_fingerprint,
      outputFingerprint: logicalFingerprint(row.output_fingerprint),
      evidenceVersionIds: JSON.parse(row.evidence_version_ids_json) as string[],
      proposedSubjectBindings: JSON.parse(
        row.proposed_subject_bindings_json,
      ) as unknown[],
      confidence: row.confidence,
      rationale: row.rationale,
      provenance: JSON.parse(row.provenance_json) as unknown,
      createdAt: row.created_at,
      created,
    };
  }

  private validate(input: PersistCandidateInferenceInput): void {
    requireNonEmpty(input.identityKey, "Inference identity key");
    requireNonEmpty(input.adapterId, "Inference adapter ID");
    requireNonEmpty(input.contractVersion, "Inference contract version");
    requireNonEmpty(input.providerId, "Inference provider ID");
    requireNonEmpty(input.modelId, "Inference model ID");
    requireNonEmpty(input.promptVersion, "Inference prompt version");
    requireNonEmpty(input.inputFingerprint, "Inference input fingerprint");
    requireNonEmpty(input.rationale, "Inference rationale");
    if (
      input.confidence === "probable" &&
      (input.evidenceVersionIds.length === 0 ||
        input.proposedSubjectBindings.length === 0)
    ) {
      throw new Error(
        "A probable Inference requires EvidenceVersion IDs and proposed Subject bindings",
      );
    }
    for (const evidenceVersionId of sortedUnique(input.evidenceVersionIds)) {
      const exists = this.db
        .prepare(`SELECT 1 AS present FROM evidence_versions WHERE id = ?`)
        .get(evidenceVersionId) as { present: number } | undefined;
      if (!exists) {
        throw new Error(`EvidenceVersion ${evidenceVersionId} does not exist`);
      }
    }
  }
}
