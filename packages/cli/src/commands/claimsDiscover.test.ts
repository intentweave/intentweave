// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { initSchema } from "@intentweave/index";
import {
  runClaimsCheck,
  runClaimsDiscover,
  runClaimsExplain,
} from "./claims.js";

describe("iw claims discover", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("persists deterministic R1 Candidates without activating Claims", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-candidate-discovery-"),
    );
    try {
      mkdirSync(path.join(workspace, "src"), { recursive: true });
      mkdirSync(path.join(workspace, ".iw"), { recursive: true });
      writeFileSync(
        path.join(workspace, "src/options.ts"),
        "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;\n",
      );
      const dbPath = path.join(workspace, ".iw/index.db");
      const database = new Database(dbPath);
      initSchema(database);
      database.close();
      process.chdir(workspace);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await runClaimsDiscover({ all: true, format: "json" });
      await runClaimsDiscover({ all: true, format: "json" });
      await runClaimsDiscover({ all: true, format: "json", semantic: true });

      const first = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        discoveredCount: number;
        surfacedCount: number;
        semanticDiscovery: string;
        candidates: Array<{ state: string; sourceKinds: string[] }>;
      };
      expect(first).toMatchObject({
        discoveredCount: 1,
        surfacedCount: 1,
        semanticDiscovery: "not_run",
      });
      expect(first.candidates[0]).toMatchObject({
        state: "discovered",
        sourceKinds: ["code-annotation", "code-default"],
      });
      const semantic = JSON.parse(String(log.mock.calls[2]?.[0])) as {
        semanticDiscovery: {
          status: string;
          groups: number;
          providerCalls: number;
        };
      };
      expect(semantic.semanticDiscovery).toMatchObject({
        status: "not_applicable",
        groups: 0,
        providerCalls: 0,
      });
      const persisted = new Database(dbPath, { readonly: true });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM claim_candidates`)
          .get(),
      ).toEqual({ count: 1 });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM candidate_evidence`)
          .get(),
      ).toEqual({ count: 2 });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM parameter_identities`)
          .get(),
      ).toEqual({ count: 0 });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM claim_identities`)
          .get(),
      ).toEqual({ count: 0 });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM candidate_inferences`)
          .get(),
      ).toEqual({ count: 0 });
      persisted.close();
      expect(process.exitCode).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps single-source probable Candidates behind --all", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-candidate-surfacing-"),
    );
    try {
      mkdirSync(path.join(workspace, "src"), { recursive: true });
      mkdirSync(path.join(workspace, ".iw"), { recursive: true });
      writeFileSync(
        path.join(workspace, "src/options.ts"),
        "export const MAX_RETRIES = 3;\n",
      );
      const database = new Database(path.join(workspace, ".iw/index.db"));
      initSchema(database);
      database.close();
      process.chdir(workspace);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await runClaimsDiscover({ format: "json" });

      const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        discoveredCount: number;
        surfacedCount: number;
        hiddenCount: number;
        candidates: unknown[];
      };
      expect(output).toMatchObject({
        discoveredCount: 1,
        surfacedCount: 0,
        hiddenCount: 1,
        candidates: [],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("promotes only explicit bindings with materialized Policy provenance", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-explicit-binding-"),
    );
    try {
      mkdirSync(path.join(workspace, "src"), { recursive: true });
      mkdirSync(path.join(workspace, ".iw"), { recursive: true });
      writeFileSync(
        path.join(workspace, "src/options.ts"),
        "export const PAGE_SIZE = 25;\nexport const MAX_RETRIES = 3;\n",
      );
      writeFileSync(
        path.join(workspace, "intentweave.bindings.yaml"),
        `parameters:
  ui.pageSize:
    codeDefaults:
      - file: src/options.ts
        export: PAGE_SIZE
`,
      );
      const dbPath = path.join(workspace, ".iw/index.db");
      const database = new Database(dbPath);
      initSchema(database);
      database.close();
      process.chdir(workspace);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await runClaimsDiscover({ all: true, format: "json" });
      await runClaimsDiscover({ all: true, format: "json" });

      const output = JSON.parse(String(log.mock.calls[1]?.[0])) as {
        discoveredCount: number;
        candidates: Array<{
          identityKey: string;
          state: string;
          confidence: string;
        }>;
      };
      expect(output.discoveredCount).toBe(2);
      expect(output.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identityKey: "r1:ui.pageSize:CLM-DEFAULT",
            state: "discovered",
            confidence: "certain",
          }),
          expect.objectContaining({
            state: "discovered",
            confidence: "probable",
          }),
        ]),
      );
      const discoveredOnly = new Database(dbPath, { readonly: true });
      expect(
        discoveredOnly
          .prepare(`SELECT COUNT(*) AS count FROM claim_assessments`)
          .get(),
      ).toEqual({ count: 0 });
      expect(
        discoveredOnly
          .prepare(`SELECT COUNT(*) AS count FROM candidate_policy_decisions`)
          .get(),
      ).toEqual({ count: 0 });
      discoveredOnly.close();

      log.mockClear();
      process.exitCode = undefined;
      await runClaimsCheck({ format: "json" });
      await runClaimsCheck({ format: "json" });

      const persisted = new Database(dbPath, { readonly: true });
      const policy = persisted
        .prepare(
          `SELECT decision.policy_id, decision.policy_version,
                  decision.promoted_claim_identity_id, review.actor_kind,
                  review.actor_id, review.effect
           FROM candidate_policy_decisions decision
           JOIN candidate_reviews review
             ON review.candidate_id = decision.candidate_id
            AND review.promoted_claim_identity_id = decision.promoted_claim_identity_id`,
        )
        .get() as {
        policy_id: string;
        policy_version: string;
        promoted_claim_identity_id: string;
        actor_kind: string;
        actor_id: string;
        effect: string;
      };
      expect(policy).toMatchObject({
        policy_id: "explicit-binding",
        policy_version: "1",
        actor_kind: "policy",
        actor_id: "explicit-binding",
        effect: "effective",
      });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM claim_identities`)
          .get(),
      ).toEqual({ count: 1 });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM claim_assessments`)
          .get(),
      ).toEqual({ count: 1 });
      expect(
        persisted
          .prepare(
            `SELECT link.basis, link.confidence
             FROM candidate_subjects link
             JOIN subject_identities subject ON subject.id = link.subject_identity_id
             JOIN claim_candidates candidate ON candidate.id = link.candidate_id
             WHERE candidate.identity_key = 'r1:ui.pageSize:CLM-DEFAULT'
             ORDER BY candidate.version_ordinal LIMIT 1`,
          )
          .get(),
      ).toEqual({ basis: "explicit-binding", confidence: "certain" });
      expect(
        persisted
          .prepare(`SELECT COUNT(*) AS count FROM candidate_policy_decisions`)
          .get(),
      ).toEqual({ count: 1 });
      persisted.close();

      log.mockClear();
      await runClaimsExplain({
        claim: policy.promoted_claim_identity_id,
        format: "json",
      });
      const explanation = JSON.parse(String(log.mock.calls[0]?.[0])) as Array<{
        promotion: {
          policy_id: string;
          policy_version: string;
          policy_rationale: string;
        };
      }>;
      expect(explanation[0]?.promotion).toMatchObject({
        policy_id: "explicit-binding",
        policy_version: "1",
        policy_rationale:
          "Activate the Claim selected by an explicit Parameter binding",
      });
      expect(process.exitCode).toBe(0);

      writeFileSync(
        path.join(workspace, "src/options.ts"),
        "export const PAGE_SIZE = 30;\nexport const MAX_RETRIES = 3;\n",
      );
      process.exitCode = undefined;
      await runClaimsCheck({ format: "json" });
      await runClaimsCheck({ format: "json" });

      const changed = new Database(dbPath, { readonly: true });
      expect(
        changed
          .prepare(`SELECT COUNT(*) AS count FROM candidate_policy_decisions`)
          .get(),
      ).toEqual({ count: 2 });
      expect(
        changed
          .prepare(
            `SELECT version.normalized_statement_json
             FROM claim_versions version
             JOIN claim_assessments assessment
               ON assessment.claim_version_id = version.id
              AND assessment.is_current = 1`,
          )
          .get(),
      ).toEqual({ normalized_statement_json: '{"value":30}' });
      expect(
        changed.prepare(`SELECT COUNT(*) AS count FROM claim_identities`).get(),
      ).toEqual({ count: 1 });
      changed.close();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
