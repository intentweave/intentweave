// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end AX extraction test against the real PduView.tsx from ARC-372.
 *
 * PduView.tsx is 79 750 bytes (2208 lines) — larger than the old 64 KB default
 * (65 536 B) but smaller than the new 256 KB default (262 144 B).
 *
 * This test verifies that:
 *  1. The file is NOT skipped with the new default.
 *  2. All 9 exported symbols are present in the index.
 *  3. No symbols were silently dropped (symbol count > 0).
 *  4. With the OLD default the file WOULD have been skipped (regression anchor).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runAxStage } from "../stages/ax.js";

// Path to the real file attached in docs/
const PDUVIEW_SRC = path.resolve(__dirname, "../../../../docs/PduView.tsx");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTempWorkspace(srcFile: string): { ws: string; relPath: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cari-ax-pduview-"));
  const relPath = "src/views/PduView.tsx";
  const dest = path.join(ws, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcFile, dest);
  return { ws, relPath };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runAxStage — real-world PduView.tsx (ARC-372)", () => {
  // Skip gracefully if the docs file is absent (e.g. in external forks)
  const fileExists = fs.existsSync(PDUVIEW_SRC);

  it.skipIf(!fileExists)("PduView.tsx is above old 64 KB threshold", () => {
    const size = fs.statSync(PDUVIEW_SRC).size;
    expect(size).toBeGreaterThan(65_536); // proves old default would skip
    expect(size).toBeLessThan(262_144); // proves new default allows it
  });

  it.skipIf(!fileExists)(
    "ARC-372: with old 64 KB default the file is skipped (regression anchor)",
    async () => {
      const { ws, relPath } = makeTempWorkspace(PDUVIEW_SRC);
      try {
        const output = await runAxStage({
          workspaceRoot: ws,
          include: ["src/**/*.tsx"],
          maxFileSize: 65_536, // old default
        });
        const file = output.files.find((f) => f.filePath === relPath);
        expect(file?.skipped).toBe(true);
        expect(file?.skipReason).toMatch(/file too large/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!fileExists)(
    "with new 256 KB default the file is indexed and all exported symbols are present",
    async () => {
      const { ws, relPath } = makeTempWorkspace(PDUVIEW_SRC);
      try {
        const output = await runAxStage({
          workspaceRoot: ws,
          include: ["src/**/*.tsx"],
          // no maxFileSize → uses new default of 262 144
        });

        const file = output.files.find((f) => f.filePath === relPath);
        expect(file, "PduView.tsx should appear in output").toBeDefined();
        expect(file!.skipped, "file must not be skipped").toBeFalsy();
        expect(
          file!.symbols.length,
          "must have non-zero symbols",
        ).toBeGreaterThan(0);

        const names = file!.symbols.map((s) => s.name);

        // All 9 exported symbols from `grep -n "^export" docs/PduView.tsx`
        const expectedExports = [
          "SignalInstancesSection",
          "BitLayoutSection",
          "CommunicationSection",
          "PduTimings", // exported interface
          "WhitelistEntry", // exported interface
          "shortLabel",
          "normalizeWhitelistEntry",
          "extractPduTimings",
          "PduView",
        ];

        for (const name of expectedExports) {
          expect(
            names,
            `exported symbol "${name}" must be in the index`,
          ).toContain(name);
        }

        // Exported symbols must be marked as such
        for (const sym of file!.symbols.filter((s) =>
          expectedExports.includes(s.name),
        )) {
          expect(sym.export, `"${sym.name}" must be marked exported`).toBe(
            "exported",
          );
        }
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!fileExists)(
    "with explicit --max-file-size 200000 override the file is also indexed",
    async () => {
      const { ws, relPath } = makeTempWorkspace(PDUVIEW_SRC);
      try {
        const output = await runAxStage({
          workspaceRoot: ws,
          include: ["src/**/*.tsx"],
          maxFileSize: 200_000, // the value used in the ARC-372 CI attempt
        });

        const file = output.files.find((f) => f.filePath === relPath);
        expect(file?.skipped).toBeFalsy();
        expect(file?.symbols.some((s) => s.name === "PduView")).toBe(true);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    },
  );
});
