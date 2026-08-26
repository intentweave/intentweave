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
schemaVersion: "2"
policies: {}
candidateDecisions: {}
subjectBindings: {}
assessmentReviews: {}
baselineAcceptances: {}
`),
    ).toThrow("schemaVersion must be 1");
  });
});
