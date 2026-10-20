// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Observation commands (Phase G5.3, O2): capture an inventory run for a revision,
 * and check a range against its merge base with the continuity gate.
 *
 * A run reads files from `git archive` of its revision, so a run depends on the
 * revision alone and not on the working tree. CARI ids are attached only for HEAD,
 * because only the index matches the working tree. The index is optional.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import {
  ObservationStore,
  fingerprint,
  openMigratedDatabase,
  type RunCoverageInput,
  type RunRecordInput,
} from "@intentweave/index";
import {
  LanguageRegistry,
  createTypeScriptAdapter,
  runObservationInventory,
} from "@intentweave/analyzer";
import { minimatch } from "minimatch";
import { ClaimsGit } from "../claims/git.js";
import {
  DEFAULT_OBSERVATION_CONFIG,
  OBSERVATION_CONFIG_RELATIVE_PATH,
  evaluateContinuityGate,
  isInImplementationView,
  parseObservationConfig,
  type ObservationConfig,
  type UnresolvedContinuity,
} from "./continuityGate.js";

export const OBSERVATION_ADAPTER_ID = "typescript-observation";
export const OBSERVATION_CONTRACT_VERSION = "1";

export class ObservationCommandError extends Error {}

const SOURCE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function openStore(workspaceRoot: string): {
  db: Database.Database;
  store: ObservationStore;
} {
  const dbPath = path.join(workspaceRoot, ".iw", "index.db");
  if (!fs.existsSync(dbPath)) {
    throw new ObservationCommandError(
      `Index not found at ${dbPath}. Run \`iw index build\` first.`,
    );
  }
  const db = openMigratedDatabase(dbPath);
  return { db, store: new ObservationStore(db) };
}

/** Symbols of Claim Subjects, keyed by the CARI id that a symbol subject carries. */
function claimSymbolSubjects(db: Database.Database) {
  return (
    db
      .prepare(
        `SELECT DISTINCT subject.id AS subjectIdentityId, subject.identity_key AS identityKey
         FROM claim_subjects link
         JOIN subject_identities subject ON subject.id = link.subject_identity_id
         WHERE subject.identity_key LIKE 'symbol:%'`,
      )
      .all() as Array<{ subjectIdentityId: string; identityKey: string }>
  ).map((row) => ({
    subjectIdentityId: row.subjectIdentityId,
    cariId: row.identityKey.slice("symbol:".length),
  }));
}

/** CARI ids of the working tree's symbols, keyed by file, name, and line. */
function cariIdsByLocation(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare("SELECT id, name, file_path, line FROM symbols")
    .all() as Array<{
    id: string;
    name: string;
    file_path: string;
    line: number;
  }>;
  return new Map(
    rows.map((row) => [`${row.file_path}|${row.name}|${row.line}`, row.id]),
  );
}

/** Extract a revision into a temporary directory, from `git archive`. */
function extractRevision(workspaceRoot: string, revision: string): string {
  const archive = execFileSync(
    "git",
    ["-C", workspaceRoot, "archive", "--format=tar", revision],
    {
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iw-observation-"));
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  return directory;
}

/** The file an observed identity belongs to, or undefined for a dependency. */
export function identityFilePath(identityKey: string): string | undefined {
  if (identityKey.startsWith("file:")) return identityKey.slice("file:".length);
  if (identityKey.startsWith("module:"))
    return identityKey.slice("module:".length);
  if (identityKey.startsWith("symbol:")) {
    const rest = identityKey.slice("symbol:".length);
    const kindEnd = rest.indexOf(":");
    const hash = rest.indexOf("#", kindEnd + 1);
    return hash === -1 ? undefined : rest.slice(kindEnd + 1, hash);
  }
  if (identityKey.startsWith("call-site:")) {
    const rest = identityKey.slice("call-site:".length);
    const hash = rest.indexOf("#");
    return hash === -1 ? undefined : rest.slice(0, hash);
  }
  return undefined;
}

export interface ImplementationView {
  /** Files of the Claim Subjects. */
  subjectFiles: string[];
  /** Files that the Subject files import directly, from the CARI imports table. */
  directDependencyFiles: string[];
  /** Files matched by the configured globs. */
  globFiles: string[];
  /** Union of the three tiers, the files whose changes are in view. */
  files: string[];
}

/**
 * The implementation view (O2): Claim Subject files, their direct file dependencies
 * from the CARI imports table, and files matched by explicit globs.
 */
export function deriveImplementationView(
  db: Database.Database,
  subjectFiles: ReadonlySet<string>,
  allFiles: readonly string[],
  view: ObservationConfig["implementationView"],
  matchGlob: (filePath: string, glob: string) => boolean = (filePath, glob) =>
    minimatch(filePath, glob, { dot: true }),
): ImplementationView {
  const directDependencyFiles = new Set<string>();
  const importStatement = db.prepare(
    `SELECT DISTINCT target_file FROM imports WHERE source_file = ? AND target_file IS NOT NULL`,
  );
  for (const file of subjectFiles) {
    for (const row of importStatement.all(file) as Array<{
      target_file: string;
    }>) {
      directDependencyFiles.add(row.target_file);
    }
  }
  const globFiles = view.globs.length
    ? allFiles.filter((file) =>
        view.globs.some((glob) => matchGlob(file, glob)),
      )
    : [];
  const files = new Set([
    ...subjectFiles,
    ...directDependencyFiles,
    ...globFiles,
  ]);
  return {
    subjectFiles: [...subjectFiles].sort(),
    directDependencyFiles: [...directDependencyFiles].sort(),
    globFiles: [...new Set(globFiles)].sort(),
    files: [...files].sort(),
  };
}

/**
 * Retention (decision 3b): keep the membership of the runs a command uses and the
 * newest `retention.maxRuns` runs. Older membership is pruned; run headers stay.
 */
function applyRetention(
  store: ObservationStore,
  keepRunIds: readonly string[],
  config: ObservationConfig | undefined,
): void {
  store.pruneRuns({
    keepRunIds,
    maxRuns: (config ?? DEFAULT_OBSERVATION_CONFIG).retention.maxRuns,
  });
}

export interface CaptureSummary {
  runId: string;
  revision: string;
  coverage: Record<string, RunCoverageInput>;
  recordCount: number;
  trackedCount: number;
  bridgedSubjects: number;
}

/**
 * Capture one inventory run for a revision. A revision is captured from its archive.
 * HEAD also gets CARI ids and Claim Subject bridges, when the index is present.
 */
export function captureObservationRun(
  workspaceRoot: string,
  revision?: string,
  config?: ObservationConfig,
): CaptureSummary {
  const git = new ClaimsGit(workspaceRoot);
  const target = revision ?? git.head();
  const isHead = target === git.head();
  const files = git
    .listFiles(target)
    .filter((file) => SOURCE_PATTERN.test(file) && !file.endsWith(".d.ts"));

  const extracted = extractRevision(workspaceRoot, target);
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

    const indexPath = path.join(workspaceRoot, ".iw", "index.db");
    const withIndex = isHead && fs.existsSync(indexPath);
    const { db, store } = openStore(workspaceRoot);
    try {
      const cari = withIndex
        ? cariIdsByLocation(db)
        : new Map<string, string>();
      const records: RunRecordInput[] = inventory.records.map((record) => {
        const cariId =
          record.kind === "symbol" && record.locator.line !== undefined
            ? cari.get(
                `${record.locator.filePath}|${String(record.payload.name)}|${record.locator.line}`,
              )
            : undefined;
        return {
          kind: record.kind,
          identityKey: record.identityKey,
          locator: record.locator,
          payload: record.payload,
          ...(cariId ? { cariId } : {}),
        };
      });
      const coverage: RunCoverageInput[] = Object.entries(
        inventory.coverage,
      ).map(([kind, value]) => ({
        kind,
        status: value.status,
        ...("reason" in value && value.reason ? { reason: value.reason } : {}),
        objectCount: "objectCount" in value ? value.objectCount : 0,
      }));
      const runId = store.recordRun({
        adapterId: OBSERVATION_ADAPTER_ID,
        adapterContractVersion: OBSERVATION_CONTRACT_VERSION,
        scope: {
          files,
          description: "tracked TypeScript and JavaScript files",
        },
        repositoryRevision: target,
        coverage,
        records,
        unobservedFiles: inventory.unobservedFiles,
      });

      const view = config?.implementationView ?? {
        globs: [],
        exportedOnly: false,
      };
      const subjects = claimSymbolSubjects(db);
      const claimFiles = new Set(
        records
          .filter((record) => record.kind === "symbol" && record.cariId)
          .filter((record) =>
            subjects.some((subject) => subject.cariId === record.cariId),
          )
          .map((record) => record.locator.filePath),
      );
      const tracked = records.filter(
        (record) =>
          record.kind === "symbol" &&
          isInImplementationView(
            view,
            claimFiles,
            {
              filePath: record.locator.filePath,
              symbolName: String(record.payload.name),
              exported: record.payload.exported === true,
            },
            (filePath, glob) => minimatch(filePath, glob, { dot: true }),
          ),
      ).length;
      const bridgedSubjects = withIndex
        ? store.bridgeClaimSubjectsInRun(runId, subjects)
        : 0;
      applyRetention(store, [runId], config);

      return {
        runId,
        revision: target,
        coverage: Object.fromEntries(coverage.map((item) => [item.kind, item])),
        recordCount: records.length,
        trackedCount: tracked,
        bridgedSubjects,
      };
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

export function readObservationConfig(
  workspaceRoot: string,
): ObservationConfig {
  const file = path.join(workspaceRoot, OBSERVATION_CONFIG_RELATIVE_PATH);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined;
  return parseObservationConfig(text);
}

/**
 * The ChangeSet between a range's merge base and HEAD, opened for the caller, who must close
 * `db`. Used by the anchor impact check (G5.4 bridge). `checkObservations` keeps its own steps.
 */
export function observationChangeSet(
  workspaceRoot: string,
  since: string,
): {
  base: string;
  head: string;
  changeSetId: string;
  items: ReturnType<ObservationStore["changeItems"]>;
  db: Database.Database;
  store: ObservationStore;
} {
  const git = new ClaimsGit(workspaceRoot);
  const head = git.head();
  const base = git.mergeBase(since);
  const config = readObservationConfig(workspaceRoot);
  const baseRun = captureObservationRun(workspaceRoot, base, config);
  const headRun = captureObservationRun(workspaceRoot, head, config);
  const { db, store } = openStore(workspaceRoot);
  try {
    const contractFingerprint = fingerprint({
      adapterId: OBSERVATION_ADAPTER_ID,
      contract: OBSERVATION_CONTRACT_VERSION,
      kinds: ["file", "module", "symbol", "dependency", "call-site"],
    });
    const renames = new Map(
      git.renames(base, head).map((rename) => [rename.fromPath, rename.toPath]),
    );
    const changeSetId = store.computeChangeSet({
      baseRunId: baseRun.runId,
      headRunId: headRun.runId,
      contractFingerprint,
      renames,
    });
    return {
      base,
      head,
      changeSetId,
      items: store.changeItems(changeSetId),
      db,
      store,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface CheckSummary {
  base: string;
  head: string;
  changeSetId: string;
  counts: Record<string, number>;
  /** Change volume: all changes, those inside the implementation view, and the view size. */
  volume: {
    changes: number;
    inView: number;
    outOfView: number;
    viewFiles: number;
  };
  followedBridges: number;
  gate: ReturnType<typeof evaluateContinuityGate>;
  exitCode: 0 | 1;
}

/**
 * Check a range against its merge base. Captures HEAD and the merge base, derives the
 * ChangeSet from both, follows Subject bridges through moves, and applies the gate.
 */
export function checkObservations(
  workspaceRoot: string,
  since: string,
): CheckSummary {
  const git = new ClaimsGit(workspaceRoot);
  const head = git.head();
  const base = git.mergeBase(since);
  const config = readObservationConfig(workspaceRoot);

  const baseRun = captureObservationRun(workspaceRoot, base, config);
  const headRun = captureObservationRun(workspaceRoot, head, config);

  const { db, store } = openStore(workspaceRoot);
  try {
    const contractFingerprint = fingerprint({
      adapterId: OBSERVATION_ADAPTER_ID,
      contract: OBSERVATION_CONTRACT_VERSION,
      kinds: ["file", "module", "symbol", "dependency", "call-site"],
    });
    const renames = new Map(
      git.renames(base, head).map((rename) => [rename.fromPath, rename.toPath]),
    );
    const changeSetId = store.computeChangeSet({
      baseRunId: baseRun.runId,
      headRunId: headRun.runId,
      contractFingerprint,
      renames,
    });
    const items = store.changeItems(changeSetId);
    const followedBridges = store.followBridgesThroughChangeSet(
      changeSetId,
      headRun.runId,
    );

    const counts: Record<string, number> = {};
    for (const item of items)
      counts[item.changeKind] = (counts[item.changeKind] ?? 0) + 1;

    // Volume bound: the view is Subject files, their direct dependencies, and globs.
    const allFiles = git
      .listFiles(head)
      .filter((file) => SOURCE_PATTERN.test(file) && !file.endsWith(".d.ts"));
    const identityKeyOf = db.prepare(
      `SELECT identity_key FROM observed_identities WHERE id = ?`,
    );
    const keyOf = (identityId: string): string | undefined =>
      (identityKeyOf.get(identityId) as { identity_key: string } | undefined)
        ?.identity_key;
    const subjectFileSet = new Set<string>();
    const subjectIdentities = db
      .prepare(`SELECT DISTINCT observed_identity_id FROM subject_observations`)
      .all() as Array<{ observed_identity_id: string }>;
    for (const row of subjectIdentities) {
      const key = keyOf(row.observed_identity_id);
      const file = key ? identityFilePath(key) : undefined;
      if (file) subjectFileSet.add(file);
    }
    const view = deriveImplementationView(
      db,
      subjectFileSet,
      allFiles,
      config?.implementationView ?? { globs: [], exportedOnly: false },
    );
    const viewFiles = new Set(view.files);
    let inView = 0;
    for (const item of items) {
      const key = keyOf(item.observedIdentityId);
      const file = key ? identityFilePath(key) : undefined;
      if (file && viewFiles.has(file)) inView += 1;
    }
    const volume = {
      changes: items.length,
      inView,
      outOfView: items.length - inView,
      viewFiles: view.files.length,
    };

    const unresolved: UnresolvedContinuity[] = items
      .filter((item) => item.changeKind === "continuity-unclear")
      .map((item) => ({
        identityKey: item.observedIdentityId,
        isClaimSubject: store.hasSubjectBridge(item.observedIdentityId),
      }));
    const gate = evaluateContinuityGate(config, unresolved);
    applyRetention(store, [baseRun.runId, headRun.runId], config);
    return {
      base,
      head,
      changeSetId,
      counts,
      volume,
      followedBridges,
      gate,
      exitCode: gate.exitCode,
    };
  } finally {
    db.close();
  }
}
