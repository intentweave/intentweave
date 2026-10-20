// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptyPortableClaimsState,
  type PortableClaimsState,
} from "@intentweave/index";
import {
  ClaimsPortableStateFileError,
  claimsPortableStatePath,
  loadPortableClaimsState,
  parsePortableClaimsStateYaml,
  serializePortableClaimsState,
  writePortableClaimsState,
} from "./portableState.js";

function stateWithPolicies(): PortableClaimsState {
  return {
    ...emptyPortableClaimsState(),
    policies: {
      zebra: { version: "1", enabled: true, configuration: {} },
      alpha: {
        version: "1",
        enabled: false,
        configuration: { sourceKinds: ["code-default"] },
      },
    },
  };
}

describe("Claims portable-state YAML", () => {
  it("migrates v1 input to canonical v4 and round-trips byte-identically", () => {
    const current = serializePortableClaimsState(stateWithPolicies());
    // v1 predates intent anchors and conflict decisions, so the input omits them.
    const v1 = current
      .replace('schemaVersion: "4"', 'schemaVersion: "1"')
      .replace(/^intentAnchors: \{\}\n/m, "")
      .replace(/^conflictDecisions: \{\}\n/m, "");
    const migrated = serializePortableClaimsState(
      parsePortableClaimsStateYaml(v1),
    );

    expect(migrated).toBe(current);
    expect(migrated).toContain('schemaVersion: "4"');
  });

  it("round-trips byte-identically with canonical map ordering", () => {
    const serialized = serializePortableClaimsState(stateWithPolicies());
    const roundTripped = serializePortableClaimsState(
      parsePortableClaimsStateYaml(serialized),
    );

    expect(roundTripped).toBe(serialized);
    expect(serialized.indexOf("alpha:")).toBeLessThan(
      serialized.indexOf("zebra:"),
    );
  });

  it("writes atomically and loads the validated state", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "iw-claims-state-"));
    try {
      expect(loadPortableClaimsState(workspace)).toBeUndefined();
      const filePath = writePortableClaimsState(workspace, stateWithPolicies());

      expect(filePath).toBe(claimsPortableStatePath(workspace));
      expect(loadPortableClaimsState(workspace)).toEqual(
        parsePortableClaimsStateYaml(readFileSync(filePath, "utf-8")),
      );
      expect(readdirSync(path.dirname(filePath))).toEqual(["state.yaml"]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not replace valid state when the next value is invalid", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "iw-claims-state-"));
    try {
      const filePath = writePortableClaimsState(workspace, stateWithPolicies());
      const before = readFileSync(filePath, "utf-8");

      expect(() =>
        writePortableClaimsState(workspace, {
          ...stateWithPolicies(),
          providerPayloads: { secret: true },
        }),
      ).toThrow("providerPayloads is not supported");
      expect(readFileSync(filePath, "utf-8")).toBe(before);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects duplicate YAML keys and unsupported versions", () => {
    expect(() =>
      parsePortableClaimsStateYaml(`
schemaVersion: "1"
schemaVersion: "1"
policies: {}
candidateDecisions: {}
subjectBindings: {}
assessmentReviews: {}
baselineAcceptances: {}
`),
    ).toThrow(ClaimsPortableStateFileError);

    expect(() =>
      parsePortableClaimsStateYaml(`
schemaVersion: "5"
policies: {}
candidateDecisions: {}
subjectBindings: {}
assessmentReviews: {}
baselineAcceptances: {}
`),
    ).toThrow("must be one of: 1, 2, 3, 4");
  });

  it("round-trips an AI-proposed Intent Anchor and rejects an unknown authority", () => {
    const anchor = {
      claimIdentityId: "claim:timeout",
      scope: "claim",
      statementFingerprint: "a".repeat(64),
      mode: "protect" as const,
      source: "review" as const,
      status: "active" as const,
      actor: { kind: "human" as const, id: "reviewer" },
      decidedAt: "2026-10-20T00:00:00.000Z",
    };
    const state = {
      ...stateWithPolicies(),
      intentAnchors: {
        "anchor:proposed": { ...anchor, authority: "ai-proposed" as const },
      },
    } as PortableClaimsState;

    const serialized = serializePortableClaimsState(state);
    const parsed = parsePortableClaimsStateYaml(serialized);
    expect(parsed.intentAnchors["anchor:proposed"]?.authority).toBe(
      "ai-proposed",
    );
    expect(serializePortableClaimsState(parsed)).toBe(serialized);

    const unknown = serialized.replace(
      "authority: ai-proposed",
      "authority: bogus",
    );
    expect(() => parsePortableClaimsStateYaml(unknown)).toThrow(/authority/);
  });
});
