// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import {
  CandidateStore,
  canonicalJson,
  type PersistClaimCandidateInput,
  type PersistedCandidate,
} from "@intentweave/index";
import type { CodeEvidenceObservation } from "./discovery.js";

export const R1_DISCOVERY_ADAPTER_ID = "r1-code-values";
export const R1_DISCOVERY_CONTRACT_VERSION = "1";

export interface DiscoveredCandidateResult extends PersistedCandidate {
  proposedClaimType: string;
  confidence: "certain" | "probable";
  sourceKinds: string[];
  surfaced: boolean;
}

type R1CandidateInput = PersistClaimCandidateInput & {
  confidence: "certain" | "probable";
};

function r1CandidateInputs(
  observations: CodeEvidenceObservation[],
  repositoryRevision: string,
): R1CandidateInput[] {
  const groups = new Map<string, CodeEvidenceObservation[]>();
  for (const observation of observations) {
    const key = canonicalJson([
      observation.parameterKey,
      observation.claimType,
    ]);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const ordered = [...group].sort((left, right) =>
        canonicalJson([
          left.sourceKind,
          left.identityKey,
          left.filePath,
          left.line,
        ]).localeCompare(
          canonicalJson([
            right.sourceKind,
            right.identityKey,
            right.filePath,
            right.line,
          ]),
        ),
      );
      const primary =
        ordered.find((item) => item.sourceKind === "code-default") ??
        ordered[0];
      const observedValues = [
        ...new Map(
          ordered.map((item) => [
            canonicalJson(item.normalizedValue),
            item.normalizedValue,
          ]),
        ).values(),
      ];
      const explicitBinding = primary.bindingBasis === "explicit-map";
      const confidence: R1CandidateInput["confidence"] = explicitBinding
        ? "certain"
        : "probable";
      return {
        identityKey: `r1:${primary.parameterKey}:${primary.claimType}`,
        candidateKind: "r1-code-value",
        proposedClaimType: primary.claimType,
        discoveryMode: "deterministic" as const,
        discoveryAdapterId: R1_DISCOVERY_ADAPTER_ID,
        discoveryContractVersion: R1_DISCOVERY_CONTRACT_VERSION,
        confidence,
        normalizedStatement: {
          subject: primary.parameterKey,
          predicate:
            primary.claimType === "CLM-DEFAULT" ? "defaults-to" : "equals",
          value: primary.normalizedValue,
          observedValues,
        },
        provenance: {
          repositoryRevision,
          adapterId: R1_DISCOVERY_ADAPTER_ID,
          contractVersion: R1_DISCOVERY_CONTRACT_VERSION,
        },
        evidence: ordered.map((item) => ({
          evidenceKey: item.identityKey,
          sourceKind: item.sourceKind,
          role: "source",
          provenance: {
            filePath: item.filePath,
            symbolId: item.symbolId,
            line: item.line,
            semanticLocation: item.semanticLocation,
            normalizedValue: item.normalizedValue,
            bindingBasis: item.bindingBasis ?? null,
            bindingConfidence: item.bindingConfidence ?? null,
          },
        })),
        subjects: [
          {
            kind: "parameter" as const,
            identityKey: `parameter:${primary.parameterKey}`,
            displayName: primary.parameterKey,
            role: "subject",
            basis: explicitBinding ? "explicit-binding" : "r1-discovery",
            confidence,
          },
        ],
      };
    })
    .sort((left, right) => left.identityKey.localeCompare(right.identityKey));
}

/** Persist deterministic R1 findings as Candidates without activating Claims. */
export function persistR1Candidates(
  store: CandidateStore,
  observations: CodeEvidenceObservation[],
  repositoryRevision: string,
): DiscoveredCandidateResult[] {
  return r1CandidateInputs(observations, repositoryRevision).map((input) => {
    const candidate = store.persist(input);
    const sourceKinds = [
      ...new Set(input.evidence.map((item) => item.sourceKind)),
    ].sort();
    return {
      ...candidate,
      proposedClaimType: input.proposedClaimType,
      confidence: input.confidence,
      sourceKinds,
      surfaced: input.confidence === "certain" || sourceKinds.length >= 2,
    };
  });
}
