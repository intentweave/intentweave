// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for AX symbol extraction of modern React patterns.
 *
 * Root cause (ARC-372): files like EcuView.tsx (41 KB, 909 lines) and
 * FrameView.tsx (36 KB, 845 lines) produced 0 symbols from runAxStage even
 * though they were NOT being skipped by the file-size gate.  Investigation
 * showed that modern React components are typically written as:
 *
 *   export const EcuView = React.memo(({ entity }) => { ... });
 *
 * In tree-sitter the value of the variable_declarator is a call_expression
 * (React.memo), not an arrow_function directly.  The extractor's
 * extractVariables() therefore sets kind = "variable" instead of "function",
 * and mapSymbolKind("variable") returns null, silently dropping the symbol.
 *
 * Result: any file whose top-level exported symbols are ALL wrapped in HOC
 * call expressions (React.memo, React.forwardRef, memo, forwardRef, connect,
 * styled.div, etc.) will have 0 symbols extracted.
 *
 * Fix: extractVariables() should inspect call_expression arguments for nested
 * arrow_function / function_expression nodes and promote kind to "function"
 * when found.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runAxStage } from "../stages/ax.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const workspaces: string[] = [];

function newWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cari-ax-react-"));
  workspaces.push(ws);
  return ws;
}

function write(ws: string, relPath: string, content: string): void {
  const abs = path.join(ws, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runAxStage — React component symbol extraction", () => {
  it("direct arrow function component is extracted", async () => {
    const ws = newWorkspace();
    write(
      ws,
      "src/DirectView.tsx",
      `
export const DirectView = ({ entity }: { entity: unknown }) => {
  return null;
};
`,
    );

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.tsx"],
    });
    const file = output.files.find((f) => f.filePath === "src/DirectView.tsx");
    expect(file?.skipped).toBeFalsy();
    expect(file?.symbols.some((s) => s.name === "DirectView")).toBe(true);
  });

  /**
   * ARC-372 regression: React.memo-wrapped component produces 0 symbols.
   *
   * `export const EcuView = React.memo(...)` — value node is call_expression,
   * not arrow_function → kind stays "variable" → mapSymbolKind returns null →
   * symbol dropped → 0 symbols for the whole file.
   */
  it("ARC-372 regression: React.memo-wrapped component is extracted as a function symbol", async () => {
    const ws = newWorkspace();
    write(
      ws,
      "src/EcuView.tsx",
      `
import React from "react";

export const EcuView = React.memo(({ entity }: { entity: unknown }) => {
  return null;
});
`,
    );

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.tsx"],
    });
    const file = output.files.find((f) => f.filePath === "src/EcuView.tsx");
    expect(file?.skipped).toBeFalsy();
    expect(
      file?.symbols.some((s) => s.name === "EcuView"),
      "EcuView should be extracted — React.memo wrap must not drop the symbol",
    ).toBe(true);
    expect(file?.symbols.find((s) => s.name === "EcuView")?.export).toBe(
      "exported",
    );
  });

  it("React.forwardRef-wrapped component is extracted", async () => {
    const ws = newWorkspace();
    write(
      ws,
      "src/FrameView.tsx",
      `
import React from "react";

export const FrameView = React.forwardRef<HTMLDivElement, { label: string }>(
  ({ label }, ref) => {
    return null;
  },
);
`,
    );

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.tsx"],
    });
    const file = output.files.find((f) => f.filePath === "src/FrameView.tsx");
    expect(file?.skipped).toBeFalsy();
    expect(
      file?.symbols.some((s) => s.name === "FrameView"),
      "FrameView should be extracted — React.forwardRef wrap must not drop the symbol",
    ).toBe(true);
  });

  it("bare memo() import wrap is extracted", async () => {
    const ws = newWorkspace();
    write(
      ws,
      "src/SignalView.tsx",
      `
import { memo } from "react";

export const SignalView = memo(({ signal }: { signal: string }) => {
  return null;
});
`,
    );

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.tsx"],
    });
    const file = output.files.find((f) => f.filePath === "src/SignalView.tsx");
    expect(file?.skipped).toBeFalsy();
    expect(file?.symbols.some((s) => s.name === "SignalView")).toBe(true);
  });

  it("file with only React.memo exports has non-zero symbol count", async () => {
    // This is the exact scenario that caused EcuView (41 KB, 909 lines) to have
    // 0 symbols — every top-level export was a React.memo call.
    const ws = newWorkspace();
    write(
      ws,
      "src/PduView.tsx",
      `
import React from "react";

export const PduView = React.memo(({ pdu }: { pdu: string }) => null);
export const PduHeader = React.memo(({ title }: { title: string }) => null);
export const PduBody = React.memo(({ children }: { children: React.ReactNode }) => null);
`,
    );

    const output = await runAxStage({
      workspaceRoot: ws,
      include: ["src/**/*.tsx"],
    });
    const file = output.files.find((f) => f.filePath === "src/PduView.tsx");
    expect(file?.skipped).toBeFalsy();
    expect(file?.symbols.length).toBeGreaterThan(0);
    expect(file?.symbols.map((s) => s.name)).toContain("PduView");
    expect(file?.symbols.map((s) => s.name)).toContain("PduHeader");
    expect(file?.symbols.map((s) => s.name)).toContain("PduBody");
  });
});
