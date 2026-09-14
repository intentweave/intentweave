// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type Database from "@intentweave/sqlite-compat";
import {
  CLAIM_ORIGIN_CONTRACT_VERSION,
  canonicalJson,
  emptyPortableClaimsState,
  normalizeClaimOrigins,
  parseClaimOrigin,
  type ClaimOrigin,
  type PortableClaimOrigin,
  type PortableClaimsState,
} from "@intentweave/index";
import {
  loadPortableClaimsState,
  writePortableClaimsState,
} from "./portableState.js";

interface CandidateOriginRow {
  candidate_id: string;
  identity_key: string;
  observation_fingerprint: string;
  discovery_mode: "deterministic" | "semantic" | "manual";
  discovery_adapter_id: string;
  discovery_contract_version: string;
  candidate_provenance_json: string;
  review_id: string;
  actor_kind: string;
  actor_id: string;
  review_provenance_json: string;
  policy_id: string | null;
  policy_version: string | null;
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function reconstructedOrigin(row: CandidateOriginRow): ClaimOrigin {
  const source =
    row.discovery_mode === "semantic"
      ? "agent"
      : row.discovery_mode === "manual"
        ? "human"
        : "cari";
  return {
    contractVersion: CLAIM_ORIGIN_CONTRACT_VERSION,
    kind: "reconstructed",
    source,
    sourceIdentity: row.identity_key,
    sourceFingerprint: row.observation_fingerprint,
    provenance: {
      candidateId: row.candidate_id,
      candidateProvenance: parseRecord(row.candidate_provenance_json),
      discoveryAdapterId: row.discovery_adapter_id,
      discoveryContractVersion: row.discovery_contract_version,
      promotion: {
        reviewId: row.review_id,
        actorKind: row.actor_kind,
        actorId: row.actor_id,
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        provenance: parseRecord(row.review_provenance_json),
      },
    },
  };
}

/**
 * Project ingress provenance from existing Candidate/Policy records. This is
 * intentionally a read-time projection: G5.2a adds no Origin table or Claim
 * identity input, so the same Claim can have multiple Origins without a new
 * ClaimVersion.
 */
export function projectClaimOrigins(
  database: Database.Database,
  claimIdentityId: string,
  portableState?: PortableClaimsState,
): ClaimOrigin[] {
  const portableOrigins = portableState?.claimOrigins[claimIdentityId] ?? [];
  const rows = database
    .prepare(
      `SELECT candidate.id AS candidate_id,
              candidate.identity_key,
              candidate.observation_fingerprint,
              candidate.discovery_mode,
              candidate.discovery_adapter_id,
              candidate.discovery_contract_version,
              (
                SELECT original.provenance_json
                FROM claim_candidates original
                WHERE original.identity_key = candidate.identity_key
                  AND original.observation_fingerprint = candidate.observation_fingerprint
                ORDER BY original.version_ordinal ASC
                LIMIT 1
              ) AS candidate_provenance_json,
              review.id AS review_id,
              review.actor_kind,
              review.actor_id,
              review.provenance_json AS review_provenance_json,
              policy.policy_id,
              policy.policy_version
       FROM candidate_reviews review
       JOIN claim_candidates candidate
         ON candidate.id = review.candidate_id
       LEFT JOIN candidate_policy_decisions policy
         ON policy.candidate_id = review.candidate_id
        AND policy.promoted_claim_identity_id = review.promoted_claim_identity_id
       WHERE review.promoted_claim_identity_id = ?
         AND review.decision = 'promote'
         AND review.effect = 'effective'
       ORDER BY candidate.version_ordinal, review.created_at, review.id`,
    )
    .all(claimIdentityId) as CandidateOriginRow[];

  const origins: ClaimOrigin[] = [...portableOrigins, ...rows.map((row) => {
    const candidateProvenance = parseRecord(row.candidate_provenance_json);
    return parseClaimOrigin(candidateProvenance.origin) ??
      reconstructedOrigin(row);
  })];
  if (origins.length > 0) return normalizeClaimOrigins(origins);

  const legacy = database
    .prepare(
      `SELECT ci.identity_key, cv.id AS claim_version_id
       FROM claim_identities ci
       JOIN claim_versions cv ON cv.claim_identity_id = ci.id
       WHERE ci.id = ?
       ORDER BY cv.version_ordinal DESC
       LIMIT 1`,
    )
    .get(claimIdentityId) as
    | { identity_key: string; claim_version_id: string }
    | undefined;
  if (!legacy) return [];
  return [
    {
      contractVersion: CLAIM_ORIGIN_CONTRACT_VERSION,
      kind: "reconstructed",
      source: "cari",
      sourceIdentity: legacy.identity_key,
      sourceVersion: legacy.claim_version_id,
      provenance: {
        claimIdentityId,
        legacyProjection: true,
      },
    },
  ];
}

function portableOrigin(origin: ClaimOrigin): PortableClaimOrigin {
  return {
    ...origin,
    provenance: JSON.parse(canonicalJson(origin.provenance)) as PortableClaimOrigin["provenance"],
  };
}

/** Persist effective Origins without introducing a SQLite Origin relation. */
export function persistPortableClaimOrigins(
  workspaceRoot: string,
  database: Database.Database,
  claimIdentityId: string,
): string {
  const state = loadPortableClaimsState(workspaceRoot) ?? emptyPortableClaimsState();
  const origins = projectClaimOrigins(database, claimIdentityId, state);
  if (origins.length === 0) {
    throw new Error(`Claim ${claimIdentityId} has no Origin to persist`);
  }
  state.claimOrigins[claimIdentityId] = origins.map(portableOrigin);
  return writePortableClaimsState(workspaceRoot, state);
}