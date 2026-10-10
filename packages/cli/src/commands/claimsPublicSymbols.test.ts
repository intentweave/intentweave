// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { initSchema } from "@intentweave/index";
import {
  runClaimsCandidateReview,
  runClaimsCandidatesTriage,
  runClaimsCheck,
  runClaimsDiscover,
  runClaimsExplain,
  runClaimsReview,
} from "./claims.js";

describe("CLM-PUBLIC-SYMBOL-DOCUMENTED", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("discovers, promotes, evaluates, explains, and reopens public symbol Claims", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-public-symbol-claims-"),
    );
    try {
      mkdirSync(path.join(workspace, "src"), { recursive: true });
      mkdirSync(path.join(workspace, ".iw"), { recursive: true });
      writeFileSync(
        path.join(workspace, "src/public.ts"),
        "export function documented(): void {}\nexport function undocumented(): void {}\n",
      );
      const dbPath = path.join(workspace, ".iw/index.db");
      const database = new Database(dbPath);
      initSchema(database);
      const insertSymbol = database.prepare(
        `INSERT INTO symbols (
           id, name, kind, container, signature, file_path, line, end_line,
           export, doc_summary, is_internal
         ) VALUES (?, ?, 'function', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertSymbol.run(
        "symbol-documented",
        "documented",
        "documented(): void",
        "src/public.ts",
        1,
        1,
        "exported",
        "Handles a documented operation.",
        0,
      );
      insertSymbol.run(
        "symbol-undocumented",
        "undocumented",
        "undocumented(): void",
        "src/public.ts",
        2,
        2,
        "exported",
        null,
        0,
      );
      insertSymbol.run(
        "symbol-private",
        "privateHelper",
        "privateHelper(): void",
        "src/public.ts",
        3,
        3,
        "none",
        null,
        0,
      );
      insertSymbol.run(
        "symbol-internal",
        "internalHelper",
        "internalHelper(): void",
        "src/public.ts",
        4,
        4,
        "exported",
        null,
        1,
      );
      database.close();

      process.chdir(workspace);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await runClaimsDiscover({ all: true, format: "json" });
      const discovery = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        adapters: Array<{ id: string }>;
        candidates: Array<{
          id: string;
          identityKey: string;
          proposedClaimType: string;
          state: string;
          sourceKinds: string[];
        }>;
      };
      expect(discovery.adapters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "cari-public-symbol-documentation",
          }),
        ]),
      );
      expect(discovery.candidates).toHaveLength(2);
      expect(discovery.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identityKey: "public-symbol-doc:symbol-documented",
            proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
            state: "correlated",
            sourceKinds: ["code-documentation", "code-symbol"],
          }),
          expect.objectContaining({
            identityKey: "public-symbol-doc:symbol-undocumented",
            proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
            state: "correlated",
          }),
        ]),
      );
      const discoveredOnly = new Database(dbPath, { readonly: true });
      expect(
        discoveredOnly
          .prepare(`SELECT COUNT(*) AS count FROM claim_identities`)
          .get(),
      ).toEqual({ count: 0 });
      expect(
        discoveredOnly
          .prepare(`SELECT COUNT(*) AS count FROM evidence_versions`)
          .get(),
      ).toEqual({ count: 4 });
      discoveredOnly.close();

      const promote = async (identityKey: string) => {
        const candidate = discovery.candidates.find(
          (item) => item.identityKey === identityKey,
        )!;
        await runClaimsCandidatesTriage({
          candidate: candidate.id,
          format: "json",
        });
        const triage = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          candidates: Array<{ id: string }>;
        };
        await runClaimsCandidateReview({
          candidate: triage.candidates[0]!.id,
          actor: "reviewer",
          decision: "promote",
          rationale: "This public API is governed by documentation policy",
          format: "json",
        });
        return JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
          assessment: {
            id: string;
            claimIdentityId: string;
          };
          review: { candidate: { id: string } };
        };
      };

      const documented = await promote("public-symbol-doc:symbol-documented");
      const undocumented = await promote(
        "public-symbol-doc:symbol-undocumented",
      );
      const promoted = new Database(dbPath, { readonly: true });
      expect(
        promoted
          .prepare(
            `SELECT epistemic_status FROM claim_assessments WHERE id = ?`,
          )
          .get(documented.assessment.id),
      ).toEqual({ epistemic_status: "supported" });
      expect(
        promoted
          .prepare(
            `SELECT epistemic_status FROM claim_assessments WHERE id = ?`,
          )
          .get(undocumented.assessment.id),
      ).toEqual({ epistemic_status: "refuted" });
      expect(
        promoted
          .prepare(
            `SELECT normalized_status FROM rule_result_versions
             ORDER BY normalized_status`,
          )
          .all(),
      ).toEqual([
        { normalized_status: "failed" },
        { normalized_status: "passed" },
      ]);
      expect(
        promoted
          .prepare(`SELECT COUNT(*) AS count FROM parameter_identities`)
          .get(),
      ).toEqual({ count: 0 });
      promoted.close();

      log.mockClear();
      await runClaimsExplain({
        claim: documented.review.candidate.id,
        format: "json",
      });
      const explanation = JSON.parse(
        String(log.mock.calls.at(-1)?.[0]),
      ) as Array<{
        claimIdentityId: string;
        status: string;
        subjects: Array<{ kind: string; identityKey: string }>;
        dependencies: Array<{
          dependency_kind: string;
          epistemic_role: string;
          rule_status: string;
          rule_reasons: string[];
        }>;
      }>;
      expect(explanation[0]).toMatchObject({
        claimIdentityId: documented.assessment.claimIdentityId,
        status: "supported",
        subjects: [{ kind: "symbol", identityKey: "symbol:symbol-documented" }],
        dependencies: [
          {
            dependency_kind: "rule_result_version",
            epistemic_role: "warrant",
            rule_status: "passed",
            rule_reasons: ["public-symbol-documentation-present"],
          },
        ],
      });

      await runClaimsReview({
        claim: documented.assessment.claimIdentityId,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
      const signatureIndex = new Database(dbPath);
      signatureIndex
        .prepare(`UPDATE symbols SET signature = ? WHERE id = ?`)
        .run("documented(value: string): void", "symbol-documented");
      signatureIndex.close();
      process.exitCode = undefined;
      await runClaimsCheck({ format: "json" });

      const signatureChanged = new Database(dbPath, { readonly: true });
      expect(
        signatureChanged
          .prepare(
            `SELECT assessment.epistemic_status
             FROM claim_assessments assessment
             JOIN claim_versions version ON version.id = assessment.claim_version_id
             WHERE version.claim_identity_id = ? AND assessment.is_current = 1`,
          )
          .get(documented.assessment.claimIdentityId),
      ).toEqual({ epistemic_status: "supported" });
      expect(
        signatureChanged
          .prepare(
            `SELECT reason, status FROM review_decision_reopens
             WHERE claim_identity_id = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(documented.assessment.claimIdentityId),
      ).toEqual({ reason: "warrant-changed", status: "open" });
      signatureChanged.close();
      expect(process.exitCode).toBe(1);
      await runClaimsReview({
        claim: documented.assessment.claimIdentityId,
        actor: "reviewer",
        decision: "accepted",
        rationale: "The documented signature remains valid",
        format: "json",
      });

      const changedIndex = new Database(dbPath);
      changedIndex
        .prepare(`UPDATE symbols SET doc_summary = NULL WHERE id = ?`)
        .run("symbol-documented");
      changedIndex.close();

      process.exitCode = undefined;
      log.mockClear();
      await runClaimsCheck({ format: "json" });
      expect(vi.mocked(console.error).mock.calls).toEqual([]);
      const changedCheck = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        claims: Array<{
          claimIdentityId: string;
          ruleStatuses: string[];
          assessmentStatuses: string[];
        }>;
      };
      expect(changedCheck.claims).toContainEqual(
        expect.objectContaining({
          claimIdentityId: documented.assessment.claimIdentityId,
          ruleStatuses: ["failed"],
          assessmentStatuses: ["refuted"],
        }),
      );

      const changed = new Database(dbPath, { readonly: true });
      const current = changed
        .prepare(
          `SELECT assessment.epistemic_status
           FROM claim_assessments assessment
           JOIN claim_versions version ON version.id = assessment.claim_version_id
           WHERE version.claim_identity_id = ? AND assessment.is_current = 1`,
        )
        .get(documented.assessment.claimIdentityId);
      expect(current).toEqual({ epistemic_status: "refuted" });
      expect(
        changed
          .prepare(
            `SELECT decision.policy_id, decision.decision
             FROM candidate_policy_decisions decision
             JOIN claim_candidates candidate ON candidate.id = decision.candidate_id
             WHERE candidate.identity_key = ?
               AND decision.policy_id = 'promoted-claim-continuity'
             ORDER BY candidate.version_ordinal DESC LIMIT 1`,
          )
          .get("public-symbol-doc:symbol-documented"),
      ).toEqual({
        policy_id: "promoted-claim-continuity",
        decision: "promote",
      });
      expect(
        changed
          .prepare(
            `SELECT reason, status FROM review_decision_reopens
             WHERE claim_identity_id = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(documented.assessment.claimIdentityId),
      ).toEqual({ reason: "warrant-changed", status: "open" });
      changed.close();
      expect(process.exitCode).toBe(1);

      const removedIndex = new Database(dbPath);
      removedIndex
        .prepare(`DELETE FROM symbols WHERE id = ?`)
        .run("symbol-documented");
      removedIndex.close();
      process.exitCode = undefined;
      await runClaimsCheck({ format: "json" });
      const removedCheck = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        claims: Array<{
          claimIdentityId: string;
          ruleStatuses: string[];
        }>;
      };
      expect(removedCheck.claims).toContainEqual(
        expect.objectContaining({
          claimIdentityId: documented.assessment.claimIdentityId,
          ruleStatuses: ["not_applicable"],
        }),
      );

      const removed = new Database(dbPath, { readonly: true });
      expect(
        removed
          .prepare(
            `SELECT result.applicability, result.normalized_status
             FROM rule_result_versions result
             JOIN rule_result_identities identity
               ON identity.id = result.rule_result_identity_id
             WHERE identity.rule_id = 'R.public-symbol-documentation'
               AND identity.identity_key LIKE '%symbol:symbol-documented%'
             ORDER BY result.version_ordinal DESC LIMIT 1`,
          )
          .get(),
      ).toEqual({
        applicability: "not_applicable",
        normalized_status: "not_applicable",
      });
      expect(
        removed
          .prepare(
            `SELECT assessment.epistemic_status
             FROM claim_assessments assessment
             JOIN claim_versions version
               ON version.id = assessment.claim_version_id
             WHERE version.claim_identity_id = ?
               AND assessment.is_current = 1`,
          )
          .get(documented.assessment.claimIdentityId),
      ).toEqual({ epistemic_status: "inconclusive" });
      expect(
        removed
          .prepare(
            `SELECT candidate.state
             FROM claim_candidates candidate
             WHERE candidate.identity_key = ?
             ORDER BY candidate.version_ordinal DESC LIMIT 1`,
          )
          .get("public-symbol-doc:symbol-documented"),
      ).toEqual({ state: "promoted" });
      removed.close();

      log.mockClear();
      await runClaimsExplain({
        claim: documented.review.candidate.id,
        format: "json",
      });
      const retiredExplanation = JSON.parse(
        String(log.mock.calls.at(-1)?.[0]),
      ) as Array<{
        status: string;
        dependencies: Array<{
          rule_status: string;
          rule_reasons: string[];
        }>;
      }>;
      expect(retiredExplanation[0]).toMatchObject({
        status: "inconclusive",
        dependencies: [
          {
            rule_status: "not_applicable",
            rule_reasons: ["public-symbol-no-longer-applicable"],
          },
        ],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
