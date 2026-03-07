/**
 * @file AST Extractor
 * 
 * Tree-sitter based TypeScript/JavaScript AST extractor.
 * Lightweight, fast, focused on structural extraction for spec↔code traceability.
 */

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ExtractedSymbol,
  ExtractedImport,
  ExtractedExport,
  FileExtractionResult,
  ExtractionOptions,
  BatchExtractionResult,
  SymbolKind,
  ExportKind,
  SourceRange,
} from './types.js';

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
    options?: Partial<ExtractionOptions>
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
      const content = await fs.promises.readFile(absolutePath, 'utf-8');
      const tree = this.parser.parse(content);
      
      const symbols: ExtractedSymbol[] = [];
      const imports: ExtractedImport[] = [];
      const exports: ExtractedExport[] = [];
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
        0
      );
      
      // Check for parse errors
      if (tree.rootNode.hasError) {
        errors.push('Parse errors detected in file');
      }
      
      return {
        filePath: relativePath,
        language,
        symbols,
        imports,
        exports,
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
    options?: Partial<ExtractionOptions>
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
    language: 'typescript' | 'javascript' | 'tsx' | 'jsx',
    options?: Partial<ExtractionOptions>
  ): FileExtractionResult {
    const opts = { ...this.defaultOptions, ...options };
    this.setParserLanguage(language);
    
    const tree = this.parser.parse(content);
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
      0
    );
    
    return {
      filePath,
      language,
      symbols,
      imports,
      exports,
      extractedAt: Date.now(),
      errors: tree.rootNode.hasError ? ['Parse errors detected'] : undefined,
    };
  }

  /**
   * Set parser language based on detected language
   */
  private setParserLanguage(language: 'typescript' | 'javascript' | 'tsx' | 'jsx'): void {
    switch (language) {
      case 'typescript':
        this.parser.setLanguage(TypeScript.typescript);
        break;
      case 'tsx':
        this.parser.setLanguage(TypeScript.tsx);
        break;
      case 'javascript':
      case 'jsx':
        // Use TypeScript parser for JS (it handles JS syntax)
        this.parser.setLanguage(TypeScript.typescript);
        break;
    }
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): 'typescript' | 'javascript' | 'tsx' | 'jsx' {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.ts': return 'typescript';
      case '.tsx': return 'tsx';
      case '.jsx': return 'jsx';
      default: return 'javascript';
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
    depth: number
  ): void {
    if (depth > options.maxDepth) return;

    switch (node.type) {
      // Function declarations
      case 'function_declaration':
      case 'generator_function_declaration':
        this.extractFunction(node, content, filePath, symbols, options, parentName);
        break;

      // Class declarations
      case 'class_declaration':
        this.extractClass(node, content, filePath, symbols, options, depth);
        break;

      // Interface declarations (TypeScript)
      case 'interface_declaration':
        this.extractInterface(node, content, filePath, symbols, options, depth);
        break;

      // Type alias (TypeScript)
      case 'type_alias_declaration':
        this.extractTypeAlias(node, content, filePath, symbols, options);
        break;

      // Enum (TypeScript)
      case 'enum_declaration':
        this.extractEnum(node, content, filePath, symbols, options);
        break;

      // Variable declarations (may contain arrow functions)
      case 'lexical_declaration':
      case 'variable_declaration':
        this.extractVariables(node, content, filePath, symbols, options, parentName);
        break;

      // Import statements
      case 'import_statement':
        this.extractImport(node, content, imports);
        break;

      // Export statements
      case 'export_statement':
        this.extractExport(node, content, filePath, symbols, exports, options, depth);
        // Don't recurse into export_statement children - they're handled by extractExport
        return;

      // Module/namespace (TypeScript)
      case 'module':
        this.extractModule(node, content, filePath, symbols, options, depth);
        break;
    }

    // Recurse into children for top-level nodes
    if (depth === 0 || node.type === 'program' || node.type === 'statement_block') {
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
          depth
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
    parentName?: string
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isAsync = node.children.some(c => c.type === 'async');
    const params = this.extractParameters(node);
    const docSummary = options.includeDocSummary 
      ? this.extractDocComment(node, content) 
      : undefined;

    symbols.push({
      name,
      kind: 'function',
      filePath,
      range: this.nodeToRange(node),
      parent: parentName,
      isExported: false, // Will be updated by export handling
      isAsync,
      docSummary,
      parameters: options.includeParameters ? params : undefined,
      signature: this.extractSignature(node, content),
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
    depth: number
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const docSummary = options.includeDocSummary 
      ? this.extractDocComment(node, content) 
      : undefined;

    symbols.push({
      name,
      kind: 'class',
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary,
      signature: `class ${name}`,
    });

    // Extract class members
    if (options.includeMembers && depth < options.maxDepth) {
      const body = node.childForFieldName('body');
      if (body) {
        this.extractClassMembers(body, content, filePath, symbols, options, name);
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
    className: string
  ): void {
    for (const child of body.children) {
      switch (child.type) {
        case 'method_definition': {
          const nameNode = child.childForFieldName('name');
          if (!nameNode) continue;

          const name = nameNode.text;
          const isConstructor = name === 'constructor';
          const isStatic = child.children.some(c => c.type === 'static');
          const isGetter = child.children.some(c => c.text === 'get');
          const isSetter = child.children.some(c => c.text === 'set');
          const isAsync = child.children.some(c => c.type === 'async');
          const visibility = this.extractVisibility(child);

          if (!options.includePrivate && visibility === 'private') continue;

          const kind: SymbolKind = isConstructor ? 'constructor' 
            : isGetter ? 'getter'
            : isSetter ? 'setter'
            : 'method';

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
            parameters: options.includeParameters ? this.extractParameters(child) : undefined,
            docSummary: options.includeDocSummary ? this.extractDocComment(child, content) : undefined,
          });
          break;
        }

        case 'public_field_definition':
        case 'field_definition': {
          const nameNode = child.childForFieldName('name');
          if (!nameNode) continue;

          const name = nameNode.text;
          const isStatic = child.children.some(c => c.type === 'static');
          const visibility = this.extractVisibility(child);

          if (!options.includePrivate && visibility === 'private') continue;

          symbols.push({
            name,
            kind: 'property',
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
    depth: number
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const docSummary = options.includeDocSummary 
      ? this.extractDocComment(node, content) 
      : undefined;

    symbols.push({
      name,
      kind: 'interface',
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary,
      signature: `interface ${name}`,
    });

    // Extract interface members
    if (options.includeMembers && depth < options.maxDepth) {
      const body = node.childForFieldName('body');
      if (body) {
        this.extractInterfaceMembers(body, content, filePath, symbols, options, name);
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
    interfaceName: string
  ): void {
    for (const child of body.children) {
      switch (child.type) {
        case 'method_signature': {
          const nameNode = child.childForFieldName('name');
          if (!nameNode) continue;

          symbols.push({
            name: nameNode.text,
            kind: 'method',
            filePath,
            range: this.nodeToRange(child),
            parent: interfaceName,
            isExported: false,
            parameters: options.includeParameters ? this.extractParameters(child) : undefined,
          });
          break;
        }

        case 'property_signature': {
          const nameNode = child.childForFieldName('name');
          if (!nameNode) continue;

          symbols.push({
            name: nameNode.text,
            kind: 'property',
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
    options: Required<ExtractionOptions>
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'type',
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary: options.includeDocSummary ? this.extractDocComment(node, content) : undefined,
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
    options: Required<ExtractionOptions>
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    symbols.push({
      name: nameNode.text,
      kind: 'enum',
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary: options.includeDocSummary ? this.extractDocComment(node, content) : undefined,
    });
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
    parentName?: string
  ): void {
    const declarators = node.descendantsOfType('variable_declarator');
    
    for (const declarator of declarators) {
      const nameNode = declarator.childForFieldName('name');
      const valueNode = declarator.childForFieldName('value');
      
      if (!nameNode) continue;
      
      const name = nameNode.text;
      let kind: SymbolKind = 'variable';
      let isAsync = false;
      let params: string[] | undefined;
      
      // Check if it's an arrow function or function expression
      if (valueNode) {
        if (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression') {
          kind = 'function';
          isAsync = valueNode.children.some(c => c.type === 'async');
          params = options.includeParameters ? this.extractParameters(valueNode) : undefined;
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
        docSummary: options.includeDocSummary ? this.extractDocComment(node, content) : undefined,
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
    depth: number
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text.replace(/['"]/g, '');

    symbols.push({
      name,
      kind: 'namespace',
      filePath,
      range: this.nodeToRange(node),
      isExported: false,
      docSummary: options.includeDocSummary ? this.extractDocComment(node, content) : undefined,
    });
  }

  /**
   * Extract import statement
   */
  private extractImport(
    node: Parser.SyntaxNode,
    content: string,
    imports: ExtractedImport[]
  ): void {
    const sourceNode = node.childForFieldName('source');
    if (!sourceNode) return;

    const moduleSpecifier = sourceNode.text.replace(/['"]/g, '');
    const isRelative = moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/');
    
    const importItems: ExtractedImport['imports'] = [];
    
    // Find import clause
    const importClause = node.children.find(c => c.type === 'import_clause');
    if (importClause) {
      for (const child of importClause.children) {
        switch (child.type) {
          case 'identifier':
            // Default import
            importItems.push({ name: child.text, isDefault: true });
            break;
            
          case 'namespace_import': {
            const nsName = child.children.find(c => c.type === 'identifier');
            if (nsName) {
              importItems.push({ name: nsName.text, isNamespace: true });
            }
            break;
          }
          
          case 'named_imports':
            for (const specifier of child.descendantsOfType('import_specifier')) {
              const nameNode = specifier.childForFieldName('name');
              const aliasNode = specifier.childForFieldName('alias');
              
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
    depth: number
  ): void {
    const isDefault = node.children.some(c => c.text === 'default');
    const sourceNode = node.childForFieldName('source');
    
    // Handle declaration exports (export function, export class, etc.)
    const declaration = node.childForFieldName('declaration');
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
        depth + 1
      );
      
      // Mark newly added symbols as exported
      for (let i = startLength; i < symbols.length; i++) {
        symbols[i].isExported = true;
        symbols[i].exportKind = isDefault ? 'default' : 'declaration';
      }
      return;
    }

    // Handle export clause (export { x, y })
    const exportClause = node.children.find(c => c.type === 'export_clause');
    if (exportClause) {
      const sourceModule = sourceNode?.text.replace(/['"]/g, '');
      const kind: ExportKind = sourceModule ? 're-export' : 'named';
      
      for (const specifier of exportClause.descendantsOfType('export_specifier')) {
        const nameNode = specifier.childForFieldName('name');
        const aliasNode = specifier.childForFieldName('alias');
        
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
      const valueNode = node.childForFieldName('value');
      if (valueNode && valueNode.type === 'identifier') {
        exports.push({
          name: 'default',
          localName: valueNode.text,
          kind: 'default',
          range: this.nodeToRange(node),
        });
      }
    }
  }

  /**
   * Extract function/method parameters
   */
  private extractParameters(node: Parser.SyntaxNode): string[] {
    const params = node.childForFieldName('parameters');
    if (!params) return [];

    const result: string[] = [];
    
    for (const child of params.children) {
      if (child.type === 'required_parameter' || 
          child.type === 'optional_parameter' ||
          child.type === 'rest_pattern') {
        const pattern = child.childForFieldName('pattern');
        if (pattern) {
          result.push(pattern.text);
        }
      } else if (child.type === 'identifier') {
        result.push(child.text);
      }
    }
    
    return result;
  }

  /**
   * Extract visibility modifier from class member
   */
  private extractVisibility(node: Parser.SyntaxNode): 'public' | 'private' | 'protected' | undefined {
    for (const child of node.children) {
      if (child.type === 'accessibility_modifier') {
        const text = child.text;
        if (text === 'private' || text === 'protected' || text === 'public') {
          return text;
        }
      }
    }
    // Check for # prefix (ES private field)
    const nameNode = node.childForFieldName('name');
    if (nameNode?.text.startsWith('#')) {
      return 'private';
    }
    return undefined;
  }

  /**
   * Extract JSDoc comment from preceding node
   */
  private extractDocComment(node: Parser.SyntaxNode, content: string): string | undefined {
    // Look for comment immediately before this node
    const startLine = node.startPosition.row;
    const lines = content.split('\n');
    
    // Look backwards for JSDoc
    for (let i = startLine - 1; i >= Math.max(0, startLine - 5); i--) {
      const line = lines[i].trim();
      if (line.startsWith('/**')) {
        // Found start of JSDoc, extract first meaningful line
        for (let j = i; j < startLine; j++) {
          const docLine = lines[j].trim();
          // Skip /** and */ and @param etc
          if (docLine.startsWith('/**') || 
              docLine.startsWith('*/') || 
              docLine.startsWith('* @') ||
              docLine === '*') {
            continue;
          }
          // Found content line
          const match = docLine.match(/^\*\s*(.+)/);
          if (match) {
            return match[1].trim();
          }
        }
        break;
      }
      // Stop if we hit non-comment, non-whitespace
      if (line && !line.startsWith('//') && !line.startsWith('*')) {
        break;
      }
    }
    
    return undefined;
  }

  /**
   * Extract signature for display
   */
  private extractSignature(node: Parser.SyntaxNode, content: string): string | undefined {
    // Get first line of the declaration
    const startLine = node.startPosition.row;
    const lines = content.split('\n');
    
    if (startLine < lines.length) {
      const line = lines[startLine].trim();
      // Truncate at opening brace
      const braceIndex = line.indexOf('{');
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
}

/**
 * Create an AST extractor instance
 */
export function createExtractor(
  workspaceRoot: string,
  options?: Partial<ExtractionOptions>
): AstExtractor {
  return new AstExtractor(workspaceRoot, options);
}
