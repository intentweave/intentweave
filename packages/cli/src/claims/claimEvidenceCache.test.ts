// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractDiscoveredCodeEvidence } from "./discovery.js";

describe("claim evidence cache", () => {
  const originalCwd = process.cwd();
  const workspaces: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("returns the same evidence on a second run and keys entries by content", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "iw-evidence-cache-"));
    workspaces.push(workspace);
    process.chdir(workspace);
    const files: Record<string, string> = {
      "src/a.ts": "export const SESSION_TIMEOUT = 1800;\n",
    };
    const readCode = (file: string) => files[file] ?? "";

    const first = extractDiscoveredCodeEvidence(["src/a.ts"], readCode);
    const cacheDir = path.join(workspace, ".iw", "cache", "claim-evidence");
    expect(existsSync(cacheDir)).toBe(true);
    expect(readdirSync(cacheDir)).toHaveLength(1);

    const second = extractDiscoveredCodeEvidence(["src/a.ts"], readCode);
    expect(second).toEqual(first);
    expect(readdirSync(cacheDir)).toHaveLength(1);

    files["src/a.ts"] = "export const SESSION_TIMEOUT = 3600;\n";
    const changed = extractDiscoveredCodeEvidence(["src/a.ts"], readCode);
    expect(readdirSync(cacheDir)).toHaveLength(2);
    expect(changed).not.toEqual(first);
  });
});
