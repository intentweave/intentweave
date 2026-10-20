// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractParameterTable } from "./documentParameterTable.js";

const HEADER = "| Parameter | Value | Scope |\n| --- | --- | --- |\n";

describe("parameter table extraction (G5.5 step 1)", () => {
  it("extracts rows with their line numbers and a content hash", () => {
    const text = `# ADR-017\n\n${HEADER}| session.timeout | 1800 | production |\n| cli.depth | full | default |\n`;
    const result = extractParameterTable(text);
    expect(result.rows).toEqual([
      { key: "session.timeout", value: "1800", scope: "production", line: 5 },
      { key: "cli.depth", value: "full", scope: "default", line: 6 },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(extractParameterTable(text).contentHash).toBe(result.contentHash);
    expect(extractParameterTable(text + "\n").contentHash).not.toBe(
      result.contentHash,
    );
  });

  it("recognizes only the exact parameter header", () => {
    const text = `| Name | Value | Scope |\n| --- | --- | --- |\n| session.timeout | 1800 | production |\n`;
    const result = extractParameterTable(text);
    expect(result.rows).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("ignores tables inside fenced code blocks", () => {
    const text =
      "```markdown\n" +
      HEADER +
      "| session.timeout | 1800 | production |\n```\n";
    expect(extractParameterTable(text).rows).toEqual([]);
  });

  it("rejects malformed rows with a reason and keeps the valid rows", () => {
    const text = `${HEADER}| session.timeout | 1800 | production |
| session.timeout | 1800 |
| Session Timeout | 1800 | production |
| session.timeout | 18 00 | production |
| cli.depth | full | Default Scope |
`;
    const result = extractParameterTable(text);
    expect(result.rows.map((row) => row.key)).toEqual(["session.timeout"]);
    expect(result.rejected.map((item) => item.line)).toEqual([4, 5, 6, 7]);
    expect(result.rejected[0]!.reason).toContain("needs 3 cells");
    expect(result.rejected[1]!.reason).toContain("is not a parameter key");
    expect(result.rejected[2]!.reason).toContain("single value token");
    expect(result.rejected[3]!.reason).toContain("is not a scope");
  });

  it("rejects both rows when a key and scope are stated twice in one document", () => {
    const text = `${HEADER}| session.timeout | 1800 | production |
| session.timeout | 3600 | production |
| cli.depth | full | default |
`;
    const result = extractParameterTable(text);
    expect(result.rows.map((row) => row.key)).toEqual(["cli.depth"]);
    expect(result.rejected.map((item) => item.line)).toEqual([3, 4]);
    expect(result.rejected[0]!.reason).toContain("more than once");
  });

  it("refuses a table whose separator row is missing, and does not read its rows", () => {
    const text = `| Parameter | Value | Scope |\n| session.timeout | 1800 | production |\n`;
    const result = extractParameterTable(text);
    expect(result.rows).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("no separator row");
  });

  it("reads a value written as code, without its backticks", () => {
    const text = `${HEADER}| \`session.timeout\` | \`1800\` | \`production\` |\n`;
    expect(extractParameterTable(text).rows[0]).toMatchObject({
      key: "session.timeout",
      value: "1800",
    });
  });

  it("finds no rows in ADR-001, which states no parameter values", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const adr = readFileSync(
      path.resolve(here, "../../../../docs/ADR-001-INTENT-ENGINE.md"),
      "utf-8",
    );
    const result = extractParameterTable(adr);
    expect(result.rows).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});
