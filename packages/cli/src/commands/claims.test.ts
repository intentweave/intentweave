// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("extracts an unscoped default claim without a bindings manifest", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "src"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(
      path.join(workspace, "src", "options.ts"),
      "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;\nexport const MAX_RETRIES = 3;\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    expect(process.exitCode).toBe(4);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      claims: expect.arrayContaining([
        {
          parameterKey: expect.stringContaining("code:variable:"),
          claimType: "CLM-DEFAULT",
          ruleStatuses: ["passed"],
          assessmentStatuses: ["supported"],
        },
        {
          parameterKey: expect.stringContaining("code:variable:"),
          claimType: "CLM-LITERAL",
          ruleStatuses: ["passed"],
          assessmentStatuses: ["supported"],
        },
      ]),
      scopes: [],
    });
    const index = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      index.prepare("SELECT COUNT(*) AS count FROM claim_identities").get(),
    ).toEqual({ count: 2 });
    expect(
      index
        .prepare("SELECT COUNT(*) AS count FROM rule_result_identities")
        .get(),
    ).toEqual({ count: 2 });
    expect(
      index
        .prepare(
          `SELECT basis, confidence FROM parameter_evidence_bindings
           ORDER BY basis, confidence`,
        )
        .all(),
    ).toHaveLength(3);
    expect(
      index
        .prepare(
          `SELECT COUNT(*) AS count FROM parameter_evidence_bindings
           WHERE basis = 'r1-discovery' AND confidence = 'probable'`,
        )
        .get(),
    ).toEqual({ count: 3 });
    index.close();
  });

  it("restores a portable review in a fresh index and rejects a stale basis", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "src"));
    const databasePath = path.join(workspace, ".iw", "index.db");
    const sourcePath = path.join(workspace, "src", "options.ts");
    const initializeIndex = () => {
      const database = new Database(databasePath);
      initSchema(database);
      database.close();
    };
    initializeIndex();
    writeFileSync(sourcePath, "export const MAX_RETRIES = 3;\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const initialIndex = new Database(databasePath);
    const claim = initialIndex
      .prepare("SELECT id FROM claim_identities")
      .get() as { id: string };
    initialIndex.close();
    await runClaimsReview({
      claim: claim.id,
      actor: "reviewer",
      decision: "accepted",
      rationale: "Validated project default",
      format: "json",
    });
    const statePath = path.join(workspace, ".iw", "claims", "state.yaml");
    const portableState = readFileSync(statePath, "utf-8");

    rmSync(databasePath);
    initializeIndex();
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      portableStateIssues: [],
    });
    const restoredIndex = new Database(databasePath);
    expect(
      restoredIndex
        .prepare(
          `SELECT decision, actor, decision_origin
           FROM review_decisions WHERE is_current = 1`,
        )
        .get(),
    ).toEqual({
      decision: "accepted",
      actor: "reviewer",
      decision_origin: "portable",
    });
    restoredIndex.close();
    expect(readFileSync(statePath, "utf-8")).toBe(portableState);

    rmSync(databasePath);
    initializeIndex();
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsCheck({
      format: "json",
      contracts: { implementationFingerprint: "claims-engine-v2" },
    });

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      portableStateIssues: [],
    });

    rmSync(databasePath);
    initializeIndex();
    writeFileSync(sourcePath, "export const MAX_RETRIES = 4;\n");
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json" });

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      portableStateIssues: [
        {
          claimIdentityId: claim.id,
          kind: "stale_assessment",
        },
      ],
    });
    const staleIndex = new Database(databasePath);
    expect(
      staleIndex
        .prepare("SELECT COUNT(*) AS count FROM review_decisions")
        .get(),
    ).toEqual({ count: 0 });
    staleIndex.close();
  });

  it("refresh retires stale auto claims but preserves explicit claims", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "src"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    codeDefaults:
      - file: src/session.ts
        export: SESSION_TIMEOUT
`,
    );
    writeFileSync(
      path.join(workspace, "src", "session.ts"),
      "export const SESSION_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "src", "parser.ts"),
      'export const COMMIT_START = "ACTIVE";\n',
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const autoClaim = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN parameter_identities parameter
           ON parameter.id = ci.parameter_identity_id
         WHERE parameter.canonical_key LIKE 'code:%'`,
      )
      .get() as { id: string };
    baselineIndex.close();

    writeFileSync(
      path.join(workspace, "src", "parser.ts"),
      'export const COMMIT_START = "---COMMIT_START---";\n',
    );
    log.mockClear();
    process.exitCode = undefined;

    await runClaimsCheck({ refresh: true, format: "json" });

    expect(process.exitCode).toBe(4);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      retiredClaims: [
        {
          claimIdentityId: autoClaim.id,
          claimType: "CLM-LITERAL",
          reviewReopened: false,
        },
      ],
    });
    const refreshedIndex = new Database(
      path.join(workspace, ".iw", "index.db"),
    );
    expect(
      refreshedIndex
        .prepare(
          `SELECT parameter.canonical_key, assessment.is_current
           FROM claim_assessments assessment
           JOIN claim_versions version ON version.id = assessment.claim_version_id
           JOIN claim_identities ci ON ci.id = version.claim_identity_id
           JOIN parameter_identities parameter
             ON parameter.id = ci.parameter_identity_id
           ORDER BY parameter.canonical_key`,
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonical_key: "session.timeout",
          is_current: 1,
        }),
        expect.objectContaining({
          canonical_key: expect.stringContaining("code:variable:"),
          is_current: 0,
        }),
      ]),
    );
    refreshedIndex.close();

    log.mockClear();
    process.exitCode = undefined;
    await runClaimsCheck({ refresh: true, format: "json" });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      retiredClaims: [],
    });
  });

  it("refresh reopens a reviewed auto claim while preserving its explanation", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "src"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(
      path.join(workspace, "src", "parser.ts"),
      'export const COMMIT_START = "ACTIVE";\n',
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const claim = baselineIndex
      .prepare("SELECT id FROM claim_identities")
      .get() as { id: string };
    baselineIndex.close();
    await runClaimsReview({
      claim: claim.id,
      actor: "reviewer",
      decision: "accepted",
      format: "json",
    });
    writeFileSync(
      path.join(workspace, "src", "parser.ts"),
      'export const COMMIT_START = "---COMMIT_START---";\n',
    );
    log.mockClear();
    process.exitCode = undefined;

    await runClaimsCheck({ refresh: true, format: "json" });

    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      retiredClaims: [
        {
          claimIdentityId: claim.id,
          reviewReopened: true,
        },
      ],
    });
    const refreshedIndex = new Database(
      path.join(workspace, ".iw", "index.db"),
    );
    expect(
      refreshedIndex
        .prepare(
          `SELECT reason, status, secondary_provenance_json
           FROM review_decision_reopens
           WHERE claim_identity_id = ?`,
        )
        .get(claim.id),
    ).toMatchObject({
      reason: "continuity-broken",
      status: "open",
      secondary_provenance_json: expect.stringContaining(
        "refresh-reconciliation",
      ),
    });
    expect(
      refreshedIndex
        .prepare(
          `SELECT COUNT(*) AS count
           FROM claim_assessments assessment
           JOIN claim_versions version ON version.id = assessment.claim_version_id
           WHERE version.claim_identity_id = ? AND assessment.is_current = 1`,
        )
        .get(claim.id),
    ).toEqual({ count: 0 });
    refreshedIndex.close();

    log.mockClear();
    process.exitCode = undefined;
    await runClaimsExplain({ claim: claim.id, format: "json" });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject([
      {
        claimIdentityId: claim.id,
        reopens: [
          expect.objectContaining({
            reason: "continuity-broken",
            status: "open",
          }),
        ],
      },
    ]);
  });

  it("reports P-001 when documented and implemented index-depth defaults conflict", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "packages", "cli", "src", "commands"), {
      recursive: true,
    });
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  cli.index-build.depth:
    codeDefaults:
      - file: packages/cli/src/commands/indexBuild.ts
        option: "--depth <depth>"
    documentation:
      - file: docs/CLI-USAGE.md
        assertions:
          - id: default-depth-doc
            target: default
            pattern: '^iw index build\\s+# (?<value>structured) depth \\(default\\)$'
`,
    );
    writeFileSync(
      path.join(
        workspace,
        "packages",
        "cli",
        "src",
        "commands",
        "indexBuild.ts",
      ),
      `build.option("--depth <depth>", "Annotation depth", "full");\n`,
    );
    writeFileSync(
      path.join(workspace, "docs", "CLI-USAGE.md"),
      "iw index build                    # structured depth (default)\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      claims: [
        {
          parameterKey: "cli.index-build.depth",
          claimType: "CLM-DEFAULT",
          ruleStatuses: ["passed", "failed"],
          assessmentStatuses: ["supported", "refuted"],
        },
      ],
    });
    const index = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      index
        .prepare(
          `SELECT ci.claim_type, ca.epistemic_status
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           JOIN claim_identities ci ON ci.id = cv.claim_identity_id
           ORDER BY ci.claim_type`,
        )
        .all(),
    ).toEqual([
      { claim_type: "CLM-DEFAULT", epistemic_status: "supported" },
      { claim_type: "CLM-DOC-CONFORMANCE", epistemic_status: "refuted" },
    ]);
    index.close();

    log.mockClear();
    process.exitCode = undefined;
    await runClaimsExplain({
      claim: "cli.index-build.depth",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject([
      {
        parameterKey: "cli.index-build.depth",
        claimType: "CLM-DEFAULT",
        status: "supported",
      },
      {
        parameterKey: "cli.index-build.depth",
        claimType: "CLM-DOC-CONFORMANCE",
        status: "refuted",
      },
    ]);

    log.mockClear();
    await runClaimsExplain({
      claim: "cli.index-build.depth",
      type: "CLM-DOC-CONFORMANCE",
      format: "text",
    });
    expect(log.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        "CLM-DOC-CONFORMANCE: refuted",
        "  Parameter: cli.index-build.depth",
        '  Statement: {"documentedValue":"structured","effectiveValue":"full"}',
      ]),
    );

    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runClaimsReview({
      claim: "cli.index-build.depth",
      actor: "reviewer",
      decision: "accepted",
      format: "json",
    });
    expect(process.exitCode).toBe(64);
    expect(String(error.mock.calls[0][0])).toContain(
      "Add --type and, when needed, --scope",
    );

    log.mockClear();
    process.exitCode = undefined;
    await runClaimsReview({
      claim: "cli.index-build.depth",
      type: "CLM-DOC-CONFORMANCE",
      actor: "reviewer",
      decision: "accepted",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      parameterKey: "cli.index-build.depth",
      claimType: "CLM-DOC-CONFORMANCE",
    });
  });

  it("promotes an inferred claim when an explicit binding is later added", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "src"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(
      path.join(workspace, "src", "options.ts"),
      "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;\n",
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const inferredIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const inferred = inferredIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN parameter_identities parameter ON parameter.id = ci.parameter_identity_id
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE parameter.canonical_key LIKE 'code:%' AND assessment.is_current = 1`,
      )
      .get() as { id: string };
    inferredIndex.close();
    await runClaimsReview({
      claim: inferred.id,
      actor: "reviewer",
      decision: "accepted",
      format: "json",
    });

    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  ui.pageSize:
    codeDefaults:
      - file: src/options.ts
        export: PAGE_SIZE
`,
    );
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    expect(process.exitCode).toBe(0);
    const promotedIndex = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      promotedIndex
        .prepare(
          `SELECT parameter.canonical_key
           FROM claim_identities ci
           JOIN parameter_identities parameter ON parameter.id = ci.parameter_identity_id
           JOIN claim_versions version ON version.claim_identity_id = ci.id
           JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
           WHERE assessment.is_current = 1`,
        )
        .all(),
    ).toEqual([{ canonical_key: "ui.pageSize" }]);
    expect(
      promotedIndex
        .prepare(
          `SELECT assessment.is_current, assessment.superseded_by_assessment_id
           FROM claim_assessments assessment
           JOIN claim_versions version ON version.id = assessment.claim_version_id
           JOIN claim_identities ci ON ci.id = version.claim_identity_id
           WHERE ci.id = ?`,
        )
        .get(inferred.id),
    ).toMatchObject({
      is_current: 0,
      superseded_by_assessment_id: expect.any(String),
    });
    expect(
      promotedIndex
        .prepare(
          `SELECT decision_origin, is_current
           FROM review_decisions
           WHERE is_current = 1`,
        )
        .all(),
    ).toEqual([{ decision_origin: "carry-forward", is_current: 1 }]);
    promotedIndex.close();
  });

  it("reopens review when promotion changes the claim policy", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, ".iw"));
    mkdirSync(path.join(workspace, "src"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    writeFileSync(
      path.join(workspace, "src", "options.ts"),
      "export const PAGE_SIZE = 25;\n",
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const inferredIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const inferred = inferredIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN parameter_identities parameter ON parameter.id = ci.parameter_identity_id
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE parameter.canonical_key LIKE 'code:%' AND assessment.is_current = 1`,
      )
      .get() as { id: string };
    inferredIndex.close();
    await runClaimsReview({
      claim: inferred.id,
      actor: "reviewer",
      decision: "accepted",
      format: "json",
    });

    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  ui.pageSize:
    codeDefaults:
      - file: src/options.ts
        export: PAGE_SIZE
`,
    );
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    expect(process.exitCode).toBe(4);
    const promotedIndex = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      promotedIndex
        .prepare(
          `SELECT parameter.canonical_key
           FROM claim_identities ci
           JOIN parameter_identities parameter ON parameter.id = ci.parameter_identity_id
           JOIN claim_versions version ON version.claim_identity_id = ci.id
           JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
           WHERE assessment.is_current = 1`,
        )
        .all(),
    ).toEqual([{ canonical_key: "ui.pageSize" }]);
    expect(
      promotedIndex
        .prepare(
          `SELECT reason, status
           FROM review_decision_reopens
           WHERE claim_identity_id != ?`,
        )
        .all(inferred.id),
    ).toEqual([{ reason: "warrant-changed", status: "open" }]);
    promotedIndex.close();
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
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 3600\n",
    );
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
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      "parameters: {}\n",
    );
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

  it("carries reviews forward for a Git-detected code rename", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "config"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/session.ts
        export: SESSION_TIMEOUT
`,
    );
    writeFileSync(
      path.join(workspace, "config", "environments.yaml"),
      "environments:\n  - name: eu-prod\n    capabilities: [session-runtime]\n",
    );
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 3600\n",
    );
    writeFileSync(
      path.join(workspace, "src", "session.ts"),
      "/**\n * The default session timeout.\n * @default 1800\n */\nexport const SESSION_TIMEOUT = 1800;\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "base claims evidence");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baselineClaims = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE assessment.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    baselineIndex.close();
    for (const claim of baselineClaims) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    writeFileSync(
      path.join(workspace, "README.md"),
      "Unrelated documentation change.\n",
    );
    git("add", "README.md");
    git("commit", "-m", "update unrelated readme");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(0);
    const unrelatedIndex = new Database(
      path.join(workspace, ".iw", "index.db"),
    );
    expect(
      unrelatedIndex
        .prepare(`SELECT COUNT(*) AS count FROM evidence_continuity`)
        .get(),
    ).toEqual({ count: 0 });
    expect(
      unrelatedIndex
        .prepare(`SELECT COUNT(*) AS count FROM review_decision_reopens`)
        .get(),
    ).toEqual({ count: 0 });
    expect(
      unrelatedIndex
        .prepare(
          `SELECT COUNT(*) AS count FROM review_decisions WHERE is_current = 1`,
        )
        .get(),
    ).toEqual({ count: baselineClaims.length });
    unrelatedIndex.close();

    mkdirSync(path.join(workspace, "src", "auth"));
    renameSync(
      path.join(workspace, "src", "session.ts"),
      path.join(workspace, "src", "auth", "session.ts"),
    );
    writeFileSync(
      path.join(workspace, "src", "auth", "session.ts"),
      "/**\n * The default session timeout.\n * @default 1800\n */\nexport const IDLE_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/auth/session.ts
        export: IDLE_TIMEOUT
`,
    );
    git("add", "-A");
    git("commit", "-m", "rename timeout source");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    const renamedIndex = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      renamedIndex
        .prepare(
          `SELECT continuity.basis, continuity.confidence
           FROM evidence_continuity continuity
           JOIN evidence_versions version ON version.id = continuity.to_evidence_version_id
           JOIN evidence_identities identity ON identity.id = version.evidence_identity_id
           WHERE identity.source_kind LIKE 'code-%'
           ORDER BY continuity.basis`,
        )
        .all(),
    ).toEqual([
      { basis: "git-file-rename", confidence: "certain" },
      { basis: "git-file-rename", confidence: "certain" },
    ]);
    expect(process.exitCode).toBe(0);
    expect(
      renamedIndex
        .prepare(`SELECT COUNT(*) AS count FROM review_decision_reopens`)
        .get(),
    ).toEqual({ count: 0 });
    expect(
      renamedIndex
        .prepare(
          `SELECT COUNT(*) AS count FROM review_decisions
           WHERE is_current = 1 AND decision_origin = 'carry-forward'`,
        )
        .get(),
    ).toEqual({ count: baselineClaims.length });
    renamedIndex.close();
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
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 1800\n",
    );
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

    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 3600\n",
    );
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
      .all() as Array<{
      from_ordinal: number;
      to_ordinal: number;
      provenance_json: string;
    }>;
    expect(continuity.length).toBeGreaterThan(0);
    expect(
      continuity.every((link) => link.from_ordinal < link.to_ordinal),
    ).toBe(true);
    expect(
      continuity.map((link) => JSON.parse(link.provenance_json)),
    ).toContainEqual(
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
      index
        .prepare(
          `SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`,
        )
        .get(),
    ).toEqual({ current_reviews: 1 });
    expect(
      index
        .prepare(
          `SELECT decision_origin FROM review_decisions WHERE is_current = 1`,
        )
        .get(),
    ).toEqual({ decision_origin: "manual" });
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
      brokenIndex
        .prepare(
          `SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`,
        )
        .get(),
    ).toEqual({ current_reviews: 2 });
    brokenIndex.close();

    const warrantReviewIndex = new Database(
      path.join(workspace, ".iw", "index.db"),
    );
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
    const priorEngineIndex = new Database(
      path.join(workspace, ".iw", "index.db"),
    );
    priorEngineIndex
      .prepare(
        `UPDATE rule_result_versions
         SET rule_contract_version = 'stale-contract', fingerprint = 'stale-' || id`,
      )
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
    expect(warrantReopens.every((reopen) => reopen.status === "open")).toBe(
      true,
    );
    expect(
      warrantIndex
        .prepare(
          `SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`,
        )
        .get(),
    ).toEqual({ current_reviews: 0 });
    warrantIndex.close();

    const uncertainReviewIndex = new Database(
      path.join(workspace, ".iw", "index.db"),
    );
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
    const uncertainIndex = new Database(
      path.join(workspace, ".iw", "index.db"),
    );
    const uncertainReopens = uncertainIndex
      .prepare(
        `SELECT reason, status FROM review_decision_reopens
         WHERE reason = 'continuity-uncertain'`,
      )
      .all() as Array<{ reason: string; status: string }>;
    expect(uncertainReopens.length).toBeGreaterThan(0);
    expect(uncertainReopens.every((reopen) => reopen.status === "open")).toBe(
      true,
    );
    expect(
      uncertainIndex
        .prepare(
          `SELECT COUNT(*) AS current_reviews FROM review_decisions WHERE is_current = 1`,
        )
        .get(),
    ).toEqual({ current_reviews: 0 });
    uncertainIndex.close();
  });

  it("breaks continuity instead of binding a similar unbound literal (C4)", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "config"));
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "src", "auth"), { recursive: true });
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/auth/session.ts
        export: IDLE_TIMEOUT
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
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 5400\n",
    );
    writeFileSync(
      path.join(workspace, "src", "auth", "session.ts"),
      "/**\n * @default 1800\n */\nexport const IDLE_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The eu-prod override is 5400 seconds.\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "c3 baseline");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baselineClaims = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE assessment.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    baselineIndex.close();
    for (const claim of baselineClaims) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    rmSync(path.join(workspace, "src", "auth", "session.ts"));
    mkdirSync(path.join(workspace, "src", "network"), { recursive: true });
    writeFileSync(
      path.join(workspace, "src", "network", "request.ts"),
      "export const REQUEST_TIMEOUT = 1800;\n",
    );
    git("add", "-A");
    git("commit", "-m", "delete idle timeout, add similar request timeout");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    // inconclusive (CLM-DEFAULT lost its code evidence) outranks review-required.
    expect(process.exitCode).toBe(2);
    const c4Index = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      c4Index
        .prepare(
          `SELECT reason, status FROM review_decision_reopens
           WHERE reason = 'continuity-broken'`,
        )
        .all(),
    ).toEqual([{ reason: "continuity-broken", status: "open" }]);
    const currentByType = c4Index
      .prepare(
        `SELECT ci.claim_type, ci.scope, ca.epistemic_status
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         JOIN claim_identities ci ON ci.id = cv.claim_identity_id
         WHERE ca.is_current = 1
         ORDER BY ci.claim_type`,
      )
      .all() as Array<{
      claim_type: string;
      scope: string | null;
      epistemic_status: string;
    }>;
    expect(currentByType).toEqual(
      expect.arrayContaining([
        {
          claim_type: "CLM-EFFECTIVE",
          scope: "eu-prod",
          epistemic_status: "supported",
        },
        {
          claim_type: "CLM-DOC-CONFORMANCE",
          scope: "eu-prod",
          epistemic_status: "supported",
        },
        {
          claim_type: "CLM-LITERAL",
          scope: null,
          epistemic_status: "supported",
        },
      ]),
    );
    expect(
      currentByType.some(
        (claim) => claim.claim_type === "CLM-DEFAULT" && claim.scope === null,
      ),
    ).toBe(false);
    const requestClaim = c4Index
      .prepare(
        `SELECT parameter.canonical_key
         FROM claim_identities ci
         JOIN parameter_identities parameter ON parameter.id = ci.parameter_identity_id
         WHERE ci.claim_type = 'CLM-LITERAL'`,
      )
      .get() as { canonical_key: string };
    expect(requestClaim.canonical_key).toContain("code:variable:");
    expect(
      c4Index
        .prepare(
          `SELECT COUNT(*) AS count FROM evidence_continuity continuity
           JOIN evidence_versions version ON version.id = continuity.to_evidence_version_id
           WHERE version.file_path = 'src/network/request.ts'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    c4Index.close();
  });

  it("refutes doc-conformance when documentation drifts from the effective value (C5)", async () => {
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
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 5400\n",
    );
    writeFileSync(
      path.join(workspace, "src", "session.ts"),
      "/**\n * @default 1800\n */\nexport const SESSION_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The eu-prod override is 5400 seconds.\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "c2 baseline");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baselineClaims = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE assessment.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    baselineIndex.close();
    for (const claim of baselineClaims) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The eu-prod override is 3600 seconds.\n",
    );
    git("add", "docs/session-timeout.md");
    git("commit", "-m", "drift documentation back to 3600");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(1);
    const c5Index = new Database(path.join(workspace, ".iw", "index.db"));
    const currentByType = c5Index
      .prepare(
        `SELECT ci.claim_type, ca.epistemic_status
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         JOIN claim_identities ci ON ci.id = cv.claim_identity_id
         WHERE ca.is_current = 1
         ORDER BY ci.claim_type`,
      )
      .all() as Array<{ claim_type: string; epistemic_status: string }>;
    expect(currentByType).toEqual([
      { claim_type: "CLM-DEFAULT", epistemic_status: "supported" },
      { claim_type: "CLM-DOC-CONFORMANCE", epistemic_status: "refuted" },
      { claim_type: "CLM-EFFECTIVE", epistemic_status: "supported" },
    ]);
    const failedWarrant = c5Index
      .prepare(
        `SELECT result.normalized_status, dependency.epistemic_role, dependency.assessment_effect
         FROM claim_assessment_dependencies dependency
         JOIN rule_result_versions result ON result.id = dependency.dependency_version_id
         JOIN claim_assessments ca ON ca.id = dependency.claim_assessment_id
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         JOIN claim_identities ci ON ci.id = cv.claim_identity_id
         WHERE ca.is_current = 1 AND ci.claim_type = 'CLM-DOC-CONFORMANCE'
           AND dependency.dependency_kind = 'rule_result_version'`,
      )
      .all() as Array<{
      normalized_status: string;
      epistemic_role: string;
      assessment_effect: string;
    }>;
    expect(failedWarrant).toEqual([
      {
        normalized_status: "failed",
        epistemic_role: "warrant",
        assessment_effect: "contradicts",
      },
    ]);
    expect(
      c5Index
        .prepare(
          `SELECT reason, status FROM review_decision_reopens
           WHERE reason = 'material-change'`,
        )
        .all(),
    ).toEqual([{ reason: "material-change", status: "open" }]);
    c5Index.close();
  });

  it("reopens CLM-DEFAULT when documented default evidence is deleted (P1)", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    codeDefaults:
      - file: src/options.ts
        export: PAGE_SIZE
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: default-doc
            target: default
            pattern: '^The default application timeout is (?<value>\\d+) seconds\\.$'
`,
    );
    writeFileSync(
      path.join(workspace, "src", "options.ts"),
      "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;\nexport const MAX_RETRIES = 3;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The default application timeout is 25 seconds.\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "c0 baseline default documentation");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baselineClaims = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE assessment.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    baselineIndex.close();
    for (const claim of baselineClaims) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    rmSync(path.join(workspace, "docs", "session-timeout.md"));
    git("add", "-A");
    git("commit", "-m", "delete default documentation");
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json", since: "HEAD~1" });

    expect(process.exitCode).toBe(2);
    const p1Index = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      p1Index
        .prepare(
          `SELECT reason, status
           FROM review_decision_reopens
           WHERE reason = 'continuity-broken'`,
        )
        .all(),
    ).toEqual([{ reason: "continuity-broken", status: "open" }]);
    const reopenedClaim = p1Index
      .prepare(
        `SELECT ci.claim_type
         FROM review_decision_reopens reopen
         JOIN claim_identities ci ON ci.id = reopen.claim_identity_id
         WHERE reopen.reason = 'continuity-broken'
         LIMIT 1`,
      )
      .get() as { claim_type: string };
    expect(reopenedClaim.claim_type).toBe("CLM-DEFAULT");
    const documentationRule = p1Index
      .prepare(
        `SELECT result.normalized_status, result.normalized_output_json,
                result.normalized_reasons_json
         FROM rule_result_versions result
         JOIN rule_result_identities identity
           ON identity.id = result.rule_result_identity_id
         WHERE identity.rule_id = 'R3.doc-conformance'
           AND identity.identity_key LIKE 'R3.doc-conformance:session.timeout:%'
         ORDER BY result.version_ordinal DESC
         LIMIT 1`,
      )
      .get() as {
      normalized_status: string;
      normalized_output_json: string;
      normalized_reasons_json: string;
    };
    expect(documentationRule.normalized_status).toBe("inconclusive");
    expect(JSON.parse(documentationRule.normalized_output_json)).toMatchObject({
      assertionId: "default-doc",
      filePath: "docs/session-timeout.md",
      reason: "documentation-assertion-missing",
    });
    expect(JSON.parse(documentationRule.normalized_reasons_json)).toEqual([
      "documentation-assertion-missing",
    ]);
    expect(
      p1Index
        .prepare(
          `SELECT ci.claim_type, ci.scope
           FROM review_decisions review
           JOIN claim_identities ci ON ci.id = review.claim_identity_id
           WHERE review.is_current = 1
           ORDER BY ci.claim_type, ci.scope`,
        )
        .all(),
    ).toEqual([
      { claim_type: "CLM-DOC-CONFORMANCE", scope: null },
      { claim_type: "CLM-LITERAL", scope: null },
    ]);
    p1Index.close();
  });

  it("retires deleted CLM-DEFAULT even when no review decision exists", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    codeDefaults:
      - file: src/options.ts
        export: PAGE_SIZE
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: default-doc
            target: default
            pattern: '^The default application timeout is (?<value>\\d+) seconds\\.$'
`,
    );
    writeFileSync(
      path.join(workspace, "src", "options.ts"),
      "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The default application timeout is 25 seconds.\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "baseline default documentation");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    rmSync(path.join(workspace, "docs", "session-timeout.md"));
    git("add", "-A");
    git("commit", "-m", "delete default documentation before review");
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json", since: "HEAD~1" });

    expect(process.exitCode).toBe(2);
    const index = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      index
        .prepare(
          `SELECT COUNT(*) AS count
           FROM review_decision_reopens
           WHERE reason = 'continuity-broken'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      index
        .prepare(
          `SELECT COUNT(*) AS count
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           JOIN claim_identities ci ON ci.id = cv.claim_identity_id
           WHERE ci.claim_type = 'CLM-DEFAULT' AND ca.is_current = 1`,
        )
        .get(),
    ).toEqual({ count: 0 });
    index.close();
  });

  it("supports explain and review for open reopens after reviewed delete", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    codeDefaults:
      - file: src/options.ts
        export: PAGE_SIZE
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: default-doc
            target: default
            pattern: '^The default application timeout is (?<value>\\d+) seconds\\.$'
`,
    );
    writeFileSync(
      path.join(workspace, "src", "options.ts"),
      "/**\n * @default 25\n */\nexport const PAGE_SIZE = 25;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The default application timeout is 25 seconds.\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "baseline for reviewed delete");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const claimsToReview = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions cv ON cv.claim_identity_id = ci.id
         JOIN claim_assessments ca ON ca.claim_version_id = cv.id
         WHERE ca.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    const defaultClaim = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions cv ON cv.claim_identity_id = ci.id
         JOIN claim_assessments ca ON ca.claim_version_id = cv.id
         WHERE ca.is_current = 1 AND ci.claim_type = 'CLM-DEFAULT'`,
      )
      .get() as { id: string };
    baselineIndex.close();
    for (const claim of claimsToReview) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    rmSync(path.join(workspace, "docs", "session-timeout.md"));
    git("add", "-A");
    git("commit", "-m", "delete reviewed default documentation");
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json", since: "HEAD~1" });

    expect(process.exitCode).toBe(2);
    const reopenedIndex = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      reopenedIndex
        .prepare(
          `SELECT reason, status
           FROM review_decision_reopens
           WHERE claim_identity_id = ? AND reason = 'continuity-broken'`,
        )
        .get(defaultClaim.id),
    ).toEqual({ reason: "continuity-broken", status: "open" });
    reopenedIndex.close();

    log.mockClear();
    await runClaimsExplain({ claim: defaultClaim.id, format: "json" });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject([
      {
        claimIdentityId: defaultClaim.id,
        reopens: expect.arrayContaining([
          expect.objectContaining({
            reason: "continuity-broken",
            status: "open",
          }),
        ]),
      },
    ]);

    log.mockClear();
    await runClaimsExplain({ claim: defaultClaim.id, format: "text" });
    expect(process.exitCode).toBe(0);
    expect(log.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        "  Reopen: continuity-broken (open)",
        expect.stringContaining("    Dependency: evidence_version:"),
        expect.stringContaining("    Provenance: "),
      ]),
    );

    log.mockClear();
    await runClaimsReview({
      claim: defaultClaim.id,
      actor: "reviewer",
      decision: "accepted",
      format: "json",
    });
    expect(process.exitCode).toBe(0);

    const resolvedIndex = new Database(path.join(workspace, ".iw", "index.db"));
    expect(
      resolvedIndex
        .prepare(
          `SELECT status, resolved_by_decision_id
           FROM review_decision_reopens
           WHERE claim_identity_id = ? AND reason = 'continuity-broken'`,
        )
        .get(defaultClaim.id),
    ).toMatchObject({
      status: "resolved",
      resolved_by_decision_id: expect.any(String),
    });
    resolvedIndex.close();
  });

  it("marks the default contested when literal and annotation conflict (C6)", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "config"));
    mkdirSync(path.join(workspace, "src", "auth"), { recursive: true });
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/auth/session.ts
        export: IDLE_TIMEOUT
`,
    );
    writeFileSync(
      path.join(workspace, "config", "environments.yaml"),
      "environments:\n  - name: eu-prod\n    capabilities: [session-runtime]\n",
    );
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 5400\n",
    );
    writeFileSync(
      path.join(workspace, "src", "auth", "session.ts"),
      "/**\n * @default 1800\n * @example IDLE_TIMEOUT = 7200\n */\nexport const IDLE_TIMEOUT = 1800;\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "c3 baseline");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baselineClaims = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE assessment.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    baselineIndex.close();
    for (const claim of baselineClaims) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    writeFileSync(
      path.join(workspace, "src", "auth", "session.ts"),
      "/**\n * @default 3600\n * @example IDLE_TIMEOUT = 7200\n */\nexport const IDLE_TIMEOUT = 1800;\n",
    );
    git("add", "src/auth/session.ts");
    git("commit", "-m", "conflicting default annotation");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(1);
    const c6Index = new Database(path.join(workspace, ".iw", "index.db"));
    const defaultClaim = c6Index
      .prepare(
        `SELECT ca.epistemic_status, cv.normalized_statement_json
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         JOIN claim_identities ci ON ci.id = cv.claim_identity_id
         WHERE ca.is_current = 1 AND ci.claim_type = 'CLM-DEFAULT'`,
      )
      .get() as { epistemic_status: string; normalized_statement_json: string };
    expect(defaultClaim.epistemic_status).toBe("contested");
    expect(JSON.parse(defaultClaim.normalized_statement_json)).toEqual({
      value: 1800,
    });
    const codeEvidenceValues = c6Index
      .prepare(
        `SELECT DISTINCT version.normalized_value
         FROM evidence_versions version
         JOIN evidence_identities identity ON identity.id = version.evidence_identity_id
         JOIN parameter_identities parameter ON parameter.id = identity.parameter_identity_id
         WHERE parameter.canonical_key = 'session.timeout'
           AND identity.source_kind LIKE 'code-%'`,
      )
      .all() as Array<{ normalized_value: string }>;
    expect(
      codeEvidenceValues.map((row) => row.normalized_value).sort(),
    ).toEqual(["1800", "3600"]);
    expect(
      c6Index
        .prepare(
          `SELECT reason, status FROM review_decision_reopens
           WHERE reason = 'material-change'`,
        )
        .all(),
    ).toEqual([{ reason: "material-change", status: "open" }]);
    c6Index.close();
  });

  it("continues a rename with value change as probable and reopens for material change (C7)", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "intentweave-claims-"));
    workspaces.push(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf-8" }).trim();
    mkdirSync(path.join(workspace, "config"));
    mkdirSync(path.join(workspace, "docs"));
    mkdirSync(path.join(workspace, "src", "auth"), { recursive: true });
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/auth/session.ts
        export: IDLE_TIMEOUT
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: default-doc
            target: default
            pattern: '^The default timeout is (?<value>\\d+) seconds\\.$'
          - id: eu-prod-override-doc
            target: effective
            scope: eu-prod
            pattern: '^The eu-prod override is (?<value>\\d+) seconds\\.$'
`,
    );
    writeFileSync(
      path.join(workspace, "config", "environments.yaml"),
      "environments:\n  - name: dev\n    capabilities: [session-runtime]\n  - name: eu-prod\n    capabilities: [session-runtime]\n",
    );
    writeFileSync(
      path.join(workspace, "config", "dev.yaml"),
      "session:\n  timeout: 1800\n",
    );
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 5400\n",
    );
    writeFileSync(
      path.join(workspace, "src", "auth", "session.ts"),
      "/**\n * The default session timeout for authenticated users.\n * Applies to idle sessions across all regions.\n * @default 1800\n */\nexport const IDLE_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The default timeout is 1800 seconds.\nThe eu-prod override is 5400 seconds.\n",
    );
    git("init");
    git("config", "user.email", "claims@example.test");
    git("config", "user.name", "Claims Test");
    git("add", ".");
    git("commit", "-m", "c3 baseline");
    mkdirSync(path.join(workspace, ".iw"));
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baselineClaims = baselineIndex
      .prepare(
        `SELECT ci.id
         FROM claim_identities ci
         JOIN claim_versions version ON version.claim_identity_id = ci.id
         JOIN claim_assessments assessment ON assessment.claim_version_id = version.id
         WHERE assessment.is_current = 1`,
      )
      .all() as Array<{ id: string }>;
    baselineIndex.close();
    for (const claim of baselineClaims) {
      await runClaimsReview({
        claim: claim.id,
        actor: "reviewer",
        decision: "accepted",
        format: "json",
      });
    }

    renameSync(
      path.join(workspace, "src", "auth", "session.ts"),
      path.join(workspace, "src", "auth", "idle.ts"),
    );
    writeFileSync(
      path.join(workspace, "src", "auth", "idle.ts"),
      "/**\n * The default session timeout for authenticated users.\n * Applies to idle sessions across all regions.\n * @default 2400\n */\nexport const AUTH_IDLE_TIMEOUT = 2400;\n",
    );
    writeFileSync(
      path.join(workspace, "intentweave.bindings.yaml"),
      `parameters:
  session.timeout:
    configKeys: [session.timeout]
    codeDefaults:
      - file: src/auth/idle.ts
        export: AUTH_IDLE_TIMEOUT
    documentation:
      - file: docs/session-timeout.md
        assertions:
          - id: default-doc
            target: default
            pattern: '^The default timeout is (?<value>\\d+) seconds\\.$'
          - id: eu-prod-override-doc
            target: effective
            scope: eu-prod
            pattern: '^The eu-prod override is (?<value>\\d+) seconds\\.$'
`,
    );
    git("add", "-A");
    git("commit", "-m", "rename and raise idle timeout");
    process.exitCode = undefined;

    await runClaimsCheck({ scope: "eu-prod", since: "HEAD~1", format: "json" });

    expect(process.exitCode).toBe(1);
    const c7Index = new Database(path.join(workspace, ".iw", "index.db"));
    const codeContinuity = c7Index
      .prepare(
        `SELECT continuity.basis, continuity.confidence
         FROM evidence_continuity continuity
         JOIN evidence_versions version ON version.id = continuity.to_evidence_version_id
         JOIN evidence_identities identity ON identity.id = version.evidence_identity_id
         WHERE identity.source_kind LIKE 'code-%'
         ORDER BY identity.source_kind`,
      )
      .all() as Array<{ basis: string; confidence: string }>;
    expect(codeContinuity).toEqual([
      { basis: "git-file-rename", confidence: "probable" },
      { basis: "git-file-rename", confidence: "probable" },
    ]);
    const defaultClaim = c7Index
      .prepare(
        `SELECT ca.id, ca.epistemic_status, cv.normalized_statement_json
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         JOIN claim_identities ci ON ci.id = cv.claim_identity_id
         WHERE ca.is_current = 1 AND ci.claim_type = 'CLM-DEFAULT'`,
      )
      .get() as {
      id: string;
      epistemic_status: string;
      normalized_statement_json: string;
    };
    expect(defaultClaim.epistemic_status).toBe("supported");
    expect(JSON.parse(defaultClaim.normalized_statement_json)).toEqual({
      value: 2400,
    });
    const docDependency = c7Index
      .prepare(
        `SELECT dependency.epistemic_role, dependency.assessment_effect
         FROM claim_assessment_dependencies dependency
         JOIN evidence_versions version ON version.id = dependency.dependency_version_id
         JOIN evidence_identities identity ON identity.id = version.evidence_identity_id
         WHERE dependency.claim_assessment_id = ?
           AND dependency.dependency_kind = 'evidence_version'
           AND identity.source_kind = 'documentation'`,
      )
      .all(defaultClaim.id) as Array<{
      epistemic_role: string;
      assessment_effect: string;
    }>;
    expect(docDependency).toEqual([
      { epistemic_role: "assertion", assessment_effect: "contradicts" },
    ]);
    const reopens = c7Index
      .prepare(
        `SELECT reason, status, secondary_provenance_json FROM review_decision_reopens
         WHERE reason = 'material-change'`,
      )
      .all() as Array<{
      reason: string;
      status: string;
      secondary_provenance_json: string | null;
    }>;
    expect(reopens.length).toBeGreaterThan(0);
    expect(reopens.every((reopen) => reopen.status === "open")).toBe(true);
    expect(
      reopens.some((reopen) =>
        reopen.secondary_provenance_json?.includes(
          '"continuityConfidence":"probable"',
        ),
      ),
    ).toBe(true);
    c7Index.close();
  });

  it("versions only new scope entries and separates not-applicable from inconclusive (C8)", async () => {
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
      "environments:\n  - name: dev\n    capabilities: [session-runtime]\n  - name: eu-prod\n    capabilities: [session-runtime]\n",
    );
    writeFileSync(
      path.join(workspace, "config", "dev.yaml"),
      "session:\n  timeout: 1800\n",
    );
    writeFileSync(
      path.join(workspace, "config", "eu-prod.yaml"),
      "session:\n  timeout: 5400\n",
    );
    writeFileSync(
      path.join(workspace, "src", "session.ts"),
      "/**\n * @default 1800\n */\nexport const SESSION_TIMEOUT = 1800;\n",
    );
    writeFileSync(
      path.join(workspace, "docs", "session-timeout.md"),
      "The eu-prod override is 5400 seconds.\n",
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    const baselineIndex = new Database(path.join(workspace, ".iw", "index.db"));
    const baselineScopeEvidence = baselineIndex
      .prepare(
        `SELECT identity.identity_key, version.id, version.version_ordinal
         FROM evidence_versions version
         JOIN evidence_identities identity ON identity.id = version.evidence_identity_id
         WHERE identity.source_kind = 'scope-registry'
         ORDER BY identity.identity_key`,
      )
      .all() as Array<{
      identity_key: string;
      id: string;
      version_ordinal: number;
    }>;
    baselineIndex.close();
    expect(baselineScopeEvidence.map((row) => row.identity_key)).toEqual([
      "scope-registry:dev",
      "scope-registry:eu-prod",
    ]);

    writeFileSync(
      path.join(workspace, "config", "environments.yaml"),
      "environments:\n  - name: dev\n    capabilities: [session-runtime]\n  - name: eu-prod\n    capabilities: [session-runtime]\n  - name: mobile-preview\n    capabilities: []\n  - name: staging\n    capabilities: [session-runtime]\n",
    );
    process.chdir(workspace);
    process.exitCode = undefined;

    await runClaimsCheck({ format: "json" });

    expect(process.exitCode).toBe(2);
    const c8Index = new Database(path.join(workspace, ".iw", "index.db"));
    const scopeEvidence = c8Index
      .prepare(
        `SELECT identity.identity_key, version.id, version.version_ordinal
         FROM evidence_versions version
         JOIN evidence_identities identity ON identity.id = version.evidence_identity_id
         WHERE identity.source_kind = 'scope-registry'
         ORDER BY identity.identity_key`,
      )
      .all() as Array<{
      identity_key: string;
      id: string;
      version_ordinal: number;
    }>;
    expect(scopeEvidence.map((row) => row.identity_key)).toEqual([
      "scope-registry:dev",
      "scope-registry:eu-prod",
      "scope-registry:mobile-preview",
      "scope-registry:staging",
    ]);
    for (const baseline of baselineScopeEvidence) {
      const current = scopeEvidence.find(
        (row) => row.identity_key === baseline.identity_key,
      );
      expect(current).toMatchObject({ id: baseline.id, version_ordinal: 1 });
    }
    const r7Mobile = c8Index
      .prepare(
        `SELECT result.normalized_status, result.applicability
         FROM rule_result_versions result
         JOIN rule_result_identities identity ON identity.id = result.rule_result_identity_id
         WHERE identity.rule_id = 'R7.scope-override' AND identity.scope = 'mobile-preview'`,
      )
      .get() as
      | { normalized_status: string; applicability: string }
      | undefined;
    expect(r7Mobile).toEqual({
      normalized_status: "not_applicable",
      applicability: "not_applicable",
    });
    expect(
      c8Index
        .prepare(
          `SELECT COUNT(*) AS count
           FROM claim_assessments ca
           JOIN claim_versions cv ON cv.id = ca.claim_version_id
           JOIN claim_identities ci ON ci.id = cv.claim_identity_id
           WHERE ci.scope = 'mobile-preview'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    const stagingClaims = c8Index
      .prepare(
        `SELECT ci.claim_type, ca.epistemic_status
         FROM claim_assessments ca
         JOIN claim_versions cv ON cv.id = ca.claim_version_id
         JOIN claim_identities ci ON ci.id = cv.claim_identity_id
         WHERE ci.scope = 'staging' AND ca.is_current = 1`,
      )
      .all() as Array<{ claim_type: string; epistemic_status: string }>;
    expect(stagingClaims).toEqual([
      { claim_type: "CLM-EFFECTIVE", epistemic_status: "inconclusive" },
    ]);
    c8Index.close();
  });
});
