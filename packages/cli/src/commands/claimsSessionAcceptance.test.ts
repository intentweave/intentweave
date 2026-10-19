// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end acceptance for Intent Anchors (G5.4), through the real claims commands.
 * The subject is the documented index-build depth default (a parameter Claim). Code and
 * documentation must agree for the Claim to be supported, so a changed default is a real
 * statement change, and not a refuted one.
 *
 * Cases:
 *  1. An unprotected Claim whose statement changes does not block the gate.
 *  2. A protected Claim whose statement changes is an intent_conflict.
 *  3. A declared follow-up accepts the change, and records its review.
 *  4. reject_change keeps the conflict until the statement is corrected.
 *  5. accept_amendment supersedes the anchor; grant_exception is time-limited.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initSchema } from "@intentweave/index";
import {
  runClaimsCheck,
  runClaimsConflictResolve,
  runClaimsReview,
} from "./claims.js";

// Acceptance suites build indexes and run several checks; allow for load.
vi.setConfig({ testTimeout: 180_000 });

type Depth = "structured" | "full";

describe("session acceptance: intent anchors on a parameter Claim", () => {
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

  /** Code default and documented default, written together. */
  function writeDefault(workspace: string, code: Depth, docs: Depth): void {
    mkdirSync(path.join(workspace, ".iw"), { recursive: true });
    mkdirSync(path.join(workspace, "docs"), { recursive: true });
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
            pattern: '^iw index build\\s+# (?<value>${docs}) depth \\(default\\)$'
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
      `build.option("--depth <depth>", "Annotation depth", "${code}");\n`,
    );
    writeFileSync(
      path.join(workspace, "docs", "CLI-USAGE.md"),
      `iw index build                    # ${docs} depth (default)\n`,
    );
  }

  function newWorkspace(code: Depth, docs: Depth): string {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-acceptance-"),
    );
    workspaces.push(workspace);
    writeDefault(workspace, code, docs);
    process.chdir(workspace);
    return workspace;
  }

  function setGateMode(workspace: string, mode: "report" | "gate"): void {
    mkdirSync(path.join(workspace, ".iw", "claims"), { recursive: true });
    writeFileSync(
      path.join(workspace, ".iw", "claims", "intent.yaml"),
      `schemaVersion: "1"\nmode: ${mode}\n`,
    );
  }

  /** Run a check and return its parsed output and exit code. */
  async function check(options: { asOf?: string } = {}): Promise<{
    output: {
      intentAnchors?: Array<{
        outcome: string;
        reason: string;
        currentStatementFingerprint?: string;
        claimIdentityId: string;
      }>;
      claims: Array<{
        parameterKey?: string | null;
        assessmentStatuses: string[];
      }>;
    };
    exitCode: number | undefined;
  }> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.exitCode = undefined;
    await runClaimsCheck({ format: "json", ...options });
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    const exitCode = process.exitCode;
    log.mockRestore();
    return { output, exitCode };
  }

  /** Protect the depth Claim with an accepted review of its current assessment. */
  async function protectDefault(): Promise<void> {
    await check();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runClaimsReview({
      claim: "cli.index-build.depth",
      type: "CLM-DEFAULT",
      actor: "acceptance",
      decision: "accepted",
      purpose: "protect",
      rationale: "Protected default",
      format: "json",
    });
    vi.restoreAllMocks();
  }

  function claimIdentityId(): string {
    const database = new Database(path.join(process.cwd(), ".iw", "index.db"));
    const row = database
      .prepare(
        `SELECT id FROM claim_identities WHERE claim_type = 'CLM-DEFAULT' LIMIT 1`,
      )
      .get() as { id: string };
    database.close();
    return row.id;
  }

  it("case 1: an unprotected changed Claim does not block the gate", async () => {
    const workspace = newWorkspace("structured", "structured");
    setGateMode(workspace, "gate");
    await check();
    // Change code and documentation together: both agree again, so the Claim stays
    // supported with a changed statement and no anchor.
    writeDefault(workspace, "full", "full");
    const report = await check();
    // Gate mode with no protected Claims: anchors are evaluated, and none exist.
    expect(report.output.intentAnchors).toEqual([]);
    expect(report.exitCode).not.toBe(4);
    // The same state in report mode still asks for review, so the gate rule is what changes it.
    setGateMode(workspace, "report");
    expect((await check()).exitCode).toBe(4);
    expect(
      report.output.claims.every((c) =>
        c.assessmentStatuses.every((s) => s === "supported"),
      ),
    ).toBe(true);
  });

  it("case 2: a protected Claim whose statement changes is an intent_conflict", async () => {
    const workspace = newWorkspace("structured", "structured");
    setGateMode(workspace, "gate");
    await protectDefault();
    // Change the code default only: the documentation no longer agrees, so the
    // statement changes and the Claim is refuted.
    writeDefault(workspace, "full", "structured");
    const result = await check();
    const conflict = result.output.intentAnchors?.find(
      (a) => a.outcome === "intent_conflict",
    );
    expect(conflict).toBeDefined();
    expect(result.exitCode).toBe(1);
    expect(
      readFileSync(
        path.join(workspace, ".iw", "claims", "intent.yaml"),
        "utf-8",
      ),
    ).toContain("gate");
  });

  it("case 3: a declared follow-up accepts the change and records its review", async () => {
    const workspace = newWorkspace("structured", "structured");
    setGateMode(workspace, "gate");
    await protectDefault();
    const identity = claimIdentityId();
    // Code and documentation change together, so the statement changes and is supported.
    writeDefault(workspace, "full", "full");
    const undeclared = await check();
    const conflict = undeclared.output.intentAnchors?.find(
      (a) => a.outcome === "intent_conflict",
    );
    expect(conflict?.currentStatementFingerprint).toBeDefined();
    expect(undeclared.exitCode).toBe(1);

    setGateMode(workspace, "gate");
    writeFileSync(
      path.join(workspace, ".iw", "claims", "intent.yaml"),
      `schemaVersion: "1"\nmode: gate\nfollowUps:\n  - claimIdentityId: ${identity}\n    statementFingerprint: ${conflict!.currentStatementFingerprint}\n`,
    );
    const declared = await check();
    expect(declared.output.intentAnchors?.map((a) => a.outcome)).toEqual([
      "satisfied",
    ]);
    expect(declared.exitCode).not.toBe(1);
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    const review = database
      .prepare(
        `SELECT decision_origin FROM review_decisions WHERE decision_origin = 'follow-up'`,
      )
      .all();
    database.close();
    expect(review.length).toBeGreaterThan(0);
  });

  it("case 4: reject_change keeps the conflict until the statement is corrected", async () => {
    const workspace = newWorkspace("structured", "structured");
    setGateMode(workspace, "gate");
    await protectDefault();
    writeDefault(workspace, "full", "structured");
    await check();

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runClaimsConflictResolve({
      claim: "cli.index-build.depth",
      type: "CLM-DEFAULT",
      decision: "reject_change",
      actor: "acceptance",
      rationale: "Full depth is not the documented contract",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
    vi.restoreAllMocks();

    const rejected = await check();
    const outcome = rejected.output.intentAnchors?.[0];
    expect(outcome?.outcome).toBe("intent_conflict");
    expect(outcome?.reason).toContain("rejected by acceptance");
    expect(rejected.exitCode).toBe(1);

    // Correcting the code restores the protected statement, so the anchor is satisfied.
    writeDefault(workspace, "structured", "structured");
    const corrected = await check();
    expect(corrected.output.intentAnchors?.map((a) => a.outcome)).toEqual([
      "satisfied",
    ]);
  });

  it("case 5: accept_amendment supersedes the anchor, and grant_exception expires", async () => {
    const workspace = newWorkspace("structured", "structured");
    setGateMode(workspace, "gate");
    await protectDefault();

    // Exception: a refuted change is excepted until the given expiry, then conflicts.
    writeDefault(workspace, "full", "structured");
    await check();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runClaimsConflictResolve({
      claim: "cli.index-build.depth",
      type: "CLM-DEFAULT",
      decision: "grant_exception",
      actor: "acceptance",
      rationale: "Migration in progress",
      expires: "2030-01-01T00:00:00Z",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
    vi.restoreAllMocks();

    const excepted = await check({ asOf: "2029-06-01T00:00:00Z" });
    expect(excepted.output.intentAnchors?.[0]?.outcome).toBe("intent_excepted");
    expect(excepted.exitCode).toBe(1); // the refuted assessment still fails the check

    const expired = await check({ asOf: "2031-01-01T00:00:00Z" });
    expect(expired.output.intentAnchors?.[0]?.outcome).toBe("intent_conflict");
    expect(expired.output.intentAnchors?.[0]?.reason).toContain("expired");

    // Amendment: the documentation catches up, so the statement is supported again and
    // the new statement can be protected.
    writeDefault(workspace, "full", "full");
    // The exception covers this exact statement, so it still applies to the same change.
    const supported = await check();
    expect(supported.output.intentAnchors?.[0]?.outcome).toBe(
      "intent_excepted",
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runClaimsConflictResolve({
      claim: "cli.index-build.depth",
      type: "CLM-DEFAULT",
      decision: "accept_amendment",
      actor: "acceptance",
      rationale: "Full depth is the new default",
      format: "json",
    });
    expect(process.exitCode).toBe(0);
    vi.restoreAllMocks();
    const amended = await check();
    expect(amended.output.intentAnchors?.map((a) => a.outcome)).toEqual([
      "satisfied",
    ]);
  });

  /** Delete the index database and its WAL files, as a rebuild starts from nothing. */
  function discardIndex(workspace: string): void {
    for (const name of readdirSync(path.join(workspace, ".iw"))) {
      if (name.startsWith("index.db")) {
        rmSync(path.join(workspace, ".iw", name), { force: true });
      }
    }
    // Recreate an empty index the same way the fixture does, so a check starts clean.
    const database = new Database(path.join(workspace, ".iw", "index.db"));
    initSchema(database);
    database.close();
  }

  it("keeps a rejected change after the index is rebuilt", async () => {
    const workspace = newWorkspace("structured", "structured");
    setGateMode(workspace, "gate");
    await protectDefault();
    writeDefault(workspace, "full", "structured");
    await check();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runClaimsConflictResolve({
      claim: "cli.index-build.depth",
      type: "CLM-DEFAULT",
      decision: "reject_change",
      actor: "acceptance",
      rationale: "Full depth is not the documented contract",
      format: "json",
    });
    vi.restoreAllMocks();

    discardIndex(workspace);
    const rebuilt = await check();
    const outcome = rebuilt.output.intentAnchors?.[0];
    expect(outcome?.outcome).toBe("intent_conflict");
    expect(outcome?.reason).toContain("rejected by acceptance");
    expect(rebuilt.exitCode).toBe(1);
  });

  it("keeps an exception, and its expiry, after the index is rebuilt", async () => {
    const workspace = newWorkspace("structured", "structured");
    setGateMode(workspace, "gate");
    await protectDefault();
    writeDefault(workspace, "full", "structured");
    await check();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runClaimsConflictResolve({
      claim: "cli.index-build.depth",
      type: "CLM-DEFAULT",
      decision: "grant_exception",
      actor: "acceptance",
      rationale: "Migration in progress",
      expires: "2030-01-01T00:00:00Z",
      format: "json",
    });
    vi.restoreAllMocks();

    discardIndex(workspace);
    const before = await check({ asOf: "2029-06-01T00:00:00Z" });
    expect(before.output.intentAnchors?.[0]?.outcome).toBe("intent_excepted");

    discardIndex(workspace);
    const after = await check({ asOf: "2031-01-01T00:00:00Z" });
    expect(after.output.intentAnchors?.[0]?.outcome).toBe("intent_conflict");
    expect(after.output.intentAnchors?.[0]?.reason).toContain("expired");
  });
});
