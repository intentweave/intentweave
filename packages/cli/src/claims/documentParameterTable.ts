// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic document extraction (Phase G5.5, step 1). A Markdown document states a
 * parameter value in a table with exactly this header:
 *
 *   | Parameter | Value | Scope |
 *
 * Each row is a parameter key, a value token, and a scope. The extractor is pure: it reads
 * text and returns rows and diagnostics. It never calls a model, and it never guesses.
 * A row that does not match the convention is rejected with a reason, so a wrong row is
 * never silently accepted. Tables inside fenced code blocks are ignored.
 */

import { createHash } from "node:crypto";

export const PARAMETER_TABLE_HEADER = ["Parameter", "Value", "Scope"] as const;

const KEY_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const VALUE_PATTERN = /^[A-Za-z0-9_.+-]+$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface DocumentParameterRow {
  key: string;
  value: string;
  scope: string;
  /** 1-based line of the row in the document. */
  line: number;
}

export interface DocumentParameterRejection {
  line: number;
  text: string;
  reason: string;
}

export interface DocumentParameterExtraction {
  /** Hash of the document text, so a row can be traced to the exact text it came from. */
  contentHash: string;
  rows: DocumentParameterRow[];
  rejected: DocumentParameterRejection[];
}

/** Split a Markdown table row into trimmed cell texts, without the outer pipes. */
function splitRow(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (
    !trimmed.startsWith("|") ||
    !trimmed.endsWith("|") ||
    trimmed.length < 2
  ) {
    return undefined;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/** A cell may hold the value in backticks, as code. The backticks are not part of it. */
function unquote(cell: string): string {
  const match = /^`([^`]*)`$/.exec(cell);
  return match ? match[1]!.trim() : cell;
}

function isSeparator(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function extractParameterTable(
  text: string,
): DocumentParameterExtraction {
  const contentHash = createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 16);
  const lines = text.split("\n");
  const rows: DocumentParameterRow[] = [];
  const rejected: DocumentParameterRejection[] = [];
  let inFence = false;
  let expectSeparator = false;
  let inTable = false;
  const seen = new Map<string, number[]>();

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    const line = index + 1;
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      inTable = false;
      expectSeparator = false;
      continue;
    }
    if (inFence) continue;

    const cells = splitRow(raw);
    if (!cells) {
      inTable = false;
      expectSeparator = false;
      continue;
    }
    if (!inTable) {
      // The header row starts a table; only the exact parameter header is recognized.
      const isHeader =
        cells.length === PARAMETER_TABLE_HEADER.length &&
        cells.every((cell, i) => cell === PARAMETER_TABLE_HEADER[i]);
      if (isHeader) {
        inTable = true;
        expectSeparator = true;
      }
      continue;
    }
    if (expectSeparator) {
      expectSeparator = false;
      if (!isSeparator(cells)) {
        rejected.push({
          line,
          text: raw,
          reason: "the parameter table has no separator row",
        });
        inTable = false;
      }
      continue;
    }

    if (cells.length !== PARAMETER_TABLE_HEADER.length) {
      rejected.push({
        line,
        text: raw,
        reason: `a parameter row needs ${PARAMETER_TABLE_HEADER.length} cells`,
      });
      continue;
    }
    const [keyCell, valueCell, scopeCell] = cells.map(unquote);
    if (!KEY_PATTERN.test(keyCell!)) {
      rejected.push({
        line,
        text: raw,
        reason: `"${keyCell}" is not a parameter key`,
      });
      continue;
    }
    if (!VALUE_PATTERN.test(valueCell!)) {
      rejected.push({
        line,
        text: raw,
        reason: `"${valueCell}" is not a single value token`,
      });
      continue;
    }
    if (!SCOPE_PATTERN.test(scopeCell!)) {
      rejected.push({
        line,
        text: raw,
        reason: `"${scopeCell}" is not a scope`,
      });
      continue;
    }
    const identity = `${keyCell}\u0000${scopeCell}`;
    const previous = seen.get(identity) ?? [];
    previous.push(line);
    seen.set(identity, previous);
    rows.push({ key: keyCell!, value: valueCell!, scope: scopeCell!, line });
  }

  // Fail closed: a key and scope stated twice in one document has no single value.
  for (const [identity, lineNumbers] of seen) {
    if (lineNumbers.length < 2) continue;
    const [key, scope] = identity.split("\u0000");
    for (const line of lineNumbers) {
      rows.splice(
        rows.findIndex((row) => row.line === line),
        1,
      );
      rejected.push({
        line,
        text: lines[line - 1]!,
        reason: `"${key}" in scope "${scope}" is stated more than once in this document`,
      });
    }
  }
  rows.sort((a, b) => a.line - b.line);
  rejected.sort((a, b) => a.line - b.line);
  return { contentHash, rows, rejected };
}
