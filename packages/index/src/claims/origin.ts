// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson, fingerprint } from "./canonical.js";

export const CLAIM_ORIGIN_CONTRACT_VERSION = "1" as const;

export type ClaimOriginKind = "reconstructed" | "declared" | "imported";
export type ClaimOriginSource =
  | "cari"
  | "human"
  | "adr"
  | "spec"
  | "agent"
  | "external-rm";

export interface ClaimOrigin {
  contractVersion: typeof CLAIM_ORIGIN_CONTRACT_VERSION;
  kind: ClaimOriginKind;
  source: ClaimOriginSource;
  sourceIdentity: string;
  sourceVersion?: string;
  sourceFingerprint?: string;
  provenance: unknown;
}

function originKey(origin: ClaimOrigin): string {
  return canonicalJson({
    contractVersion: origin.contractVersion,
    kind: origin.kind,
    source: origin.source,
    sourceIdentity: origin.sourceIdentity,
    sourceVersion: origin.sourceVersion ?? null,
    sourceFingerprint: origin.sourceFingerprint ?? null,
  });
}

/** Stable identity for an Origin projection; it is not a Claim identity input. */
export function claimOriginFingerprint(origin: ClaimOrigin): string {
  return fingerprint(originKey(origin));
}

/**
 * Keep equivalent Origins deterministic and preserve the full provenance of
 * the lexicographically smallest equivalent projection.
 */
export function normalizeClaimOrigins(
  origins: readonly ClaimOrigin[],
): ClaimOrigin[] {
  const selected = new Map<string, ClaimOrigin>();
  for (const origin of origins) {
    const key = originKey(origin);
    const previous = selected.get(key);
    if (!previous || canonicalJson(origin) < canonicalJson(previous)) {
      selected.set(key, origin);
    }
  }
  return [...selected.values()].sort((left, right) =>
    originKey(left).localeCompare(originKey(right)),
  );
}

/** Parse an Origin carried by an existing Candidate/provenance record. */
export function parseClaimOrigin(value: unknown): ClaimOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const origin = value as Record<string, unknown>;
  if (
    origin.contractVersion !== CLAIM_ORIGIN_CONTRACT_VERSION ||
    typeof origin.kind !== "string" ||
    !["reconstructed", "declared", "imported"].includes(origin.kind) ||
    typeof origin.source !== "string" ||
    !["cari", "human", "adr", "spec", "agent", "external-rm"].includes(
      origin.source,
    ) ||
    typeof origin.sourceIdentity !== "string" ||
    origin.sourceIdentity.trim().length === 0 ||
    (origin.sourceVersion === undefined &&
      origin.sourceFingerprint === undefined) ||
    (origin.sourceVersion !== undefined &&
      typeof origin.sourceVersion !== "string") ||
    (origin.sourceFingerprint !== undefined &&
      typeof origin.sourceFingerprint !== "string")
  ) {
    return undefined;
  }
  return {
    contractVersion: CLAIM_ORIGIN_CONTRACT_VERSION,
    kind: origin.kind as ClaimOriginKind,
    source: origin.source as ClaimOriginSource,
    sourceIdentity: origin.sourceIdentity,
    ...(origin.sourceVersion === undefined
      ? {}
      : { sourceVersion: origin.sourceVersion }),
    ...(origin.sourceFingerprint === undefined
      ? {}
      : { sourceFingerprint: origin.sourceFingerprint }),
    provenance: origin.provenance ?? {},
  };
}
