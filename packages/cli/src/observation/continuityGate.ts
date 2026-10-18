// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Continuity checker configuration and gate (Phase G5.3, O2).
 *
 * Reads `.iw/claims/observations.yaml` and decides whether unresolved continuity
 * fails a CI run. The default is report mode, so an upgrade never fails CI on its own.
 * The gate is evaluated without any model call. It is the only path from continuity
 * to an exit code, and it applies only to the scopes that the configuration names.
 */

import { load as yamlLoad } from "js-yaml";

export const OBSERVATION_CONFIG_RELATIVE_PATH = ".iw/claims/observations.yaml";

export type ContinuityMode = "report" | "gate";
export type ContinuityScope = "claim-subjects" | "all";

export interface ContinuityConfig {
  mode: ContinuityMode;
  scopes: ContinuityScope[];
}

export interface ImplementationViewConfig {
  /** Explicit file globs added to the derived view. */
  globs: string[];
  /** When true, only exported symbols are tracked in the view. */
  exportedOnly: boolean;
}

export interface RetentionConfig {
  /** Newest observation runs whose membership is kept, besides the runs a check uses. */
  maxRuns: number;
}

export interface ObservationConfig {
  continuity: ContinuityConfig;
  implementationView: ImplementationViewConfig;
  retention: RetentionConfig;
}

export const DEFAULT_OBSERVATION_CONFIG: ObservationConfig = {
  continuity: { mode: "report", scopes: ["claim-subjects"] },
  implementationView: { globs: [], exportedOnly: false },
  retention: { maxRuns: 20 },
};

export class ObservationConfigError extends Error {}

export function parseObservationConfig(
  text: string | undefined,
): ObservationConfig {
  if (text === undefined) return DEFAULT_OBSERVATION_CONFIG;
  const parsed = yamlLoad(text) as {
    schemaVersion?: unknown;
    continuity?: { mode?: unknown; scopes?: unknown };
    retention?: { maxRuns?: unknown };
  } | null;
  if (!parsed || typeof parsed !== "object") {
    throw new ObservationConfigError("observations.yaml must be a mapping");
  }
  if (parsed.schemaVersion !== "1") {
    throw new ObservationConfigError(
      'observations.yaml schemaVersion must be "1"',
    );
  }
  const mode = parsed.continuity?.mode ?? "report";
  if (mode !== "report" && mode !== "gate") {
    throw new ObservationConfigError(
      `continuity.mode must be report or gate, got ${String(mode)}`,
    );
  }
  const view = (
    parsed as {
      implementationView?: { globs?: unknown; exportedOnly?: unknown };
    }
  ).implementationView;
  const globs = view?.globs ?? [];
  if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string")) {
    throw new ObservationConfigError(
      "implementationView.globs must be a list of strings",
    );
  }
  const exportedOnly = view?.exportedOnly ?? false;
  if (typeof exportedOnly !== "boolean") {
    throw new ObservationConfigError(
      "implementationView.exportedOnly must be true or false",
    );
  }
  const scopes = parsed.continuity?.scopes ?? ["claim-subjects"];
  if (
    !Array.isArray(scopes) ||
    scopes.some((scope) => scope !== "claim-subjects" && scope !== "all")
  ) {
    throw new ObservationConfigError(
      "continuity.scopes must list claim-subjects or all",
    );
  }
  return {
    continuity: { mode, scopes: [...new Set(scopes as ContinuityScope[])] },
    implementationView: { globs: [...(globs as string[])], exportedOnly },
    retention: { maxRuns: parseMaxRuns(parsed) },
  };
}

function parseMaxRuns(parsed: { retention?: { maxRuns?: unknown } }): number {
  const maxRuns =
    parsed.retention?.maxRuns ?? DEFAULT_OBSERVATION_CONFIG.retention.maxRuns;
  if (
    typeof maxRuns !== "number" ||
    !Number.isInteger(maxRuns) ||
    maxRuns < 1
  ) {
    throw new ObservationConfigError(
      "retention.maxRuns must be a whole number of at least 1",
    );
  }
  return maxRuns;
}

export interface UnresolvedContinuity {
  identityKey: string;
  isClaimSubject: boolean;
}

export interface ContinuityGateResult {
  exitCode: 0 | 1;
  mode: ContinuityMode;
  gated: UnresolvedContinuity[];
  reported: UnresolvedContinuity[];
}

/**
 * Evaluate the gate. Unresolved continuity fails only in gate mode and only for the
 * configured scopes. Everything else is reported, never blocking.
 */
export function evaluateContinuityGate(
  config: ObservationConfig,
  unresolved: readonly UnresolvedContinuity[],
): ContinuityGateResult {
  const { mode, scopes } = config.continuity;
  const gatedScope = (item: UnresolvedContinuity) =>
    scopes.includes("all") ||
    (scopes.includes("claim-subjects") && item.isClaimSubject);
  const gated = mode === "gate" ? unresolved.filter(gatedScope) : [];
  const reported = unresolved.filter((item) => !gated.includes(item));
  return {
    exitCode: gated.length > 0 ? 1 : 0,
    mode,
    gated,
    reported,
  };
}

export interface TrackedCandidate {
  filePath: string;
  symbolName?: string;
  exported: boolean;
}

/**
 * The implementation view: the files of Claim Subjects, plus explicit globs, with an
 * optional exported-only filter on symbols. The derived part is never silently
 * extended by a glob, since globs are listed in the configuration.
 */
export function isInImplementationView(
  config: ImplementationViewConfig,
  claimSubjectFiles: ReadonlySet<string>,
  candidate: TrackedCandidate,
  matchGlob: (filePath: string, glob: string) => boolean,
): boolean {
  if (
    config.exportedOnly &&
    candidate.symbolName !== undefined &&
    !candidate.exported
  ) {
    return false;
  }
  if (claimSubjectFiles.has(candidate.filePath)) return true;
  return config.globs.some((glob) => matchGlob(candidate.filePath, glob));
}
