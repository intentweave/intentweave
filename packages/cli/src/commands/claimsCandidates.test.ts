// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateInferenceStore,
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import { parsePortableClaimsStateYaml } from "../claims/portableState.js";
import { shortCandidateReference } from "../claims/presentation.js";
import {
  runClaimsCandidateReview,
  runClaimsCandidatesTriage,
  runClaimsCheck,
  runClaimsDiscover,
  runClaimsExplain,
} from "./claims.js";

describe("iw claims candidates", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function workspace(): { root: string; dbPath: string } {
    const root = mkdtempSync(path.join(tmpdir(), "intentweave-candidates-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, ".iw"), { recursive: true });
    writeFileSync(
      path.join(root, "src/options.ts"),
      "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;\n",
    );
    const dbPath = path.join(root, ".iw/index.db");
    const database = new Database(dbPath);
    initSchema(database);
    database.close();
    return { root, dbPath };
  }

  async function discoverAndTriage(): Promise<{
    root: string;
    dbPath: string;
    candidateId: string;
  }> {
    const fixture = workspace();
    process.chdir(fixture.root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runClaimsDiscover({ all: true, format: "json" });
    const discovered = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string }>;
    };
    await runClaimsCandidatesTriage({
      candidate: shortCandidateReference(discovered.candidates[0]!.id),
      format: "json",
    });
    const triaged = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string; state: string }>;
    };
    expect(triaged.candidates[0]?.state).toBe("triaged");
    return { ...fixture, candidateId: triaged.candidates[0]!.id };
  }

  it("explains grounded semantic inference before Candidate promotion", async () => {
    const fixture = workspace();
    try {
      const database = new Database(fixture.dbPath);
      const evidenceVersionId = new ClaimsStore(
        database,
      ).persistGenericEvidence({
        subjects: [
          {
            kind: "symbol",
            identityKey: "symbol:parse-config-cli",
            displayName: "parseConfig",
            role: "subject",
            basis: "documentation-name-match",
            confidence: "probable",
          },
        ],
        sourceKind: "documentation-reference",
        identityKey: "documentation-reference:parse-config",
        fingerprint: fingerprint({ text: "CLI parseConfig reference" }),
        materialFingerprint: fingerprint({
          text: "CLI parseConfig reference",
        }),
        normalizedValue: { text: "CLI parseConfig reference" },
        semanticLocation: "docs/cli.md:10",
        provenance: { fixture: true },
        filePath: "docs/cli.md",
        spanStartLine: 10,
        spanEndLine: 10,
      }).id;
      const candidates = new CandidateStore(database);
      const discovered = candidates.persist({
        identityKey:
          "public-symbol-doc-correlation:doc:parseConfig:parse-config-cli",
        candidateKind: "public-symbol-documentation-correlation",
        proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
        discoveryMode: "deterministic",
        discoveryAdapterId: "cari-public-symbol-documentation",
        discoveryContractVersion: "1",
        confidence: "ambiguous",
        normalizedStatement: {
          symbolName: "parseConfig",
          symbolKind: "function",
          proposedDocumentationPath: "docs/cli.md",
          symbolFilePath: "packages/cli/src/config.ts",
        },
        provenance: { alternatives: ["parse-config-cli", "parse-config-core"] },
        evidence: [
          {
            evidenceKey: "documentation-reference:parse-config",
            evidenceVersionId,
            sourceKind: "documentation-reference",
            role: "documentation",
            provenance: { filePath: "docs/cli.md", line: 10 },
          },
        ],
        subjects: [
          {
            kind: "symbol",
            identityKey: "symbol:parse-config-cli",
            displayName: "parseConfig",
            role: "subject",
            basis: "ambiguous-documentation-name-match",
            confidence: "ambiguous",
          },
        ],
      });
      const inference = new CandidateInferenceStore(database).persist({
        identityKey:
          "semantic-symbol-correlation:documentation-reference:parse-config",
        adapterId: "semantic-symbol-documentation-correlation",
        contractVersion: "1",
        providerId: "fixture-v2",
        modelId: "fixture-model",
        promptVersion: "1",
        inputFingerprint: fingerprint({ evidenceVersionId }),
        normalizedOutput: {
          selectedCandidateIdentityKey:
            "public-symbol-doc-correlation:doc:parseConfig:parse-config-cli",
          evidenceVersionIds: [evidenceVersionId],
          rationale: "The CLI path identifies the intended Symbol.",
        },
        evidenceVersionIds: [evidenceVersionId],
        proposedSubjectBindings: [
          {
            role: "subject",
            subjectIdentityKey: "symbol:parse-config-cli",
          },
        ],
        confidence: "probable",
        rationale: "The CLI path identifies the intended Symbol.",
        provenance: { requestId: "fixture-request", finishReason: "stop" },
      });
      const correlated = candidates.attachInference(discovered.id, {
        inferenceId: inference.id,
        confidence: "probable",
        basis: "semantic-symbol-documentation-correlation",
        provenance: { fixture: true },
      });
      database.close();

      process.chdir(fixture.root);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await runClaimsExplain({
        claim: shortCandidateReference(correlated.id),
        format: "json",
      });
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        kind: string;
        candidate: { id: string; state: string; inferenceId: string };
        inference: {
          id: string;
          adapterId: string;
          confidence: string;
          rationale: string;
          evidenceVersionIds: string[];
        };
      };
      expect(output).toMatchObject({
        kind: "candidate",
        candidate: {
          id: correlated.id,
          state: "correlated",
          inferenceId: inference.id,
        },
        inference: {
          id: inference.id,
          adapterId: "semantic-symbol-documentation-correlation",
          confidence: "probable",
          rationale: "The CLI path identifies the intended Symbol.",
          evidenceVersionIds: [evidenceVersionId],
        },
      });

      log.mockClear();
      await runClaimsExplain({
        claim: shortCandidateReference(correlated.id),
        format: "text",
      });
      expect(log.mock.calls.flat().join("\n")).toContain(
        "Semantic inference: probable via semantic-symbol-documentation-correlation@1",
      );
      expect(log.mock.calls.flat().join("\n")).toContain(
        "Why: The CLI path identifies the intended Symbol.",
      );
      expect(process.exitCode).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("promotes a triaged R1 Candidate into a linked active Claim", async () => {
    const fixture = await discoverAndTriage();
    try {
      const log = vi.mocked(console.log);
      await runClaimsCandidateReview({
        candidate: shortCandidateReference(fixture.candidateId),
        actor: "benjamin",
        decision: "promote",
        rationale: "PAGE_SIZE is a repository contract",
        format: "json",
      });
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        review: { candidate: { id: string; state: string } };
        assessment: { claimIdentityId: string; id: string };
        portableStatePath: string;
      };
      expect(output.review.candidate.state).toBe("promoted");
      expect(output.assessment.claimIdentityId).toMatch(/^claim:/);
      const database = new Database(fixture.dbPath, { readonly: true });
      expect(
        database
          .prepare(
            `SELECT review.promoted_claim_identity_id, candidate.state
             FROM candidate_reviews review
             JOIN claim_candidates candidate
               ON candidate.identity_key = (
                 SELECT identity_key FROM claim_candidates WHERE id = review.candidate_id
               )
             WHERE review.decision = 'promote'
             ORDER BY candidate.version_ordinal DESC LIMIT 1`,
          )
          .get(),
      ).toEqual({
        promoted_claim_identity_id: output.assessment.claimIdentityId,
        state: "promoted",
      });
      expect(
        database
          .prepare(
            `SELECT epistemic_status FROM claim_assessments WHERE id = ?`,
          )
          .get(output.assessment.id),
      ).toEqual({ epistemic_status: "supported" });
      database.close();

      const portable = parsePortableClaimsStateYaml(
        readFileSync(output.portableStatePath, "utf-8"),
      );
      const decision = Object.values(portable.candidateDecisions)[0];
      expect(decision).toMatchObject({
        decision: "promote",
        actor: { kind: "human", id: "benjamin" },
        rationale: "PAGE_SIZE is a repository contract",
      });

      await runClaimsExplain({
        claim: output.assessment.claimIdentityId,
        format: "json",
      });
      const explanation = JSON.parse(
        String(log.mock.calls.at(-1)?.[0]),
      ) as Array<{
        promotion: { actor_kind: string; actor_id: string };
      }>;
      expect(explanation[0]?.promotion).toMatchObject({
        actor_kind: "human",
        actor_id: "benjamin",
      });

      log.mockClear();
      await runClaimsExplain({
        claim: shortCandidateReference(output.review.candidate.id),
        format: "json",
      });
      const candidateExplanation = JSON.parse(
        String(log.mock.calls.at(-1)?.[0]),
      ) as Array<{ claimIdentityId: string }>;
      expect(candidateExplanation[0]?.claimIdentityId).toBe(
        output.assessment.claimIdentityId,
      );

      rmSync(fixture.dbPath);
      const rebuilt = new Database(fixture.dbPath);
      initSchema(rebuilt);
      rebuilt.close();
      log.mockClear();
      process.exitCode = undefined;
      await runClaimsCheck({ format: "json" });

      expect(process.exitCode).toBe(4);
      const restored = new Database(fixture.dbPath, { readonly: true });
      expect(
        restored
          .prepare(
            `SELECT candidate.state, review.actor_kind, review.actor_id,
                    review.promoted_claim_identity_id
             FROM candidate_reviews review
             JOIN claim_candidates candidate
               ON candidate.identity_key = (
                 SELECT identity_key FROM claim_candidates WHERE id = review.candidate_id
               )
             WHERE review.decision = 'promote'
             ORDER BY candidate.version_ordinal DESC LIMIT 1`,
          )
          .get(),
      ).toEqual({
        state: "promoted",
        actor_kind: "human",
        actor_id: "benjamin",
        promoted_claim_identity_id: output.assessment.claimIdentityId,
      });
      restored.close();

      writeFileSync(
        path.join(fixture.root, "src/options.ts"),
        "/**\n * @default 30\n */\nexport const PAGE_SIZE = 30;\n",
      );
      log.mockClear();
      process.exitCode = undefined;
      await runClaimsCheck({ format: "json" });

      expect(process.exitCode).toBe(4);
      const changed = new Database(fixture.dbPath, { readonly: true });
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
        changed
          .prepare(
            `SELECT policy_id, decision
             FROM candidate_policy_decisions
             WHERE policy_id = 'promoted-claim-continuity'`,
          )
          .get(),
      ).toEqual({
        policy_id: "promoted-claim-continuity",
        decision: "promote",
      });
      changed.close();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("defers locally without activating a Claim or portable decision", async () => {
    const fixture = await discoverAndTriage();
    try {
      await runClaimsCandidateReview({
        candidate: fixture.candidateId,
        actor: "benjamin",
        decision: "defer",
        rationale: "Needs another independent source",
        format: "json",
      });
      const database = new Database(fixture.dbPath, { readonly: true });
      expect(
        database
          .prepare(
            `WITH latest AS (
               SELECT identity_key, MAX(version_ordinal) AS ordinal
               FROM claim_candidates GROUP BY identity_key
             )
             SELECT candidate.state FROM claim_candidates candidate
             JOIN latest ON latest.identity_key = candidate.identity_key
                        AND latest.ordinal = candidate.version_ordinal`,
          )
          .get(),
      ).toEqual({ state: "triaged" });
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM claim_identities`)
          .get(),
      ).toEqual({ count: 0 });
      database.close();
      expect(existsSync(path.join(fixture.root, ".iw/claims/state.yaml"))).toBe(
        false,
      );
      process.exitCode = undefined;
      await runClaimsExplain({
        claim: fixture.candidateId,
        format: "json",
      });
      expect(process.exitCode).toBe(0);
      expect(
        JSON.parse(
          String(vi.mocked(console.log).mock.calls.at(-1)?.[0]),
        ) as unknown,
      ).toMatchObject({
        kind: "candidate",
        candidate: { state: "triaged" },
        inference: null,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("promotes a generic multi-Subject Candidate conservatively", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "intentweave-generic-candidate-"),
    );
    try {
      mkdirSync(path.join(root, ".iw"), { recursive: true });
      const dbPath = path.join(root, ".iw/index.db");
      const database = new Database(dbPath);
      initSchema(database);
      const candidates = new CandidateStore(database);
      const discovered = candidates.persist({
        identityKey: "architecture:no-ui-to-persistence",
        candidateKind: "architecture-dependency",
        proposedClaimType: "CLM-DEPENDENCY-CONFORMANCE",
        discoveryMode: "manual",
        discoveryAdapterId: "manual-repository-claim",
        discoveryContractVersion: "1",
        confidence: "certain",
        normalizedStatement: {
          source: "module:workspace:@intentweave/ui",
          target: "module:workspace:@intentweave/persistence",
          rule: "no-ui-to-persistence",
        },
        provenance: { repositoryRevision: "rev:manual" },
        evidence: [],
        subjects: [
          {
            kind: "module",
            identityKey: "module:workspace:@intentweave/ui",
            role: "source",
            basis: "manual",
            confidence: "certain",
          },
          {
            kind: "module",
            identityKey: "module:workspace:@intentweave/persistence",
            role: "target",
            basis: "manual",
            confidence: "certain",
          },
        ],
      });
      const triaged = candidates.triage(discovered.id, {
        basis: "manual-triage",
      });
      database.close();
      process.chdir(root);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await runClaimsCandidateReview({
        candidate: triaged.id,
        actor: "benjamin",
        decision: "promote",
        rationale: "This architecture boundary should be governed",
        format: "json",
      });

      expect(process.exitCode).toBe(0);
      const reviewOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        assessment: { claimIdentityId: string; id: string };
      };
      const persisted = new Database(dbPath, { readonly: true });
      expect(
        persisted
          .prepare(
            `SELECT claim.parameter_identity_id, claim.claim_type,
                    claim.identity_contract_id, claim.identity_contract_version,
                    version.materiality_contract_id,
                    version.materiality_contract_version,
                    assessment.epistemic_status
             FROM claim_identities claim
             JOIN claim_versions version ON version.claim_identity_id = claim.id
             JOIN claim_assessments assessment
               ON assessment.claim_version_id = version.id
             WHERE claim.id = ?`,
          )
          .get(reviewOutput.assessment.claimIdentityId),
      ).toEqual({
        parameter_identity_id: null,
        claim_type: "CLM-DEPENDENCY-CONFORMANCE",
        identity_contract_id: "dependency-claim-identity",
        identity_contract_version: "1",
        materiality_contract_id: "dependency-claim-materiality",
        materiality_contract_version: "1",
        epistemic_status: "inconclusive",
      });
      expect(
        persisted
          .prepare(
            `SELECT link.subject_role, subject.identity_key
             FROM claim_subjects link
             JOIN subject_identities subject ON subject.id = link.subject_identity_id
             WHERE link.claim_identity_id = ?
             ORDER BY link.subject_role`,
          )
          .all(reviewOutput.assessment.claimIdentityId),
      ).toEqual([
        {
          subject_role: "source",
          identity_key: "module:workspace:@intentweave/ui",
        },
        {
          subject_role: "target",
          identity_key: "module:workspace:@intentweave/persistence",
        },
      ]);
      persisted.close();

      log.mockClear();
      await runClaimsExplain({
        claim: reviewOutput.assessment.claimIdentityId,
        format: "json",
      });
      const explanation = JSON.parse(
        String(log.mock.calls.at(-1)?.[0]),
      ) as Array<{
        status: string;
        promotion: { actor_kind: string; actor_id: string };
      }>;
      expect(explanation[0]).toMatchObject({
        status: "inconclusive",
        promotion: { actor_kind: "human", actor_id: "benjamin" },
      });

      log.mockClear();
      process.exitCode = undefined;
      await runClaimsCheck({ format: "json" });
      expect(process.exitCode).toBe(2);
      const check = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        gateStatus: string;
        candidates: { active: number };
        claims: Array<{
          claimIdentityId: string;
          parameterKey: string | null;
          claimType: string;
          assessmentStatuses: string[];
        }>;
      };
      expect(check).toMatchObject({
        gateStatus: "evaluated",
        candidates: { active: 1 },
        claims: [
          {
            claimIdentityId: reviewOutput.assessment.claimIdentityId,
            parameterKey: null,
            claimType: "CLM-DEPENDENCY-CONFORMANCE",
            assessmentStatuses: ["inconclusive"],
          },
        ],
      });
      const unchanged = new Database(dbPath, { readonly: true });
      expect(
        unchanged
          .prepare(`SELECT COUNT(*) AS count FROM claim_assessments`)
          .get(),
      ).toEqual({ count: 1 });
      unchanged.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects generic promotion without a registered family contract", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "intentweave-unknown-claim-"));
    try {
      mkdirSync(path.join(root, ".iw"), { recursive: true });
      const dbPath = path.join(root, ".iw/index.db");
      const database = new Database(dbPath);
      initSchema(database);
      const candidates = new CandidateStore(database);
      const discovered = candidates.persist({
        identityKey: "manual:unknown-contract",
        candidateKind: "manual-claim",
        proposedClaimType: "CLM-UNKNOWN",
        discoveryMode: "manual",
        discoveryAdapterId: "manual-repository-claim",
        discoveryContractVersion: "1",
        confidence: "certain",
        normalizedStatement: { value: true },
        provenance: { repositoryRevision: "rev:manual" },
        evidence: [],
        subjects: [
          {
            kind: "module",
            identityKey: "module:workspace:unknown",
            role: "subject",
            basis: "manual",
            confidence: "certain",
          },
        ],
      });
      const triaged = candidates.triage(discovered.id, {
        basis: "manual-triage",
      });
      database.close();
      process.chdir(root);
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await runClaimsCandidateReview({
        candidate: triaged.id,
        actor: "benjamin",
        decision: "promote",
        rationale: "Attempt an unregistered family",
        format: "json",
      });

      expect(process.exitCode).toBe(1);
      expect(existsSync(path.join(root, ".iw/claims/state.yaml"))).toBe(false);
      const unchanged = new Database(dbPath, { readonly: true });
      expect(
        unchanged
          .prepare(`SELECT COUNT(*) AS count FROM claim_identities`)
          .get(),
      ).toEqual({ count: 0 });
      expect(
        unchanged
          .prepare(`SELECT COUNT(*) AS count FROM candidate_reviews`)
          .get(),
      ).toEqual({ count: 0 });
      unchanged.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incomplete Reviews before persisting governance state", async () => {
    const fixture = await discoverAndTriage();
    try {
      await runClaimsCandidateReview({
        candidate: fixture.candidateId,
        actor: "benjamin",
        decision: "promote",
        rationale: "",
        format: "json",
      });

      expect(process.exitCode).toBe(64);
      expect(existsSync(path.join(fixture.root, ".iw/claims/state.yaml"))).toBe(
        false,
      );
      const database = new Database(fixture.dbPath, { readonly: true });
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM candidate_reviews`)
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM claim_identities`)
          .get(),
      ).toEqual({ count: 0 });
      database.close();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not replay a stale portable promotion in a fresh index", async () => {
    const fixture = await discoverAndTriage();
    try {
      const log = vi.mocked(console.log);
      await runClaimsCandidateReview({
        candidate: fixture.candidateId,
        actor: "benjamin",
        decision: "promote",
        rationale: "PAGE_SIZE is a repository contract",
        format: "json",
      });
      rmSync(fixture.dbPath);
      writeFileSync(
        path.join(fixture.root, "src/options.ts"),
        "/**\n * @default 30\n */\nexport const PAGE_SIZE = 30;\n",
      );
      const rebuilt = new Database(fixture.dbPath);
      initSchema(rebuilt);
      rebuilt.close();
      log.mockClear();
      process.exitCode = undefined;

      await runClaimsCheck({ format: "json" });

      expect(process.exitCode).toBe(2);
      const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        gateStatus: string;
        candidates: { issues: unknown[] };
      };
      expect(output).toMatchObject({
        gateStatus: "no_active_claims",
        candidates: {
          issues: [
            {
              reason: "stale-portable-decision",
            },
          ],
        },
      });
      const database = new Database(fixture.dbPath, { readonly: true });
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM claim_identities`)
          .get(),
      ).toEqual({ count: 0 });
      database.close();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
