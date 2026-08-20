// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { fingerprint } from "./canonical.js";

export const SUBJECT_IDENTITY_CONTRACT_VERSION = "1" as const;

export type SubjectKind = "parameter" | "symbol" | "module" | "endpoint";

export interface SubjectIdentityV1 {
  id: string;
  kind: SubjectKind;
  identityKey: string;
  displayName: string;
  lifecycleState: "active" | "retired";
  contractVersion: typeof SUBJECT_IDENTITY_CONTRACT_VERSION;
}

/** Map a legacy ParameterIdentity to its deterministic G1 SubjectIdentity. */
export function parameterSubjectIdentity(
  parameterKey: string,
): SubjectIdentityV1 {
  if (parameterKey.trim().length === 0) {
    throw new Error("Parameter Subject identity requires a non-empty key");
  }
  const identityKey = `parameter:${parameterKey}`;
  return {
    id: `subject:${fingerprint(identityKey)}`,
    kind: "parameter",
    identityKey,
    displayName: parameterKey,
    lifecycleState: "active",
    contractVersion: SUBJECT_IDENTITY_CONTRACT_VERSION,
  };
}
