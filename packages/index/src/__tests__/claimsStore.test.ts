// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { ClaimsStore } from "../claims/store.js";
import { fingerprint, materialFingerprint } from "../claims/canonical.js";
import { initSchema } from "../schema.js";

describe("ClaimsStore", () => {
  let db: Database.Database;
  let store: ClaimsStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    store = new ClaimsStore(db);
  });

  afterEach(() => db.close());

  it("deduplicates evidence fingerprints and increments changed versions", () => {
    const input = {
      parameterKey: "session.timeout",
      sourceKind: "code_default",
      identityKey: "src/session.ts:SESSION_TIMEOUT",
      normalizedValue: 1800,
      semanticLocation: "SESSION_TIMEOUT",
      provenance: { extractor: "claims-v1" },
    };
    const first = store.persistEvidence({
      ...input,
      fingerprint: fingerprint({ ...input, normalizedValue: 1800 }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: input.parameterKey,
        semanticLocation: input.semanticLocation,
        normalizedValue: 1800,
      }),
    });
    const repeated = store.persistEvidence({
      ...input,
      fingerprint: fingerprint({ ...input, normalizedValue: 1800 }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: input.parameterKey,
        semanticLocation: input.semanticLocation,
        normalizedValue: 1800,
      }),
    });
    const changed = store.persistEvidence({
      ...input,
      normalizedValue: 3600,
      fingerprint: fingerprint({ ...input, normalizedValue: 3600 }),
      materialFingerprint: materialFingerprint({
        parameterIdentity: input.parameterKey,
        semanticLocation: input.semanticLocation,
        normalizedValue: 3600,
      }),
    });

    expect(first).toMatchObject({ ordinal: 1, created: true });
    expect(repeated).toEqual({ ...first, created: false });
    expect(changed).toMatchObject({ ordinal: 2, created: true });
  });

  it("deduplicates normalized rule results and links their evidence", () => {
    const evidence = store.persistEvidence({
      parameterKey: "session.timeout",
      sourceKind: "config",
      identityKey: "config:session.timeout",
      fingerprint: "evidence-v1",
      materialFingerprint: "material-v1",
      normalizedValue: 1800,
      semanticLocation: "session.timeout",
      provenance: {},
    });
    const rule = {
      ruleId: "r3-effective-timeout",
      scope: "eu-prod",
      applicability: "applicable" as const,
      normalizedStatus: "passed" as const,
      normalizedOutput: { value: 1800 },
      normalizedReasons: ["config-present"],
      ruleContractVersion: "r3-v1",
      implementationFingerprint: "impl-v1",
    };

    const first = store.persistRuleResult(rule, [evidence.id]);
    const repeated = store.persistRuleResult(rule, [evidence.id]);
    const evidenceLinks = db
      .prepare(
        `SELECT evidence_version_id FROM rule_result_evidence
         WHERE rule_result_version_id = ?`,
      )
      .all(first.id) as Array<{ evidence_version_id: string }>;

    expect(first).toMatchObject({ ordinal: 1, created: true });
    expect(repeated).toEqual({ ...first, created: false });
    expect(evidenceLinks).toEqual([{ evidence_version_id: evidence.id }]);
  });
});