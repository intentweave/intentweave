// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * O3 dual write: the Fastify discoverer records its route registrations as an
 * observation run. The run must describe the same endpoints that the Candidate path
 * produces, and an unused framework must be recorded as unsupported, never absent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initSchema } from "@intentweave/index";
import Database from "@intentweave/sqlite-compat";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverFastifyObservations,
  FASTIFY_ENDPOINT_DISCOVERY_ADAPTER_ID,
  mergeDuplicateObservations,
  persistFastifyEndpointCandidates,
} from "./fastifyEndpointDiscovery.js";
import { readEndpointObservations } from "./endpointObservationProducer.js";
import { persistNestEndpointCandidates } from "./nestEndpointDiscovery.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function openDatabase(): Database.Database {
  const directory = mkdtempSync(path.join(tmpdir(), "iw-endpoint-producer-"));
  workspaces.push(directory);
  const database = new Database(path.join(directory, "index.db"));
  initSchema(database);
  return database;
}

const PACKAGE_JSON = JSON.stringify({ dependencies: { fastify: "^5.0.0" } });

const ROUTES = `import Fastify from "fastify";
export default async function routes(fastify) {
  fastify.get("/health", async () => ({ ok: true }));
  fastify.post("/orders", async () => ({ created: true }));
}
`;

function sourcesFor(files: Record<string, string>): {
  readSource: (filePath: string) => string | undefined;
  filePaths: string[];
} {
  return {
    readSource: (filePath) => files[filePath],
    filePaths: Object.keys(files).filter(
      (file) => file.endsWith(".ts") || file.endsWith(".js"),
    ),
  };
}

function insertFiles(database: Database.Database, paths: string[]): void {
  const insert = database.prepare(
    "INSERT INTO files (path, is_doc, indexed) VALUES (?, 0, 1)",
  );
  for (const filePath of paths) insert.run(filePath);
}

describe("Fastify endpoint observation producer", () => {
  it("records one route observation per candidate and covers the scanned files", () => {
    const database = openDatabase();
    const files = {
      "package.json": PACKAGE_JSON,
      "src/routes.ts": ROUTES,
    };
    insertFiles(database, ["package.json", "src/routes.ts"]);
    const { readSource } = sourcesFor(files);

    const candidates = persistFastifyEndpointCandidates(
      database,
      "rev:1",
      readSource,
    );
    const candidateKeys = candidates.map((candidate) => candidate.identityKey);

    const run = database
      .prepare(
        `SELECT id, adapter_id FROM observation_runs WHERE adapter_id = 'fastify-endpoint-discovery' OR adapter_id LIKE '%fastify%'`,
      )
      .get() as { id: string; adapter_id: string } | undefined;
    expect(run).toBeDefined();

    const coverage = database
      .prepare(
        `SELECT kind, coverage_status, object_count FROM observation_run_coverage WHERE run_id = ?`,
      )
      .all(run!.id) as Array<{
      kind: string;
      coverage_status: string;
      object_count: number;
    }>;
    expect(coverage).toEqual([
      { kind: "call-site", coverage_status: "complete", object_count: 2 },
    ]);

    const routes = database
      .prepare(
        `SELECT i.identity_key FROM observation_run_items item
         JOIN observed_identities i ON i.id = item.observed_identity_id
         WHERE item.run_id = ?`,
      )
      .all(run!.id) as Array<{ identity_key: string }>;
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(
        route.identity_key.startsWith("endpoint-route:fastify:src/routes.ts#"),
      ).toBe(true);
    }
    expect(candidateKeys).toHaveLength(2);
    database.close();
  });

  it("records an unsupported run, not an absent one, when fastify is not declared", () => {
    const database = openDatabase();
    const files = {
      "package.json": JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      "src/routes.ts": ROUTES,
    };
    insertFiles(database, ["package.json", "src/routes.ts"]);
    const { readSource } = sourcesFor(files);

    const candidates = persistFastifyEndpointCandidates(
      database,
      "rev:1",
      readSource,
    );
    expect(candidates).toEqual([]);

    const coverage = database
      .prepare(
        `SELECT kind, coverage_status, reason FROM observation_run_coverage`,
      )
      .all() as Array<{
      kind: string;
      coverage_status: string;
      reason: string;
    }>;
    expect(coverage).toEqual([
      {
        kind: "call-site",
        coverage_status: "unsupported",
        reason: "fastify is not a declared dependency",
      },
    ]);
    database.close();
  });

  it("records a complete symbol run for NestJS, even when no handler is found", () => {
    const database = openDatabase();
    const candidates = persistNestEndpointCandidates(
      database,
      "rev:1",
      () => undefined,
    );
    expect(candidates).toEqual([]);

    const coverage = database
      .prepare(
        `SELECT kind, coverage_status, object_count FROM observation_run_coverage`,
      )
      .all() as Array<{
      kind: string;
      coverage_status: string;
      object_count: number;
    }>;
    expect(coverage).toEqual([
      { kind: "symbol", coverage_status: "complete", object_count: 0 },
    ]);
    database.close();
  });

  it("builds the Candidate inputs from the recorded run, equal to the discovery output", () => {
    const database = openDatabase();
    const files = { "package.json": PACKAGE_JSON, "src/routes.ts": ROUTES };
    insertFiles(database, ["package.json", "src/routes.ts"]);
    const { readSource } = sourcesFor(files);
    persistFastifyEndpointCandidates(database, "rev:1", readSource);

    const run = database
      .prepare(`SELECT id FROM observation_runs WHERE adapter_id = ?`)
      .get(FASTIFY_ENDPOINT_DISCOVERY_ADAPTER_ID) as { id: string };
    const fromRun = readEndpointObservations(database, run.id);
    const direct = [
      ...mergeDuplicateObservations(
        discoverFastifyObservations(
          new Map(Object.entries(files).filter(([f]) => f !== "package.json")),
        ),
      ).values(),
    ];
    expect(fromRun).toEqual(direct);
    database.close();
  });

  it("does not reuse a stale run when the workspace changes under the same revision", () => {
    const database = openDatabase();
    const first = { "package.json": PACKAGE_JSON, "src/routes.ts": ROUTES };
    insertFiles(database, ["package.json", "src/routes.ts"]);
    persistFastifyEndpointCandidates(
      database,
      "rev:1",
      sourcesFor(first).readSource,
    );

    // Same HEAD, one route removed in the working tree.
    const edited = {
      "package.json": PACKAGE_JSON,
      "src/routes.ts": `import Fastify from "fastify";
export default async function routes(fastify) {
  fastify.get("/health", async () => ({ ok: true }));
}
`,
    };
    persistFastifyEndpointCandidates(
      database,
      "rev:1",
      sourcesFor(edited).readSource,
    );

    const runs = database
      .prepare(
        `SELECT id FROM observation_runs WHERE adapter_id = ? ORDER BY started_at`,
      )
      .all(FASTIFY_ENDPOINT_DISCOVERY_ADAPTER_ID) as Array<{ id: string }>;
    expect(runs).toHaveLength(2);
    const latest = readEndpointObservations(database, runs[1]!.id);
    // The route path carries the registering file, as the Candidate identity does.
    expect(latest.map((observation) => observation.routePath)).toEqual([
      "/health@src/routes.ts",
    ]);
    database.close();
  });
});
