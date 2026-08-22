// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "@intentweave/sqlite-compat";
import { initSchema } from "@intentweave/index";
import { runClaimsDiscover } from "./claims.js";

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
      const persisted = new Database(dbPath, { readonly: true });
      expect(
        persisted.prepare(`SELECT COUNT(*) AS count FROM claim_candidates`).get(),
      ).toEqual({ count: 1 });
      expect(
        persisted.prepare(`SELECT COUNT(*) AS count FROM candidate_evidence`).get(),
      ).toEqual({ count: 2 });
      expect(
        persisted.prepare(`SELECT COUNT(*) AS count FROM parameter_identities`).get(),
      ).toEqual({ count: 0 });
      expect(
        persisted.prepare(`SELECT COUNT(*) AS count FROM claim_identities`).get(),
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
});
