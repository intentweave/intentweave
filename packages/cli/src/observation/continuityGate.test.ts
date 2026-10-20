// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBSERVATION_CONFIG,
  ObservationConfigError,
  evaluateContinuityGate,
  isInImplementationView,
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

describe("implementation view", () => {
  const matchGlob = (filePath: string, glob: string) =>
    filePath.startsWith(glob.replace("/**", ""));
  const view = { globs: ["packages/api/**"], exportedOnly: false };

  it("tracks the files of Claim Subjects without any glob", () => {
    const files = new Set(["src/billing.ts"]);
    expect(
      isInImplementationView(
        { globs: [], exportedOnly: false },
        files,
        { filePath: "src/billing.ts", symbolName: "charge", exported: false },
        matchGlob,
      ),
    ).toBe(true);
  });

  it("adds files that match an explicit glob", () => {
    expect(
      isInImplementationView(
        view,
        new Set(),
        {
          filePath: "packages/api/routes.ts",
          symbolName: "route",
          exported: false,
        },
        matchGlob,
      ),
    ).toBe(true);
  });

  it("excludes unrelated files", () => {
    expect(
      isInImplementationView(
        view,
        new Set(["src/billing.ts"]),
        { filePath: "src/other.ts", symbolName: "other", exported: true },
        matchGlob,
      ),
    ).toBe(false);
  });

  it("keeps only exported symbols when exportedOnly is set", () => {
    const exportedOnly = { globs: [], exportedOnly: true };
    const files = new Set(["src/billing.ts"]);
    expect(
      isInImplementationView(
        exportedOnly,
        files,
        { filePath: "src/billing.ts", symbolName: "helper", exported: false },
        matchGlob,
      ),
    ).toBe(false);
    expect(
      isInImplementationView(
        exportedOnly,
        files,
        { filePath: "src/billing.ts", symbolName: "charge", exported: true },
        matchGlob,
      ),
    ).toBe(true);
  });

  it("parses the view and rejects malformed globs", () => {
    const config = parseObservationConfig(
      'schemaVersion: "1"\nimplementationView:\n  globs: ["packages/api/**"]\n  exportedOnly: true\n',
    );
    expect(config.implementationView).toEqual({
      globs: ["packages/api/**"],
      exportedOnly: true,
    });
    expect(() =>
      parseObservationConfig(
        'schemaVersion: "1"\nimplementationView:\n  globs: [1]\n',
      ),
    ).toThrow(ObservationConfigError);
  });
});

describe("retention setting", () => {
  it("defaults to 20 runs and reads an explicit value", () => {
    expect(parseObservationConfig(undefined).retention.maxRuns).toBe(20);
    expect(
      parseObservationConfig('schemaVersion: "1"\nretention:\n  maxRuns: 5\n')
        .retention.maxRuns,
    ).toBe(5);
  });

  it("rejects a value that is not a whole number of at least 1", () => {
    expect(() =>
      parseObservationConfig('schemaVersion: "1"\nretention:\n  maxRuns: 0\n'),
    ).toThrow(ObservationConfigError);
    expect(() =>
      parseObservationConfig(
        'schemaVersion: "1"\nretention:\n  maxRuns: 2.5\n',
      ),
    ).toThrow(ObservationConfigError);
  });
});
