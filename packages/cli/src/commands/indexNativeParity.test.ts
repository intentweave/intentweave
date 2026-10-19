// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Native engine parity for Claims (G5.4 follow-up). The native `cari-build` must produce
 * the same symbol identities and signatures as the TypeScript AX stage, because Claim
 * identities are built from them. Runs only when CARI_BUILD_PATH points at a native
 * binary built from the current source; otherwise it is skipped.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "@intentweave/sqlite-compat";
import { afterEach, describe, expect, it } from "vitest";

const nativeBinary = process.env.CARI_BUILD_PATH;
const cli = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/cli/src/cli.ts",
);

const FIXTURE = `export interface Extractor {
  name: string;
  kind: "component" | "class";
}
export interface Layer {
  name: string;
}
export function make(a: number): number {
  return a;
}
export class Registry {
  register(extractor: Extractor): void {
    void extractor;
  }
}
`;

describe.skipIf(!nativeBinary)(
  "native index parity with the TypeScript engine",
  () => {
    const workspaces: string[] = [];
    afterEach(() => {
      for (const workspace of workspaces.splice(0)) {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    function buildSymbols(
      workspace: string,
      engine: "ts" | "native",
    ): Map<string, string | null> {
      const args = [
        "index",
        "build",
        "--depth",
        "structured",
        ...(engine === "ts" ? ["--no-native"] : []),
        ".",
      ];
      execFileSync("tsx", [cli, ...args], {
        cwd: workspace,
        env: { ...process.env, IW_SESSION: "native-parity" },
        encoding: "utf-8",
        stdio: "pipe",
      });
      const db = new Database(path.join(workspace, ".iw", "index.db"));
      const rows = db
        .prepare("SELECT id, signature FROM symbols")
        .all() as Array<{
        id: string;
        signature: string | null;
      }>;
      db.close();
      return new Map(rows.map((row) => [row.id, row.signature]));
    }

    it("produces the same symbol identities and signatures as the TypeScript engine", () => {
      const workspace = mkdtempSync(
        path.join(tmpdir(), "intentweave-native-parity-"),
      );
      workspaces.push(workspace);
      mkdirSync(path.join(workspace, "src"));
      writeFileSync(path.join(workspace, "src", "api.ts"), FIXTURE);
    writeFileSync(path.join(workspace, "README.md"), "# Parity\n");
      execFileSync("git", ["init", "-q"], { cwd: workspace });

      const ts = buildSymbols(workspace, "ts");
      rmSync(path.join(workspace, ".iw"), { recursive: true, force: true });
      const native = buildSymbols(workspace, "native");

      expect([...native.keys()].sort()).toEqual([...ts.keys()].sort());
      for (const [id, signature] of ts) {
        expect(native.get(id) ?? null, id).toBe(signature);
      }
    }, 180_000);
  },
);
