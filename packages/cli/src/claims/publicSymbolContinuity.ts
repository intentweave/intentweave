// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import type { CandidateConfidence } from "@intentweave/index";

export interface PublicSymbolObservation {
  id: string;
  name: string;
  kind: string;
  signature: string | null;
  structureHash: string | null;
  filePath: string;
}

export interface PublicSymbolDiscoveryContext {
  baseRevision: string;
  headRevision: string;
  changedPaths: readonly string[];
  renames: ReadonlyArray<{
    fromPath: string;
    toPath: string;
    similarity: number;
  }>;
}

export interface PublicSymbolSubjectBinding {
  candidateIdentityKey: string;
  canonicalSubject: {
    kind: "symbol";
    identityKey: string;
    displayName: string;
    role: "subject";
    basis: string;
    confidence: CandidateConfidence;
  };
  observedSubject: {
    kind: "symbol";
    identityKey: string;
    displayName: string;
    role: "subject";
    basis: string;
    confidence: CandidateConfidence;
  };
  continuity?: {
    basis: string;
    confidence: CandidateConfidence;
    provenance: Record<string, unknown>;
  };
}

interface HistoricalSymbol {
  candidate_identity_key: string;
  subject_identity_key: string;
  subject_display_name: string;
  file_path: string;
  normalized_value: string;
}

function objectValue(value: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function signatureShape(signature: unknown): string | undefined {
  if (typeof signature !== "string") return undefined;
  return signature.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, "_");
}

function promotedAliasBinding(
  database: Database.Database,
  adapterId: string,
  symbol: PublicSymbolObservation,
): PublicSymbolSubjectBinding | undefined {
  const existing = database
    .prepare(
      `SELECT candidate.identity_key AS candidate_identity_key,
              subject.identity_key AS subject_identity_key,
              subject.display_name AS subject_display_name
       FROM subject_aliases alias
       JOIN subject_identities subject
         ON subject.id = alias.subject_identity_id
       JOIN candidate_subjects candidate_subject
         ON candidate_subject.subject_identity_id = subject.id
       JOIN claim_candidates candidate
         ON candidate.id = candidate_subject.candidate_id
       WHERE alias.alias_kind = 'cari-symbol-id'
         AND alias.alias_key = ?
         AND candidate.discovery_adapter_id = ?
         AND candidate.candidate_kind = 'public-symbol-documentation'
         AND EXISTS (
           SELECT 1 FROM candidate_reviews review
           JOIN claim_candidates reviewed
             ON reviewed.id = review.candidate_id
           WHERE reviewed.identity_key = candidate.identity_key
             AND review.decision = 'promote'
             AND review.effect = 'effective'
             AND review.promoted_claim_identity_id IS NOT NULL
         )
       ORDER BY candidate.version_ordinal DESC LIMIT 1`,
    )
    .get(symbol.id, adapterId) as
    | {
        candidate_identity_key: string;
        subject_identity_key: string;
        subject_display_name: string;
      }
    | undefined;
  if (!existing) return undefined;
  const observedSubjectKey = `symbol:${symbol.id}`;
  const continuity = database
    .prepare(
      `SELECT continuity.basis, continuity.confidence
       FROM subject_continuity continuity
       JOIN subject_identities source
         ON source.id = continuity.from_subject_identity_id
       JOIN subject_identities target
         ON target.id = continuity.to_subject_identity_id
       WHERE source.identity_key = ? AND target.identity_key = ?
       ORDER BY continuity.version_ordinal DESC LIMIT 1`,
    )
    .get(existing.subject_identity_key, observedSubjectKey) as
    | { basis: string; confidence: CandidateConfidence }
    | undefined;
  const confidence = continuity?.confidence ?? "certain";
  return {
    candidateIdentityKey: existing.candidate_identity_key,
    canonicalSubject: {
      kind: "symbol",
      identityKey: existing.subject_identity_key,
      displayName: existing.subject_display_name,
      role: "subject",
      basis: continuity?.basis ?? "cari-symbol-id-alias",
      confidence,
    },
    observedSubject: {
      kind: "symbol",
      identityKey: observedSubjectKey,
      displayName: symbol.name,
      role: "subject",
      basis: "cari-symbol-table",
      confidence,
    },
  };
}

function historicalSymbols(
  database: Database.Database,
  adapterId: string,
  baseRevision: string,
  predecessorPaths: readonly string[],
): HistoricalSymbol[] {
  if (predecessorPaths.length === 0) return [];
  const placeholders = predecessorPaths.map(() => "?").join(", ");
  return database
    .prepare(
      `SELECT DISTINCT candidate.identity_key AS candidate_identity_key,
              subject.identity_key AS subject_identity_key,
              subject.display_name AS subject_display_name,
              evidence.file_path, evidence.normalized_value
       FROM evidence_versions evidence
       JOIN evidence_identities identity
         ON identity.id = evidence.evidence_identity_id
       JOIN candidate_evidence candidate_evidence
         ON candidate_evidence.evidence_version_id = evidence.id
        AND candidate_evidence.evidence_role = 'definition'
       JOIN claim_candidates candidate
         ON candidate.id = candidate_evidence.candidate_id
       JOIN candidate_subjects candidate_subject
         ON candidate_subject.candidate_id = candidate.id
       JOIN subject_identities subject
         ON subject.id = candidate_subject.subject_identity_id
       WHERE identity.source_kind = 'code-symbol'
         AND candidate.discovery_adapter_id = ?
         AND candidate.candidate_kind = 'public-symbol-documentation'
         AND evidence.repository_revision = ?
         AND evidence.file_path IN (${placeholders})
         AND EXISTS (
           SELECT 1 FROM candidate_reviews review
           JOIN claim_candidates reviewed
             ON reviewed.id = review.candidate_id
           WHERE reviewed.identity_key = candidate.identity_key
             AND review.decision = 'promote'
             AND review.effect = 'effective'
             AND review.promoted_claim_identity_id IS NOT NULL
         )
       ORDER BY candidate.identity_key`,
    )
    .all(adapterId, baseRevision, ...predecessorPaths) as HistoricalSymbol[];
}

function isUniquePredecessor(
  historical: HistoricalSymbol,
  symbol: PublicSymbolObservation,
): boolean {
  const definition = objectValue(historical.normalized_value);
  if (!definition || definition.kind !== symbol.kind) return false;
  const sameName = definition.name === symbol.name;
  const sameSignature =
    typeof definition.signature === "string" &&
    typeof symbol.signature === "string" &&
    definition.signature === symbol.signature;
  const previousSignatureShape = signatureShape(definition.signature);
  const currentSignatureShape = signatureShape(symbol.signature);
  const sameSignatureShape =
    previousSignatureShape !== undefined &&
    currentSignatureShape !== undefined &&
    previousSignatureShape === currentSignatureShape;
  const sameStructure =
    typeof definition.structureHash === "string" &&
    definition.structureHash.length > 0 &&
    definition.structureHash === symbol.structureHash;
  return sameName || sameSignature || sameSignatureShape || sameStructure;
}

export function correlatePublicSymbolSubject(
  database: Database.Database,
  adapterId: string,
  symbol: PublicSymbolObservation,
  context?: PublicSymbolDiscoveryContext,
): PublicSymbolSubjectBinding {
  const aliased = promotedAliasBinding(database, adapterId, symbol);
  if (aliased) return aliased;

  const observedSubject = {
    kind: "symbol" as const,
    identityKey: `symbol:${symbol.id}`,
    displayName: symbol.name,
    role: "subject" as const,
    basis: "cari-symbol-table",
    confidence: "certain" as const,
  };
  if (!context) {
    return {
      candidateIdentityKey: `public-symbol-doc:${symbol.id}`,
      canonicalSubject: observedSubject,
      observedSubject,
    };
  }

  const rename = context.renames.find(
    (candidate) => candidate.toPath === symbol.filePath,
  );
  const predecessorPaths = [
    ...(context.changedPaths.includes(symbol.filePath)
      ? [symbol.filePath]
      : []),
    ...(rename ? [rename.fromPath] : []),
  ];
  const matches = historicalSymbols(database, adapterId, context.baseRevision, [
    ...new Set(predecessorPaths),
  ]).filter((historical) => isUniquePredecessor(historical, symbol));
  if (matches.length !== 1) {
    return {
      candidateIdentityKey: `public-symbol-doc:${symbol.id}`,
      canonicalSubject: observedSubject,
      observedSubject,
    };
  }

  const predecessor = matches[0]!;
  const definition = objectValue(predecessor.normalized_value)!;
  const materialUnchanged =
    definition.name === symbol.name &&
    definition.kind === symbol.kind &&
    definition.signature === symbol.signature;
  const confidence: CandidateConfidence = materialUnchanged
    ? "certain"
    : "probable";
  const basis = rename ? "git-file-rename" : "git-unique-predecessor";
  const canonicalSubject = {
    kind: "symbol" as const,
    identityKey: predecessor.subject_identity_key,
    displayName: predecessor.subject_display_name,
    role: "subject" as const,
    basis,
    confidence,
  };
  return {
    candidateIdentityKey: predecessor.candidate_identity_key,
    canonicalSubject,
    observedSubject: { ...observedSubject, confidence },
    ...(canonicalSubject.identityKey !== observedSubject.identityKey
      ? {
          continuity: {
            basis,
            confidence,
            provenance: {
              baseRevision: context.baseRevision,
              headRevision: context.headRevision,
              fromPath: predecessor.file_path,
              toPath: symbol.filePath,
              gitRename: rename ?? null,
              materialUnchanged,
            },
          },
        }
      : {}),
  };
}
