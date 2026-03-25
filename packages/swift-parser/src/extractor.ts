// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Swift AST Extractor
 *
 * Tree-sitter based Swift AST extractor.
 * Extracts structs, classes, protocols, enums, extensions, functions,
 * properties, initialisers, and import statements from Swift source files.
 */

import Parser from "tree-sitter";
import Swift from "tree-sitter-swift";
import * as fs from "fs";
import * as path from "path";
import type {
  SwiftSymbol,
  SwiftImport,
  SwiftFileResult,
  SwiftExtractionOptions,
  SwiftBatchResult,
  SwiftSymbolKind,
  AccessControl,
  SourceRange,
} from "./types.js";

// ── Node type → SwiftSymbolKind mapping ──────────────────────────────────────

/**
 * In tree-sitter-swift, `struct`, `class`, `enum`, and `extension` all parse
 * as `class_declaration`. We distinguish them by the keyword child node text.
 */
function classDeclarationKind(node: Parser.SyntaxNode): SwiftSymbolKind {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    switch (child.type) {
      case "struct":
        return "struct";
      case "enum":
        return "enum";
      case "extension":
        return "extension";
      case "class":
        return "class";
    }
  }
  return "class"; // fallback
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toRange(node: Parser.SyntaxNode): SourceRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

/** Extract visibility modifier from a `modifiers` child node. */
function extractAccessControl(
  node: Parser.SyntaxNode,
): AccessControl | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "modifiers") {
      for (let j = 0; j < child.childCount; j++) {
        const mod = child.child(j)!;
        if (mod.type === "visibility_modifier") {
          return mod.text as AccessControl;
        }
      }
    }
  }
  return undefined;
}

/** Check for static / class modifier. */
function isStaticDeclaration(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "modifiers") {
      for (let j = 0; j < child.childCount; j++) {
        const mod = child.child(j)!;
        if (
          (mod.type === "property_modifier" ||
            mod.type === "member_modifier") &&
          (mod.text === "static" || mod.text === "class")
        ) {
          return true;
        }
      }
    }
    // Also check direct `class` keyword before `func`
    if (child.type === "class" && node.type === "function_declaration") {
      return true;
    }
  }
  return false;
}

/** Check for async keyword. */
function isAsyncDeclaration(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)!.type === "async") return true;
  }
  return false;
}

/** Check for throws/rethrows keyword. */
function isThrowingDeclaration(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const t = node.child(i)!.type;
    if (t === "throws" || t === "rethrows") return true;
  }
  return false;
}

/** Extract parameter labels from function/init declaration. */
function extractParameters(node: Parser.SyntaxNode): string[] {
  const params: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) params.push(nameNode.text);
    }
  }
  return params;
}

/** Extract inheritance specifiers (conformances / superclass). */
function extractInheritance(node: Parser.SyntaxNode): string[] {
  const result: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "inheritance_specifier") {
      // Walk into user_type → type_identifier
      const userType = child.firstChild;
      if (userType) {
        const typeId =
          userType.type === "type_identifier"
            ? userType
            : (userType.childForFieldName("name") ?? userType.firstChild);
        if (typeId) result.push(typeId.text);
      }
    }
  }
  return result;
}

/** Extract preceding doc comment (triple-slash or block doc comment). */
function extractDocComment(
  node: Parser.SyntaxNode,
  content: string,
): string | undefined {
  const prev = node.previousSibling;
  if (!prev) return undefined;
  if (prev.type === "comment") {
    const text = prev.text;
    if (text.startsWith("///")) {
      return text.replace(/^\/\/\/\s?/, "").trim();
    }
    if (text.startsWith("/**")) {
      return text
        .replace(/^\/\*\*\s?/, "")
        .replace(/\s?\*\/$/, "")
        .trim();
    }
  }
  return undefined;
}

/** Build a displayable signature string. */
function buildSignature(
  node: Parser.SyntaxNode,
  kind: SwiftSymbolKind,
): string {
  const lines = node.text.split("\n");
  const firstLine = lines[0].trim();
  // Trim body
  const bodyIdx = firstLine.indexOf("{");
  if (bodyIdx > 0) return firstLine.substring(0, bodyIdx).trim();
  return firstLine.length > 120 ? firstLine.substring(0, 120) + "…" : firstLine;
}

/**
 * Is a symbol "exported" (public-facing)?
 * In Swift, `public` and `open` are exported. Everything else is internal.
 */
function isExported(ac: AccessControl | undefined): boolean {
  return ac === "public" || ac === "open";
}

// ── Extractor ────────────────────────────────────────────────────────────────

export class SwiftExtractor {
  private parser: Parser;
  private workspaceRoot: string;
  private defaultOptions: Required<SwiftExtractionOptions>;

  constructor(
    workspaceRoot: string,
    options?: Partial<SwiftExtractionOptions>,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.parser = new Parser();
    this.parser.setLanguage(Swift);

    this.defaultOptions = {
      includePrivate: options?.includePrivate ?? false,
      includeDocSummary: options?.includeDocSummary ?? true,
      includeParameters: options?.includeParameters ?? true,
      includeMembers: options?.includeMembers ?? true,
      maxDepth: options?.maxDepth ?? 2,
    };
  }

  /**
   * Extract symbols from a single Swift file.
   */
  async extractFile(
    filePath: string,
    options?: Partial<SwiftExtractionOptions>,
  ): Promise<SwiftFileResult> {
    const opts = { ...this.defaultOptions, ...options };
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workspaceRoot, filePath);

    const relativePath = path.relative(this.workspaceRoot, absolutePath);

    try {
      const content = await fs.promises.readFile(absolutePath, "utf-8");
      return this.extractFromString(content, relativePath, opts);
    } catch (error) {
      return {
        filePath: relativePath,
        language: "swift",
        symbols: [],
        imports: [],
        extractedAt: Date.now(),
        errors: [(error as Error).message],
      };
    }
  }

  /**
   * Extract symbols from a Swift source string (for testing / in-memory).
   */
  extractFromString(
    content: string,
    filePath: string,
    options?: Partial<SwiftExtractionOptions>,
  ): SwiftFileResult {
    const opts = { ...this.defaultOptions, ...options };
    const tree = this.parser.parse(content);

    const symbols: SwiftSymbol[] = [];
    const imports: SwiftImport[] = [];
    const errors: string[] = [];

    this.walkNode(
      tree.rootNode,
      content,
      filePath,
      symbols,
      imports,
      opts,
      undefined,
      0,
    );

    if (tree.rootNode.hasError) {
      errors.push("Parse errors detected in file");
    }

    return {
      filePath,
      language: "swift",
      symbols,
      imports,
      extractedAt: Date.now(),
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Extract symbols from multiple Swift files.
   */
  async extractBatch(
    filePaths: string[],
    options?: Partial<SwiftExtractionOptions>,
  ): Promise<SwiftBatchResult> {
    const startTime = Date.now();
    const files = new Map<string, SwiftFileResult>();
    const failures: Array<{ filePath: string; error: string }> = [];
    let totalSymbols = 0;

    for (const filePath of filePaths) {
      try {
        const result = await this.extractFile(filePath, options);
        files.set(result.filePath, result);
        totalSymbols += result.symbols.length;

        if (result.errors?.length) {
          failures.push({ filePath: result.filePath, error: result.errors[0] });
        }
      } catch (error) {
        failures.push({ filePath, error: (error as Error).message });
      }
    }

    return {
      files,
      totalSymbols,
      totalFiles: filePaths.length,
      failures,
      durationMs: Date.now() - startTime,
    };
  }

  // ── Tree walker ──────────────────────────────────────────────────────────

  private walkNode(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SwiftSymbol[],
    imports: SwiftImport[],
    options: Required<SwiftExtractionOptions>,
    parentName: string | undefined,
    depth: number,
  ): void {
    if (depth > options.maxDepth) return;

    switch (node.type) {
      case "class_declaration":
        this.extractClassDeclaration(
          node,
          content,
          filePath,
          symbols,
          imports,
          options,
          parentName,
          depth,
        );
        break;

      case "protocol_declaration":
        this.extractProtocol(
          node,
          content,
          filePath,
          symbols,
          imports,
          options,
          depth,
        );
        break;

      case "function_declaration":
      case "protocol_function_declaration":
        this.extractFunction(
          node,
          content,
          filePath,
          symbols,
          options,
          parentName,
        );
        break;

      case "init_declaration":
        this.extractInit(node, content, filePath, symbols, options, parentName);
        break;

      case "typealias_declaration":
        this.extractTypealias(
          node,
          content,
          filePath,
          symbols,
          options,
          parentName,
        );
        break;

      case "property_declaration":
      case "protocol_property_declaration":
        this.extractProperty(
          node,
          content,
          filePath,
          symbols,
          options,
          parentName,
        );
        break;

      case "import_declaration":
        this.extractImport(node, imports);
        break;

      default:
        // Recurse into children for top-level or body nodes
        for (let i = 0; i < node.childCount; i++) {
          this.walkNode(
            node.child(i)!,
            content,
            filePath,
            symbols,
            imports,
            options,
            parentName,
            depth,
          );
        }
        break;
    }
  }

  // ── Extractors ───────────────────────────────────────────────────────────

  /**
   * Handles class, struct, enum, and extension (all `class_declaration`).
   */
  private extractClassDeclaration(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SwiftSymbol[],
    imports: SwiftImport[],
    options: Required<SwiftExtractionOptions>,
    parentName: string | undefined,
    depth: number,
  ): void {
    const kind = classDeclarationKind(node);
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "<anonymous>";
    const ac = extractAccessControl(node);

    if (!options.includePrivate && (ac === "private" || ac === "fileprivate")) {
      return;
    }

    const inheritance = extractInheritance(node);
    const sym: SwiftSymbol = {
      name,
      kind,
      filePath,
      range: toRange(node),
      parent: parentName,
      isExported: isExported(ac),
      accessControl: ac,
      signature: buildSignature(node, kind),
    };

    if (options.includeDocSummary) {
      sym.docSummary = extractDocComment(node, content);
    }

    // Inheritance
    if (kind === "class" && inheritance.length > 0) {
      // First item could be superclass (starts uppercase, not a protocol convention)
      sym.superclass = inheritance[0];
      sym.conformances = inheritance.slice(1);
    } else if (kind === "struct" || kind === "enum") {
      sym.conformances = inheritance;
    } else if (kind === "extension") {
      // For extensions, the "name" is the extended type
      const userTypeNode = node.children.find((c) => c.type === "user_type");
      if (userTypeNode) {
        sym.extendedType = userTypeNode.text;
        sym.name = userTypeNode.text;
      }
      sym.conformances = inheritance;
    }

    if (kind === "class") {
      sym.isFinal = node.text.includes("final ");
    }

    symbols.push(sym);

    // Extract members
    if (options.includeMembers) {
      const body = node.children.find(
        (c) => c.type === "class_body" || c.type === "enum_class_body",
      );
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          this.walkNode(
            body.child(i)!,
            content,
            filePath,
            symbols,
            imports,
            options,
            name,
            depth + 1,
          );
        }
      }
    }
  }

  /**
   * Extract protocol declaration.
   */
  private extractProtocol(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SwiftSymbol[],
    imports: SwiftImport[],
    options: Required<SwiftExtractionOptions>,
    depth: number,
  ): void {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "<anonymous>";
    const ac = extractAccessControl(node);

    if (!options.includePrivate && (ac === "private" || ac === "fileprivate")) {
      return;
    }

    const inheritance = extractInheritance(node);
    const sym: SwiftSymbol = {
      name,
      kind: "protocol",
      filePath,
      range: toRange(node),
      isExported: isExported(ac),
      accessControl: ac,
      conformances: inheritance,
      signature: buildSignature(node, "protocol"),
    };

    if (options.includeDocSummary) {
      sym.docSummary = extractDocComment(node, content);
    }

    symbols.push(sym);

    // Extract protocol members
    if (options.includeMembers) {
      const body = node.children.find((c) => c.type === "protocol_body");
      if (body) {
        for (let i = 0; i < body.childCount; i++) {
          this.walkNode(
            body.child(i)!,
            content,
            filePath,
            symbols,
            imports,
            options,
            name,
            depth + 1,
          );
        }
      }
    }
  }

  /**
   * Extract function declaration.
   */
  private extractFunction(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SwiftSymbol[],
    options: Required<SwiftExtractionOptions>,
    parentName: string | undefined,
  ): void {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "<anonymous>";
    const ac = extractAccessControl(node);

    if (!options.includePrivate && (ac === "private" || ac === "fileprivate")) {
      return;
    }

    const kind: SwiftSymbolKind = parentName ? "method" : "function";
    const sym: SwiftSymbol = {
      name,
      kind,
      filePath,
      range: toRange(node),
      parent: parentName,
      isExported: isExported(ac),
      accessControl: ac,
      isAsync: isAsyncDeclaration(node),
      isThrowing: isThrowingDeclaration(node),
      isStatic: isStaticDeclaration(node),
      signature: buildSignature(node, kind),
    };

    if (options.includeParameters) {
      sym.parameters = extractParameters(node);
    }
    if (options.includeDocSummary) {
      sym.docSummary = extractDocComment(node, content);
    }

    symbols.push(sym);
  }

  /**
   * Extract initializer declaration.
   */
  private extractInit(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SwiftSymbol[],
    options: Required<SwiftExtractionOptions>,
    parentName: string | undefined,
  ): void {
    const ac = extractAccessControl(node);

    if (!options.includePrivate && (ac === "private" || ac === "fileprivate")) {
      return;
    }

    const sym: SwiftSymbol = {
      name: "init",
      kind: "initializer",
      filePath,
      range: toRange(node),
      parent: parentName,
      isExported: isExported(ac),
      accessControl: ac,
      isThrowing: isThrowingDeclaration(node),
      signature: buildSignature(node, "initializer"),
    };

    if (options.includeParameters) {
      sym.parameters = extractParameters(node);
    }
    if (options.includeDocSummary) {
      sym.docSummary = extractDocComment(node, content);
    }

    symbols.push(sym);
  }

  /**
   * Extract typealias.
   */
  private extractTypealias(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SwiftSymbol[],
    options: Required<SwiftExtractionOptions>,
    parentName: string | undefined,
  ): void {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text ?? "<anonymous>";
    const ac = extractAccessControl(node);

    if (!options.includePrivate && (ac === "private" || ac === "fileprivate")) {
      return;
    }

    symbols.push({
      name,
      kind: "typealias",
      filePath,
      range: toRange(node),
      parent: parentName,
      isExported: isExported(ac),
      accessControl: ac,
      signature: buildSignature(node, "typealias"),
      docSummary: options.includeDocSummary
        ? extractDocComment(node, content)
        : undefined,
    });
  }

  /**
   * Extract property declaration (let / var) or protocol_property_declaration.
   */
  private extractProperty(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SwiftSymbol[],
    options: Required<SwiftExtractionOptions>,
    parentName: string | undefined,
  ): void {
    let nameNode = node.childForFieldName("name");
    let name: string;

    if (node.type === "protocol_property_declaration") {
      // protocol_property_declaration has a `pattern` child with the identifier
      const pattern = node.children.find((c) => c.type === "pattern");
      name = pattern
        ? (pattern.childForFieldName("bound_identifier")?.text ??
          pattern.text.replace(/^(var|let)\s+/, "").trim())
        : (nameNode?.text ?? "<anonymous>");
    } else {
      name = nameNode?.text ?? "<anonymous>";
    }

    const ac = extractAccessControl(node);

    if (!options.includePrivate && (ac === "private" || ac === "fileprivate")) {
      return;
    }

    symbols.push({
      name,
      kind: "property",
      filePath,
      range: toRange(node),
      parent: parentName,
      isExported: isExported(ac),
      accessControl: ac,
      isStatic: isStaticDeclaration(node),
      signature: buildSignature(node, "property"),
      docSummary: options.includeDocSummary
        ? extractDocComment(node, content)
        : undefined,
    });
  }

  /**
   * Extract import declaration.
   */
  private extractImport(node: Parser.SyntaxNode, imports: SwiftImport[]): void {
    // import_declaration children: "import" keyword, optional kind, identifier(s)
    let moduleName = "";
    let importKind: SwiftImport["kind"];
    let symbolName: string | undefined;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "import") continue; // skip keyword

      // Kind specifier: `import struct Foundation.URL`
      if (
        [
          "struct",
          "class",
          "protocol",
          "enum",
          "func",
          "var",
          "typealias",
        ].includes(child.text)
      ) {
        importKind = child.text as SwiftImport["kind"];
        continue;
      }

      // The identifier node contains the module path
      if (child.type === "identifier") {
        const parts: string[] = [];
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j);
          if (part && part.type === "simple_identifier") {
            parts.push(part.text);
          }
        }
        if (parts.length > 1) {
          moduleName = parts[0];
          symbolName = parts.slice(1).join(".");
        } else {
          moduleName = parts[0] ?? child.text;
        }
      }
    }

    if (moduleName) {
      imports.push({
        moduleName,
        kind: importKind,
        symbolName,
        range: toRange(node),
      });
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Swift extractor instance.
 */
export function createSwiftExtractor(
  workspaceRoot: string,
  options?: Partial<SwiftExtractionOptions>,
): SwiftExtractor {
  return new SwiftExtractor(workspaceRoot, options);
}
