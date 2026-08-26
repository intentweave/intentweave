// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "@intentweave/sqlite-compat";
import { persistPublicSymbolCandidates } from "../claims/publicSymbolDiscovery.js";
import {
  runClaimsCandidateReview,
  runClaimsCandidatesTriage,
  runClaimsCheck,
  runClaimsDiscover,
  runClaimsExplain,
  runClaimsReview,
} from "./claims.js";

describe("G3 public Symbol Git slice", () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  const workspaces: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  function repoRoot(): string {
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../",
    );
  }

  function git(workspace: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
  }

  function commit(workspace: string, message: string): string {
    git(workspace, "add", "-A");
    git(workspace, "commit", "-m", message);
    return git(workspace, "rev-parse", "HEAD");
  }

  function buildIndex(workspace: string): void {
    execFileSync(
      "tsx",
      [
        path.join(repoRoot(), "packages", "cli", "src", "cli.ts"),
        "index",
        "build",
        "--depth",
        "structured",
        "--no-native",
        ".",
      ],
      {
        cwd: workspace,
        encoding: "utf-8",
        env: { ...process.env, IW_SESSION: "g3-symbol-slice" },
      },
    );
  }

  function parseConfigSource(input: {
    documentation?: string;
    parameters: string;
  }): string {
    const documentation = input.documentation
      ? `/**\n * ${input.documentation}\n * @returns the normalized configuration\n */\n`
      : "";
    return `${documentation}export function parseConfig(${input.parameters}): string {
  const normalized = source.trim();
  if (normalized.length === 0) {
    return source;
  }
  return normalized;
}
`;
  }

  function currentClaim(database: Database.Database, claimIdentityId: string) {
    return database
      .prepare(
        `SELECT assessment.id, assessment.epistemic_status
         FROM claim_assessments assessment
         JOIN claim_versions version ON version.id = assessment.claim_version_id
         WHERE version.claim_identity_id = ? AND assessment.is_current = 1`,
      )
      .get(claimIdentityId) as {
      id: string;
      epistemic_status: string;
    };
  }

  async function acceptClaim(claimIdentityId: string): Promise<void> {
    await runClaimsReview({
      claim: claimIdentityId,
      actor: "g3-reviewer",
      decision: "accepted",
      rationale: "Accepted by the deterministic G3 fixture",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
  }

  it("runs S0-S5 through build, continuity, --since, reopen, Explain, and ambiguity", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-g3-symbol-git-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
    writeFileSync(
      path.join(workspace, "README.md"),
      "# G3 Symbol Contract Fixture\n",
    );
    writeFileSync(
      path.join(workspace, "src/config.ts"),
      parseConfigSource({
        documentation: "Parses a configuration source.",
        parameters: "source: string",
      }),
    );
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    const s0 = commit(workspace, "S0 documented public symbol");
    buildIndex(workspace);

    process.chdir(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await runClaimsDiscover({ all: true, format: "json" });
    const baselineDiscovery = JSON.parse(
      String(log.mock.calls.at(-1)?.[0]),
    ) as {
      candidates: Array<{
        id: string;
        identityKey: string;
        proposedClaimType: string;
        confidence: string;
      }>;
    };
    const baselineCandidate = baselineDiscovery.candidates.find(
      (candidate) =>
        candidate.proposedClaimType === "CLM-PUBLIC-SYMBOL-DOCUMENTED" &&
        candidate.confidence === "certain",
    );
    expect(baselineCandidate).toBeDefined();
    await runClaimsCandidatesTriage({
      candidate: baselineCandidate!.id,
      format: "json",
    });
    const triage = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string }>;
    };
    await runClaimsCandidateReview({
      candidate: triage.candidates[0]!.id,
      actor: "g3-reviewer",
      decision: "promote",
      rationale: "Public API documentation is a repository contract",
      format: "json",
    });
    const promotion = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      assessment: { id: string; claimIdentityId: string };
      review: { candidate: { id: string } };
    };
    const claimIdentityId = promotion.assessment.claimIdentityId;
    await acceptClaim(claimIdentityId);
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    expect(process.exitCode).toBe(0);

    mkdirSync(path.join(workspace, "src/settings"), { recursive: true });
    renameSync(
      path.join(workspace, "src/config.ts"),
      path.join(workspace, "src/settings/config.ts"),
    );
    const s1 = commit(workspace, "S1 move only");
    buildIndex(workspace);
    const preSince = new Database(path.join(workspace, ".iw/index.db"));
    const movedSymbol = preSince
      .prepare(
        `SELECT id FROM symbols
         WHERE name = 'parseConfig' AND export = 'exported'`,
      )
      .get() as { id: string };
    persistPublicSymbolCandidates(preSince, s1);
    expect(
      preSince
        .prepare(
          `SELECT state FROM claim_candidates
           WHERE identity_key = ? ORDER BY version_ordinal DESC LIMIT 1`,
        )
        .get(`public-symbol-doc:${movedSymbol.id}`),
    ).toEqual({ state: "correlated" });
    preSince.close();
    process.exitCode = undefined;
    await runClaimsCheck({ since: s0, format: "json" });
    expect(process.exitCode).toBe(0);

    let database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM claim_identities
           WHERE claim_type = 'CLM-PUBLIC-SYMBOL-DOCUMENTED'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT state FROM claim_candidates
           WHERE identity_key = ? ORDER BY version_ordinal DESC LIMIT 1`,
        )
        .get(`public-symbol-doc:${movedSymbol.id}`),
    ).toEqual({ state: "superseded" });
    expect(
      database
        .prepare(
          `SELECT subject.identity_key
           FROM subject_aliases alias
           JOIN subject_identities subject
             ON subject.id = alias.subject_identity_id
           WHERE alias.alias_kind = 'cari-symbol-id' AND alias.alias_key = ?`,
        )
        .get(movedSymbol.id),
    ).toEqual(
      expect.objectContaining({
        identity_key: expect.stringContaining("src/config.ts"),
      }),
    );
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM subject_continuity`)
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM review_decision_reopens
           WHERE claim_identity_id = ? AND status = 'open'`,
        )
        .get(claimIdentityId),
    ).toEqual({ count: 0 });
    const carriedReview = database
      .prepare(
        `SELECT decision, carried_forward_from_decision_id
         FROM review_decisions
         WHERE claim_identity_id = ? AND is_current = 1`,
      )
      .get(claimIdentityId) as {
      decision: string;
      carried_forward_from_decision_id: string | null;
    };
    expect(carriedReview.decision).toBe("accepted");
    expect(carriedReview.carried_forward_from_decision_id).not.toBeNull();
    database.close();

    writeFileSync(
      path.join(workspace, "src/settings/config.ts"),
      parseConfigSource({
        documentation: "Parses a configuration source.",
        parameters: "source: string, strict: boolean",
      }),
    );
    const s2 = commit(workspace, "S2 signature changed");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: s1, format: "json" });
    expect(process.exitCode).toBe(4);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(currentClaim(database, claimIdentityId).epistemic_status).toBe(
      "supported",
    );
    expect(
      database
        .prepare(
          `SELECT reason, status FROM review_decision_reopens
           WHERE claim_identity_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(claimIdentityId),
    ).toEqual({ reason: "warrant-changed", status: "open" });
    database.close();

    log.mockClear();
    await runClaimsExplain({
      claim: promotion.review.candidate.id,
      format: "json",
    });
    const signatureExplanation = JSON.parse(
      String(log.mock.calls.at(-1)?.[0]),
    ) as Array<{
      claimIdentityId: string;
      status: string;
      dependencies: Array<{
        rule_status: string;
        rule_output: { signature: string };
        rule_reasons: string[];
      }>;
      reopens: Array<{ reason: string; status: string }>;
    }>;
    expect(signatureExplanation[0]).toMatchObject({
      claimIdentityId,
      status: "supported",
      dependencies: [
        {
          rule_status: "passed",
          rule_reasons: ["public-symbol-documentation-present"],
        },
      ],
      reopens: expect.arrayContaining([
        expect.objectContaining({ reason: "warrant-changed", status: "open" }),
      ]),
    });
    expect(
      signatureExplanation[0]?.dependencies[0]?.rule_output.signature,
    ).toContain("strict");
    await acceptClaim(claimIdentityId);

    writeFileSync(
      path.join(workspace, "src/settings/config.ts"),
      parseConfigSource({
        documentation: "Parses a strict or lenient configuration source.",
        parameters: 'source: string, mode: "strict" | "lenient"',
      }),
    );
    const s3 = commit(workspace, "S3 signature and documentation changed");
    buildIndex(workspace);
    process.exitCode = undefined;
    await runClaimsCheck({ since: s2, format: "json" });
    expect(process.exitCode).toBe(4);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(currentClaim(database, claimIdentityId).epistemic_status).toBe(
      "supported",
    );
    database.close();
    await acceptClaim(claimIdentityId);

    writeFileSync(
      path.join(workspace, "src/settings/config.ts"),
      parseConfigSource({
        parameters: 'source: string, mode: "strict" | "lenient"',
      }),
    );
    const s4 = commit(workspace, "S4 documentation deleted");
    buildIndex(workspace);

    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });
    expect(process.exitCode).toBe(1);
    await acceptClaim(claimIdentityId);
    process.exitCode = undefined;
    await runClaimsCheck({ since: s3, format: "json" });
    expect(process.exitCode).toBe(1);
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(currentClaim(database, claimIdentityId).epistemic_status).toBe(
      "refuted",
    );
    const anchoredReopen = database
      .prepare(
        `SELECT reason, status, secondary_provenance_json
         FROM review_decision_reopens
         WHERE claim_identity_id = ? AND status = 'open'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(claimIdentityId) as {
      reason: string;
      status: string;
      secondary_provenance_json: string;
    };
    expect(anchoredReopen).toMatchObject({
      reason: "warrant-changed",
      status: "open",
    });
    expect(JSON.parse(anchoredReopen.secondary_provenance_json)).toMatchObject({
      baseRevision: s3,
      referenceAssessmentId: expect.stringMatching(/^assessment:/),
      currentAssessmentId: expect.stringMatching(/^assessment:/),
    });
    database.close();

    writeFileSync(
      path.join(workspace, "src/load-a.ts"),
      "export function loadConfig(source: string): string {\n  return source.trim();\n}\n",
    );
    writeFileSync(
      path.join(workspace, "src/load-b.ts"),
      "export function loadConfig(source: string): string {\n  return source.trim();\n}\n",
    );
    mkdirSync(path.join(workspace, "docs"), { recursive: true });
    writeFileSync(
      path.join(workspace, "docs/config.md"),
      "Use loadConfig to load configuration input.\n",
    );
    commit(workspace, "S5 ambiguous documentation assignment");
    buildIndex(workspace);
    const writable = new Database(path.join(workspace, ".iw/index.db"));
    writable
      .prepare(
        `INSERT INTO annotations (
           doc_path, line, text, symbol_id, confidence, source
         ) VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        "docs/config.md",
        1,
        "Use loadConfig to load configuration input.",
        0.5,
        "markdown",
      );
    writable.close();

    log.mockClear();
    process.exitCode = undefined;
    await runClaimsDiscover({ all: true, format: "json" });
    const ambiguousDiscovery = JSON.parse(
      String(log.mock.calls.at(-1)?.[0]),
    ) as {
      candidates: Array<{
        id: string;
        identityKey: string;
        confidence: string;
        state: string;
        surfaced: boolean;
      }>;
    };
    const ambiguous = ambiguousDiscovery.candidates.filter((candidate) =>
      candidate.identityKey.startsWith("public-symbol-doc-correlation:"),
    );
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "ambiguous",
          state: "discovered",
          surfaced: false,
        }),
      ]),
    );
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM candidate_reviews review
           JOIN claim_candidates candidate ON candidate.id = review.candidate_id
           WHERE candidate.identity_key LIKE 'public-symbol-doc-correlation:%'
             AND review.decision = 'promote'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    database.close();

    log.mockClear();
    error.mockClear();
    process.exitCode = undefined;
    await runClaimsCandidatesTriage({
      candidate: ambiguous[0]!.id,
      format: "json",
    });
    expect(process.exitCode).toBe(64);
    expect(error.mock.calls.at(-1)?.[0]).toContain(
      "No triageable current Candidate matches",
    );
    database = new Database(path.join(workspace, ".iw/index.db"), {
      readonly: true,
    });
    expect(
      database
        .prepare(`SELECT state FROM claim_candidates WHERE id = ?`)
        .get(ambiguous[0]!.id),
    ).toEqual({ state: "discovered" });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM candidate_reviews review
           JOIN claim_candidates candidate ON candidate.id = review.candidate_id
           WHERE candidate.identity_key LIKE 'public-symbol-doc-correlation:%'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    database.close();

    log.mockClear();
    await runClaimsDiscover({ format: "json" });
    const defaultDiscovery = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ identityKey: string }>;
    };
    expect(
      defaultDiscovery.candidates.some((candidate) =>
        candidate.identityKey.startsWith("public-symbol-doc-correlation:"),
      ),
    ).toBe(false);
    expect(s4).not.toBe(s3);
  }, 60_000);
});
