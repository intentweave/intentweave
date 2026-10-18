// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Observation evaluation harness (Phase O4). Runs the TypeScript inventory on git
 * revisions, stores the runs, derives the ChangeSet, and scores the predicted change
 * items against labels. It uses the store directly, without a CARI index, so it
 * measures change detection and not the index.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LanguageRegistry,
  createTypeScriptAdapter,
  runObservationInventory,
} from "@intentweave/analyzer";
import { ObservationStore, fingerprint } from "@intentweave/index";
import type Database from "@intentweave/sqlite-compat";

export const EVALUATION_ADAPTER_ID = "typescript-observation";
export const EVALUATION_CONTRACT_VERSION = "1";

const SOURCE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Source files of a revision, as the observation command would list them. */
export function revisionSourceFiles(
  workspace: string,
  revision: string,
): string[] {
  return git(workspace, ["ls-tree", "-r", "--name-only", revision])
    .split("\n")
    .filter(
      (file) =>
        file.length > 0 && SOURCE_PATTERN.test(file) && !file.endsWith(".d.ts"),
    );
}

/** Git rename map between two revisions, one-to-one with rename detection on. */
export function revisionRenames(
  workspace: string,
  base: string,
  head: string,
): Map<string, string> {
  const output = git(workspace, ["diff", "--name-status", "-M", base, head]);
  const renames = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [status, from, to] = line.split("\t");
    if (status?.startsWith("R") && from && to) renames.set(from, to);
  }
  return renames;
}

/** Extract a revision to a temporary directory, from `git archive`. */
function extractRevision(workspace: string, revision: string): string {
  const archive = execFileSync(
    "git",
    ["-C", workspace, "archive", "--format=tar", revision],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iw-o4-"));
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  return directory;
}

/** Run the inventory on one revision and store it. Returns the run id. */
export function recordRevision(
  store: ObservationStore,
  workspace: string,
  revision: string,
): string {
  const files = revisionSourceFiles(workspace, revision);
  const extracted = extractRevision(workspace, revision);
  try {
    const registry = new LanguageRegistry().register(
      createTypeScriptAdapter({
        workspaceRoot: extracted,
        includePrivate: true,
        includeMembers: true,
        maxDepth: 2,
      }),
    );
    const inventory = runObservationInventory(registry, extracted, files);
    const coverage = Object.entries(inventory.coverage).map(
      ([kind, value]) => ({
        kind,
        status: value.status as Parameters<
          ObservationStore["recordRun"]
        >[0]["coverage"][number]["status"],
        ...("reason" in value && value.reason
          ? { reason: String(value.reason) }
          : {}),
        objectCount: "objectCount" in value ? Number(value.objectCount) : 0,
      }),
    );
    return store.recordRun({
      adapterId: EVALUATION_ADAPTER_ID,
      adapterContractVersion: EVALUATION_CONTRACT_VERSION,
      scope: { files, description: "tracked TypeScript and JavaScript files" },
      repositoryRevision: revision,
      coverage,
      unobservedFiles: inventory.unobservedFiles,
      records: inventory.records.map((record) => ({
        kind: record.kind,
        identityKey: record.identityKey,
        locator: record.locator,
        payload: record.payload,
      })),
    });
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

export interface ObservedChange {
  identityKey: string;
  kind: string;
}

/**
 * The ChangeSet between two stored runs, as identity keys and change kinds. The key is
 * the base identity, or the head identity for an added object.
 */
export function changesBetween(
  db: Database.Database,
  store: ObservationStore,
  baseRunId: string,
  headRunId: string,
  renames: ReadonlyMap<string, string>,
): ObservedChange[] {
  const changeSetId = store.computeChangeSet({
    baseRunId,
    headRunId,
    contractFingerprint: fingerprint({
      adapterId: EVALUATION_ADAPTER_ID,
      contract: EVALUATION_CONTRACT_VERSION,
    }),
    renames,
  });
  const keyOf = db.prepare(
    `SELECT identity_key FROM observed_identities WHERE id = ?`,
  );
  return store.changeItems(changeSetId).map((item) => ({
    identityKey: (
      keyOf.get(item.observedIdentityId) as { identity_key: string }
    ).identity_key,
    kind: item.changeKind,
  }));
}

export interface Score {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
}

/**
 * Score predicted changes against labels. A prediction is correct only when both the
 * identity and the kind match. Precision and recall are per kind, plus the total.
 */
export function scoreChanges(
  labels: readonly ObservedChange[],
  predicted: readonly ObservedChange[],
): { total: Score; byKind: Record<string, Score> } {
  const keyOf = (change: ObservedChange) =>
    `${change.kind}\u0000${change.identityKey}`;
  const labelled = new Set(labels.map(keyOf));
  const found = new Set(predicted.map(keyOf));
  const kinds = new Set([...labels, ...predicted].map((change) => change.kind));

  const scoreFor = (filter: (kind: string) => boolean): Score => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const key of found) {
      if (!filter(key.split("\u0000")[0]!)) continue;
      if (labelled.has(key)) truePositives += 1;
      else falsePositives += 1;
    }
    for (const key of labelled) {
      if (!filter(key.split("\u0000")[0]!)) continue;
      if (!found.has(key)) falseNegatives += 1;
    }
    const predictedCount = truePositives + falsePositives;
    const labelCount = truePositives + falseNegatives;
    return {
      truePositives,
      falsePositives,
      falseNegatives,
      precision: predictedCount === 0 ? 1 : truePositives / predictedCount,
      recall: labelCount === 0 ? 1 : truePositives / labelCount,
    };
  };

  const byKind: Record<string, Score> = {};
  for (const kind of kinds)
    byKind[kind] = scoreFor((candidate) => candidate === kind);
  return { total: scoreFor(() => true), byKind };
}
