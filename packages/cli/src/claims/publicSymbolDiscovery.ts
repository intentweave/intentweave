// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  subjectIdentity,
  type CandidateConfidence,
  type PersistedCandidate,
} from "@intentweave/index";
import {
  correlatePublicSymbolSubject,
  type PublicSymbolDiscoveryContext,
} from "./publicSymbolContinuity.js";

export const PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID =
  "cari-public-symbol-documentation";
export const PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION = "2";

export interface PublicSymbolCandidateResult extends PersistedCandidate {
  proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED";
  confidence: CandidateConfidence;
  sourceKinds: string[];
  surfaced: boolean;
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
  structure_hash: string | null;
}

interface UnlinkedAnnotationRow {
  id: number;
  doc_path: string;
  line: number;
  text: string;
  confidence: number;
  source: string;
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

function exactSymbolMention(text: string, symbolName: string): boolean {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(
    text,
  );
}

function persistAmbiguousDocumentationCandidates(
  database: Database.Database,
  claims: ClaimsStore,
  candidates: CandidateStore,
  symbols: PublicSymbolRow[],
  repositoryRevision: string,
): PublicSymbolCandidateResult[] {
  const annotations = database
    .prepare(
      `SELECT id, doc_path, line, text, confidence, source
       FROM annotations
       WHERE symbol_id IS NULL
       ORDER BY doc_path, line, id`,
    )
    .all() as UnlinkedAnnotationRow[];
  return annotations.flatMap((annotation) => {
    if (isFixtureOrTest(annotation.doc_path)) return [];
    const matches = symbols.filter((symbol) =>
      exactSymbolMention(annotation.text, symbol.name),
    );
    if (matches.length < 2) return [];
    const annotationKey = fingerprint({
      docPath: annotation.doc_path,
      line: annotation.line,
      text: annotation.text,
      source: annotation.source,
    });
    return matches.map((symbol): PublicSymbolCandidateResult => {
      const subject = {
        kind: "symbol" as const,
        identityKey: `symbol:${symbol.id}`,
        displayName: symbol.name,
        role: "subject",
        basis: "ambiguous-documentation-name-match",
        confidence: "ambiguous" as const,
      };
      const documentation = {
        present: true,
        summary: annotation.text,
        docPath: annotation.doc_path,
        line: annotation.line,
        source: annotation.source,
        sourceConfidence: annotation.confidence,
        ambiguousAssignment: true,
      };
      const evidenceKey = `documentation-reference:${annotationKey}`;
      const documentationVersion = claims.persistGenericEvidence({
        subjects: [subject],
        sourceKind: "documentation-reference",
        identityKey: evidenceKey,
        fingerprint: fingerprint(documentation),
        materialFingerprint: fingerprint(documentation),
        normalizedValue: documentation,
        semanticLocation: `${subject.identityKey}.documentation-reference`,
        provenance: {
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
          repositoryRevision,
          assignment: "ambiguous",
        },
        filePath: annotation.doc_path,
        spanStartLine: annotation.line,
        spanEndLine: annotation.line,
        repositoryRevision,
      });
      const candidate = candidates.persist({
        identityKey: `public-symbol-doc-correlation:${annotationKey}:${symbol.id}`,
        candidateKind: "public-symbol-documentation-correlation",
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
        discoveryMode: "deterministic",
        discoveryAdapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
        discoveryContractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
        confidence: "ambiguous",
        normalizedStatement: {
          symbolName: symbol.name,
          symbolKind: symbol.kind,
          requirement: "public-symbol-is-documented",
          proposedDocumentationPath: annotation.doc_path,
          proposedDocumentationLine: annotation.line,
        },
        provenance: {
          repositoryRevision,
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
          correlation: "ambiguous-documentation-name-match",
          alternatives: matches.map((match) => match.id).sort(),
        },
        evidence: [
          {
            evidenceKey,
            evidenceVersionId: documentationVersion.id,
            sourceKind: "documentation-reference",
            role: "documentation",
            provenance: { normalizedValue: documentation },
          },
        ],
        subjects: [subject],
      });
      return {
        ...candidate,
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
        confidence: "ambiguous",
        sourceKinds: ["documentation-reference"],
        surfaced: false,
      };
    });
  });
}

function bindContinuedCariSymbolAlias(
  database: Database.Database,
  claims: ClaimsStore,
  candidates: CandidateStore,
  input: {
    symbolId: string;
    canonicalSubjectId: string;
    canonicalCandidateIdentityKey: string;
    repositoryRevision: string;
  },
): void {
  const existingAlias = database
    .prepare(
      `SELECT subject_identity_id FROM subject_aliases
       WHERE alias_kind = 'cari-symbol-id' AND alias_key = ?`,
    )
    .get(input.symbolId) as { subject_identity_id: string } | undefined;
  if (
    existingAlias &&
    existingAlias.subject_identity_id !== input.canonicalSubjectId
  ) {
    const activeClaim = database
      .prepare(
        `SELECT claim_identity_id
         FROM claim_subjects
         WHERE subject_identity_id = ? LIMIT 1`,
      )
      .get(existingAlias.subject_identity_id) as
      | { claim_identity_id: string }
      | undefined;
    if (activeClaim) {
      throw new Error(
        `CARI Symbol ${input.symbolId} is already bound to promoted Claim ${activeClaim.claim_identity_id}`,
      );
    }
    database
      .prepare(
        `DELETE FROM subject_aliases
         WHERE alias_kind = 'cari-symbol-id' AND alias_key = ?`,
      )
      .run(input.symbolId);
  }

  const rawCandidateIdentityKey = `public-symbol-doc:${input.symbolId}`;
  if (rawCandidateIdentityKey !== input.canonicalCandidateIdentityKey) {
    const rawCandidate = candidates.current(rawCandidateIdentityKey);
    if (rawCandidate && rawCandidate.state !== "superseded") {
      if (rawCandidate.state === "promoted") {
        throw new Error(
          `Cannot supersede promoted Candidate ${rawCandidate.id} during Symbol continuity`,
        );
      }
      candidates.transition(rawCandidate.id, "superseded", {
        basis: "symbol-continuity",
        canonicalCandidateIdentityKey: input.canonicalCandidateIdentityKey,
        repositoryRevision: input.repositoryRevision,
      });
    }
  }
  claims.persistSubjectAlias({
    subjectIdentityId: input.canonicalSubjectId,
    aliasKind: "cari-symbol-id",
    aliasKey: input.symbolId,
  });
}

export function persistPublicSymbolCandidates(
  database: Database.Database,
  repositoryRevision: string,
  context?: PublicSymbolDiscoveryContext,
): PublicSymbolCandidateResult[] {
  const rows = database
    .prepare(
      `SELECT id, name, kind, signature, file_path, line, end_line, doc_summary,
              structure_hash
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
      const binding = correlatePublicSymbolSubject(
        database,
        PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
        {
          id: symbol.id,
          name: symbol.name,
          kind: symbol.kind,
          signature: symbol.signature,
          structureHash: symbol.structure_hash,
          filePath: symbol.file_path,
        },
        context,
      );
      const subjectIdentityKey = binding.canonicalSubject.identityKey;
      const candidateIdentityKey = binding.candidateIdentityKey;
      const definition = {
        name: symbol.name,
        kind: symbol.kind,
        signature: symbol.signature,
        structureHash: symbol.structure_hash,
        exported: true,
      };
      const materialDefinition = {
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
        subjects: [binding.observedSubject],
        sourceKind: "code-symbol",
        identityKey: `${candidateIdentityKey}:definition`,
        fingerprint: fingerprint({
          definition,
          filePath: symbol.file_path,
          line: symbol.line,
          endLine: symbol.end_line,
        }),
        materialFingerprint: fingerprint(materialDefinition),
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
        subjects: [binding.observedSubject],
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
      const canonicalSubjectId = subjectIdentity(
        "symbol",
        binding.canonicalSubject.identityKey,
        binding.canonicalSubject.displayName,
      ).id;
      if (
        binding.canonicalSubject.identityKey !==
        binding.observedSubject.identityKey
      ) {
        bindContinuedCariSymbolAlias(database, claims, candidates, {
          symbolId: symbol.id,
          canonicalSubjectId,
          canonicalCandidateIdentityKey: candidateIdentityKey,
          repositoryRevision,
        });
      }
      const continuity = binding.continuity
        ? claims.persistSubjectContinuity({
            fromSubjectIdentityId: canonicalSubjectId,
            toSubjectIdentityId: subjectIdentity(
              "symbol",
              binding.observedSubject.identityKey,
              binding.observedSubject.displayName,
            ).id,
            basis: binding.continuity.basis,
            confidence: binding.continuity.confidence,
            provenance: binding.continuity.provenance,
          })
        : undefined;
      const candidate = candidates.persist({
        identityKey: candidateIdentityKey,
        candidateKind: "public-symbol-documentation",
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
        discoveryMode: "deterministic",
        discoveryAdapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
        discoveryContractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
        confidence: binding.canonicalSubject.confidence,
        normalizedStatement: {
          symbolName: symbol.name,
          symbolKind: symbol.kind,
          requirement: "public-symbol-is-documented",
        },
        provenance: {
          repositoryRevision,
          adapterId: PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID,
          contractVersion: PUBLIC_SYMBOL_DISCOVERY_CONTRACT_VERSION,
          observedSubjectIdentityKey: binding.observedSubject.identityKey,
          continuityId: continuity?.id ?? null,
          continuityBasis: binding.continuity?.basis ?? null,
          continuityConfidence: binding.continuity?.confidence ?? null,
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
        subjects: [binding.canonicalSubject],
      });
      return {
        ...candidate,
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED" as const,
        confidence: binding.canonicalSubject.confidence,
        sourceKinds: ["code-documentation", "code-symbol"],
        surfaced: true,
      };
    });
  const ambiguous = persistAmbiguousDocumentationCandidates(
    database,
    claims,
    candidates,
    rows.filter((symbol) => !isFixtureOrTest(symbol.file_path)),
    repositoryRevision,
  );
  const activeIdentityKeys = new Set(
    discovered.map((candidate) => candidate.identityKey),
  );
  const previouslyPromoted = candidates
    .listCurrent({ subjectKind: "symbol" })
    .filter(
      (candidate) =>
        candidate.discoveryAdapterId === PUBLIC_SYMBOL_DISCOVERY_ADAPTER_ID &&
        candidate.candidateKind === "public-symbol-documentation" &&
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
  return [...discovered, ...ambiguous, ...retired];
}
