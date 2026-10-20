// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Inventory run (Phase O1). Observes a scope through the registered observation
 * adapters and reports completeness per kind.
 *
 * Coverage rules (per file, decision 1a):
 * - a kind is `complete` over the files that were observed. A file without an
 *   observation adapter, or one that fails to parse, is listed in `unobservedFiles`
 *   with its reason. Its objects are not comparable; no other object is affected;
 * - a failure that is not tied to one file (an unreadable manifest) makes its kind
 *   `partial`, with the reason;
 * - a kind that no adapter observes is `not_observed`, never absent.
 *
 * The run is in memory. Persistence in observation_runs and
 * observation_run_coverage is Phase O2 (migration 21).
 */

import type {
  LanguageRegistry,
  ObservationCapability,
  ObservationKind,
  ObservedRecord,
} from "../languageRegistry.js";
import { OBSERVATION_KINDS } from "../languageRegistry.js";

export type KindCoverage =
  | { status: "complete"; objectCount: number }
  | { status: "partial"; objectCount: number; reason: string }
  | { status: "not_observed"; reason: string }
  | { status: "unsupported"; reason: string };

export interface UnobservedFile {
  filePath: string;
  reason: string;
}

export interface InventoryRun {
  scope: { files: readonly string[] };
  coverage: Record<ObservationKind, KindCoverage>;
  records: ObservedRecord[];
  /** In-scope files that were not observed, each with its reason. */
  unobservedFiles: UnobservedFile[];
}

export function runObservationInventory(
  registry: LanguageRegistry,
  workspaceRoot: string,
  files: readonly string[],
): InventoryRun {
  const records: ObservedRecord[] = [];
  const failures = new Map<ObservationKind, string[]>();
  const unobservedFiles: UnobservedFile[] = [];
  const observedKinds = new Map<ObservationKind, number>();
  const declared = new Map<ObservationKind, ObservationCapability[]>();

  const note = (kind: ObservationKind, reason: string) => {
    failures.set(kind, [...(failures.get(kind) ?? []), reason]);
  };

  for (const file of [...files].sort()) {
    const adapter = registry.observationAdapterFor(file);
    if (!adapter?.observation) {
      unobservedFiles.push({
        filePath: file,
        reason: "no observation adapter for this file type",
      });
      continue;
    }
    for (const kind of OBSERVATION_KINDS) {
      declared.set(kind, [
        ...(declared.get(kind) ?? []),
        adapter.observation.capabilities[kind],
      ]);
    }
    try {
      for (const record of adapter.observation.observeFile(
        workspaceRoot,
        file,
      )) {
        records.push(record);
        observedKinds.set(
          record.kind,
          (observedKinds.get(record.kind) ?? 0) + 1,
        );
      }
    } catch (error) {
      unobservedFiles.push({
        filePath: file,
        reason: `observation failed: ${String(error)}`,
      });
    }
  }

  // Manifests are observed once per workspace by every adapter that owns one.
  const manifestAdapters = registry
    .observationAdapters()
    .filter((adapter) => adapter.observation?.observeManifest !== undefined);
  for (const adapter of manifestAdapters) {
    try {
      for (const record of adapter.observation!.observeManifest!(
        workspaceRoot,
      )) {
        records.push(record);
        observedKinds.set(
          record.kind,
          (observedKinds.get(record.kind) ?? 0) + 1,
        );
      }
    } catch (error) {
      note("dependency", `manifest failed: ${String(error)}`);
    }
  }
  const hasManifestAdapter = manifestAdapters.length > 0;

  const coverage = {} as Record<ObservationKind, KindCoverage>;
  for (const kind of OBSERVATION_KINDS) {
    const count = observedKinds.get(kind) ?? 0;
    if (kind === "dependency" && !hasManifestAdapter) {
      coverage[kind] = {
        status: "not_observed",
        reason: "no manifest observation adapter",
      };
      continue;
    }
    const capabilities = declared.get(kind) ?? [];
    const unsupported = capabilities.find(
      (item) => item.status === "unsupported",
    );
    const notObserved = capabilities.find(
      (item) => item.status === "not_observed",
    );
    if (
      capabilities.length === 0 &&
      !(kind === "dependency" && hasManifestAdapter)
    ) {
      coverage[kind] = {
        status: "not_observed",
        reason: "no observation adapter for in-scope files",
      };
      continue;
    }
    if (unsupported) {
      coverage[kind] = {
        status: "unsupported",
        reason: "adapter declares the kind unsupported",
      };
      continue;
    }
    if (notObserved && notObserved.status === "not_observed") {
      coverage[kind] = { status: "not_observed", reason: notObserved.reason };
      continue;
    }
    const reasons = [...(failures.get(kind) ?? [])];
    if (reasons.length > 0) {
      coverage[kind] = {
        status: "partial",
        objectCount: count,
        reason: reasons.join("; "),
      };
    } else {
      coverage[kind] = { status: "complete", objectCount: count };
    }
  }

  return {
    scope: { files: [...files].sort() },
    coverage,
    records,
    unobservedFiles: [...unobservedFiles].sort((a, b) =>
      a.filePath.localeCompare(b.filePath),
    ),
  };
}
