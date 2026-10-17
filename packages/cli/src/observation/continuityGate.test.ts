// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBSERVATION_CONFIG,
  ObservationConfigError,
  evaluateContinuityGate,
  parseObservationConfig,
} from "./continuityGate.js";

const UNRESOLVED_CLAIM = { identityKey: "symbol:claim", isClaimSubject: true };
const UNRESOLVED_INVENTORY = {
  identityKey: "symbol:inventory",
  isClaimSubject: false,
};

describe("continuity checker configuration", () => {
  it("defaults to report mode, so an upgrade never fails CI on its own", () => {
    expect(parseObservationConfig(undefined)).toEqual(
      DEFAULT_OBSERVATION_CONFIG,
    );
    const result = evaluateContinuityGate(DEFAULT_OBSERVATION_CONFIG, [
      UNRESOLVED_CLAIM,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.reported).toEqual([UNRESOLVED_CLAIM]);
  });

  it("parses an explicit gate for Claim Subjects", () => {
    const config = parseObservationConfig(
      'schemaVersion: "1"\ncontinuity:\n  mode: gate\n  scopes: [claim-subjects]\n',
    );
    expect(config.continuity).toEqual({
      mode: "gate",
      scopes: ["claim-subjects"],
    });
  });

  it("rejects an unknown schema version, mode, or scope", () => {
    expect(() => parseObservationConfig('schemaVersion: "2"\n')).toThrow(
      ObservationConfigError,
    );
    expect(() =>
      parseObservationConfig(
        'schemaVersion: "1"\ncontinuity:\n  mode: block\n',
      ),
    ).toThrow(/report or gate/);
    expect(() =>
      parseObservationConfig(
        'schemaVersion: "1"\ncontinuity:\n  scopes: [everything]\n',
      ),
    ).toThrow(/claim-subjects or all/);
  });
});

describe("continuity gate", () => {
  const gate = parseObservationConfig(
    'schemaVersion: "1"\ncontinuity:\n  mode: gate\n  scopes: [claim-subjects]\n',
  );

  it("fails CI only for unresolved continuity on configured Claim Subjects", () => {
    const result = evaluateContinuityGate(gate, [
      UNRESOLVED_CLAIM,
      UNRESOLVED_INVENTORY,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.gated).toEqual([UNRESOLVED_CLAIM]);
    expect(result.reported).toEqual([UNRESOLVED_INVENTORY]);
  });

  it("passes when nothing is unresolved", () => {
    expect(evaluateContinuityGate(gate, []).exitCode).toBe(0);
  });

  it("never blocks inventory-only continuity under a claim-subjects gate", () => {
    expect(evaluateContinuityGate(gate, [UNRESOLVED_INVENTORY]).exitCode).toBe(
      0,
    );
  });
});
