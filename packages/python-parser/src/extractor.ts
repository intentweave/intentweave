// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file Python AST Extractor
 *
 * Tree-sitter based Python AST extractor.
 * Extracts functions, classes, methods, decorators, imports,
 * module-level variables, and type hints from .py files.
 */

import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import * as fs from "fs";
import * as path from "path";
import type {
  PythonSymbol,
  PythonImport,
  PythonFileResult,
  PythonExtractionOptions,
  PythonBatchResult,
  PythonSymbolKind,
  SourceRange,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function toRange(node: Parser.SyntaxNode): SourceRange {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

/**
 * Python visibility is convention-based:
 *   `__name` → private (name-mangled)
 *   `_name`  → protected (convention)
 *   `name`   → public
 */
function getVisibility(name: string): "public" | "private" | "protected" {
  if (name.startsWith("__") && !name.endsWith("__")) return "private";
  if (name.startsWith("_")) return "protected";
  return "public";
}

/**
 * Determine if a module-level symbol is "exported".
 * - Names starting with `_` are internal by convention
 * - If `__all__` is defined, only listed names are exported
 */
function isExportedName(name: string, allNames: Set<string> | null): boolean {
  if (allNames) return allNames.has(name);
  return !name.startsWith("_");
}

/** Extract decorator names from a decorated_definition wrapper. */
function extractDecorators(node: Parser.SyntaxNode): string[] {
  const decorators: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "decorator") {
      // decorator → "@" expression
      // The expression is typically an identifier or dotted name or call
      const expr = child.childCount > 1 ? child.child(1) : null;
      if (expr) {
        // For `@staticmethod` → "staticmethod"
        // For `@app.route("/")` → "app.route"
        if (expr.type === "identifier") {
          decorators.push(expr.text);
        } else if (expr.type === "attribute") {
          decorators.push(expr.text);
        } else if (expr.type === "call") {
          // @decorator(args) → extract decorator name
          const fn = expr.childForFieldName("function");
          if (fn) decorators.push(fn.text);
        }
      }
    }
  }
  return decorators;
}

/** Extract base classes from a class argument_list. */
function extractBases(node: Parser.SyntaxNode): string[] {
  const bases: string[] = [];
  const argList = node.childForFieldName("superclasses");
  if (!argList) return bases;

  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i)!;
    if (child.type === "identifier" || child.type === "attribute") {
      bases.push(child.text);
    } else if (child.type === "keyword_argument") {
      // e.g., metaclass=ABCMeta — skip
    }
  }
  return bases;
}

/** Extract parameter names from a `parameters` node. */
function extractParameters(node: Parser.SyntaxNode): string[] {
  const params: string[] = [];
  const paramList = node.childForFieldName("parameters");
  if (!paramList) return params;

  for (let i = 0; i < paramList.childCount; i++) {
    const child = paramList.child(i)!;
    switch (child.type) {
      case "identifier":
        params.push(child.text);
        break;
      case "typed_parameter":
      case "default_parameter":
      case "typed_default_parameter": {
        // Try field name first, then fall back to first identifier child
        const nameNode =
          child.childForFieldName("name") ??
          (() => {
            for (let j = 0; j < child.childCount; j++) {
              if (child.child(j)!.type === "identifier") return child.child(j)!;
            }
            return null;
          })();
        if (nameNode) params.push(nameNode.text);
        break;
      }
      case "list_splat_pattern":
      case "dictionary_splat_pattern": {
        // *args, **kwargs
        const inner =
          child.childCount > 0 ? child.child(child.childCount - 1) : null;
        if (inner?.type === "identifier") {
          const prefix = child.type === "list_splat_pattern" ? "*" : "**";
          params.push(prefix + inner.text);
        }
        break;
      }
    }
  }
  return params;
}

/** Extract the first line of a docstring from the function/class body. */
function extractDocstring(node: Parser.SyntaxNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body || body.childCount === 0) return undefined;

  const first = body.child(0)!;
  // expression_statement → string
  if (first.type === "expression_statement") {
    const expr = first.child(0);
    if (
      expr &&
      (expr.type === "string" || expr.type === "concatenated_string")
    ) {
      const text = expr.text;
      // Strip triple quotes
      const stripped = text
        .replace(/^("""|''')\s*/, "")
        .replace(/\s*("""|''')$/, "")
        .trim();
      // Return first line only
      const firstLine = stripped.split("\n")[0].trim();
      return firstLine || undefined;
    }
  }
  return undefined;
}

/** Build a displayable signature. */
function buildSignature(
  node: Parser.SyntaxNode,
  kind: PythonSymbolKind,
): string {
  const lines = node.text.split("\n");
  const firstLine = lines[0].trim();
  // Trim body (after colon)
  const colonIdx = firstLine.indexOf(":");
  if (colonIdx > 0) return firstLine.substring(0, colonIdx).trim();
  return firstLine.length > 120 ? firstLine.substring(0, 120) + "…" : firstLine;
}

/**
 * Scan the module for `__all__ = [...]` and return the listed names.
 * Returns null if no __all__ is defined.
 */
function extractAllNames(root: Parser.SyntaxNode): Set<string> | null {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type !== "expression_statement") continue;
    const assignment = child.child(0);
    if (!assignment || assignment.type !== "assignment") continue;

    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (!left || left.text !== "__all__") continue;
    if (!right || right.type !== "list") continue;

    const names = new Set<string>();
    for (let j = 0; j < right.childCount; j++) {
      const elem = right.child(j)!;
      if (elem.type === "string") {
        // Strip quotes
        const stripped = elem.text.replace(/^["']|["']$/g, "");
        if (stripped) names.add(stripped);
      }
    }
    return names;
  }
  return null;
}

// ── Extractor ────────────────────────────────────────────────────────────────

export class PythonExtractor {
  private parser: Parser;
  private workspaceRoot: string;
  private defaultOptions: Required<PythonExtractionOptions>;

  constructor(
    workspaceRoot: string,
    options?: Partial<PythonExtractionOptions>,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.parser = new Parser();
    this.parser.setLanguage(Python);

    this.defaultOptions = {
      includePrivate: options?.includePrivate ?? false,
      includeDocSummary: options?.includeDocSummary ?? true,
      includeParameters: options?.includeParameters ?? true,
      includeMembers: options?.includeMembers ?? true,
      maxDepth: options?.maxDepth ?? 2,
    };
  }

  /**
   * Extract symbols from a single Python file.
   */
  async extractFile(
    filePath: string,
    options?: Partial<PythonExtractionOptions>,
  ): Promise<PythonFileResult> {
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
        language: "python",
        symbols: [],
        imports: [],
        extractedAt: Date.now(),
        errors: [(error as Error).message],
      };
    }
  }

  /**
   * Extract symbols from a Python source string (for testing / in-memory).
   */
  extractFromString(
    content: string,
    filePath: string,
    options?: Partial<PythonExtractionOptions>,
  ): PythonFileResult {
    const opts = { ...this.defaultOptions, ...options };
    const tree = this.parser.parse(content);

    const symbols: PythonSymbol[] = [];
    const imports: PythonImport[] = [];
    const errors: string[] = [];

    // Pre-scan for __all__
    const allNames = extractAllNames(tree.rootNode);

    this.walkNode(
      tree.rootNode,
      filePath,
      symbols,
      imports,
      opts,
      undefined,
      0,
      allNames,
    );

    if (tree.rootNode.hasError) {
      errors.push("Parse errors detected in file");
    }

    return {
      filePath,
      language: "python",
      symbols,
      imports,
      extractedAt: Date.now(),
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Extract symbols from multiple Python files.
   */
  async extractBatch(
    filePaths: string[],
    options?: Partial<PythonExtractionOptions>,
  ): Promise<PythonBatchResult> {
    const startTime = Date.now();
    const files = new Map<string, PythonFileResult>();
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

  // ── Tree walker ──────────────────────────────────────────────────────

  private walkNode(
    node: Parser.SyntaxNode,
    filePath: string,
    symbols: PythonSymbol[],
    imports: PythonImport[],
    options: Required<PythonExtractionOptions>,
    parentName: string | undefined,
    depth: number,
    allNames: Set<string> | null,
  ): void {
    if (depth > options.maxDepth) return;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      switch (child.type) {
        case "function_definition":
          this.extractFunction(
            child,
            filePath,
            symbols,
            options,
            parentName,
            depth,
            allNames,
            [],
          );
          break;

        case "class_definition":
          this.extractClass(
            child,
            filePath,
            symbols,
            imports,
            options,
            depth,
            allNames,
            [],
          );
          break;

        case "decorated_definition": {
          const decorators = extractDecorators(child);
          const definition = child.childForFieldName("definition");
          if (definition) {
            if (definition.type === "function_definition") {
              this.extractFunction(
                definition,
                filePath,
                symbols,
                options,
                parentName,
                depth,
                allNames,
                decorators,
              );
            } else if (definition.type === "class_definition") {
              this.extractClass(
                definition,
                filePath,
                symbols,
                imports,
                options,
                depth,
                allNames,
                decorators,
              );
            }
          }
          break;
        }

        case "import_statement":
          this.extractImportStatement(child, imports);
          break;

        case "import_from_statement":
          this.extractImportFromStatement(child, imports);
          break;

        case "expression_statement":
          // Module-level variable assignments
          if (depth === 0) {
            this.extractAssignment(child, filePath, symbols, allNames);
          }
          break;
      }
    }
  }

  // ── Function extraction ──────────────────────────────────────────────

  private extractFunction(
    node: Parser.SyntaxNode,
    filePath: string,
    symbols: PythonSymbol[],
    options: Required<PythonExtractionOptions>,
    parentName: string | undefined,
    depth: number,
    allNames: Set<string> | null,
    decorators: string[],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;
    const visibility = getVisibility(name);

    // Skip private if not requested
    if (!options.includePrivate && visibility !== "public" && !parentName)
      return;

    const isAsync =
      node.previousSibling?.type === "async" ||
      node.parent?.type === "async_function_definition" ||
      // Check for 'async' keyword within the node
      (node.childCount > 0 && node.child(0)?.type === "async");

    // Determine kind: function or method
    const kind: PythonSymbolKind = parentName ? "method" : "function";

    // Check for @property → treat as property
    const isProperty = decorators.includes("property");
    const actualKind: PythonSymbolKind = isProperty ? "property" : kind;

    const isStatic =
      decorators.includes("staticmethod") || decorators.includes("classmethod");

    const exported =
      parentName != null
        ? visibility === "public" // class members: exported if public
        : isExportedName(name, allNames);

    const sym: PythonSymbol = {
      name,
      kind: actualKind,
      filePath,
      range: toRange(node),
      isExported: exported,
      visibility,
      decorators: decorators.length > 0 ? decorators : undefined,
    };

    if (parentName) sym.parent = parentName;
    if (isAsync) sym.isAsync = true;
    if (isStatic) sym.isStatic = true;

    if (options.includeParameters) {
      sym.parameters = extractParameters(node);
    }

    if (options.includeDocSummary) {
      sym.docSummary = extractDocstring(node);
    }

    sym.signature = buildSignature(node, actualKind);

    symbols.push(sym);
  }

  // ── Class extraction ─────────────────────────────────────────────────

  private extractClass(
    node: Parser.SyntaxNode,
    filePath: string,
    symbols: PythonSymbol[],
    imports: PythonImport[],
    options: Required<PythonExtractionOptions>,
    depth: number,
    allNames: Set<string> | null,
    decorators: string[],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;
    const visibility = getVisibility(name);

    if (!options.includePrivate && visibility !== "public") return;

    const bases = extractBases(node);

    const sym: PythonSymbol = {
      name,
      kind: "class",
      filePath,
      range: toRange(node),
      isExported: isExportedName(name, allNames),
      visibility,
      decorators: decorators.length > 0 ? decorators : undefined,
      bases: bases.length > 0 ? bases : undefined,
    };

    if (options.includeDocSummary) {
      sym.docSummary = extractDocstring(node);
    }

    sym.signature = buildSignature(node, "class");

    symbols.push(sym);

    // Extract class body members
    if (options.includeMembers) {
      const body = node.childForFieldName("body");
      if (body) {
        this.walkNode(
          body,
          filePath,
          symbols,
          imports,
          options,
          name,
          depth + 1,
          allNames,
        );
      }
    }
  }

  // ── Import extraction ────────────────────────────────────────────────

  /** Handle `import X`, `import X as Y`, `import X, Y` */
  private extractImportStatement(
    node: Parser.SyntaxNode,
    imports: PythonImport[],
  ): void {
    // import_statement children: "import" dotted_name ("as" identifier)?
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "dotted_name") {
        const moduleName = child.text;
        let alias: string | undefined;

        // Check for "as" alias
        const next = node.child(i + 1);
        const nextNext = node.child(i + 2);
        if (next?.type === "as" && nextNext?.type === "identifier") {
          alias = nextNext.text;
        }

        imports.push({
          moduleName,
          isRelative: false,
          importedNames: [],
          isWholeModule: true,
          alias,
          range: toRange(node),
        });
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        const aliasNode = child.childForFieldName("alias");
        if (nameNode) {
          imports.push({
            moduleName: nameNode.text,
            isRelative: false,
            importedNames: [],
            isWholeModule: true,
            alias: aliasNode?.text,
            range: toRange(node),
          });
        }
      }
    }
  }

  /** Handle `from X import Y`, `from . import Z`, `from ..pkg import W` */
  private extractImportFromStatement(
    node: Parser.SyntaxNode,
    imports: PythonImport[],
  ): void {
    const moduleNode = node.childForFieldName("module_name");
    let moduleName = "";
    let isRelative = false;

    // Check for relative import prefix (dots before module name)
    let dotsPrefix = "";
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "relative_import") {
        // relative_import contains dot(s) and optionally a dotted_name
        for (let j = 0; j < child.childCount; j++) {
          const rc = child.child(j)!;
          if (rc.type === "import_prefix") {
            dotsPrefix = rc.text;
          } else if (rc.type === "dotted_name") {
            moduleName = rc.text;
          }
        }
        isRelative = true;
        break;
      }
    }

    if (!isRelative && moduleNode) {
      moduleName = moduleNode.text;
      isRelative = moduleName.startsWith(".");
    }

    if (isRelative && dotsPrefix) {
      moduleName = dotsPrefix + moduleName;
    }

    // Extract imported names
    const importedNames: Array<{ name: string; alias?: string }> = [];

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "dotted_name" && child !== moduleNode) {
        importedNames.push({ name: child.text });
      } else if (child.type === "aliased_import") {
        const nameNode = child.childForFieldName("name");
        const aliasNode = child.childForFieldName("alias");
        if (nameNode) {
          importedNames.push({
            name: nameNode.text,
            alias: aliasNode?.text,
          });
        }
      } else if (child.type === "wildcard_import") {
        importedNames.push({ name: "*" });
      }
    }

    imports.push({
      moduleName: moduleName || ".",
      isRelative,
      importedNames,
      isWholeModule: false,
      range: toRange(node),
    });
  }

  // ── Module-level assignment extraction ───────────────────────────────

  private extractAssignment(
    node: Parser.SyntaxNode,
    filePath: string,
    symbols: PythonSymbol[],
    allNames: Set<string> | null,
  ): void {
    const child = node.child(0);
    if (!child) return;

    // assignment: left = right
    if (child.type === "assignment") {
      const left = child.childForFieldName("left");
      if (!left) return;

      // Skip __all__, __name__, etc. — these are metadata, not user-visible symbols
      if (left.type === "identifier") {
        const name = left.text;
        if (name === "__all__" || name === "__name__" || name === "__file__")
          return;

        const visibility = getVisibility(name);
        const exported = isExportedName(name, allNames);

        // Determine if it looks like a constant (UPPER_SNAKE_CASE)
        const isConst = /^[A-Z][A-Z0-9_]*$/.test(name);

        symbols.push({
          name,
          kind: "variable",
          filePath,
          range: toRange(node),
          isExported: exported,
          visibility,
          signature: isConst ? `${name} = ...` : undefined,
        });
      }
    }

    // Type-annotated assignment: x: int = 5
    if (child.type === "type_alias_statement") {
      // `type X = ...` (Python 3.12+)
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const name = nameNode.text;
        symbols.push({
          name,
          kind: "variable",
          filePath,
          range: toRange(node),
          isExported: isExportedName(name, allNames),
          visibility: getVisibility(name),
        });
      }
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createPythonExtractor(
  workspaceRoot: string,
  options?: Partial<PythonExtractionOptions>,
): PythonExtractor {
  return new PythonExtractor(workspaceRoot, options);
}
