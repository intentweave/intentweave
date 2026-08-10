// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import type { SourceRange } from "./types.js";

export type ClaimLiteral = string | number | boolean | null;
export type LiteralBindingKind =
  | "variable"
  | "assignment"
  | "class-field"
  | "destructuring-default"
  | "parameter-default";

export interface ExtractedLiteralBinding {
  symbolId: string;
  kind: LiteralBindingKind;
  name: string;
  normalizedValue: ClaimLiteral;
  span: SourceRange;
  structureFingerprint: string;
}

export interface ExtractedCodeAnnotation {
  tag: "default";
  normalizedValue: ClaimLiteral;
  targetSymbolId: string;
  span: SourceRange;
}

export interface ClaimEvidenceExtraction {
  literalBindings: ExtractedLiteralBinding[];
  codeAnnotations: ExtractedCodeAnnotation[];
}

function normalizedLiteral(text: string): ClaimLiteral | undefined {
  const value = text.trim();
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^['"`]/.test(value) && /['"`]$/.test(value)) {
    return value.slice(1, -1);
  }
  if (/^-?(?:\d[\d_]*)(?:\.\d[\d_]*)?$/.test(value)) {
    return Number(value.replaceAll("_", ""));
  }
  return undefined;
}

function range(node: Parser.SyntaxNode): SourceRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bindingKind(node: Parser.SyntaxNode): LiteralBindingKind {
  if (node.type === "variable_declarator") return "variable";
  if (node.type === "assignment_expression") return "assignment";
  if (node.type.includes("field_definition")) return "class-field";
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.type.includes("formal_parameters")) return "parameter-default";
    if (ancestor.type === "variable_declarator") return "destructuring-default";
    ancestor = ancestor.parent;
  }
  return "parameter-default";
}

function immediateJsDoc(
  content: string,
  declaration: Parser.SyntaxNode,
): { text: string; startIndex: number } | undefined {
  let anchor = declaration;
  while (
    anchor.parent &&
    ["lexical_declaration", "export_statement"].includes(anchor.parent.type)
  ) {
    anchor = anchor.parent;
  }
  const before = content.slice(0, anchor.startIndex);
  const end = before.lastIndexOf("*/");
  if (end < 0 || !/^\s*$/.test(before.slice(end + 2))) return undefined;
  const start = before.lastIndexOf("/**", end);
  if (start < 0) return undefined;
  return { text: before.slice(start, end + 2), startIndex: start };
}

function annotationValue(jsDoc: string): ClaimLiteral | undefined {
  let inExample = false;
  for (const rawLine of jsDoc.split("\n")) {
    const line = rawLine.replace(/^\s*\/??\*?\s?/, "").trim();
    if (/^@example\b/i.test(line)) {
      inExample = true;
      continue;
    }
    if (inExample) continue;
    const match = line.match(
      /^(?:@default(?:Value)?\s+|default\s*(?::|is|to)\s+)(\S+)\.?$/i,
    );
    if (match) return normalizedLiteral(match[1]);
  }
  return undefined;
}

/**
 * Extract Claims-specific R1 evidence from one explicitly bound TypeScript file.
 * It deliberately does not perform parameter binding or file-system discovery.
 */
export function extractClaimEvidence(
  content: string,
  filePath: string,
): ClaimEvidenceExtraction {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const tree = parser.parse(content);
  const literalBindings: ExtractedLiteralBinding[] = [];
  const codeAnnotations: ExtractedCodeAnnotation[] = [];
  const seen = new Set<string>();

  const addBinding = (
    declaration: Parser.SyntaxNode,
    nameNode: Parser.SyntaxNode | null,
    valueNode: Parser.SyntaxNode | null,
  ) => {
    const named = declaration.namedChildren;
    nameNode ??= named.at(0) ?? null;
    valueNode ??= named.at(-1) ?? null;
    if (!nameNode || !valueNode || nameNode === valueNode) return;
    const value = normalizedLiteral(valueNode.text);
    if (value === undefined) return;
    const name = nameNode.text;
    const symbolId = `${filePath}#${name}@${nameNode.startPosition.row + 1}`;
    if (seen.has(symbolId)) return;
    seen.add(symbolId);
    const binding: ExtractedLiteralBinding = {
      symbolId,
      kind: bindingKind(declaration),
      name,
      normalizedValue: value,
      span: range(declaration),
      structureFingerprint: hash(`${declaration.type}:${name}`),
    };
    literalBindings.push(binding);

    const jsDoc = immediateJsDoc(content, declaration);
    if (jsDoc) {
      const defaultValue = annotationValue(jsDoc.text);
      if (defaultValue === undefined) return;
      codeAnnotations.push({
        tag: "default",
        normalizedValue: defaultValue,
        targetSymbolId: symbolId,
        span: {
          startLine: content.slice(0, jsDoc.startIndex).split("\n").length,
          startColumn: 0,
          endLine: declaration.startPosition.row,
          endColumn: 0,
        },
      });
    }
  };

  const visit = (node: Parser.SyntaxNode) => {
    if (node.type === "variable_declarator" || node.type === "assignment_expression") {
      addBinding(
        node,
        node.childForFieldName("name") ?? node.childForFieldName("left"),
        node.childForFieldName("value") ?? node.childForFieldName("right"),
      );
    } else if (node.type.includes("field_definition")) {
      addBinding(
        node,
        node.childForFieldName("name"),
        node.childForFieldName("value"),
      );
    } else if (
      node.type === "assignment_pattern" ||
      node.type === "object_assignment_pattern" ||
      node.type === "required_parameter" ||
      node.type === "optional_parameter"
    ) {
      addBinding(
        node,
        node.childForFieldName("left") ?? node.childForFieldName("pattern"),
        node.childForFieldName("right") ?? node.childForFieldName("value"),
      );
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(tree.rootNode);
  return { literalBindings, codeAnnotations };
}