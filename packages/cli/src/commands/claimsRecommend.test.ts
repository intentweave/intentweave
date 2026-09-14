// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  initSchema,
} from "@intentweave/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaimsCandidatesRecommend } from "./claims.js";

describe("iw claims candidates recommend", () => {
  const originalCwd = process.cwd();
  const workspaces: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  function workspace(withConfig = true): string {
    const root = mkdtempSync(path.join(tmpdir(), "iw-g6a-recommend-"));
    workspaces.push(root);
    mkdirSync(path.join(root, ".iw", "claims"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    if (withConfig) {
      writeFileSync(
        path.join(root, ".iw", "claims", "inference.yaml"),
        `schemaVersion: "1"
providers:
  allow: ["openai"]
sensitivePaths: ["secrets/**"]
budgets:
  maxCandidates: 5
  maxEvidencePerCandidate: 4
  maxExcerptChars: 500
  maxTokensPerCandidate: 2000
  maxTotalTokens: 5000
  maxEstimatedCostUsd: 0.5
  maxConcurrency: 1
`,
      );
    }
    writeFileSync(
      path.join(root, "src", "api.ts"),
      "/** Parse repository configuration. */\nexport function parseConfig() {}\n",
    );
    const database = new Database(path.join(root, ".iw", "index.db"));
    initSchema(database);
    const subject = {
      kind: "symbol" as const,
      identityKey: "symbol:parse-config",
      displayName: "parseConfig",
      role: "subject",
      basis: "cari-symbol",
      confidence: "certain" as const,
    };
    const evidence = new ClaimsStore(database).persistGenericEvidence({
      subjects: [subject],
      sourceKind: "code-symbol",
      identityKey: "code-symbol:parse-config",
      fingerprint: fingerprint({ signature: "parseConfig()" }),
      materialFingerprint: fingerprint({ signature: "parseConfig()" }),
      normalizedValue: { signature: "parseConfig()" },
      semanticLocation: "symbol:parse-config",
      provenance: { adapter: "g6a-cli-test" },
      filePath: "src/api.ts",
      spanStartLine: 2,
      spanEndLine: 2,
    });
    new CandidateStore(database).persist({
      identityKey: "public-symbol-doc:parse-config",
      candidateKind: "public-symbol-documentation",
      proposedClaimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED",
      discoveryMode: "deterministic",
      discoveryAdapterId: "g6a-cli-test",
      discoveryContractVersion: "1",
      confidence: "certain",
      normalizedStatement: {
        symbolName: "parseConfig",
        symbolKind: "function",
        requirement: "public-symbol-is-documented",
      },
      provenance: { repositoryRevision: "g6a-cli-test" },
      evidence: [
        {
          evidenceKey: "code-symbol:parse-config",
          evidenceVersionId: evidence.id,
          sourceKind: "code-symbol",
          role: "symbol",
          provenance: {},
        },
      ],
      subjects: [subject],
    });
    database.close();
    return root;
  }

  it("prints the exact preview without invoking a model", async () => {
    const root = workspace();
    process.chdir(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      preview: true,
      provider: "openai",
      format: "json",
    });

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      networkCallPerformed: boolean;
      summary: { includedCandidates: number };
      contexts: Array<{
        candidate: { claimType: string };
        security: { toolExecutionAllowed: boolean };
      }>;
    };
    expect(output).toMatchObject({
      networkCallPerformed: false,
      summary: { includedCandidates: 1 },
      contexts: [
        {
          candidate: { claimType: "CLM-PUBLIC-SYMBOL-DOCUMENTED" },
          security: { toolExecutionAllowed: false },
        },
      ],
    });
  });

  it("refuses recommendation execution before G6b", async () => {
    const root = workspace();
    process.chdir(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      preview: false,
      provider: "openai",
      format: "json",
    });

    expect(process.exitCode).toBe(64);
    expect(error.mock.calls.at(-1)?.[0]).toContain(
      "Model-backed Candidate recommendations are not enabled yet",
    );
  });

  it("requires repository-level provider approval even for preview", async () => {
    const root = workspace(false);
    process.chdir(root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runClaimsCandidatesRecommend({
      semantic: true,
      preview: true,
      provider: "openai",
      format: "json",
    });

    expect(process.exitCode).toBe(64);
    expect(error.mock.calls.at(-1)?.[0]).toContain(
      "Missing .iw/claims/inference.yaml",
    );
  });
});
