// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Framework-neutral persistence for endpoint-authentication Candidates. Each
 * framework discoverer supplies an EndpointDiscoveryProfile and normalized
 * observations; this module writes the Evidence, Subjects, and Candidate rows.
 */

import {
  ClaimsStore,
  CandidateStore,
  fingerprint,
  subjectIdentity,
  type CandidateConfidence,
  type PersistedCandidate,
} from "@intentweave/index";
import type Database from "@intentweave/sqlite-compat";

export interface EndpointCandidateResult extends PersistedCandidate {
  proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED";
  confidence: CandidateConfidence;
  sourceKinds: string[];
  surfaced: boolean;
}

/**
 * Framework-specific identity and provenance for an endpoint discoverer. The
 * persistence and retirement paths are shared; only these values differ.
 */
export interface EndpointDiscoveryProfile {
  framework: string;
  adapterId: string;
  contractVersion: string;
  packageName: string;
}

export interface EndpointObservation {
  method: string;
  routePath: string;
  routeKnown: boolean;
  controllerName: string;
  handlerName: string;
  handlerSignature: string | null;
  handlerSymbolId?: string;
  filePath: string;
  line: number;
  endLine: number;
  guards: string[];
  /** Guards named in source that could not be verified; never count as Evidence. */
  unverifiedGuards?: string[];
  guardSource: "handler" | "controller" | "scope-hook" | "none";
  publicExemption: boolean;
  documentationRequirement?: "required" | "public";
  ambiguous: boolean;
}

export function endpointIdentity(
  framework: string,
  method: string,
  routePath: string,
): string {
  return `endpoint:${framework}:${method}:${routePath}`;
}

export function endpointCandidateIdentity(
  framework: string,
  method: string,
  routePath: string,
): string {
  return `endpoint-auth:${framework}:${method}:${routePath}`;
}

export function persistObservation(
  database: Database.Database,
  repositoryRevision: string,
  observation: EndpointObservation,
  profile: EndpointDiscoveryProfile,
): EndpointCandidateResult {
  const { framework: fw, adapterId, contractVersion } = profile;
  const claims = new ClaimsStore(database);
  const candidates = new CandidateStore(database);
  const subjectKey = endpointIdentity(
    fw,
    observation.method,
    observation.routePath,
  );
  const candidateKey = endpointCandidateIdentity(
    fw,
    observation.method,
    observation.routePath,
  );
  const endpointSubject = {
    kind: "endpoint" as const,
    identityKey: subjectKey,
    displayName: `${observation.method} ${observation.routePath}`,
    role: "endpoint",
    basis: `${fw}-controller-route`,
    confidence: (observation.ambiguous
      ? "ambiguous"
      : "certain") as CandidateConfidence,
  };
  const handlerSubject = {
    kind: "symbol" as const,
    identityKey: `symbol:${fw}-handler:${observation.filePath}:${observation.controllerName}.${observation.handlerName}`,
    displayName: `${observation.controllerName}.${observation.handlerName}`,
    role: "handler",
    basis: `${fw}-route-handler`,
    confidence: "certain" as const,
  };
  const previousHandlerSubject = database
    .prepare(
      `SELECT subject.id, subject.identity_key, subject.display_name
       FROM evidence_identities evidence
       JOIN evidence_subjects link ON link.evidence_identity_id = evidence.id
       JOIN subject_identities subject ON subject.id = link.subject_identity_id
       WHERE evidence.identity_key = ? AND link.subject_role = 'handler'
         AND subject.identity_key != ?
       ORDER BY subject.created_at DESC, subject.id DESC LIMIT 1`,
    )
    .get(`${candidateKey}:handler`, handlerSubject.identityKey) as
    | { id: string; identity_key: string; display_name: string }
    | undefined;
  const guardSubjects = observation.guards.map((guard) => ({
    kind: "symbol" as const,
    identityKey: `symbol:${fw}-guard:${guard}`,
    displayName: guard,
    role: "guard",
    basis: `${fw}-use-guards`,
    confidence: "certain" as const,
  }));
  const routeValue = {
    framework: fw,
    method: observation.method,
    path: observation.routePath,
    pathKnown: observation.routeKnown,
    active: true,
  };
  const handlerValue = {
    controller: observation.controllerName,
    handler: observation.handlerName,
    signature: observation.handlerSignature,
  };
  const guardValue = {
    present: observation.guards.length > 0,
    guards: observation.guards,
    source: observation.guardSource,
    publicExemption: observation.publicExemption,
    // Written only when present so existing NestJS material fingerprints hold.
    ...(observation.unverifiedGuards?.length
      ? { unverifiedGuards: observation.unverifiedGuards }
      : {}),
  };
  const documentationValue = {
    requirement: observation.documentationRequirement ?? null,
  };
  const frameworkValue = {
    framework: fw,
    recognized: true,
    routePathStatic: observation.routeKnown,
  };
  const routeVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, handlerSubject],
    sourceKind: "framework-route",
    identityKey: `${candidateKey}:route`,
    fingerprint: fingerprint({
      routeValue,
      filePath: observation.filePath,
      line: observation.line,
      handler: handlerValue,
    }),
    materialFingerprint: fingerprint(routeValue),
    normalizedValue: routeValue,
    semanticLocation: subjectKey,
    provenance: {
      adapterId: adapterId,
      contractVersion: contractVersion,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const handlerVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, handlerSubject],
    sourceKind: "route-handler",
    identityKey: `${candidateKey}:handler`,
    fingerprint: fingerprint({
      handlerValue,
      filePath: observation.filePath,
      line: observation.line,
      symbolId: observation.handlerSymbolId ?? null,
    }),
    materialFingerprint: fingerprint({ endpoint: subjectKey }),
    normalizedValue: handlerValue,
    semanticLocation: `${subjectKey}.handler`,
    provenance: {
      adapterId: adapterId,
      contractVersion: contractVersion,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const handlerContinuity = previousHandlerSubject
    ? claims.persistSubjectContinuity({
        fromSubjectIdentityId: previousHandlerSubject.id,
        toSubjectIdentityId: subjectIdentity(
          "symbol",
          handlerSubject.identityKey,
          handlerSubject.displayName,
        ).id,
        basis: `stable-${fw}-endpoint-route`,
        confidence: "certain",
        provenance: {
          adapterId: adapterId,
          contractVersion: contractVersion,
          repositoryRevision,
          endpointIdentityKey: subjectKey,
          fromHandler: previousHandlerSubject.display_name,
          toHandler: handlerSubject.displayName,
        },
      })
    : undefined;
  const guardVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, ...guardSubjects],
    sourceKind: "authentication-guard",
    identityKey: `${candidateKey}:guard`,
    fingerprint: fingerprint({ guardValue, filePath: observation.filePath }),
    materialFingerprint: fingerprint(guardValue),
    normalizedValue: guardValue,
    semanticLocation: `${subjectKey}.authentication`,
    provenance: {
      adapterId: adapterId,
      contractVersion: contractVersion,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const documentationVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, handlerSubject],
    sourceKind: "security-documentation",
    identityKey: `${candidateKey}:documentation`,
    fingerprint: fingerprint({
      documentationValue,
      filePath: observation.filePath,
      line: observation.line,
    }),
    materialFingerprint: fingerprint(documentationValue),
    normalizedValue: documentationValue,
    semanticLocation: `${subjectKey}.security-documentation`,
    provenance: {
      adapterId: adapterId,
      contractVersion: contractVersion,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const frameworkVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject],
    sourceKind: "framework-configuration",
    identityKey: `${candidateKey}:framework`,
    fingerprint: fingerprint({
      frameworkValue,
      filePath: observation.filePath,
    }),
    materialFingerprint: fingerprint(frameworkValue),
    normalizedValue: frameworkValue,
    semanticLocation: `${subjectKey}.framework`,
    provenance: {
      adapterId: adapterId,
      contractVersion: contractVersion,
      repositoryRevision,
      package: profile.packageName,
    },
    filePath: observation.filePath,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const confidence: CandidateConfidence = observation.ambiguous
    ? "ambiguous"
    : "certain";
  const candidate = candidates.persist({
    identityKey: candidateKey,
    candidateKind: "endpoint-authentication",
    proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
    discoveryMode: "deterministic",
    discoveryAdapterId: adapterId,
    discoveryContractVersion: contractVersion,
    confidence,
    normalizedStatement: {
      method: observation.method,
      path: observation.routePath,
      requirement: "endpoint-is-authenticated",
    },
    provenance: {
      repositoryRevision,
      adapterId: adapterId,
      contractVersion: contractVersion,
      handlerContinuityId: handlerContinuity?.id ?? null,
    },
    evidence: [
      {
        evidenceKey: `${candidateKey}:route`,
        evidenceVersionId: routeVersion.id,
        sourceKind: "framework-route",
        role: "route",
        provenance: { normalizedValue: routeValue },
      },
      {
        evidenceKey: `${candidateKey}:handler`,
        evidenceVersionId: handlerVersion.id,
        sourceKind: "route-handler",
        role: "handler",
        provenance: { normalizedValue: handlerValue },
      },
      {
        evidenceKey: `${candidateKey}:guard`,
        evidenceVersionId: guardVersion.id,
        sourceKind: "authentication-guard",
        role: "guard",
        provenance: { normalizedValue: guardValue },
      },
      {
        evidenceKey: `${candidateKey}:documentation`,
        evidenceVersionId: documentationVersion.id,
        sourceKind: "security-documentation",
        role: "documentation",
        provenance: { normalizedValue: documentationValue },
      },
      {
        evidenceKey: `${candidateKey}:framework`,
        evidenceVersionId: frameworkVersion.id,
        sourceKind: "framework-configuration",
        role: "framework",
        provenance: { normalizedValue: frameworkValue },
      },
    ],
    subjects: [endpointSubject, handlerSubject, ...guardSubjects],
  });
  return {
    ...candidate,
    proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
    confidence,
    sourceKinds: [
      "authentication-guard",
      "framework-route",
      "framework-configuration",
      "route-handler",
      "security-documentation",
    ],
    surfaced: true,
  };
}

/**
 * Retire Candidates whose route disappeared from the current source and that
 * were never promoted. Promoted Candidates stay and are reconciled elsewhere.
 */
export function retireMissingEndpointCandidates(
  database: Database.Database,
  repositoryRevision: string,
  activeIdentityKeys: ReadonlySet<string>,
  profile: EndpointDiscoveryProfile,
): EndpointCandidateResult[] {
  const claims = new ClaimsStore(database);
  const candidates = new CandidateStore(database);
  return candidates
    .listCurrent({ subjectKind: "endpoint" })
    .filter(
      (candidate) =>
        candidate.discoveryAdapterId === profile.adapterId &&
        candidate.candidateKind === "endpoint-authentication" &&
        !activeIdentityKeys.has(candidate.identityKey) &&
        database
          .prepare(
            `SELECT 1 AS present
             FROM candidate_reviews review
             JOIN claim_candidates observed ON observed.id = review.candidate_id
             WHERE observed.identity_key = ?
               AND review.decision = 'promote'
               AND review.effect = 'effective'
               AND review.promoted_claim_identity_id IS NOT NULL
             LIMIT 1`,
          )
          .get(candidate.identityKey),
    )
    .flatMap((candidate): EndpointCandidateResult[] => {
      const endpointSubject = candidate.subjects.find(
        (subject) => subject.role === "endpoint",
      );
      if (!endpointSubject) return [];
      const routeValue = {
        framework: profile.framework,
        method:
          typeof (candidate.normalizedStatement as Record<string, unknown>)
            .method === "string"
            ? (candidate.normalizedStatement as Record<string, string>).method
            : null,
        path:
          typeof (candidate.normalizedStatement as Record<string, unknown>)
            .path === "string"
            ? (candidate.normalizedStatement as Record<string, string>).path
            : null,
        pathKnown: true,
        active: false,
      };
      const reconciliationSubject = {
        ...endpointSubject,
        basis: `${profile.framework}-route-reconciliation`,
        confidence: "certain" as const,
      };
      const routeVersion = claims.persistGenericEvidence({
        subjects: [reconciliationSubject],
        sourceKind: "framework-route",
        identityKey: `${candidate.identityKey}:route`,
        fingerprint: fingerprint(routeValue),
        materialFingerprint: fingerprint(routeValue),
        normalizedValue: routeValue,
        semanticLocation: endpointSubject.identityKey,
        provenance: {
          adapterId: profile.adapterId,
          contractVersion: profile.contractVersion,
          repositoryRevision,
          transition: "route-missing",
        },
        repositoryRevision,
      });
      const persisted = candidates.persist({
        identityKey: candidate.identityKey,
        candidateKind: candidate.candidateKind,
        proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
        discoveryMode: "deterministic",
        discoveryAdapterId: profile.adapterId,
        discoveryContractVersion: profile.contractVersion,
        confidence: "certain",
        normalizedStatement: candidate.normalizedStatement,
        provenance: {
          repositoryRevision,
          adapterId: profile.adapterId,
          contractVersion: profile.contractVersion,
          transition: "route-missing",
        },
        evidence: [
          {
            evidenceKey: `${candidate.identityKey}:route`,
            evidenceVersionId: routeVersion.id,
            sourceKind: "framework-route",
            role: "route",
            provenance: { normalizedValue: routeValue },
          },
        ],
        subjects: [reconciliationSubject],
      });
      return [
        {
          ...persisted,
          proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
          confidence: "certain",
          sourceKinds: ["framework-route"],
          surfaced: true,
        },
      ];
    });
}
