// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @file AST Extractor
 *
 * Tree-sitter based TypeScript/JavaScript AST extractor.
 * Lightweight, fast, focused on structural extraction for spec↔code traceability.
 */

import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import * as fs from "fs";
import * as path from "path";
import type {
  ExtractedSymbol,
  ExtractedImport,
  ExtractedExport,
  ExtractedCall,
  ExtractedPropertyAccess,
  ExtractedTypeAssertion,
  ExtractedVariableAssignment,
  ExtractedDefUseChain,
  FileExtractionResult,
  ExtractionOptions,
  BatchExtractionResult,
  SymbolKind,
  ExportKind,
  SourceRange,
} from "./types.js";

/**
 * Lightweight AST extractor using tree-sitter
 */
export class AstExtractor {
  private parser: Parser;
  private workspaceRoot: string;
  private defaultOptions: Required<ExtractionOptions>;

  constructor(workspaceRoot: string, options?: Partial<ExtractionOptions>) {
    this.workspaceRoot = workspaceRoot;
    this.parser = new Parser();

    this.defaultOptions = {
      includePrivate: options?.includePrivate ?? false,
      includeDocSummary: options?.includeDocSummary ?? true,
      includeParameters: options?.includeParameters ?? true,
      includeMembers: options?.includeMembers ?? true,
      maxDepth: options?.maxDepth ?? 2,
    };
  }

  /**
   * Extract symbols from a single file
   */
  async extractFile(
    filePath: string,
    options?: Partial<ExtractionOptions>,
  ): Promise<FileExtractionResult> {
    const opts = { ...this.defaultOptions, ...options };
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workspaceRoot, filePath);

    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    const language = this.detectLanguage(absolutePath);

    // Set parser language based on file type
    this.setParserLanguage(language);

    try {
      const content = await fs.promises.readFile(absolutePath, "utf-8");
      const tree = this.parseSafe(content);

      const symbols: ExtractedSymbol[] = [];
      const imports: ExtractedImport[] = [];
      const exports: ExtractedExport[] = [];
      const calls: ExtractedCall[] = [];
      const propertyAccesses: ExtractedPropertyAccess[] = [];
      const typeAssertions: ExtractedTypeAssertion[] = [];
      const variableAssignments: ExtractedVariableAssignment[] = [];
      const defUseChains: ExtractedDefUseChain[] = [];
      const testDescriptions: Array<{
        file: string;
        line: number;
        kind: "describe" | "it" | "test";
        description: string;
      }> = [];
      const errors: string[] = [];

      // Extract all symbols from the tree
      this.extractFromNode(
        tree.rootNode,
        content,
        relativePath,
        symbols,
        imports,
        exports,
        opts,
        undefined,
        0,
      );

      // Extract call expressions and property access chains
      this.extractUsages(tree.rootNode, relativePath, calls, propertyAccesses);

      // Extract type assertions (as any, double cast, angle cast)
      this.extractTypeAssertions(tree.rootNode, relativePath, typeAssertions);

      // Extract test descriptions from describe/it/test calls (14.6)
      this.extractTestDescriptions(
        tree.rootNode,
        relativePath,
        testDescriptions,
      );

      // Extract variable assignments with RHS text (13.10)
      this.extractVariableAssignmentsFromTree(
        tree.rootNode,
        relativePath,
        variableAssignments,
      );

      // Extract intra-function def-use chains (16.1)
      this.extractDefUseChainsFromTree(
        tree.rootNode,
        relativePath,
        defUseChains,
      );

      // Annotate @deprecated / @internal / _prefix flags on all symbols
      this.annotateJsDocFlags(symbols, content, tree);

      // Check for parse errors
      if (tree.rootNode.hasError) {
        errors.push("Parse errors detected in file");
      }

      return {
        filePath: relativePath,
        language,
        symbols,
        imports,
        exports,
        calls,
        propertyAccesses,
        typeAssertions,
        testDescriptions:
          testDescriptions.length > 0 ? testDescriptions : undefined,
        variableAssignments:
          variableAssignments.length > 0 ? variableAssignments : undefined,
        defUseChains: defUseChains.length > 0 ? defUseChains : undefined,
        extractedAt: Date.now(),
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return {
        filePath: relativePath,
        language,
        symbols: [],
        imports: [],
        exports: [],
        extractedAt: Date.now(),
        errors: [(error as Error).message],
      };
    }
  }

  /**
   * Extract symbols from multiple files
   */
  async extractBatch(
    filePaths: string[],
    options?: Partial<ExtractionOptions>,
  ): Promise<BatchExtractionResult> {
    const startTime = Date.now();
    const files = new Map<string, FileExtractionResult>();
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

  /**
   * Extract from content string (for testing or in-memory parsing)
   */
  extractFromString(
    content: string,
    filePath: string,
    language: "typescript" | "javascript" | "tsx" | "jsx",
    options?: Partial<ExtractionOptions>,
  ): FileExtractionResult {
    const opts = { ...this.defaultOptions, ...options };
    this.setParserLanguage(language);

    const tree = this.parseSafe(content);
    const symbols: ExtractedSymbol[] = [];
    const imports: ExtractedImport[] = [];
    const exports: ExtractedExport[] = [];

    this.extractFromNode(
      tree.rootNode,
      content,
      filePath,
      symbols,
      imports,
      exports,
      opts,
      undefined,
      0,
    );

    return {
      filePath,
      language,
      symbols,
      imports,
      exports,
      extractedAt: Date.now(),
      errors: tree.rootNode.hasError ? ["Parse errors detected"] : undefined,
    };
  }

  /**
   * Set parser language based on detected language
   */
  private setParserLanguage(
    language: "typescript" | "javascript" | "tsx" | "jsx",
  ): void {
    switch (language) {
      case "typescript":
        this.parser.setLanguage(TypeScript.typescript);
        break;
      case "tsx":
        this.parser.setLanguage(TypeScript.tsx);
        break;
      case "javascript":
      case "jsx":
        // Use TypeScript parser for JS (it handles JS syntax)
        this.parser.setLanguage(TypeScript.typescript);
        break;
    }
  }

  /**
   * Parse content using tree-sitter, using a callback-based approach for content
   * longer than 32 767 characters to work around a hard string-size limit in
   * tree-sitter 0.21.x Node.js bindings ("Invalid argument" for strings > 32767 chars).
   */
  private parseSafe(content: string): Parser.Tree {
    // tree-sitter 0.21.x: parser.parse(string) throws "Invalid argument" for strings
    // longer than 32 767 chars (2^15 − 1). The callback form, which receives a
    // character offset and returns a substring chunk, has no such restriction.
    const MAX_DIRECT = 32_000;
    if (content.length <= MAX_DIRECT) {
      return this.parser.parse(content);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.parser as any).parse((startIndex: number): string | null => {
      if (startIndex >= content.length) return null;
      return content.slice(startIndex, startIndex + 4096);
    }) as Parser.Tree;
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(
    filePath: string,
  ): "typescript" | "javascript" | "tsx" | "jsx" {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".ts":
        return "typescript";
      case ".tsx":
        return "tsx";
      case ".jsx":
        return "jsx";
      default:
        return "javascript";
    }
  }

  /**
   * Extract symbols from a tree-sitter node
   */
  private extractFromNode(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    imports: ExtractedImport[],
    exports: ExtractedExport[],
    options: Required<ExtractionOptions>,
    parentName: string | undefined,
    depth: number,
  ): void {
    if (depth > options.maxDepth) return;

    switch (node.type) {
      // Function declarations
      case "function_declaration":
      case "generator_function_declaration":
        this.extractFunction(
          node,
          content,
          filePath,
          symbols,
          options,
          parentName,
        );
        break;

      // Class declarations
      case "class_declaration":
        this.extractClass(node, content, filePath, symbols, options, depth);
        break;

      // Interface declarations (TypeScript)
      case "interface_declaration":
        this.extractInterface(node, content, filePath, symbols, options, depth);
        break;

      // Type alias (TypeScript)
      case "type_alias_declaration":
        this.extractTypeAlias(node, content, filePath, symbols, options);
        break;

      // Enum (TypeScript)
      case "enum_declaration":
        this.extractEnum(node, content, filePath, symbols, options);
        break;

      // Variable declarations (may contain arrow functions)
      case "lexical_declaration":
      case "variable_declaration":
        this.extractVariables(
          node,
          content,
          filePath,
          symbols,
          options,
          parentName,
        );
        break;

      // Import statements
      case "import_statement":
        this.extractImport(node, content, imports);
        break;

      // Export statements
      case "export_statement":
        this.extractExport(
          node,
          content,
          filePath,
          symbols,
          exports,
          options,
          depth,
        );
        // Don't recurse into export_statement children - they're handled by extractExport
        return;

      // Module/namespace (TypeScript)
      case "module":
        this.extractModule(node, content, filePath, symbols, options, depth);
        break;
    }

    // Recurse into children for top-level nodes
    if (
      depth === 0 ||
      node.type === "program" ||
      node.type === "statement_block"
    ) {
      for (const child of node.children) {
        this.extractFromNode(
          child,
          content,
          filePath,
          symbols,
          imports,
          exports,
          options,
          parentName,
          depth,
        );
      }
    }
  }

  /**
   * Extract function declaration
   */
  private extractFunction(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
    parentName?: string,
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;
    const isAsync = node.children.some((c) => c.type === "async");
    const params = this.extractParameters(node);
    const docSummary = options.includeDocSummary
      ? this.extractDocComment(node, content)
      : undefined;
    const decoratorList = this.extractDecorators(node);

    symbols.push({
      name,
      kind: "function",
      filePath,
      range: this.nodeToRange(node),
      parent: parentName,
      isExported: false, // Will be updated by export handling
      isAsync,
      docSummary,
      parameters: options.includeParameters ? params : undefined,
      signature: this.extractSignature(node, content),
      decorators: decoratorList.length > 0 ? decoratorList : undefined,
    });
  }

  /**
   * Extract class declaration
   */
  private extractClass(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
    depth: number,
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;
    const docSummary = options.includeDocSummary
      ? this.extractDocComment(node, content)
      : undefined;

    // Parse implements clause
    const implementsList = this.extractImplements(node);
    const decoratorList = this.extractDecorators(node);

    symbols.push({
      name,
      kind: "class",
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary,
      signature: this.extractSignature(node, content) ?? `class ${name}`,
      implements: implementsList.length > 0 ? implementsList : undefined,
      decorators: decoratorList.length > 0 ? decoratorList : undefined,
    });

    // Extract class members
    if (options.includeMembers && depth < options.maxDepth) {
      const body = node.childForFieldName("body");
      if (body) {
        this.extractClassMembers(
          body,
          content,
          filePath,
          symbols,
          options,
          name,
        );
      }
    }
  }

  /**
   * Extract class members (methods, properties)
   */
  private extractClassMembers(
    body: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
    className: string,
  ): void {
    for (const child of body.children) {
      switch (child.type) {
        case "method_definition": {
          const nameNode = child.childForFieldName("name");
          if (!nameNode) continue;

          const name = nameNode.text;
          const isConstructor = name === "constructor";
          const isStatic = child.children.some((c) => c.type === "static");
          const isGetter = child.children.some((c) => c.text === "get");
          const isSetter = child.children.some((c) => c.text === "set");
          const isAsync = child.children.some((c) => c.type === "async");
          const visibility = this.extractVisibility(child);

          if (!options.includePrivate && visibility === "private") continue;

          const kind: SymbolKind = isConstructor
            ? "constructor"
            : isGetter
              ? "getter"
              : isSetter
                ? "setter"
                : "method";

          symbols.push({
            name,
            kind,
            filePath,
            range: this.nodeToRange(child),
            parent: className,
            isExported: false,
            isAsync,
            isStatic,
            visibility,
            parameters: options.includeParameters
              ? this.extractParameters(child)
              : undefined,
            docSummary: options.includeDocSummary
              ? this.extractDocComment(child, content)
              : undefined,
            signature: this.extractSignature(child, content),
          });
          break;
        }

        case "public_field_definition":
        case "field_definition": {
          const nameNode = child.childForFieldName("name");
          if (!nameNode) continue;

          const name = nameNode.text;
          const isStatic = child.children.some((c) => c.type === "static");
          const visibility = this.extractVisibility(child);

          if (!options.includePrivate && visibility === "private") continue;

          symbols.push({
            name,
            kind: "property",
            filePath,
            range: this.nodeToRange(child),
            parent: className,
            isExported: false,
            isStatic,
            visibility,
          });
          break;
        }
      }
    }
  }

  /**
   * Extract interface declaration
   */
  private extractInterface(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
    depth: number,
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;
    const docSummary = options.includeDocSummary
      ? this.extractDocComment(node, content)
      : undefined;

    symbols.push({
      name,
      kind: "interface",
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary,
      signature: `interface ${name}`,
    });

    // Extract interface members
    if (options.includeMembers && depth < options.maxDepth) {
      const body = node.childForFieldName("body");
      if (body) {
        this.extractInterfaceMembers(
          body,
          content,
          filePath,
          symbols,
          options,
          name,
        );
      }
    }
  }

  /**
   * Extract interface members
   */
  private extractInterfaceMembers(
    body: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
    interfaceName: string,
  ): void {
    for (const child of body.children) {
      switch (child.type) {
        case "method_signature": {
          const nameNode = child.childForFieldName("name");
          if (!nameNode) continue;

          symbols.push({
            name: nameNode.text,
            kind: "method",
            filePath,
            range: this.nodeToRange(child),
            parent: interfaceName,
            isExported: false,
            parameters: options.includeParameters
              ? this.extractParameters(child)
              : undefined,
            signature: this.extractSignature(child, content),
          });
          break;
        }

        case "property_signature": {
          const nameNode = child.childForFieldName("name");
          if (!nameNode) continue;

          symbols.push({
            name: nameNode.text,
            kind: "property",
            filePath,
            range: this.nodeToRange(child),
            parent: interfaceName,
            isExported: false,
          });
          break;
        }
      }
    }
  }

  /**
   * Extract type alias
   */
  private extractTypeAlias(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: "type",
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary: options.includeDocSummary
        ? this.extractDocComment(node, content)
        : undefined,
    });
  }

  /**
   * Extract enum declaration
   */
  private extractEnum(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: "enum",
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary: options.includeDocSummary
        ? this.extractDocComment(node, content)
        : undefined,
    });
  }

  /**
   * Given a call_expression node (e.g. React.memo(...), forwardRef(...)),
   * find the first direct argument that is an arrow_function or
   * function_expression.  Used to promote HOC-wrapped variables to "function".
   *
   * Only searches the immediate argument list — one level deep — to avoid
   * false-positives from deeply nested callbacks.
   */
  private findFunctionArgument(
    callNode: Parser.SyntaxNode,
  ): Parser.SyntaxNode | null {
    const args = callNode.childForFieldName("arguments");
    if (!args) return null;
    for (const child of args.children) {
      if (
        child.type === "arrow_function" ||
        child.type === "function_expression"
      ) {
        return child;
      }
    }
    return null;
  }

  /**
   * Extract variable declarations
   */
  private extractVariables(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
    parentName?: string,
  ): void {
    const declarators = node.descendantsOfType("variable_declarator");

    for (const declarator of declarators) {
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");

      if (!nameNode) continue;

      const name = nameNode.text;
      let kind: SymbolKind = "variable";
      let isAsync = false;
      let params: string[] | undefined;

      // Check if it's an arrow function or function expression
      if (valueNode) {
        if (
          valueNode.type === "arrow_function" ||
          valueNode.type === "function_expression"
        ) {
          kind = "function";
          isAsync = valueNode.children.some((c) => c.type === "async");
          params = options.includeParameters
            ? this.extractParameters(valueNode)
            : undefined;
        } else if (valueNode.type === "call_expression") {
          // HOC / wrapper pattern: React.memo(...), React.forwardRef(...),
          // memo(...), forwardRef(...), connect(...)(...), styled.div`...`, etc.
          // If any direct argument is an arrow_function or function_expression
          // the variable is a component/function — promote the kind.
          const fnArg = this.findFunctionArgument(valueNode);
          if (fnArg) {
            kind = "function";
            isAsync = fnArg.children.some((c) => c.type === "async");
            params = options.includeParameters
              ? this.extractParameters(fnArg)
              : undefined;
          }
        }
      }

      symbols.push({
        name,
        kind,
        filePath,
        range: this.nodeToRange(declarator),
        parent: parentName,
        isExported: false,
        isAsync,
        parameters: params,
        docSummary: options.includeDocSummary
          ? this.extractDocComment(node, content)
          : undefined,
      });
    }
  }

  /**
   * Extract module/namespace declaration
   */
  private extractModule(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    options: Required<ExtractionOptions>,
    depth: number,
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text.replace(/['"]/g, "");

    symbols.push({
      name,
      kind: "namespace",
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary: options.includeDocSummary
        ? this.extractDocComment(node, content)
        : undefined,
    });
  }

  /**
   * Extract import statement
   */
  private extractImport(
    node: Parser.SyntaxNode,
    content: string,
    imports: ExtractedImport[],
  ): void {
    const sourceNode = node.childForFieldName("source");
    if (!sourceNode) return;

    const moduleSpecifier = sourceNode.text.replace(/['"]/g, "");
    const isRelative =
      moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/");

    const importItems: ExtractedImport["imports"] = [];

    // Find import clause
    const importClause = node.children.find((c) => c.type === "import_clause");
    if (importClause) {
      for (const child of importClause.children) {
        switch (child.type) {
          case "identifier":
            // Default import
            importItems.push({ name: child.text, isDefault: true });
            break;

          case "namespace_import": {
            const nsName = child.children.find((c) => c.type === "identifier");
            if (nsName) {
              importItems.push({ name: nsName.text, isNamespace: true });
            }
            break;
          }

          case "named_imports":
            for (const specifier of child.descendantsOfType(
              "import_specifier",
            )) {
              const nameNode = specifier.childForFieldName("name");
              const aliasNode = specifier.childForFieldName("alias");

              if (nameNode) {
                importItems.push({
                  name: nameNode.text,
                  alias: aliasNode?.text,
                });
              }
            }
            break;
        }
      }
    }

    imports.push({
      moduleSpecifier,
      isRelative,
      imports: importItems,
      range: this.nodeToRange(node),
    });
  }

  /**
   * Extract export statement
   */
  private extractExport(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    exports: ExtractedExport[],
    options: Required<ExtractionOptions>,
    depth: number,
  ): void {
    const isDefault = node.children.some((c) => c.text === "default");
    const sourceNode = node.childForFieldName("source");

    // Handle declaration exports (export function, export class, etc.)
    const declaration = node.childForFieldName("declaration");
    if (declaration) {
      // Extract the declaration and mark it as exported
      const startLength = symbols.length;
      this.extractFromNode(
        declaration,
        content,
        filePath,
        symbols,
        [],
        [],
        options,
        undefined,
        depth + 1,
      );

      // Mark newly added symbols as exported
      for (let i = startLength; i < symbols.length; i++) {
        symbols[i].isExported = true;
        symbols[i].exportKind = isDefault ? "default" : "declaration";
      }
      return;
    }

    // Handle export clause (export { x, y })
    const exportClause = node.children.find((c) => c.type === "export_clause");
    if (exportClause) {
      const sourceModule = sourceNode?.text.replace(/['"]/g, "");
      const kind: ExportKind = sourceModule ? "re-export" : "named";

      for (const specifier of exportClause.descendantsOfType(
        "export_specifier",
      )) {
        const nameNode = specifier.childForFieldName("name");
        const aliasNode = specifier.childForFieldName("alias");

        if (nameNode) {
          exports.push({
            name: aliasNode?.text || nameNode.text,
            localName: aliasNode ? nameNode.text : undefined,
            kind,
            sourceModule,
            range: this.nodeToRange(specifier),
          });
        }
      }
      return;
    }

    // Handle default export of expression (export default foo)
    if (isDefault) {
      const valueNode = node.childForFieldName("value");
      if (valueNode && valueNode.type === "identifier") {
        exports.push({
          name: "default",
          localName: valueNode.text,
          kind: "default",
          range: this.nodeToRange(node),
        });
      }
    }
  }

  /**
   * Extract function/method parameters
   */
  private extractParameters(node: Parser.SyntaxNode): string[] {
    const params = node.childForFieldName("parameters");
    if (!params) return [];

    const result: string[] = [];

    for (const child of params.children) {
      if (
        child.type === "required_parameter" ||
        child.type === "optional_parameter" ||
        child.type === "rest_pattern"
      ) {
        const pattern = child.childForFieldName("pattern");
        if (pattern) {
          result.push(pattern.text);
        }
      } else if (child.type === "identifier") {
        result.push(child.text);
      }
    }

    return result;
  }

  /**
   * Extract visibility modifier from class member
   */
  private extractVisibility(
    node: Parser.SyntaxNode,
  ): "public" | "private" | "protected" | undefined {
    for (const child of node.children) {
      if (child.type === "accessibility_modifier") {
        const text = child.text;
        if (text === "private" || text === "protected" || text === "public") {
          return text;
        }
      }
    }
    // Check for # prefix (ES private field)
    const nameNode = node.childForFieldName("name");
    if (nameNode?.text.startsWith("#")) {
      return "private";
    }
    return undefined;
  }

  /**
   * Scan the JSDoc block preceding a node for @deprecated and @internal tags.
   * Returns { deprecated, deprecatedNote, isInternal }.
   */
  private extractJsDocTags(
    node: Parser.SyntaxNode,
    content: string,
  ): { deprecated?: boolean; deprecatedNote?: string; isInternal?: boolean } {
    const startLine = node.startPosition.row;
    const lines = content.split("\n");
    let blockStart = -1;

    // Walk backwards to find the opening '/**'
    for (let i = startLine - 1; i >= Math.max(0, startLine - 8); i--) {
      const line = lines[i].trim();
      if (line.startsWith("/**")) {
        blockStart = i;
        break;
      }
      if (line && !line.startsWith("//") && !line.startsWith("*")) break;
    }
    if (blockStart < 0) return {};

    let deprecated: boolean | undefined;
    let deprecatedNote: string | undefined;
    let isInternal: boolean | undefined;

    for (let i = blockStart; i < startLine; i++) {
      const line = lines[i].trim().replace(/^\*\s?/, "");
      if (line.startsWith("@deprecated")) {
        deprecated = true;
        const note = line.slice("@deprecated".length).trim();
        if (note) deprecatedNote = note;
      }
      if (line.startsWith("@internal")) {
        isInternal = true;
      }
    }
    return { deprecated, deprecatedNote, isInternal };
  }

  /**
   * Post-process symbols array: annotate each with @deprecated / @internal / _prefix flags.
   * Requires the raw source content so we can scan JSDoc blocks.
   */
  private annotateJsDocFlags(
    symbols: ExtractedSymbol[],
    content: string,
    tree: Parser.Tree,
  ): void {
    // Build a line → node map once using tree-sitter's rootNode children isn't
    // efficient; instead we re-scan content lines per symbol using extractJsDocTags.
    // We do this by re-invoking the scanner with a fake node that only needs .startPosition.
    for (const sym of symbols) {
      // _prefix convention — any exported symbol starting with '_' is considered internal
      if (sym.name.startsWith("_")) {
        sym.isInternal = true;
      }
      // We need a node at the symbol's start line to pass to extractJsDocTags.
      // Use the tree's rootNode.descendantForPosition which is cheap.
      const row = sym.range.startLine - 1; // 0-based
      const node = tree.rootNode.descendantForPosition({ row, column: 0 });
      if (!node) continue;
      const flags = this.extractJsDocTags(node, content);
      if (flags.deprecated) sym.deprecated = true;
      if (flags.deprecatedNote) sym.deprecatedNote = flags.deprecatedNote;
      if (flags.isInternal) sym.isInternal = true;
    }
  }

  /**
   * Extract decorator names from a class or function node.
   * Decorators appear as sibling nodes immediately before the class/function in
   * the parent node. Returns bare names, e.g. ["Controller", "Injectable"].
   */
  private extractDecorators(node: Parser.SyntaxNode): string[] {
    const result: string[] = [];
    const parent = node.parent;
    if (!parent) return result;

    for (const child of parent.children) {
      if (child.id === node.id) break;
      if (child.type !== "decorator") continue;

      // @Foo        → identifier child
      // @Foo(args)  → call_expression child; callee is identifier/member_expression
      let nameNode: Parser.SyntaxNode | null = null;
      for (const dc of child.children) {
        if (dc.type === "identifier") {
          nameNode = dc;
          break;
        }
        if (dc.type === "call_expression") {
          nameNode = dc.childForFieldName("function") ?? dc.firstNamedChild;
          break;
        }
        if (dc.type === "member_expression") {
          nameNode = dc.childForFieldName("property") ?? dc.lastNamedChild;
          break;
        }
      }
      if (nameNode) {
        // Strip leading @ if present in text
        const raw = nameNode.text.replace(/^@/, "");
        if (raw) result.push(raw);
      }
    }
    return result;
  }

  /**
   * Traverse the full AST to extract type assertions (14.3):
   *   - as_expression where type is `any`                    → "as_any"
   *   - as_expression where value is also as_expression      → "double_cast"
   *   - type_assertion (angle-bracket syntax <Type>expr)     → "angle_cast"
   *   - any other as_expression                              → "as_cast"
   */
  private extractTypeAssertions(
    root: Parser.SyntaxNode,
    filePath: string,
    assertions: ExtractedTypeAssertion[],
  ): void {
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "as_expression") {
        const valueNode =
          node.childForFieldName("value") ?? node.firstNamedChild;
        const typeNode = node.childForFieldName("type") ?? node.lastNamedChild;
        const targetType = typeNode?.text ?? null;
        const line = node.startPosition.row + 1;
        const context = this.findEnclosingSymbol(node);

        let kind: ExtractedTypeAssertion["kind"];
        if (targetType === "any") {
          kind = "as_any";
        } else if (valueNode?.type === "as_expression") {
          kind = "double_cast";
        } else {
          kind = "as_cast";
        }

        assertions.push({ file: filePath, line, kind, context, targetType });
      } else if (node.type === "type_assertion") {
        const typeNode = node.childForFieldName("type") ?? node.firstNamedChild;
        const line = node.startPosition.row + 1;
        const context = this.findEnclosingSymbol(node);
        assertions.push({
          file: filePath,
          line,
          kind: "angle_cast",
          context,
          targetType: typeNode?.text ?? null,
        });
      }

      for (const child of node.children) {
        visit(child);
      }
    };
    visit(root);
  }

  /**
   * Extract test descriptions from describe(), it(), test() calls (14.6)
   */
  private extractTestDescriptions(
    root: Parser.SyntaxNode,
    filePath: string,
    descriptions: Array<{
      file: string;
      line: number;
      kind: "describe" | "it" | "test";
      description: string;
    }>,
  ): void {
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "call_expression") {
        const func = node.childForFieldName("function");
        if (!func) {
          for (const child of node.children) {
            visit(child);
          }
          return;
        }

        // Check if this is describe(), it(), or test()
        const funcName = func.type === "identifier" ? func.text : null;
        if (!funcName || !["describe", "it", "test"].includes(funcName)) {
          for (const child of node.children) {
            visit(child);
          }
          return;
        }

        // Find the arguments
        const args = node.childForFieldName("arguments");
        if (!args) {
          for (const child of node.children) {
            visit(child);
          }
          return;
        }

        // Extract the first string argument (the description)
        for (const child of args.children) {
          if (child.type === "string") {
            // Remove quotes from the string
            const text = child.text;
            let description = text;
            if (
              (text.startsWith('"') && text.endsWith('"')) ||
              (text.startsWith("'") && text.endsWith("'")) ||
              (text.startsWith("`") && text.endsWith("`"))
            ) {
              description = text.slice(1, -1);
            }

            const line = node.startPosition.row + 1;
            descriptions.push({
              file: filePath,
              line,
              kind: funcName as "describe" | "it" | "test",
              description,
            });
            break;
          }
        }
      }

      for (const child of node.children) {
        visit(child);
      }
    };
    visit(root);
  }

  /**
   * Extract variable assignments with RHS text for pattern-based rule checking (13.10).
   * Traverses the full AST and captures all variable_declarator nodes that have a value.
   */
  private extractVariableAssignmentsFromTree(
    root: Parser.SyntaxNode,
    filePath: string,
    assignments: ExtractedVariableAssignment[],
  ): void {
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "variable_declarator") {
        const nameNode = node.childForFieldName("name");
        const valueNode = node.childForFieldName("value");
        if (nameNode && valueNode) {
          // Normalise whitespace and truncate to 120 chars
          const valueText = valueNode.text
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
          const line = node.startPosition.row + 1;
          const context = this.findEnclosingSymbol(node);
          assignments.push({
            file: filePath,
            line,
            symbolName: nameNode.text,
            valueText,
            context,
          });
        }
      }
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(root);
  }

  /**
   * Extract intra-function local def-use chains (16.1).
   *
   * Scope: within a single function/method body only. Nested function bodies are
   * treated as separate scopes and are not included in the parent's chains.
   */
  private extractDefUseChainsFromTree(
    root: Parser.SyntaxNode,
    filePath: string,
    chains: ExtractedDefUseChain[],
  ): void {
    const visit = (node: Parser.SyntaxNode): void => {
      if (this.isFunctionLikeNode(node)) {
        this.extractFunctionDefUse(node, filePath, chains);
      }
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(root);
  }

  private extractFunctionDefUse(
    fnNode: Parser.SyntaxNode,
    filePath: string,
    chains: ExtractedDefUseChain[],
  ): void {
    const body = fnNode.childForFieldName("body");
    if (!body) return;

    const functionName = this.getFunctionName(fnNode);
    const defs: Array<{ varName: string; defLine: number }> = [];

    // Collect local definitions in this function scope (exclude nested functions).
    this.walkFunctionScope(body, (node) => {
      if (node.type === "variable_declarator") {
        const nameNode = node.childForFieldName("name");
        const valueNode = node.childForFieldName("value");
        if (nameNode?.type === "identifier" && valueNode) {
          defs.push({
            varName: nameNode.text,
            defLine: node.startPosition.row + 1,
          });
        }
      }

      if (node.type === "assignment_expression") {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "identifier" && right) {
          defs.push({
            varName: left.text,
            defLine: node.startPosition.row + 1,
          });
        }
      }
    });

    if (defs.length === 0) return;

    const reads: Array<{ name: string; line: number; context: string }> = [];
    this.walkFunctionScope(body, (node) => {
      if (!this.isIdentifierRead(node)) return;
      reads.push({
        name: node.text,
        line: node.startPosition.row + 1,
        context: this.classifyIdentifierUseContext(node),
      });
    });

    if (reads.length === 0) return;

    const seen = new Set<string>();
    for (const def of defs) {
      for (const read of reads) {
        if (read.name !== def.varName) continue;
        if (read.line <= def.defLine) continue;

        const key = `${functionName ?? ""}|${def.varName}|${def.defLine}|${read.line}|${read.context}`;
        if (seen.has(key)) continue;
        seen.add(key);

        chains.push({
          file: filePath,
          functionName,
          defLine: def.defLine,
          varName: def.varName,
          useLine: read.line,
          useContext: read.context,
        });
      }
    }
  }

  private walkFunctionScope(
    root: Parser.SyntaxNode,
    visitor: (node: Parser.SyntaxNode) => void,
  ): void {
    const walk = (node: Parser.SyntaxNode, isRoot = false): void => {
      if (!isRoot && this.isFunctionLikeNode(node)) {
        return;
      }
      visitor(node);
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(root, true);
  }

  private isFunctionLikeNode(node: Parser.SyntaxNode): boolean {
    return (
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "generator_function_declaration" ||
      node.type === "arrow_function" ||
      node.type === "function_expression" ||
      node.type === "generator_function"
    );
  }

  private getFunctionName(node: Parser.SyntaxNode): string | null {
    if (
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "generator_function_declaration"
    ) {
      return node.childForFieldName("name")?.text ?? null;
    }

    const parent = node.parent;
    if (parent?.type === "variable_declarator") {
      return parent.childForFieldName("name")?.text ?? null;
    }
    if (parent?.type === "pair") {
      return parent.childForFieldName("key")?.text ?? null;
    }
    return null;
  }

  private isIdentifierRead(node: Parser.SyntaxNode): boolean {
    if (node.type !== "identifier") return false;
    const parent = node.parent;
    if (!parent) return true;

    // Exclude declaration/assignment targets and property keys.
    if (parent.childForFieldName("name") === node) return false;
    if (parent.childForFieldName("left") === node) return false;
    if (parent.childForFieldName("property") === node) return false;
    if (parent.childForFieldName("key") === node) return false;

    if (
      parent.type === "shorthand_property_identifier_pattern" ||
      parent.type === "import_specifier" ||
      parent.type === "namespace_import" ||
      parent.type === "type_identifier"
    ) {
      return false;
    }

    return true;
  }

  private classifyIdentifierUseContext(node: Parser.SyntaxNode): string {
    const parent = node.parent;
    if (!parent) return "read";

    if (parent.type === "return_statement") return "return";
    if (
      parent.type === "arguments" &&
      parent.parent?.type === "call_expression"
    ) {
      return "call_arg";
    }
    if (
      parent.type === "member_expression" &&
      parent.childForFieldName("object") === node
    ) {
      return "property_access";
    }
    if (
      parent.type === "assignment_expression" &&
      parent.childForFieldName("right") === node
    ) {
      return "assignment_rhs";
    }

    return "read";
  }

  /**
   * Extract JSDoc / leading comment from preceding node.
   *
   * Captures the full description body (all content lines before the first
   * @-tag), capped at 600 characters, so that symbols_fts search covers
   * the complete comment — not just the first sentence.
   *
   * Also falls back to trailing `//` comments on the declaration line itself.
   */
  private extractDocComment(
    node: Parser.SyntaxNode,
    content: string,
  ): string | undefined {
    const startLine = node.startPosition.row;
    const lines = content.split("\n");

    // ── 1. Look backwards for a block comment (/** … */ or /* … */) ────────
    for (let i = startLine - 1; i >= Math.max(0, startLine - 20); i--) {
      const line = lines[i].trim();

      if (
        line.startsWith("/**") ||
        (line.startsWith("/*") && !line.startsWith("/**/"))
      ) {
        // Collect all description lines from start of block to startLine
        const bodyParts: string[] = [];
        for (let j = i; j < startLine; j++) {
          const docLine = lines[j].trim();
          // Stop description at first JSDoc @-tag
          if (docLine.startsWith("* @") || docLine.startsWith("@")) break;
          // Skip delimiters
          if (
            docLine === "/**" ||
            docLine === "*/" ||
            docLine === "/*" ||
            docLine === "*"
          )
            continue;
          // Single-line /** … */
          const singleLine = docLine.match(/^\/\*+\s*(.+?)\s*\*\/$/);
          if (singleLine) {
            bodyParts.push(singleLine[1]);
            continue;
          }
          // /** content or /* content (opening line has text)
          const openLine = docLine.match(/^\/\*+\s*(.+)/);
          if (openLine) {
            bodyParts.push(openLine[1]);
            continue;
          }
          // * content line
          const starLine = docLine.match(/^\*\s*(.*)/);
          if (starLine && starLine[1]) bodyParts.push(starLine[1]);
        }
        if (bodyParts.length === 0) break;
        const full = bodyParts.join(" ").replace(/\s+/g, " ").trim();
        return full.length > 600 ? full.slice(0, 597) + "…" : full;
      }

      // Stop if we hit real code (not comment or blank)
      if (
        line &&
        !line.startsWith("//") &&
        !line.startsWith("*") &&
        !line.startsWith("*/")
      ) {
        break;
      }
    }

    // ── 2. Look backwards for consecutive // comment lines ─────────────────
    const commentLines: string[] = [];
    for (let i = startLine - 1; i >= Math.max(0, startLine - 10); i--) {
      const line = lines[i].trim();
      if (line.startsWith("//")) {
        commentLines.unshift(line.replace(/^\/\/\s?/, ""));
      } else if (line === "") {
        break; // blank line separates comment blocks
      } else {
        break;
      }
    }
    if (commentLines.length > 0) {
      const full = commentLines.join(" ").replace(/\s+/g, " ").trim();
      return full.length > 600 ? full.slice(0, 597) + "…" : full;
    }

    // ── 3. Trailing // comment on the declaration line itself ───────────────
    if (startLine < lines.length) {
      const declLine = lines[startLine];
      const trailingMatch = declLine.match(/\/\/\s*(.+)$/);
      if (trailingMatch) return trailingMatch[1].trim();
    }

    return undefined;
  }

  /**
   * Extract interface names from an implements clause on a class node.
   */
  private extractImplements(node: Parser.SyntaxNode): string[] {
    const result: string[] = [];
    for (const child of node.children) {
      // tree-sitter-typescript wraps "implements X, Y" in a class_heritage node
      const heritageNode =
        child.type === "implements_clause"
          ? child
          : child.type === "class_heritage"
            ? child
            : null;
      if (!heritageNode) continue;

      // Look for "implements" keyword, then collect type names after it
      let foundImplements = false;
      for (const hChild of heritageNode.children) {
        if (hChild.type === "implements_clause") {
          // Nested implements_clause inside class_heritage
          for (const tNode of hChild.children) {
            if (tNode.type === "type_identifier") {
              result.push(tNode.text);
            } else if (tNode.type === "generic_type") {
              const nameNode =
                tNode.childForFieldName("name") ??
                tNode.children.find((c) => c.type === "type_identifier");
              if (nameNode) result.push(nameNode.text);
            }
          }
          foundImplements = true;
        } else if (hChild.text === "implements") {
          foundImplements = true;
        } else if (foundImplements) {
          if (hChild.type === "type_identifier") {
            result.push(hChild.text);
          } else if (hChild.type === "generic_type") {
            const nameNode =
              hChild.childForFieldName("name") ??
              hChild.children.find((c) => c.type === "type_identifier");
            if (nameNode) result.push(nameNode.text);
          }
        }
      }
    }
    return result;
  }

  /**
   * Extract signature for display
   */
  private extractSignature(
    node: Parser.SyntaxNode,
    content: string,
  ): string | undefined {
    // Get first line of the declaration
    const startLine = node.startPosition.row;
    const lines = content.split("\n");

    if (startLine < lines.length) {
      const line = lines[startLine].trim();
      // Truncate at opening brace
      const braceIndex = line.indexOf("{");
      if (braceIndex > 0) {
        return line.substring(0, braceIndex).trim();
      }
      return line;
    }

    return undefined;
  }

  /**
   * Convert tree-sitter node to SourceRange
   */
  private nodeToRange(node: Parser.SyntaxNode): SourceRange {
    return {
      startLine: node.startPosition.row + 1, // Convert to 1-based
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      endColumn: node.endPosition.column,
    };
  }

  // ── Usage extraction (calls + property access chains) ───────────────────────

  /**
   * Traverse the entire AST to extract:
   * - call_expression nodes → symbol_calls
   * - member_expression chains of depth ≥ 3 → property_accesses
   */
  private extractUsages(
    root: Parser.SyntaxNode,
    filePath: string,
    calls: ExtractedCall[],
    propertyAccesses: ExtractedPropertyAccess[],
  ): void {
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === "call_expression") {
        this.extractCall(node, filePath, calls);
      }

      if (node.type === "member_expression") {
        // Only capture outermost member_expression in a chain (parent != member_expression)
        // to avoid redundant sub-chains (handled by building all prefixes below)
        if (node.parent?.type !== "member_expression") {
          this.extractPropertyAccessChain(node, filePath, propertyAccesses);
        }
      }

      for (const child of node.children) {
        visit(child);
      }
    };

    visit(root);
  }

  /**
   * Extract a call expression into ExtractedCall.
   */
  private extractCall(
    node: Parser.SyntaxNode,
    filePath: string,
    calls: ExtractedCall[],
  ): void {
    const calleeNode = node.childForFieldName("function");
    if (!calleeNode) return;

    const line = node.startPosition.row + 1;
    const callerName = this.findEnclosingSymbol(node);

    if (calleeNode.type === "identifier") {
      const name = calleeNode.text;
      if (!name || name.length === 0) return;
      calls.push({
        callerFile: filePath,
        callerName,
        callerLine: line,
        calleeName: name,
        calleeId: null,
        isMethod: false,
      });
    } else if (calleeNode.type === "member_expression") {
      const prop = calleeNode.childForFieldName("property");
      if (!prop) return;
      const chain = this.buildMemberChain(calleeNode);
      calls.push({
        callerFile: filePath,
        callerName,
        callerLine: line,
        calleeName: prop.text,
        calleeId: chain.includes("?") ? null : chain,
        isMethod: true,
      });
    }
  }

  /**
   * Given the outermost member_expression node in a chain, emit all
   * sub-chains of depth ≥ 3 so that rules like "**.source.path" find them.
   *
   * E.g. `a.b.c.d` → emits `a.b.c` (depth 3) and `a.b.c.d` (depth 4).
   */
  private extractPropertyAccessChain(
    outerNode: Parser.SyntaxNode,
    filePath: string,
    propertyAccesses: ExtractedPropertyAccess[],
  ): void {
    const line = outerNode.startPosition.row + 1;
    const symbolName = this.findEnclosingSymbol(outerNode);

    // Collect all prefix chains rooted at outerNode
    const chains = this.collectChainPrefixes(outerNode);
    for (const chain of chains) {
      const depth = (chain.match(/\./g) ?? []).length + 1;
      if (depth < 3) continue;
      if (depth > 12) continue; // guard against pathological deep chains
      const root = chain.split(".")[0];
      if (!root || root === "?") continue;
      propertyAccesses.push({
        file: filePath,
        symbolName,
        line,
        chain,
        root,
        depth,
      });
    }
  }

  /**
   * Recursively collect all prefix chains for a member_expression subtree.
   * Returns chains ordered from shortest to longest.
   *
   * For `a.b.c.d` returns ["a.b", "a.b.c", "a.b.c.d"].
   */
  private collectChainPrefixes(node: Parser.SyntaxNode): string[] {
    if (node.type !== "member_expression") {
      return [
        node.type === "identifier" || node.type === "this" ? node.text : "?",
      ];
    }
    const obj = node.childForFieldName("object");
    const prop = node.childForFieldName("property");
    if (!obj || !prop) return [];

    // Skip computed access (obj[expr])
    const hasBracket = node.children.some(
      (c) => c.type === "[" || c.type === "optional_chain",
    );
    if (hasBracket && !node.text.includes("?.")) {
      // Allow optional chaining but skip subscript computed access
      const objChains = this.collectChainPrefixes(obj);
      if (objChains.length === 0) return [];
      const base = objChains[objChains.length - 1];
      if (base === "?") return [];
      return objChains;
    }

    const objChains = this.collectChainPrefixes(obj);
    if (objChains.length === 0) return [];
    const base = objChains[objChains.length - 1];
    if (base === "?") return [];

    // Normalise optional chaining (?.) to regular dot for pattern matching
    const propText = prop.text;
    if (!propText) return objChains;

    const full = `${base}.${propText}`;
    return [...objChains, full];
  }

  /**
   * Build the full dotted chain string for a member_expression node.
   * Returns '?' for unresolvable roots (computed access, literals, etc.).
   */
  private buildMemberChain(node: Parser.SyntaxNode): string {
    if (node.type === "member_expression") {
      const obj = node.childForFieldName("object");
      const prop = node.childForFieldName("property");
      if (!obj || !prop) return "?";
      const base = this.buildMemberChain(obj);
      if (base === "?") return "?";
      return `${base}.${prop.text}`;
    }
    if (node.type === "identifier" || node.type === "this") {
      return node.text;
    }
    return "?";
  }

  /**
   * Walk up the parent chain to find the nearest enclosing function/method name.
   * Returns null for module-level code.
   */
  private findEnclosingSymbol(node: Parser.SyntaxNode): string | null {
    let current = node.parent;
    while (current) {
      if (
        current.type === "function_declaration" ||
        current.type === "method_definition" ||
        current.type === "generator_function_declaration"
      ) {
        return current.childForFieldName("name")?.text ?? null;
      }
      if (
        current.type === "arrow_function" ||
        current.type === "function_expression" ||
        current.type === "generator_function"
      ) {
        // Check if assigned to a variable: `const foo = () => ...`
        const parent = current.parent;
        if (parent?.type === "variable_declarator") {
          return parent.childForFieldName("name")?.text ?? null;
        }
        // Check if it's a method in an object literal: `{ foo: () => ... }`
        if (parent?.type === "pair") {
          return parent.childForFieldName("key")?.text ?? null;
        }
        return null;
      }
      current = current.parent;
    }
    return null;
  }
}

/**
 * Create an AST extractor instance
 */
export function createExtractor(
  workspaceRoot: string,
  options?: Partial<ExtractionOptions>,
): AstExtractor {
  return new AstExtractor(workspaceRoot, options);
}
