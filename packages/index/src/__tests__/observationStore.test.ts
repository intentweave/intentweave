// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ClaimsStore } from "../claims/store.js";
import Database from "@intentweave/sqlite-compat";
import {
  initSchema,
  migrateSchemaToCurrent,
  CURRENT_SCHEMA_VERSION,
} from "../schema.js";
import {
  ObservationStore,
  type RecordRunInput,
  type RunRecordInput,
} from "../observation/observationStore.js";

function fresh() {
  const db = new Database(":memory:");
  initSchema(db);
  return { db, store: new ObservationStore(db) };
}

const FULL = ["file", "module", "symbol", "dependency", "call-site"] as const;

function complete(): RecordRunInput["coverage"] {
  return FULL.map((kind) => ({ kind, status: "complete", objectCount: 0 }));
}

function symbol(
  filePath: string,
  name: string,
  payload: Record<string, unknown> = {},
): RunRecordInput {
  return {
    kind: "symbol",
    identityKey: `symbol:function:${filePath}#${name}`,
    locator: { filePath, line: 1, endLine: 3 },
    payload: {
      name,
      container: null,
      signature: "(a: string): void",
      ...payload,
    },
  };
}

function run(
  store: ObservationStore,
  revision: string,
  records: RunRecordInput[],
  coverage: RecordRunInput["coverage"] = complete(),
  files: string[] = ["src/a.ts"],
): string {
  return store.recordRun({
    adapterId: "test-typescript",
    adapterContractVersion: "1",
    scope: { files, description: "tracked files" },
    repositoryRevision: revision,
    coverage,
    records,
  });
}

describe("observation store (migration 21)", () => {
  it("creates the observation tables on a fresh database at the current schema version", () => {
    const { db } = fresh();
    expect(CURRENT_SCHEMA_VERSION).toBe("21");
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'observ%'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "observation_runs",
        "observation_run_coverage",
        "observation_run_items",
        "observed_identities",
        "observed_versions",
        "observed_changesets",
        "observed_change_items",
      ]),
    );
  });

  it("records a run once and returns the same id for the same inputs", () => {
    const { store } = fresh();
    const first = run(store, "r1", [symbol("src/a.ts", "charge")]);
    const second = run(store, "r1", [symbol("src/a.ts", "charge")]);
    expect(second).toBe(first);
  });

  it("rejects a partial kind without a reason", () => {
    const { store } = fresh();
    expect(() =>
      run(
        store,
        "r1",
        [],
        [{ kind: "symbol", status: "partial", objectCount: 0 }],
      ),
    ).toThrow(/needs a reason/);
  });

  it("stores a version only when the payload or locator changes, and allows A -> B -> A history", () => {
    const { db, store } = fresh();
    const a = symbol("src/a.ts", "charge", { signature: "(a: string): void" });
    const b = symbol("src/a.ts", "charge", { signature: "(a: number): void" });
    run(store, "r1", [a]);
    run(store, "r2", [{ ...a }]);
    run(store, "r3", [b]);
    run(store, "r4", [a]);
    const versions = db
      .prepare(
        `SELECT version_ordinal FROM observed_versions version
         JOIN observed_identities identity ON identity.id = version.observed_identity_id
         WHERE identity.identity_key = ? ORDER BY version_ordinal`,
      )
      .all(a.identityKey) as Array<{ version_ordinal: number }>;
    expect(versions.map((row) => row.version_ordinal)).toEqual([1, 2, 3]);
  });

  it("rejects a run with the same identity key twice", () => {
    const { store } = fresh();
    expect(() =>
      run(store, "r1", [
        symbol("src/a.ts", "charge"),
        symbol("src/a.ts", "charge"),
      ]),
    ).toThrow(/Duplicate identity key/);
  });

  it("derives a signature change as property-changed on the same identity", () => {
    const { store } = fresh();
    const before = run(store, "r1", [symbol("src/a.ts", "charge")]);
    const after = run(store, "r2", [
      symbol("src/a.ts", "charge", {
        signature: "(a: string, currency: string): void",
      }),
    ]);
    const changeSet = store.computeChangeSet({
      baseRunId: before,
      headRunId: after,
      contractFingerprint: "c1",
      renames: new Map(),
    });
    expect(store.changeItems(changeSet)).toEqual([
      expect.objectContaining({
        changeKind: "property-changed",
        changedProperties: ["signature"],
      }),
    ]);
  });

  it("derives a rename as moved with the successor identity, not as removed and added", () => {
    const { store } = fresh();
    const before = run(store, "r1", [symbol("src/a.ts", "charge")]);
    const after = run(store, "r2", [symbol("src/b.ts", "charge")], complete(), [
      "src/b.ts",
    ]);
    const changeSet = store.computeChangeSet({
      baseRunId: before,
      headRunId: after,
      contractFingerprint: "c1",
      renames: new Map([["src/a.ts", "src/b.ts"]]),
    });
    const items = store.changeItems(changeSet);
    expect(items.map((item) => item.changeKind)).toEqual(["moved"]);
    expect(items[0]!.successorIdentityId).not.toBeNull();
  });

  it("keeps same-name declarations apart and reports an ambiguous rename as continuity-unclear", () => {
    const { store } = fresh();
    const before = run(store, "r1", [
      symbol("src/a.ts", "pick", { container: null }),
      {
        ...symbol("src/a.ts", "pick"),
        identityKey: "symbol:function:src/a.ts#pick~2",
      },
    ]);
    const after = run(
      store,
      "r2",
      [
        symbol("src/b.ts", "pick"),
        {
          ...symbol("src/b.ts", "pick"),
          identityKey: "symbol:function:src/b.ts#pick~2",
        },
      ],
      complete(),
      ["src/b.ts"],
    );
    const changeSet = store.computeChangeSet({
      baseRunId: before,
      headRunId: after,
      contractFingerprint: "c1",
      renames: new Map([["src/a.ts", "src/b.ts"]]),
    });
    const kinds = store.changeItems(changeSet).map((item) => item.changeKind);
    expect(kinds.every((kind) => kind === "continuity-unclear")).toBe(true);
    expect(kinds).toHaveLength(4);
  });

  it("reports removal only from complete coverage in both runs", () => {
    const { store } = fresh();
    const before = run(store, "r1", [
      symbol("src/a.ts", "charge"),
      symbol("src/a.ts", "refund"),
    ]);
    const completeAfter = run(store, "r2", [symbol("src/a.ts", "charge")]);
    const partialAfter = run(
      store,
      "r3",
      [symbol("src/a.ts", "charge")],
      [
        {
          kind: "symbol",
          status: "partial",
          reason: "parse error",
          objectCount: 1,
        },
        ...complete().filter((c) => c.kind !== "symbol"),
      ],
    );
    const renames = new Map<string, string>();
    const full = store.changeItems(
      store.computeChangeSet({
        baseRunId: before,
        headRunId: completeAfter,
        contractFingerprint: "c1",
        renames,
      }),
    );
    expect(full.map((item) => item.changeKind)).toEqual(["removed"]);
    const partial = store.changeItems(
      store.computeChangeSet({
        baseRunId: before,
        headRunId: partialAfter,
        contractFingerprint: "c1",
        renames,
      }),
    );
    expect(partial.map((item) => item.changeKind)).toEqual(["not_comparable"]);
  });

  it("produces the same ChangeSet for the same runs, whichever store recorded them first", () => {
    const first = fresh();
    const second = fresh();
    const records = (
      store: ObservationStore,
    ): { base: string; head: string } => {
      const base = run(store, "r1", [symbol("src/a.ts", "charge")]);
      const head = run(
        store,
        "r2",
        [symbol("src/b.ts", "charge")],
        complete(),
        ["src/b.ts"],
      );
      return { base, head };
    };
    // Second store records head before base.
    const headFirst = run(
      second.store,
      "r2",
      [symbol("src/b.ts", "charge")],
      complete(),
      ["src/b.ts"],
    );
    const baseSecond = run(second.store, "r1", [symbol("src/a.ts", "charge")]);
    const left = records(first.store);
    const renames = new Map([["src/a.ts", "src/b.ts"]]);
    const leftSet = first.store.computeChangeSet({
      baseRunId: left.base,
      headRunId: left.head,
      contractFingerprint: "c1",
      renames,
    });
    const rightSet = second.store.computeChangeSet({
      baseRunId: baseSecond,
      headRunId: headFirst,
      contractFingerprint: "c1",
      renames,
    });
    expect(
      first.store.changeItems(leftSet).map((item) => item.changeKind),
    ).toEqual(
      second.store.changeItems(rightSet).map((item) => item.changeKind),
    );
    // Recomputing returns the stored ChangeSet, not a second one.
    expect(
      first.store.computeChangeSet({
        baseRunId: left.base,
        headRunId: left.head,
        contractFingerprint: "c1",
        renames,
      }),
    ).toBe(leftSet);
  });

  it("binds a Subject only with a rule or review basis, and follows a move through the ChangeSet", () => {
    const { db, store } = fresh();
    const before = run(store, "r1", [symbol("src/a.ts", "charge")]);
    const after = run(store, "r2", [symbol("src/b.ts", "charge")], complete(), [
      "src/b.ts",
    ]);
    const observed = db
      .prepare("SELECT id FROM observed_identities WHERE identity_key = ?")
      .get("symbol:function:src/a.ts#charge") as { id: string };
    db.prepare(
      `INSERT INTO subject_identities (id, kind, identity_key, display_name, lifecycle_state, contract_version, created_at)
       VALUES ('subject-charge', 'symbol', 'symbol:canonical-charge', 'charge', 'active', '1', 0)`,
    ).run();
    expect(() =>
      store.bridgeSubject({
        subjectIdentityId: "subject-charge",
        observedIdentityId: observed.id,
        role: "subject",
        basis: "adhoc",
        contractVersion: "1",
      }),
    ).toThrow(/rule or review/);
    store.bridgeSubject({
      subjectIdentityId: "subject-charge",
      observedIdentityId: observed.id,
      role: "subject",
      basis: "rule:public-symbol-bridge@1",
      contractVersion: "1",
    });
    const changeSet = store.computeChangeSet({
      baseRunId: before,
      headRunId: after,
      contractFingerprint: "c1",
      renames: new Map([["src/a.ts", "src/b.ts"]]),
    });
    expect(store.followBridgesThroughChangeSet(changeSet, after)).toBe(1);
    const current = db
      .prepare(
        "SELECT observed_identity_id, basis FROM subject_observations WHERE subject_identity_id = ? AND retired_run_id IS NULL",
      )
      .all("subject-charge") as Array<{
      observed_identity_id: string;
      basis: string;
    }>;
    expect(current).toHaveLength(1);
    expect(current[0]!.observed_identity_id).not.toBe(observed.id);
    expect(current[0]!.basis).toBe("rule:observation-changeset-move@1");
  });

  it("projects an observed version into evidence that existing dependencies can reach", () => {
    const { db, store } = fresh();
    const base = run(store, "r1", [symbol("src/a.ts", "charge")]);
    const version = db
      .prepare(
        `SELECT version.id FROM observed_versions version
         JOIN observation_run_items item ON item.effective_version_id = version.id
         WHERE item.run_id = ?`,
      )
      .get(base) as { id: string };
    const evidenceVersionId = store.projectVersion({
      observedVersionId: version.id,
      projectionContractVersion: "1",
      evidence: {
        subjects: [
          {
            kind: "symbol",
            identityKey: "symbol:canonical-charge",
            displayName: "charge",
            role: "subject",
            basis: "rule:public-symbol-bridge@1",
            confidence: "certain",
          },
        ],
        sourceKind: "observed-symbol",
        identityKey: "observation:symbol:src/a.ts#charge",
        fingerprint: "fp1",
        materialFingerprint: "mfp1",
        normalizedValue: { signature: "(a: string): void" },
        semanticLocation: "src/a.ts#charge",
        provenance: { source: "observation" },
      },
    });
    const projected = db
      .prepare(
        "SELECT evidence_version_id FROM observed_evidence_projection WHERE observed_version_id = ?",
      )
      .get(version.id) as { evidence_version_id: string };
    expect(projected.evidence_version_id).toBe(evidenceVersionId);
  });

  it("stores change impacts separately from change items", () => {
    const { db, store } = fresh();
    const before = run(store, "r1", [symbol("src/a.ts", "charge")]);
    const after = run(store, "r2", [
      symbol("src/a.ts", "charge", { signature: "(x: number): void" }),
    ]);
    const changeSet = store.computeChangeSet({
      baseRunId: before,
      headRunId: after,
      contractFingerprint: "c1",
      renames: new Map(),
    });
    const item = store.changeItems(changeSet)[0]!;
    db.prepare(
      `INSERT INTO claim_identities
         (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
       VALUES ('claim-x', NULL, 'CLM-TEST', NULL, 'claim-x', 0)`,
    ).run();
    store.recordChangeImpact({
      changeItemId: item.id,
      claimIdentityId: "claim-x",
      materialityContractVersion: "m1",
      result: "material",
    });
    const impact = db
      .prepare("SELECT result FROM change_impacts WHERE change_item_id = ?")
      .get(item.id);
    expect(impact).toEqual({ result: "material" });
    expect(
      Object.keys(
        db
          .prepare("SELECT * FROM observed_change_items LIMIT 1")
          .get() as object,
      ),
    ).not.toContain("materiality");
  });
});

describe("migration 21 from schema 20", () => {
  it("upgrades a version 20 database without losing claims data", () => {
    const { db } = fresh();
    db.exec(
      "DROP TABLE observation_run_items; DROP TABLE observation_run_coverage; DROP TABLE observed_change_items; DROP TABLE observed_changesets; DROP TABLE change_impacts; DROP TABLE observed_evidence_projection; DROP TABLE subject_observations; DROP TABLE observed_continuity_links; DROP TABLE observed_relations; DROP TABLE observed_versions; DROP TABLE observed_identities; DROP TABLE observation_runs;",
    );
    db.prepare(
      "UPDATE _meta SET value = '20' WHERE key = 'schema_version'",
    ).run();
    migrateSchemaToCurrent(db);
    const version = db
      .prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(version.value).toBe("21");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observation_runs'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });
});

describe("Reverse Impact from projected observations", () => {
  it("finds the Claims whose assessments depend on evidence projected from a changed observation", () => {
    const { db, store } = fresh();
    const base = run(store, "r1", [symbol("src/a.ts", "charge")]);
    const version = db
      .prepare(
        `SELECT version.id FROM observed_versions version
         JOIN observation_run_items item ON item.effective_version_id = version.id
         WHERE item.run_id = ?`,
      )
      .get(base) as { id: string };
    const subject = {
      kind: "symbol" as const,
      identityKey: "symbol:canonical-charge",
      displayName: "charge",
      role: "subject",
      basis: "rule:claim-subject-bridge@1",
      confidence: "certain" as const,
    };
    const evidenceVersion = store.projectVersion({
      observedVersionId: version.id,
      projectionContractVersion: "1",
      evidence: {
        subjects: [subject],
        sourceKind: "observed-symbol",
        identityKey: "observation:symbol:src/a.ts#charge",
        fingerprint: "fp-1",
        materialFingerprint: "mfp-1",
        normalizedValue: { signature: "(a: string): void" },
        semanticLocation: "src/a.ts#charge",
        provenance: { source: "observation" },
      },
    });
    const claims = new ClaimsStore(db);
    const assessment = claims.persistGenericClaimAssessment({
      subjects: [{ ...subject, role: "subject" }],
      claimType: "CLM-OBSERVED-SYMBOL",
      identityContract: { id: "observed-symbol-identity", version: "1" },
      materialityContract: { id: "observed-symbol-materiality", version: "1" },
      normalizedStatement: { symbol: "charge" },
      assessmentPolicyId: "observed-symbol",
      assessmentPolicyVersion: "1",
      repositoryRevision: "r1",
      status: "supported",
      dependencies: [
        {
          dependencyKind: "evidence_version",
          dependencyVersionId: evidenceVersion,
          epistemicRole: "assertion",
          warrantPolarity: null,
          assessmentEffect: "neutral",
        },
      ],
    });
    const identity = db
      .prepare("SELECT id FROM observed_identities WHERE identity_key = ?")
      .get("symbol:function:src/a.ts#charge") as { id: string };
    expect(store.dependentClaims(identity.id)).toEqual([
      assessment.claimIdentityId,
    ]);

    // A signature change supersedes the projected evidence. The Claim still depends on
    // the superseded basis, so it is in Reverse Impact.
    const changed = run(store, "r2", [
      symbol("src/a.ts", "charge", { signature: "(a: number): void" }),
    ]);
    const changedVersion = db
      .prepare(
        `SELECT version.id FROM observed_versions version
         JOIN observation_run_items item ON item.effective_version_id = version.id
         WHERE item.run_id = ?`,
      )
      .get(changed) as { id: string };
    store.projectVersion({
      observedVersionId: changedVersion.id,
      projectionContractVersion: "1",
      evidence: {
        subjects: [subject],
        sourceKind: "observed-symbol",
        identityKey: "observation:symbol:src/a.ts#charge",
        fingerprint: "fp-2",
        materialFingerprint: "mfp-2",
        normalizedValue: { signature: "(a: number): void" },
        semanticLocation: "src/a.ts#charge",
        provenance: { source: "observation" },
      },
    });
    expect(store.dependentClaims(identity.id)).toEqual([
      assessment.claimIdentityId,
    ]);
  });

  it("returns no Claims for an observation that no assessment depends on", () => {
    const { db, store } = fresh();
    run(store, "r1", [symbol("src/a.ts", "unused")]);
    const identity = db
      .prepare("SELECT id FROM observed_identities WHERE identity_key = ?")
      .get("symbol:function:src/a.ts#unused") as { id: string };
    expect(store.dependentClaims(identity.id)).toEqual([]);
  });
});
