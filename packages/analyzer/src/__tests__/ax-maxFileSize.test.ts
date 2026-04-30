// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for AX stage maxFileSize option wiring.
 *
 * Reproduces the ARC-372 field report where passing --max-file-size did not
 * prevent large files from being skipped (and small files still produced 0
 * symbols).  These tests verify that:
 *
 *  1. maxFileSize is honoured: a file LARGER than the threshold is skipped.
 *  2. maxFileSize override works: a file that exceeds the DEFAULT threshold is
 *     indexed when a larger maxFileSize is supplied.
 *  3. A file SMALLER than the threshold is never skipped, regardless of the
 *     option value.
 *  4. Skipped files are reported with a human-readable skipReason.
 *  5. Symbol extraction runs (non-zero symbols) for a non-skipped .ts file.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runAxStage } from "../stages/ax.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a temp workspace directory and return its path. */
function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cari-ax-size-"));
}

/** Write content to a file inside the workspace, return file size in bytes. */
function writeFile(
  workspace: string,
  relPath: string,
  content: string,
): number {
  const abs = path.join(workspace, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return fs.statSync(abs).size;
}

/** Build a .ts source string with a single exported function of known padding. */
function makeTypescriptSource(extraPaddingBytes = 0): string {
  const base = `export function myExportedFunction(x: number): number {\n  return x * 2;\n}\n`;
  const padding =
    extraPaddingBytes > 0 ? "// " + "x".repeat(extraPaddingBytes) + "\n" : "";
  return base + padding;
}

const createdWorkspaces: string[] = [];

function newWorkspace(): string {
  const ws = makeTempWorkspace();
  createdWorkspaces.push(ws);
  return ws;
}

afterEach(() => {
  // Clean up all temp workspaces created in tests
  for (const ws of createdWorkspaces.splice(0)) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runAxStage — maxFileSize option wiring", () => {
  it("skips a file whose size exceeds maxFileSize", async () => {
    const ws = newWorkspace();
    const size = writeFile(ws, "src/big.ts", makeTypescriptSource(5000));

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.ts"],
      maxFileSize: size - 1, // one byte below actual size
    });

    const file = output.files.find((f) => f.filePath === "src/big.ts");
    expect(file).toBeDefined();
    expect(file!.skipped).toBe(true);
    expect(file!.skipReason).toMatch(/file too large/);
  });

  it("does NOT skip a file whose size is below maxFileSize", async () => {
    const ws = newWorkspace();
    const size = writeFile(ws, "src/small.ts", makeTypescriptSource(0));

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.ts"],
      maxFileSize: size + 1000, // well above actual size
    });

    const file = output.files.find((f) => f.filePath === "src/small.ts");
    expect(file).toBeDefined();
    expect(file!.skipped).toBeFalsy();
  });

  /**
   * ARC-372 regression: a ~80 KB file was skipped with the old 64 KB default
   * even when --max-file-size 200000 was passed, because the option was not
   * wired through.  This test creates a file that is larger than the old
   * default (65536 B) but smaller than 200000 B, then asserts that
   * maxFileSize: 200000 does NOT skip it.
   */
  it("ARC-372 regression: file between old-default (64 KB) and override (200 KB) is indexed when override is supplied", async () => {
    const ws = newWorkspace();
    // Target ~70 KB — larger than old default 65536, smaller than 200000
    const targetBytes = 70_000;
    const base = makeTypescriptSource(0);
    const paddingNeeded = Math.max(
      0,
      targetBytes - Buffer.byteLength(base, "utf-8"),
    );
    const content = base + "// " + "x".repeat(paddingNeeded) + "\n";

    const actualSize = writeFile(ws, "src/EcuView.ts", content);
    expect(actualSize).toBeGreaterThan(65536); // sanity: larger than old default
    expect(actualSize).toBeLessThan(200_000); // sanity: smaller than override

    // With the old default (65536) the file WOULD be skipped
    const outputWithOldDefault = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.ts"],
      maxFileSize: 65536,
    });
    const skippedByDefault = outputWithOldDefault.files.find(
      (f) => f.filePath === "src/EcuView.ts",
    );
    expect(skippedByDefault?.skipped).toBe(true); // confirm old behaviour

    // With maxFileSize: 200000 (the --max-file-size 200000 flag) it must NOT be skipped
    const outputWithOverride = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.ts"],
      maxFileSize: 200_000,
    });
    const indexedWithOverride = outputWithOverride.files.find(
      (f) => f.filePath === "src/EcuView.ts",
    );
    expect(indexedWithOverride).toBeDefined();
    expect(indexedWithOverride!.skipped).toBeFalsy();
  });

  it("new default (262144 / 256 KB) does not skip a 70 KB file", async () => {
    const ws = newWorkspace();
    const targetBytes = 70_000;
    const base = makeTypescriptSource(0);
    const padding = Math.max(0, targetBytes - Buffer.byteLength(base, "utf-8"));
    const content = base + "// " + "x".repeat(padding) + "\n";
    writeFile(ws, "src/LargeView.ts", content);

    // Default maxFileSize (262144) — do not pass the option at all
    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.ts"],
    });

    const file = output.files.find((f) => f.filePath === "src/LargeView.ts");
    expect(file).toBeDefined();
    expect(file!.skipped).toBeFalsy();
  });

  it("extracts at least one symbol from a non-skipped .ts file", async () => {
    const ws = newWorkspace();
    writeFile(ws, "src/auth.ts", makeTypescriptSource(0));

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.ts"],
    });

    const file = output.files.find((f) => f.filePath === "src/auth.ts");
    expect(file).toBeDefined();
    expect(file!.skipped).toBeFalsy();
    expect(file!.symbols.length).toBeGreaterThan(0);
    expect(file!.symbols.some((s) => s.name === "myExportedFunction")).toBe(
      true,
    );
  });

  it("skipReason contains byte sizes for diagnosability", async () => {
    const ws = newWorkspace();
    const size = writeFile(ws, "src/huge.ts", makeTypescriptSource(2000));

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.ts"],
      maxFileSize: 100, // force skip
    });

    const file = output.files.find((f) => f.filePath === "src/huge.ts");
    expect(file?.skipReason).toMatch(/100 bytes/); // threshold reported
    expect(file?.skipReason).toMatch(new RegExp(`${size} bytes`)); // actual size reported
  });
});
