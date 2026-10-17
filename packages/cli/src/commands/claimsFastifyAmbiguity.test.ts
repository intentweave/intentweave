// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "@intentweave/sqlite-compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runClaimsCandidateReview,
  runClaimsCandidatesTriage,
  runClaimsCheck,
  runClaimsDiscover,
} from "./claims.js";

/**
 * A semantic correlation can raise a candidate's stored confidence to probable.
 * Deterministic ambiguity recorded in Route Evidence must still keep the Rule
 * inconclusive after promotion. The control fixture has one verifier, so the
 * same route must pass.
 */
describe("Fastify guard ambiguity survives semantic correlation", () => {
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

  function git(workspace: string, ...args: string[]): void {
    execFileSync("git", args, { cwd: workspace, encoding: "utf-8" });
  }

  const APP = `import AutoLoad from "@fastify/autoload";
import { join } from "node:path";
export default async function app(fastify, opts) {
  await fastify.register(AutoLoad, { dir: join(__dirname, "plugins"), options: opts });
  await fastify.register(AutoLoad, {
    dir: join(__dirname, "modules"),
    options: { ...opts, prefix: "/api" },
    maxDepth: 2,
  });
}
`;

  const TOKEN_A = `import fp from "fastify-plugin";
export default fp(async function tokenA(fastify) {
  fastify.decorate("checkToken", async (request) => {
    await request.jwtVerify();
  });
});
`;

  const TOKEN_B = `import fp from "fastify-plugin";
export default fp(async function tokenB(fastify) {
  fastify.decorate("checkToken", async (request) => {
    await request.jwtVerify({ secret: process.env.SERVICE_JWT_SECRET });
  });
});
`;

  const ORDERS_PLUGIN = `import ordersRoutes from "./orders.routes";
export default async function ordersPlugin(fastify) {
  await fastify.register(ordersRoutes);
}
`;

  const ORDERS_ROUTES = `export default async function ordersRoutes(fastify) {
  fastify.get("/orders", { preHandler: [fastify.checkToken] }, async () => ({ orders: [] }));
}
`;

  function createWorkspace(options: { secondVerifier: boolean }): string {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "intentweave-fastify-ambiguity-"),
    );
    workspaces.push(workspace);
    mkdirSync(path.join(workspace, "src/plugins"), { recursive: true });
    mkdirSync(path.join(workspace, "src/modules/orders"), { recursive: true });
    writeFileSync(path.join(workspace, ".gitignore"), ".iw/\n");
    writeFileSync(path.join(workspace, "README.md"), "# Fastify Fixture\n");
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "fastify-ambiguity-fixture",
        private: true,
        dependencies: {
          fastify: "^5.0.0",
          "fastify-plugin": "^5.0.0",
          "@fastify/autoload": "^6.0.0",
        },
      }),
    );
    writeFileSync(path.join(workspace, "src/app.ts"), APP);
    writeFileSync(path.join(workspace, "src/plugins/token-a.ts"), TOKEN_A);
    if (options.secondVerifier) {
      writeFileSync(path.join(workspace, "src/plugins/token-b.ts"), TOKEN_B);
    }
    writeFileSync(
      path.join(workspace, "src/modules/orders/orders.plugin.ts"),
      ORDERS_PLUGIN,
    );
    writeFileSync(
      path.join(workspace, "src/modules/orders/orders.routes.ts"),
      ORDERS_ROUTES,
    );
    git(workspace, "init");
    git(workspace, "config", "user.email", "claims@example.test");
    git(workspace, "config", "user.name", "Claims Test");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-m", "fastify fixture");
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
        env: { ...process.env, IW_SESSION: "fastify-ambiguity" },
      },
    );
    return workspace;
  }

  /**
   * Discover, then simulate the semantic apply step: the candidate becomes
   * correlated at probable confidence. Then triage, promote, and check.
   */
  async function promoteWithProbableCorrelation(
    workspace: string,
    log: ReturnType<typeof vi.spyOn>,
  ): Promise<{ ruleStatuses: string[] }> {
    process.chdir(workspace);
    log.mockClear();
    process.exitCode = undefined;
    await runClaimsDiscover({ all: true, format: "json" });
    const discovered = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string; identityKey: string }>;
    };
    const candidate = discovered.candidates.find((item) =>
      item.identityKey.startsWith(
        "endpoint-auth:fastify:GET:/api/orders/orders",
      ),
    );
    expect(candidate).toBeDefined();

    const database = new Database(path.join(workspace, ".iw/index.db"));
    database
      .prepare(
        `UPDATE claim_candidates
         SET confidence = 'probable', state = 'correlated'
         WHERE identity_key = ?`,
      )
      .run(candidate!.identityKey);
    database.close();

    log.mockClear();
    await runClaimsCandidatesTriage({
      candidate: candidate!.id,
      format: "json",
    });
    const triaged = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      candidates: Array<{ id: string }>;
    };
    await runClaimsCandidateReview({
      candidate: triaged.candidates[0]!.id,
      actor: "fastify-ambiguity-test",
      decision: "promote",
      rationale: "Regression fixture for semantic correlation",
      format: "json",
    });

    const execution = await runClaimsCheck({
      format: "json",
      emit: false,
      setExitCode: false,
    });
    const claims = execution?.output.claims ?? [];
    expect(claims.length).toBeGreaterThan(0);
    return { ruleStatuses: claims.flatMap((claim) => claim.ruleStatuses) };
  }

  it("keeps a guard with two verifier definitions inconclusive after a probable correlation", async () => {
    const workspace = createWorkspace({ secondVerifier: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { ruleStatuses } = await promoteWithProbableCorrelation(
      workspace,
      log,
    );

    expect(ruleStatuses).toEqual(["inconclusive"]);
    expect(ruleStatuses).not.toContain("passed");
  });

  it("passes the same route when the guard has one verifier definition", async () => {
    const workspace = createWorkspace({ secondVerifier: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { ruleStatuses } = await promoteWithProbableCorrelation(
      workspace,
      log,
    );

    expect(ruleStatuses).toEqual(["passed"]);
  });
});
