// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  type PersistedCandidate,
} from "@intentweave/index";

export const PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID =
  "cari-public-symbol-documentation";
export const PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION = "1";

export interface PublicSymbolCandidateResult extends PersistedCandidate {
  proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED";
  confidence: "certain";
  sourceKinds: string[];
  surfaced: true;
}

interface PublicSymbolRow {
  id: string;
  name: string;
  kind: string;
  signature: string | null;
  file_path: string;
  line: number;
  end_line: number | null;
  doc_summary: string | null;
}

function statementRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isFixtureOrTest(filePath: string): boolean {
  return (
    /(^|\/)(__tests__|fixtures?|test|tests)(\/|$)/.test(filePath) ||
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(filePath)
  );
}

export function persistPublicSymbolCandidates(
  database: Database.Database,
  repositoryRevision: string,
): PublicSymbolCandidateResult[] {
  const rows = database
    .prepare(
      `SELECT id, name, kind, signature, file_path, line, end_line, doc_summary
       FROM symbols
       WHERE (export = 'exported' OR export = 1)
         AND (container IS NULL OR container = '')
         AND is_internal = 0
       ORDER BY file_path, line, id`,
    )
    .all() as PublicSymbolRow[];
  const claims = new ClaimsStore(database);
  const candidates = new CandidateStore(database);
  const discovered = rows
    .filter((symbol) => !isFixtureOrTest(symbol.file_path))
    .map((symbol) => {
      const subjectIdentityKey = `symbol:${symbol.id}`;
      const candidateIdentityKey = `public-symbol-doc:${symbol.id}`;
      const subject = {
        kind: "symbol" as const,
        identityKey: subjectIdentityKey,
        displayName: symbol.name,
        role: "subject",
        basis: "cari-symbol-table",
        confidence: "certain" as const,
      };
      const definition = {
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature,
        exported: true,
      };
      const documentation = {
        present: Boolean(symbol.doc_summary?.trim()),
        summary: symbol.doc_summary?.trim() || null,
      };
      const definitionVersion = claims.persistGenericEvidence({
        subjects: [subject],
        sourceKind: "code-symbol",
        identityKey: `${candidateIdentityKey}:definition`,
        fingerprint: fingerprint({
          definition,
          filePath: symbol.file_path,
          line: symbol.line,
          endLine: symbol.end_line,
        }),
        materialFingerprint: fingerprint(definition),
        normalizedValue: definition,
        semanticLocation: subjectIdentityKey,
        provenance: {
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
          repositoryRevision,
        },
        filePath: symbol.file_path,
        symbolId: symbol.id,
        spanStartLine: symbol.line,
        spanEndLine: symbol.end_line ?? symbol.line,
        repositoryRevision,
      });
      const documentationVersion = claims.persistGenericEvidence({
        subjects: [subject],
        sourceKind: "code-documentation",
        identityKey: `${candidateIdentityKey}:documentation`,
        fingerprint: fingerprint({
          documentation,
          filePath: symbol.file_path,
          line: symbol.line,
        }),
        materialFingerprint: fingerprint(documentation),
        normalizedValue: documentation,
        semanticLocation: `${subjectIdentityKey}.documentation`,
        provenance: {
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
          repositoryRevision,
        },
        filePath: symbol.file_path,
        symbolId: symbol.id,
        spanStartLine: symbol.line,
        spanEndLine: symbol.end_line ?? symbol.line,
        repositoryRevision,
      });
      const candidate = candidates.persist({
        identityKey: candidateIdentityKey,
        candidateKind: "public-symbol-documentation",
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
        discoveryMode: "deterministic",
        discoveryAdapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
        discoveryContractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
        confidence: "certain",
        normalizedStatement: {
          symbolName: symbol.name,
          symbolKind: symbol.kind,
          requirement: "public-symbol-is-documented",
        },
        provenance: {
          repositoryRevision,
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
        },
        evidence: [
          {
            evidenceKey: `${candidateIdentityKey}:definition`,
            evidenceVersionId: definitionVersion.id,
            sourceKind: "code-symbol",
            role: "definition",
            provenance: { normalizedValue: definition },
          },
          {
            evidenceKey: `${candidateIdentityKey}:documentation`,
            evidenceVersionId: documentationVersion.id,
            sourceKind: "code-documentation",
            role: "documentation",
            provenance: { normalizedValue: documentation },
          },
        ],
        subjects: [subject],
      });
      return {
        ...candidate,
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED" as const,
        confidence: "certain" as const,
        sourceKinds: ["code-documentation", "code-symbol"],
        surfaced: true as const,
      };
    });
  const activeIdentityKeys = new Set(
    discovered.map((candidate) => candidate.identityKey),
  );
  const previouslyPromoted = candidates
    .listCurrent({ subjectKind: "symbol" })
    .filter(
      (candidate) =>
        candidate.discoveryAdapterId === PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID &&
        database
          .prepare(
            `SELECT 1 AS present
             FROM candidate_reviews review
             JOIN claim_candidates observed
               ON observed.id = review.candidate_id
             WHERE observed.identity_key = ?
               AND review.decision = 'promote'
               AND review.effect = 'effective'
               AND review.promoted_claim_identity_id IS NOT NULL
             LIMIT 1`,
          )
          .get(candidate.identityKey),
    );
  const retired = previouslyPromoted.flatMap(
    (candidate): PublicSymbolCandidateResult[] => {
      if (activeIdentityKeys.has(candidate.identityKey)) return [];
      const subject = candidate.subjects[0];
      if (!subject) return [];
      const statement = statementRecord(candidate.normalizedStatement);
      const definition = {
        name:
          typeof statement.symbolName === "string"
            ? statement.symbolName
            : subject.displayName,
        kind:
          typeof statement.symbolKind === "string"
            ? statement.symbolKind
            : "unknown",
        signature: null,
        exported: false,
        lifecycle: "not-public-or-missing",
      };
      const definitionVersion = claims.persistGenericEvidence({
        subjects: [
          {
            ...subject,
            basis: "cari-symbol-table-reconciliation",
            confidence: "certain",
          },
        ],
        sourceKind: "code-symbol",
        identityKey: `${candidate.identityKey}:definition`,
        fingerprint: fingerprint(definition),
        materialFingerprint: fingerprint(definition),
        normalizedValue: definition,
        semanticLocation: subject.identityKey,
        provenance: {
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
          repositoryRevision,
          transition: "not-public-or-missing",
        },
        symbolId: subject.identityKey.replace(/^symbol:/, ""),
        repositoryRevision,
      });
      const persisted = candidates.persist({
        identityKey: candidate.identityKey,
        candidateKind: candidate.candidateKind,
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
        discoveryMode: "deterministic",
        discoveryAdapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
        discoveryContractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
        confidence: "certain",
        normalizedStatement: candidate.normalizedStatement,
        provenance: {
          repositoryRevision,
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
          transition: "not-public-or-missing",
        },
        evidence: [
          {
            evidenceKey: `${candidate.identityKey}:definition`,
            evidenceVersionId: definitionVersion.id,
            sourceKind: "code-symbol",
            role: "definition",
            provenance: { normalizedValue: definition },
          },
        ],
        subjects: [
          {
            ...subject,
            basis: "cari-symbol-table-reconciliation",
            confidence: "certain",
          },
        ],
      });
      return [
        {
          ...persisted,
          proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
          confidence: "certain",
          sourceKinds: ["code-symbol"],
          surfaced: true,
        },
      ];
    },
  );
  return [...discovered, ...retired];
}
