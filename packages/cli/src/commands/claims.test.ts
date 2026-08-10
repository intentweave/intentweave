// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { initSchema } from "@intentweave/index";
import { runClaimsCheck, runClaimsExplain, runClaimsReview } from "./claims.js";

describe("iw claims check", () => {
  const workspaces: string[] = [];
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs the C0 bound path and reports review-required before a review", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "config"));
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "src"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/session.ts
        export: SESSION_TIMEOUT
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: eu-prod-override-doc
            target: effective
            scope: eu-prod
            pattern: '^The eu-prod override is (?<value>\\d+) seconds\\.$'
`,
    );
    writeFileSync(
      path.join(workspace, "config", "environments.yaml"),
      `environments:
  - name: eu-prod
    capabilities: [session-runtime]
  - name: mobile-preview
    capabilities: []
  - name: staging
    capabilities: [session-runtime]
`,
    );
    writeFileSync(path.join(workspace, "config", "eu-prod.yaml"), "session:\n  timeout: 3600\n");
    writeFileSync(
      path.join(workspace, "src", "session.ts"),
      "/**\n * @default 1800\n */\nexport const SESSION_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The eu-prod override is 3600 seconds.\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", format: "json" });

    expect(process.exitCode).toBe(4);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      scopes: [
        {
          scope: "eu-prod",
          ruleStatuses: ["passed", "passed", "passed", "passed"],
          assessmentStatuses: ["supported", "supported", "supported"],
        },
      ],
    });
    const index = new Database(path.join(workspace, ".iw", "index.db"));
    const claimsToReview = index
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions cv ON cv.claim_identity_id = ci.id
         JOIN claim_assessments ca ON ca.claim_version_id = cv.id
         WHERE ca.is_current = 1
         ORDER BY ci.claim_type`,
      )
      .all() as Array<{ id: string }>;
    index.close();
    expect(claimsToReview).toHaveLength(3);
    const effectiveClaim = claimsToReview[0]!;

    log.mockClear();
    for (const claim of claimsToReview) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      claimIdentityId: effectiveClaim.id,
      carriedForward: false,
    });

    log.mockClear();
    await runClaimsExplain({ claim: effectiveClaim.id, format: "json" });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject([
      {
        claimIdentityId: effectiveClaim.id,
        status: "supported",
        dependencies: expect.any(Array),
        review: expect.objectContaining({ decision: "accepted" }),
      },
    ]);

    log.mockClear();
    await runClaimsCheck({ scope: "eu-prod", format: "json" });
    expect(process.exitCode).toBe(0);

    log.mockClear();
    await runClaimsCheck({ scope: "mobile-preview", format: "json" });
    expect(process.exitCode).toBe(3);

    log.mockClear();
    await runClaimsCheck({ scope: "staging", format: "json" });
    expect(process.exitCode).toBe(2);
  });

  it("returns invalid-input for an unknown scope before creating a rule result", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "config"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(path.join(workspace, "intentweave.bindings.yaml"), "parameters: {}\n");
    writeFileSync(
      path.join(workspace, "config", "environments.yaml"),
      "environments:\n  - name: eu-prod\n    capabilities: [session-runtime]\n",
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "does-not-exist", format: "text" });

    expect(process.exitCode).toBe(64);
  });

  it("links evidence from the merge-base to immutable HEAD for --since", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "config"));
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/session.ts
        export: SESSION_TIMEOUT
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: eu-prod-override-doc
            target: effective
            scope: eu-prod
            pattern: '^The eu-prod override is (?<value>\\d+) seconds\\.$'
`,
    );
    writeFileSync(
      path.join(workspace, "config", "environments.yaml"),
      "environments:\n  - name: eu-prod\n    capabilities: [session-runtime]\n",
    );
    writeFileSync(path.join(workspace, "config", "eu-prod.yaml"), "session:\n  timeout: 1800\n");
    writeFileSync(
      path.join(workspace, "src", "session.ts"),
      "/**\n * @default 1800\n */\nexport const SESSION_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The eu-prod override is 1800 seconds.\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "base claims evidence");
    const baseRevision = git("rev-parse", "HEAD");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", format: "json" });
    const baseIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baseClaims = baseIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions cv ON cv.claim_identity_id = ci.id
         JOIN claim_assessments ca ON ca.claim_version_id = cv.id
         WHERE ca.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    baseIndex.close();
    for (const claim of baseClaims) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    writeFileSync(path.join(workspace, "config", "eu-prod.yaml"), "session:\n  timeout: 3600\n");
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The eu-prod override is 3600 seconds.\n",
    );
    git("add", "config/eu-prod.yaml", "docs/session-timeout.md");
    git("commit", "-m", "raise eu timeout");
    const headRevision = git("rev-parse", "HEAD");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(4);
    const index = new Database(path.join(workspace, ".iw", "index.db"));
    const continuity = index
      .prepare(
        `SELECT previous.version_ordinal AS from_ordinal,
                current.version_ordinal AS to_ordinal,
                continuity.provenance_json
         FROM evidence_continuity continuity
         JOIN evidence_versions previous ON previous.id = continuity.from_evidence_version_id
         JOIN evidence_versions current ON current.id = continuity.to_evidence_version_id`,
      )
      .all() as Array<{ from_ordinal: number; to_ordinal: number; provenance_json: string }>;
    expect(continuity.length).toBeGreaterThan(0);
    expect(continuity.every((link) => link.from_ordinal < link.to_ordinal)).toBe(true);
    expect(continuity.map((link) => JSON.parse(link.provenance_json))).toContainEqual(
      expect.objectContaining({
        baseRevision,
        headRevision,
        materialChange: true,
        changedPaths: ["config/eu-prod.yaml", "docs/session-timeout.md"],
      }),
    );
    const reopens = index
      .prepare(
        `SELECT reason, status FROM review_decision_reopens
         WHERE reason = 'material-change'`,
      )
      .all() as Array<{ reason: string; status: string }>;
    expect(reopens).toHaveLength(2);
    expect(reopens).toEqual(
      expect.arrayContaining([
        { reason: "material-change", status: "open" },
        { reason: "material-change", status: "open" },
      ]),
    );
    expect(
      index.prepare(`SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`).get(),
    ).toEqual({ current_reviews: 1 });
    expect(
      index.prepare(`SELECT decision_origin FROM review_decisions WHERE is_current = 1`).get(),
    ).toEqual({ decision_origin: "carry-forward" });
    index.close();

    const reviewIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const claimsToReview = reviewIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions cv ON cv.claim_identity_id = ci.id
         JOIN claim_assessments ca ON ca.claim_version_id = cv.id
         WHERE ca.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    reviewIndex.close();
    for (const claim of claimsToReview) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }
    writeFileSync(
      path.join(workspace, "src", "session.ts"),
      "export const SESSION_TIMEOUT = 1800;\n",
    );
    git("add", "src/session.ts");
    git("commit", "-m", "remove timeout annotation");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(4);
    const brokenIndex = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      brokenIndex
        .prepare(
          `SELECT reason, status FROM review_decision_reopens
           WHERE reason = 'continuity-broken'`,
        )
        .all(),
    ).toEqual([{ reason: "continuity-broken", status: "open" }]);
    expect(
      brokenIndex.prepare(`SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`).get(),
    ).toEqual({ current_reviews: 2 });
    brokenIndex.close();

    const warrantReviewIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const claimsForWarrantReview = warrantReviewIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions cv ON cv.claim_identity_id = ci.id
         JOIN claim_assessments ca ON ca.claim_version_id = cv.id
         WHERE ca.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    warrantReviewIndex.close();
    for (const claim of claimsForWarrantReview) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }
    const priorEngineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    priorEngineIndex
      .prepare(`UPDATE rule_result_versions SET implementation_fingerprint = 'claims-engine-v0'`)
      .run();
    priorEngineIndex.close();
    writeFileSync(path.join(workspace, "continuity.md"), "snapshot anchor\n");
    git("add", "continuity.md");
    git("commit", "-m", "advance immutable reference");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(4);
    const warrantIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const warrantReopens = warrantIndex
      .prepare(
        `SELECT reason, status FROM review_decision_reopens
         WHERE reason = 'warrant-changed'`,
      )
      .all() as Array<{ reason: string; status: string }>;
    expect(warrantReopens.length).toBeGreaterThan(0);
    expect(warrantReopens.every((reopen) => reopen.status === "open")).toBe(true);
    expect(
      warrantIndex.prepare(`SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`).get(),
    ).toEqual({ current_reviews: 0 });
    warrantIndex.close();

    const uncertainReviewIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const claimsForUncertainReview = uncertainReviewIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions cv ON cv.claim_identity_id = ci.id
         JOIN claim_assessments ca ON ca.claim_version_id = cv.id
         WHERE ca.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    uncertainReviewIndex.close();
    for (const claim of claimsForUncertainReview) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/session-v2.ts
        export: SESSION_TIMEOUT
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: eu-prod-override-doc
            target: effective
            scope: eu-prod
            pattern: '^The eu-prod override is (?<value>\\d+) seconds\\.$'
`,
    );
    writeFileSync(
      path.join(workspace, "src", "session-v2.ts"),
      "export const SESSION_TIMEOUT = 1800;\n",
    );
    git("add", "intentweave.bindings.yaml", "src/session-v2.ts");
    git("commit", "-m", "move timeout binding");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(4);
    const uncertainIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const uncertainReopens = uncertainIndex
      .prepare(
        `SELECT reason, status FROM review_decision_reopens
         WHERE reason = 'continuity-uncertain'`,
      )
      .all() as Array<{ reason: string; status: string }>;
    expect(uncertainReopens.length).toBeGreaterThan(0);
    expect(uncertainReopens.every((reopen) => reopen.status === "open")).toBe(true);
    expect(
      uncertainIndex.prepare(`SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`).get(),
    ).toEqual({ current_reviews: 0 });
    uncertainIndex.close();
  });
});