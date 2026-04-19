// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * AX Stage Helpers — shared utilities for language adapter plugins.
 *
 * These functions are used by both the built-in TypeScript adapter and
 * external language plugins (Swift, Python, etc.) to produce consistent
 * AxFileResult output. Extracted to a separate module so that plugins
 * can import them without pulling in parser-specific code.
 */

import * as crypto from "crypto";
import type { AxSymbol, AxTodo, AxRationale } from "./ax.js";

// ============================================================================
// Symbol ID Generation
// ============================================================================

/**
 * Generate a stable symbol ID: `impl:<path>#<kind>:<name>(<sigHash>)`
 */
export function generateSymbolId(
  filePath: string,
  kind: string,
  name: string,
  container?: string,
  signature?: string,
): string {
  const base = container ? `${container}.${name}` : name;
  const sigHash = signature
    ? crypto.createHash("sha256").update(signature).digest("hex").slice(0, 8)
    : "";

  // Normalize path for cross-platform stability
  const normalizedPath = filePath.replace(/\\/g, "/");

  return sigHash
    ? `impl:${normalizedPath}#${kind}:${base}(${sigHash})`
    : `impl:${normalizedPath}#${kind}:${base}`;
}

// ============================================================================
// Content Hashing
// ============================================================================

/**
 * Generate file content hash for change detection.
 */
export function hashFileContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ============================================================================
// Body Hash / Clone Detection
// ============================================================================

/** Minimum body lines to qualify for clone detection */
const MIN_BODY_LINES = 4;

/** Regex patterns for normalising identifiers and literals to placeholders */
const STRING_LITERAL = /(['"`])(?:(?!\1|\\).|\\.)*\1/g;
const NUMERIC_LITERAL = /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;
const IDENTIFIER = /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g;

/** Reserved words that should NOT be replaced (they define structure) */
const RESERVED = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "of", "return", "static",
  "super", "switch", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "var", "void", "while", "with", "yield",
]);

/**
 * Compute a structural hash by replacing identifiers and literals with
 * placeholders. Catches renamed-variable copies (Type 2 clones).
 */
function computeStructureHash(sym: AxSymbol, normalisedBody: string): void {
  const structural = normalisedBody
    .replace(STRING_LITERAL, '"S"')
    .replace(NUMERIC_LITERAL, "0")
    .replace(IDENTIFIER, (match) => (RESERVED.has(match) ? match : "_"));

  sym.structureHash = crypto
    .createHash("sha256")
    .update(structural)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Compute a normalised body hash for clone detection.
 * Modifies the symbol in place (sets bodyHash / bodyLines / structureHash).
 */
export function computeBodyHash(sym: AxSymbol, lines: string[]): void {
  const bodyLineCount = sym.span.endLine - sym.span.startLine + 1;
  if (bodyLineCount < MIN_BODY_LINES) return;

  const body = lines
    .slice(sym.span.startLine - 1, sym.span.endLine)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"))
    .join("\n");

  if (body.length === 0) return;

  sym.bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 16);
  sym.bodyLines = bodyLineCount;

  computeStructureHash(sym, body);
}

// ============================================================================
// TODO / Rationale Extraction
// ============================================================================

/** Regex matching TODO / FIXME / HACK / XXX markers in comments */
const TODO_PATTERN =
  /(?:\/\/|\/\*|^\s*\*|#)\s*(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/i;

/** Regex matching WHY / NOTE / IMPORTANT / DESIGN rationale markers in comments */
const RATIONALE_PATTERN =
  /(?:\/\/|\/\*|^\s*\*|#)\s*(WHY|NOTE|IMPORTANT|DESIGN)\b[:\s]*(.*)/i;

/**
 * Extract TODO / FIXME / HACK / XXX markers from source lines.
 */
export function extractTodos(lines: string[]): AxTodo[] {
  const todos: AxTodo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TODO_PATTERN.exec(lines[i]);
    if (m) {
      todos.push({
        line: i + 1,
        kind: m[1].toLowerCase() as AxTodo["kind"],
        text: m[2].trim(),
      });
    }
  }
  return todos;
}

/**
 * Extract WHY / NOTE / IMPORTANT / DESIGN rationale markers from source lines.
 */
export function extractRationale(lines: string[]): AxRationale[] {
  const items: AxRationale[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RATIONALE_PATTERN.exec(lines[i]);
    if (m) {
      items.push({
        line: i + 1,
        kind: m[1].toLowerCase() as AxRationale["kind"],
        text: m[2].trim(),
      });
    }
  }
  return items;
}
