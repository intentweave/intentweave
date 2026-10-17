// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tracer spike for the generalized observation layer (Phase O-T).
 *
 * Captures complete runs of public TypeScript and JavaScript symbols, derives
 * generic change items between two runs, and predicts which Claim Subjects they
 * touch. It deliberately uses a separate spike store and is not migration 21.
 * It is a validation instrument, not the implementation of Phase O2.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import Database from "@intentweave/sqlite-compat";

export interface SymbolObservation {
  identityKey: string;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  payload: {
    name: string;
    kind: string;
    signature: string | null;
    documented: boolean;
    documentationHash: string | null;
    deprecated: boolean;
  };
  payloadFingerprint: string;
}

export type SpikeChangeKind =
  | "added"
  | "removed"
  | "moved"
  | "property-changed"
  | "not_comparable";

export interface SpikeChangeItem {
  kind: SpikeChangeKind;
  identityKey: string;
  successorIdentityKey?: string;
  changedProperties?: string[];
  basis: string;
}

const PROPERTY_NAMES = [
  "name",
  "kind",
  "signature",
  "documented",
  "documentationHash",
  "deprecated",
] as const;

/**
 * Observed identity of a symbol at creation: kind, file, and name. The CARI
 * symbol id is not used, because it embeds a hash of the signature, so a
 * signature change would look like a removal and an addition.
 */
export function symbolIdentityKey(
  kind: string,
  filePath: string,
  name: string,
): string {
  return `symbol:${kind}:${filePath}#${name}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function openSpikeStore(file: string): Database.Database {
  const database = new Database(file);
  database.exec(`
    CREATE TABLE IF NOT EXISTS spike_runs (
      id TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      complete INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS spike_observations (
      run_id TEXT NOT NULL REFERENCES spike_runs(id),
      identity_key TEXT NOT NULL,
      cari_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      PRIMARY KEY (run_id, identity_key)
    );
  `);
  return database;
}

/**
 * Read public symbols from a CARI index with the same selection rule as the
 * Claim discovery (exported, no container). `complete` is true only when the
 * index build covered the whole scope.
 */
export function captureSymbolRun(
  store: Database.Database,
  indexFile: string,
  revision: string,
  complete: boolean,
): string {
  const index = new Database(indexFile);
  let rows: Array<{
    id: string;
    name: string;
    kind: string;
    signature: string | null;
    doc_summary: string | null;
    deprecated: number;
    file_path: string;
    line: number;
  }>;
  try {
    rows = index
      .prepare(
        `SELECT id, name, kind, signature, doc_summary, deprecated, file_path, line
         FROM symbols
         WHERE (export = 'exported' OR export = 1)
           AND (container IS NULL OR container = '')
         ORDER BY file_path, line, id`,
      )
      .all() as typeof rows;
  } finally {
    index.close();
  }

  const runId = fingerprint({
    revision,
    complete,
    rows: rows.map((r) => r.id),
  }).slice(0, 32);
  store
    .prepare(
      "INSERT OR REPLACE INTO spike_runs (id, revision, complete, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(runId, revision, complete ? 1 : 0, Date.now());
  store.prepare("DELETE FROM spike_observations WHERE run_id = ?").run(runId);
  const insert = store.prepare(
    `INSERT INTO spike_observations
       (run_id, identity_key, cari_id, name, kind, file_path, line, payload_json, payload_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const payload = {
      name: row.name,
      kind: row.kind,
      signature: row.signature,
      documented: Boolean(row.doc_summary),
      documentationHash: row.doc_summary ? fingerprint(row.doc_summary) : null,
      deprecated: row.deprecated === 1,
    };
    insert.run(
      runId,
      symbolIdentityKey(row.kind, row.file_path, row.name),
      row.id,
      row.name,
      row.kind,
      row.file_path,
      row.line,
      JSON.stringify(payload),
      fingerprint(payload),
    );
  }
  return runId;
}

function readRun(
  store: Database.Database,
  runId: string,
): {
  complete: boolean;
  observations: Map<string, SymbolObservation>;
} {
  const run = store
    .prepare("SELECT complete FROM spike_runs WHERE id = ?")
    .get(runId) as { complete: number } | undefined;
  if (!run) throw new Error(`Unknown spike run ${runId}`);
  const observations = new Map<string, SymbolObservation>();
  for (const row of store
    .prepare("SELECT * FROM spike_observations WHERE run_id = ?")
    .all(runId) as Array<{
    identity_key: string;
    name: string;
    kind: string;
    file_path: string;
    line: number;
    payload_json: string;
    payload_fingerprint: string;
  }>) {
    observations.set(row.identity_key, {
      identityKey: row.identity_key,
      name: row.name,
      kind: row.kind,
      filePath: row.file_path,
      line: row.line,
      payload: JSON.parse(row.payload_json),
      payloadFingerprint: row.payload_fingerprint,
    });
  }
  return { complete: run.complete === 1, observations };
}

/**
 * Git rename map for file paths between two revisions. A rename keeps the
 * symbols of the old file reachable at the new file, by name and kind.
 */
export function gitRenames(
  workspace: string,
  baseRevision: string,
  headRevision: string,
): Map<string, string> {
  const output = execFileSync(
    "git",
    ["diff", "-M", "--name-status", baseRevision, headRevision],
    { cwd: workspace, encoding: "utf-8" },
  );
  const renames = new Map<string, string>();
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 3 && parts[0]!.startsWith("R")) {
      renames.set(parts[1]!, parts[2]!);
    }
  }
  return renames;
}

/**
 * ChangeSet between a base and a head run. It depends only on the two runs and
 * the rename map, so the output does not depend on which run was captured first.
 */
export function buildChangeSet(
  store: Database.Database,
  baseRunId: string,
  headRunId: string,
  renames: ReadonlyMap<string, string>,
): SpikeChangeItem[] {
  const base = readRun(store, baseRunId);
  const head = readRun(store, headRunId);
  const items: SpikeChangeItem[] = [];

  // Successor of a base symbol: same name and kind in the renamed file.
  const successorOf = new Map<string, string>();
  for (const [identityKey, observation] of base.observations) {
    const renamedTo = renames.get(observation.filePath);
    if (!renamedTo) continue;
    for (const candidate of head.observations.values()) {
      if (
        candidate.filePath === renamedTo &&
        candidate.name === observation.name &&
        candidate.kind === observation.kind &&
        !successorOf.has(identityKey)
      ) {
        successorOf.set(identityKey, candidate.identityKey);
      }
    }
  }
  const claimedHeads = new Set(successorOf.values());

  for (const [identityKey, observation] of base.observations) {
    if (head.observations.has(identityKey) && !successorOf.has(identityKey)) {
      const after = head.observations.get(identityKey)!;
      if (after.payloadFingerprint !== observation.payloadFingerprint) {
        const changed = PROPERTY_NAMES.filter(
          (name) =>
            JSON.stringify(observation.payload[name]) !==
            JSON.stringify(after.payload[name]),
        );
        items.push({
          kind: "property-changed",
          identityKey,
          changedProperties: changed,
          basis: "identity-equal",
        });
      }
      continue;
    }
    const successor = successorOf.get(identityKey);
    if (successor) {
      const after = head.observations.get(successor)!;
      const changed = PROPERTY_NAMES.filter(
        (name) =>
          JSON.stringify(observation.payload[name]) !==
          JSON.stringify(after.payload[name]),
      );
      items.push({
        kind: "moved",
        identityKey,
        successorIdentityKey: successor,
        changedProperties: changed,
        basis: "git-rename",
      });
      continue;
    }
    if (!head.complete || !base.complete) {
      items.push({
        kind: "not_comparable",
        identityKey,
        basis: "partial-coverage",
      });
    } else {
      items.push({ kind: "removed", identityKey, basis: "complete-coverage" });
    }
  }

  for (const identityKey of head.observations.keys()) {
    if (base.observations.has(identityKey) || claimedHeads.has(identityKey))
      continue;
    if (!head.complete || !base.complete) {
      items.push({
        kind: "not_comparable",
        identityKey,
        basis: "partial-coverage",
      });
    } else {
      items.push({ kind: "added", identityKey, basis: "complete-coverage" });
    }
  }

  return items.sort((left, right) =>
    `${left.kind}:${left.identityKey}`.localeCompare(
      `${right.kind}:${right.identityKey}`,
    ),
  );
}

/**
 * Predicted Claim impact: a change touches a Claim when it affects a Subject
 * identity the Claim depends on. A property change on a Subject is material for
 * the public-symbol contract only when signature or documentation changed. A move
 * alone is not.
 */
export function predictImpact(
  items: readonly SpikeChangeItem[],
  claimSubjectKeys: ReadonlySet<string>,
): { reopen: string[]; carryForward: string[] } {
  const reopen: string[] = [];
  const carryForward: string[] = [];
  for (const item of items) {
    if (!claimSubjectKeys.has(item.identityKey)) continue;
    if (item.kind === "property-changed") {
      const material = (item.changedProperties ?? []).some((property) =>
        ["signature", "documented", "documentationHash"].includes(property),
      );
      (material ? reopen : carryForward).push(item.identityKey);
    } else if (item.kind === "moved") {
      const material = (item.changedProperties ?? []).some((property) =>
        ["signature", "documented", "documentationHash"].includes(property),
      );
      (material ? reopen : carryForward).push(item.identityKey);
    } else if (item.kind === "removed" || item.kind === "not_comparable") {
      reopen.push(item.identityKey);
    }
  }
  return { reopen, carryForward };
}
