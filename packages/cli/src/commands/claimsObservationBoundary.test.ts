// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision C boundary: `claims check` derives continuity from Git and the claims
 * tables. Observation tables are written by `observations capture` and read only by
 * the observation commands and the ObservationStore. This guard fails if a claims
 * path reads them, which would make `claims check` depend on capture history.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
// Explicit table names, so columns such as `observed_at` do not match.
const OBSERVATION_TABLE = new RegExp(
  `\\b(${[
    "observation_runs",
    "observation_run_coverage",
    "observation_run_items",
    "observed_identities",
    "observed_versions",
    "observed_relations",
    "observed_continuity_links",
    "observed_evidence_projection",
    "subject_observations",
    "observed_changesets",
    "observed_change_items",
    "change_impacts",
  ].join("|")})\\b`,
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [full] : [];
  });
}

describe("claims check does not read observation tables (decision C)", () => {
  const claimsDirectories = [
    path.resolve(here, "../claims"),
    path.resolve(here, "./claims.ts"),
    path.resolve(here, "../../../index/src/claims"),
  ];

  it("keeps observation table names out of claims discovery and assessment code", () => {
    // The guard is textual. It does not follow imports, so the command wiring in
    // claims.ts is allowed to call the observation module and nothing else.
    const offenders = claimsDirectories
      .flatMap((entry) =>
        statSync(entry).isDirectory() ? sourceFiles(entry) : [entry],
      )
      .filter((file) => OBSERVATION_TABLE.test(readFileSync(file, "utf-8")));
    expect(offenders).toEqual([]);
  });
});
