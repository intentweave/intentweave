// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-level helpers shared by framework endpoint discoverers.
 */

import path from "node:path";

export function languageFor(
  filePath: string,
): "typescript" | "javascript" | "tsx" | "jsx" {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "typescript";
  }
}

export function literalString(
  expression: string | undefined,
): string | undefined {
  if (!expression) return "";
  const quote = expression[0];
  if (!quote || !["'", '"', "`"].includes(quote)) return undefined;
  if (expression.at(-1) !== quote) return undefined;
  const value = expression.slice(1, -1);
  if (quote === "`" && value.includes("${")) return undefined;
  return value.replace(/\\([\\'"`])/g, "$1");
}
