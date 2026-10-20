// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  followUpsInChangeSet,
  IntentConfigError,
  parseIntentConfig,
  parseIntentConfigAt,
} from "./intentConfig.js";

const DIGEST = "a".repeat(64);

describe("intent.yaml", () => {
  it("defaults to report mode with no follow-ups", () => {
    expect(parseIntentConfig("")).toEqual({ mode: "report", followUps: [] });
  });

  it("parses a declared follow-up", () => {
    expect(
      parseIntentConfig(
        `schemaVersion: "1"\nmode: gate\nfollowUps:\n  - claimIdentityId: claim:x\n    statementFingerprint: ${DIGEST}\n`,
      ),
    ).toEqual({
      mode: "gate",
      followUps: [{ claimIdentityId: "claim:x", statementFingerprint: DIGEST }],
    });
  });

  it("rejects an unknown key, a malformed digest, and an unknown mode", () => {
    expect(() => parseIntentConfig("bogus: 1\n")).toThrow(IntentConfigError);
    expect(() =>
      parseIntentConfig(
        `followUps:\n  - claimIdentityId: claim:x\n    statementFingerprint: short\n`,
      ),
    ).toThrow("64-character lowercase hex digest");
    expect(() => parseIntentConfig("mode: strict\n")).toThrow("mode must be");
  });
});

describe("followUpsInChangeSet", () => {
  const a = {
    claimIdentityId: "claim:a",
    statementFingerprint: "a".repeat(64),
  };
  const b = {
    claimIdentityId: "claim:b",
    statementFingerprint: "b".repeat(64),
  };

  it("keeps only declarations the base configuration does not already contain", () => {
    expect(followUpsInChangeSet([a, b], [a])).toEqual([b]);
  });

  it("treats every head declaration as new when the base has none", () => {
    expect(followUpsInChangeSet([a], [])).toEqual([a]);
  });

  it("authorizes nothing when the head declares nothing", () => {
    expect(followUpsInChangeSet([], [a])).toEqual([]);
  });

  it("reads a missing base file as no declarations", () => {
    expect(parseIntentConfigAt(undefined)).toEqual({
      mode: "report",
      followUps: [],
    });
  });
});
