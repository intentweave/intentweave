// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Claim Relations through the CLI helpers (G5.4 slice 2). A relation is written to portable
 * state and restored into a rebuilt index, so it survives an index rebuild.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "@intentweave/sqlite-compat";
import {
  AbstractIntentStore,
  ClaimRelationStore,
  initSchema,
} from "@intentweave/index";
import {
  persistPortableAbstractAnchor,
  persistPortableAbstractRealization,
  persistPortableClaimRelation,
  projectPortableAbstractIntents,
  projectPortableClaimRelations,
} from "../claims/portableReviewProjection.js";
import { loadPortableClaimsState } from "../claims/portableState.js";
import { runClaimsRelationList } from "./claims.js";

describe("Claim Relations in portable state", () => {
  const workspaces: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  function seedClaims(database: Database.Database): void {
    database.exec(
      `INSERT INTO parameter_identities (id, canonical_key, created_at) VALUES ('param', 'param', 0)`,
    );
    for (const id of ["claim:design", "claim:impl"]) {
      database
        .prepare(
          `INSERT INTO claim_identities
             (id, parameter_identity_id, claim_type, scope, identity_key, created_at)
           VALUES (?, 'param', 'parameter', 'repo', ?, 0)`,
        )
        .run(id, id);
    }
  }

  it("restores a recorded relation into a rebuilt index from portable state", () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-relations-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw", "claims"), { recursive: true });

    const first = new Database(":memory:");
    initSchema(first);
    seedClaims(first);
    const relation = new ClaimRelationStore(first).add({
      sourceClaimIdentityId: "claim:impl",
      targetClaimIdentityId: "claim:design",
      relation: "realizes",
      actor: "reviewer",
      rationale: "implementation realizes the design",
      createdAt: 1_000,
    });
    persistPortableClaimRelation(workspace, relation);
    first.close();

    // A rebuilt index starts empty: the relation comes back from portable state alone.
    const rebuilt = new Database(":memory:");
    initSchema(rebuilt);
    seedClaims(rebuilt);
    const state = loadPortableClaimsState(workspace);
    expect(state).toBeDefined();
    expect(projectPortableClaimRelations(rebuilt, state!)).toEqual({
      imported: 1,
      skipped: 0,
    });
    expect(new ClaimRelationStore(rebuilt).realizersOf("claim:design")).toEqual(
      ["claim:impl"],
    );
    rebuilt.close();
  });

  it("reports a missing index as a binding error and does not create one", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-relations-"),
    );
    workspaces.push(workspace);
    process.chdir(workspace);
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await runClaimsRelationList({ format: "json" });
    expect(process.exitCode).toBe(64);
    expect(String(errors.mock.calls[0]?.[0])).toContain("Index not found");
  });

  it("restores an abstract intent's realizers and anchor into a rebuilt index", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-abstract-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw", "claims"), { recursive: true });
    const first = new Database(":memory:");
    initSchema(first);
    seedClaims(first);
    const store = new AbstractIntentStore(first);
    for (const id of ["claim:design", "claim:impl"]) {
      persistPortableAbstractRealization(
        workspace,
        store.realize({
          intentKey: "index-is-configurable",
          claimIdentityId: id,
          actor: "reviewer",
          createdAt: 1,
        }),
      );
    }
    persistPortableAbstractAnchor(
      workspace,
      store.protect({
        intentKey: "index-is-configurable",
        actor: "reviewer",
        createdAt: 2,
      }),
    );
    first.close();

    const rebuilt = new Database(":memory:");
    initSchema(rebuilt);
    seedClaims(rebuilt);
    const state = loadPortableClaimsState(workspace);
    expect(projectPortableAbstractIntents(rebuilt, state!)).toEqual({
      imported: 3,
      skipped: 0,
    });
    const restored = new AbstractIntentStore(rebuilt);
    expect(restored.activeRealizers("index-is-configurable")).toEqual([
      "claim:design",
      "claim:impl",
    ]);
    expect(restored.active().map((a) => a.intentKey)).toEqual([
      "index-is-configurable",
    ]);
    rebuilt.close();
  });
});
