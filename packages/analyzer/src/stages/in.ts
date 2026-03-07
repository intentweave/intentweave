/**
 * IN Stage - Ingestion
 * 
 * Per-artifact stage that parses input files and creates semantic chunks.
 * 
 * Input: Raw file content
 * Output: in.json (semantic chunks with provenance)
 * 
 * Responsibilities:
 * - Parse input file (markdown, yaml, etc.)
 * - Split into semantic chunks (sections, blocks) with line/char spans
 * - Track source provenance (file path, line ranges)
 * - Output chunks ready for RX batching
 */

import type { PipelineContext } from '../pipeline/context.js';
import { inferArtifactRole } from '../profiles/loader.js';

// =============================================================================
// IN Stage Types (Local definitions for Phase 2)
// =============================================================================

/**
 * Parsed table structure for structured extraction
 */
export interface ParsedTable {
  /** Table headers */
  headers: string[];
  /** Table rows (array of cell values) */
  rows: string[][];
  /** Optional caption/title if detected */
  caption?: string;
}

/**
 * Semantic chunk from input file
 */
export interface SemanticChunk {
  /** Chunk identifier */
  id: string;
  /** Chunk content */
  content: string;
  /** Chunk type (section, block, paragraph, code, heading, list, table, other) */
  type: 'section' | 'block' | 'paragraph' | 'code' | 'heading' | 'list' | 'table' | 'other';
  /** Heading level (if applicable) */
  headingLevel?: number;
  /** Section title (if section type) */
  title?: string;
  /** Start line in source (1-based) */
  startLine: number;
  /** End line in source (1-based) */
  endLine: number;
  /** Start character offset */
  startChar?: number;
  /** End character offset */
  endChar?: number;
  /** Parent chunk ID (for hierarchical structure) */
  parentId?: string;
  /** Parsed table data (if type is table) */
  tableData?: ParsedTable;
}

/**
 * IN Stage Output
 */
export interface InStageOutput {
  $schema: string;
  schemaVersion: string;
  stage: 'IN';
  artifactId: string;
  filePath: string;
  artifactFormat: string;
  artifactRole?: string;
  chunks: SemanticChunk[];
  meta: {
    chunkCount: number;
    totalLines: number;
    totalChars: number;
    processingTimeMs: number;
  };
}

/**
 * IN Stage Input
 */
export interface InStageInput {
  /** Artifact ID */
  artifactId: string;
  /** Source file path */
  filePath: string;
  /** Raw file content */
  content: string;
  /** Optional artifact format override */
  artifactFormat?: string;
  /** Optional artifact role override */
  artifactRole?: string;
}

/**
 * IN Stage Options
 */
export interface InStageOptions {
  /** Maximum chunk size in characters (for very large files) */
  maxChunkSize?: number;
  /** Minimum chunk size (avoid tiny chunks) */
  minChunkSize?: number;
  /** Whether to include code blocks as separate chunks */
  splitCodeBlocks?: boolean;
}

const DEFAULT_OPTIONS: Required<InStageOptions> = {
  maxChunkSize: 16000, // 16k chars (~4k tokens) - optimal based on chunk size experiment
  minChunkSize: 50,
  splitCodeBlocks: true,
};

// =============================================================================
// Artifact Format Detection
// =============================================================================

/**
 * Detect artifact format from file extension
 */
export function detectArtifactFormat(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  
  const formatMap: Record<string, string> = {
    md: 'markdown',
    markdown: 'markdown',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    py: 'python',
    sql: 'sql',
    cypher: 'cypher',
  };
  
  return formatMap[ext] ?? 'unknown';
}

/**
 * Detect artifact role from filename or content patterns.
 * 
 * Returns WX-compatible artifact roles:
 * 'intent' | 'spec' | 'implementation' | 'test' | 'config' | 'unknown'
 */
export function detectArtifactRole(filePath: string, content: string): string {
  const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
  const nameWithoutExt = basename.replace(/\.[^.]+$/, '');
  
  // Exact filename matches (highest priority)
  // Maps to WX-compatible roles: intent, spec, implementation, test, config, unknown
  const roleMap: Record<string, string> = {
    // Intent documents
    'prompt': 'intent',
    'intent': 'intent',
    'requirements': 'intent',
    'goal': 'intent',
    'objectives': 'intent',
    
    // Specification documents
    'spec': 'spec',
    'specification': 'spec',
    'design': 'spec',
    'architecture': 'spec',
    'readme': 'spec',  // READMEs often describe specifications
    'documentation': 'spec',
    
    // Implementation
    'impl': 'implementation',
    'implementation': 'implementation',
    'code': 'implementation',
    'source': 'implementation',
    
    // Test
    'test': 'test',
    'tests': 'test',
    'validation': 'test',
    
    // Config
    'config': 'config',
    'configuration': 'config',
    'settings': 'config',
  };
  
  if (roleMap[nameWithoutExt]) {
    return roleMap[nameWithoutExt];
  }
  
  // Pattern matching in filename
  if (/-prompt\b|\bprompt-/.test(basename)) return 'intent';
  if (/-intent\b|\bintent-/.test(basename)) return 'intent';
  if (/-requirements?\b|\brequirements?-/.test(basename)) return 'intent'; // requirements = intent
  if (/-spec\b|\bspec-/.test(basename)) return 'spec';
  if (/-impl\b|\bimpl-/.test(basename)) return 'implementation';
  if (/-test\b|\btest-/.test(basename)) return 'test';
  if (/-config\b|\bconfig-/.test(basename)) return 'config';
  
  // Content-based heuristics for markdown files
  if (filePath.endsWith('.md')) {
    const firstLines = content.split('\n').slice(0, 20).join('\n').toLowerCase();
    
    if (/^#.*\b(intent|goal|objective|prompt|requirements?)\b/im.test(firstLines)) {
      return 'intent';
    }
    if (/^#.*\b(spec|specification|design|architecture)\b/im.test(firstLines)) {
      return 'spec';
    }
    if (/^#.*\b(implementation|code|solution)\b/im.test(firstLines)) {
      return 'implementation';
    }
    if (/^#.*\b(test|testing|validation)\b/im.test(firstLines)) {
      return 'test';
    }
  }
  
  return 'unknown';
}

/**
 * Normalize any artifact role string to WX-compatible roles.
 * This ensures roles from external sources (like input.artifactRole)
 * are mapped to valid WX roles.
 * 
 * Valid WX roles: 'intent' | 'spec' | 'implementation' | 'test' | 'config' | 'unknown'
 */
export function normalizeArtifactRole(role: string | undefined | null): string {
  if (!role) return 'unknown';
  
  const normalized = role.toLowerCase().trim();
  
  const roleMapping: Record<string, string> = {
    // Intent variants
    'intent': 'intent',
    'prompt': 'intent',
    'requirements': 'intent',
    'goal': 'intent',
    'objectives': 'intent',
    
    // Spec variants
    'spec': 'spec',
    'specification': 'spec',
    'design': 'spec',
    'architecture': 'spec',
    'readme': 'spec',
    'documentation': 'spec',
    'docs': 'spec',
    
    // Implementation variants
    'implementation': 'implementation',
    'impl': 'implementation',
    'code': 'implementation',
    'source': 'implementation',
    
    // Test variants
    'test': 'test',
    'tests': 'test',
    'testing': 'test',
    'validation': 'test',
    'verification': 'test',
    
    // Config variants  
    'config': 'config',
    'configuration': 'config',
    'settings': 'config',
    
    // Already valid
    'unknown': 'unknown',
  };
  
  return roleMapping[normalized] ?? 'unknown';
}

// =============================================================================
// Markdown Chunking
// =============================================================================

interface ChunkBuilder {
  chunks: SemanticChunk[];
  currentChunk: Partial<SemanticChunk> | null;
  lineNumber: number;
  charOffset: number;
  chunkIndex: number;
  headingStack: Array<{ level: number; id: string }>;
}

/**
 * Parse markdown content into semantic chunks
 */
function parseMarkdown(
  content: string, 
  artifactId: string,
  options: Required<InStageOptions>
): SemanticChunk[] {
  const lines = content.split('\n');
  const builder: ChunkBuilder = {
    chunks: [],
    currentChunk: null,
    lineNumber: 1,
    charOffset: 0,
    chunkIndex: 0,
    headingStack: [],
  };
  
  let inCodeBlock = false;
  let codeBlockStart = 0;
  let codeBlockContent: string[] = [];
  
  // Table tracking
  let inTable = false;
  let tableStart = 0;
  let tableLines: string[] = [];
  let tableCaption: string | undefined = undefined;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = builder.charOffset;
    
    // Check for code block delimiters
    if (line.startsWith('```')) {
      // Flush any pending table
      if (inTable) {
        const tableChunk = createTableChunk(
          builder,
          artifactId,
          tableLines,
          tableStart,
          builder.lineNumber - 1,
          tableCaption
        );
        if (tableChunk) {
          builder.chunks.push(tableChunk);
          builder.chunkIndex++;
        }
        inTable = false;
        tableLines = [];
        tableCaption = undefined;
      }
      
      if (!inCodeBlock) {
        // Start of code block
        flushCurrentChunk(builder, artifactId);
        inCodeBlock = true;
        codeBlockStart = builder.lineNumber;
        codeBlockContent = [line];
      } else {
        // End of code block
        codeBlockContent.push(line);
        if (options.splitCodeBlocks) {
          const codeChunk = createCodeChunk(
            builder,
            artifactId,
            codeBlockContent.join('\n'),
            codeBlockStart,
            builder.lineNumber
          );
          builder.chunks.push(codeChunk);
          builder.chunkIndex++;
        }
        inCodeBlock = false;
        codeBlockContent = [];
      }
    } else if (inCodeBlock) {
      codeBlockContent.push(line);
    } else if (isTableLine(line)) {
      // Table row detection
      if (!inTable) {
        // Starting a new table
        flushCurrentChunk(builder, artifactId);
        inTable = true;
        tableStart = builder.lineNumber;
        tableLines = [line];
        // Check if previous chunk was a heading that might be the table caption
        const prevChunk = builder.chunks[builder.chunks.length - 1];
        if (prevChunk && prevChunk.type === 'section' && prevChunk.title) {
          tableCaption = prevChunk.title;
        }
      } else {
        tableLines.push(line);
      }
    } else if (inTable) {
      // Line is not a table row, so table has ended
      const tableChunk = createTableChunk(
        builder,
        artifactId,
        tableLines,
        tableStart,
        builder.lineNumber - 1,
        tableCaption
      );
      if (tableChunk) {
        builder.chunks.push(tableChunk);
        builder.chunkIndex++;
      }
      inTable = false;
      tableLines = [];
      tableCaption = undefined;
      
      // Process this line normally (fallthrough to other cases)
      // Re-evaluate this line in the context below
      if (line.startsWith('#')) {
        // Heading
        const headingMatch = line.match(/^(#+)\s*(.*)$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const title = headingMatch[2].trim();
          
          while (
            builder.headingStack.length > 0 && 
            builder.headingStack[builder.headingStack.length - 1].level >= level
          ) {
            builder.headingStack.pop();
          }
          
          const chunkId = `${artifactId}-chunk-${builder.chunkIndex}`;
          builder.headingStack.push({ level, id: chunkId });
          
          builder.currentChunk = {
            id: chunkId,
            type: 'section',
            title,
            headingLevel: level,
            content: line,
            startLine: builder.lineNumber,
            startChar: lineStart,
            parentId: builder.headingStack.length > 1 
              ? builder.headingStack[builder.headingStack.length - 2].id 
              : undefined,
          };
        }
      } else if (line.trim() === '') {
        // Empty line - ignore after table
      } else if (line.startsWith('- ') || line.startsWith('* ') || line.match(/^\d+\.\s/)) {
        // List item
        builder.currentChunk = {
          id: `${artifactId}-chunk-${builder.chunkIndex}`,
          type: 'list',
          content: line,
          startLine: builder.lineNumber,
          startChar: lineStart,
          parentId: builder.headingStack.length > 0 
            ? builder.headingStack[builder.headingStack.length - 1].id 
            : undefined,
        };
      } else {
        // Regular text
        builder.currentChunk = {
          id: `${artifactId}-chunk-${builder.chunkIndex}`,
          type: 'paragraph',
          content: line,
          startLine: builder.lineNumber,
          startChar: lineStart,
          parentId: builder.headingStack.length > 0 
            ? builder.headingStack[builder.headingStack.length - 1].id 
            : undefined,
        };
      }
    } else if (line.startsWith('#')) {
      // Heading - start new section
      flushCurrentChunk(builder, artifactId);
      
      const headingMatch = line.match(/^(#+)\s*(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();
        
        // Update heading stack
        while (
          builder.headingStack.length > 0 && 
          builder.headingStack[builder.headingStack.length - 1].level >= level
        ) {
          builder.headingStack.pop();
        }
        
        const chunkId = `${artifactId}-chunk-${builder.chunkIndex}`;
        builder.headingStack.push({ level, id: chunkId });
        
        builder.currentChunk = {
          id: chunkId,
          type: 'section',
          title,
          headingLevel: level,
          content: line,
          startLine: builder.lineNumber,
          startChar: lineStart,
          parentId: builder.headingStack.length > 1 
            ? builder.headingStack[builder.headingStack.length - 2].id 
            : undefined,
        };
      }
    } else if (line.trim() === '') {
      // Empty line - might end current paragraph
      if (builder.currentChunk && builder.currentChunk.type === 'paragraph') {
        flushCurrentChunk(builder, artifactId);
      } else if (builder.currentChunk) {
        builder.currentChunk.content += '\n' + line;
      }
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.match(/^\d+\.\s/)) {
      // List item
      if (!builder.currentChunk || builder.currentChunk.type !== 'list') {
        flushCurrentChunk(builder, artifactId);
        builder.currentChunk = {
          id: `${artifactId}-chunk-${builder.chunkIndex}`,
          type: 'list',
          content: line,
          startLine: builder.lineNumber,
          startChar: lineStart,
          parentId: builder.headingStack.length > 0 
            ? builder.headingStack[builder.headingStack.length - 1].id 
            : undefined,
        };
      } else {
        builder.currentChunk.content += '\n' + line;
      }
    } else {
      // Regular text - add to current chunk or start new paragraph
      if (!builder.currentChunk) {
        builder.currentChunk = {
          id: `${artifactId}-chunk-${builder.chunkIndex}`,
          type: 'paragraph',
          content: line,
          startLine: builder.lineNumber,
          startChar: lineStart,
          parentId: builder.headingStack.length > 0 
            ? builder.headingStack[builder.headingStack.length - 1].id 
            : undefined,
        };
      } else {
        builder.currentChunk.content += '\n' + line;
      }
    }
    
    builder.lineNumber++;
    builder.charOffset += line.length + 1; // +1 for newline
  }
  
  // Flush remaining table
  if (inTable && tableLines.length > 0) {
    const tableChunk = createTableChunk(
      builder,
      artifactId,
      tableLines,
      tableStart,
      builder.lineNumber - 1,
      tableCaption
    );
    if (tableChunk) {
      builder.chunks.push(tableChunk);
      builder.chunkIndex++;
    }
  }
  
  // Flush remaining chunk
  flushCurrentChunk(builder, artifactId);
  
  // If code block was never closed
  if (inCodeBlock && codeBlockContent.length > 0) {
    const codeChunk = createCodeChunk(
      builder,
      artifactId,
      codeBlockContent.join('\n'),
      codeBlockStart,
      builder.lineNumber - 1
    );
    builder.chunks.push(codeChunk);
  }
  
  // Filter out tiny chunks
  return builder.chunks.filter(
    chunk => chunk.content.length >= options.minChunkSize
  );
}

function flushCurrentChunk(builder: ChunkBuilder, artifactId: string): void {
  if (builder.currentChunk && builder.currentChunk.content) {
    const chunk: SemanticChunk = {
      id: builder.currentChunk.id ?? `${artifactId}-chunk-${builder.chunkIndex}`,
      content: builder.currentChunk.content,
      type: builder.currentChunk.type ?? 'other',
      title: builder.currentChunk.title,
      headingLevel: builder.currentChunk.headingLevel,
      startLine: builder.currentChunk.startLine ?? 1,
      endLine: builder.lineNumber - 1,
      startChar: builder.currentChunk.startChar,
      endChar: builder.charOffset - 1,
      parentId: builder.currentChunk.parentId,
    };
    
    builder.chunks.push(chunk);
    builder.chunkIndex++;
    builder.currentChunk = null;
  }
}

function createCodeChunk(
  builder: ChunkBuilder,
  artifactId: string,
  content: string,
  startLine: number,
  endLine: number
): SemanticChunk {
  return {
    id: `${artifactId}-chunk-${builder.chunkIndex}`,
    content,
    type: 'code',
    startLine,
    endLine,
  };
}

// =============================================================================
// Table Parsing
// =============================================================================

/**
 * Check if a line is a table row (starts with | or is a separator line)
 */
function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') || /^\|?[\s:]*-{3,}[\s:|]*-/.test(trimmed);
}

/**
 * Check if a line is a table separator (|---|---|)
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  // Match patterns like: |---|---|, |:---|:--:|, --- | --- |, etc.
  return /^\|?[\s]*:?-{3,}:?[\s]*\|/.test(trimmed) || 
         /^[\s]*:?-{3,}:?[\s]*\|[\s]*:?-{3,}:?/.test(trimmed);
}

/**
 * Parse a table row into cells
 */
function parseTableRow(line: string): string[] {
  // Remove leading/trailing pipes and split by |
  const trimmed = line.trim();
  const withoutLeadingPipe = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailingPipe = withoutLeadingPipe.endsWith('|') 
    ? withoutLeadingPipe.slice(0, -1) 
    : withoutLeadingPipe;
  
  return withoutTrailingPipe.split('|').map(cell => cell.trim());
}

/**
 * Parse markdown table lines into structured data
 */
function parseTableContent(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null;
  
  // Find separator line to identify header
  const separatorIdx = lines.findIndex(isTableSeparator);
  if (separatorIdx < 1) {
    // No separator found, or separator is first line - not a valid table
    return null;
  }
  
  // Header is the line before separator
  const headerLine = lines[separatorIdx - 1];
  const headers = parseTableRow(headerLine);
  
  if (headers.length < 1) return null;
  
  // Data rows are all lines after separator
  const dataLines = lines.slice(separatorIdx + 1);
  const rows: string[][] = [];
  
  for (const line of dataLines) {
    if (!isTableLine(line) || isTableSeparator(line)) continue;
    const cells = parseTableRow(line);
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  
  return { headers, rows };
}

/**
 * Convert parsed table to a JSON-structured summary for LLM context
 * This enriches the chunk content with structured data that's easier
 * for LLMs to extract relationships from.
 */
function tableToStructuredSummary(table: ParsedTable, caption?: string): string {
  const lines: string[] = [];
  lines.push('\n<!-- [STRUCTURED_TABLE_DATA] -->');
  if (caption) {
    lines.push(`Table: ${caption}`);
  }
  lines.push('```json');
  
  // Convert table to array of objects
  const structured = table.rows.map(row => {
    const obj: Record<string, string> = {};
    table.headers.forEach((header, i) => {
      obj[header] = row[i] ?? '';
    });
    return obj;
  });
  
  lines.push(JSON.stringify(structured, null, 2));
  lines.push('```');
  lines.push('<!-- [/STRUCTURED_TABLE_DATA] -->');
  
  return lines.join('\n');
}

/**
 * Create a table chunk with enriched content
 */
function createTableChunk(
  builder: ChunkBuilder,
  artifactId: string,
  tableLines: string[],
  startLine: number,
  endLine: number,
  caption?: string
): SemanticChunk | null {
  const originalContent = tableLines.join('\n');
  const parsedTable = parseTableContent(tableLines);
  
  if (!parsedTable || parsedTable.headers.length === 0) {
    // Not a valid table, return as regular content
    return null;
  }
  
  // Enrich content with structured summary
  const structuredSummary = tableToStructuredSummary(parsedTable, caption);
  const enrichedContent = originalContent + structuredSummary;
  
  return {
    id: `${artifactId}-chunk-${builder.chunkIndex}`,
    content: enrichedContent,
    type: 'table',
    title: caption,
    startLine,
    endLine,
    tableData: parsedTable,
    parentId: builder.headingStack.length > 0 
      ? builder.headingStack[builder.headingStack.length - 1].id 
      : undefined,
  };
}

// =============================================================================
// Generic Text Chunking (for non-markdown files)
// =============================================================================

/**
 * Simple chunking for non-markdown files
 * Chunks by double newlines or by size
 */
function parseGenericText(
  content: string,
  artifactId: string,
  options: Required<InStageOptions>
): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  const blocks = content.split(/\n\n+/);
  
  let lineNumber = 1;
  let charOffset = 0;
  let chunkIndex = 0;
  
  for (const block of blocks) {
    if (block.trim().length < options.minChunkSize) {
      charOffset += block.length + 2; // +2 for \n\n
      lineNumber += (block.match(/\n/g) || []).length + 2;
      continue;
    }
    
    // Split large blocks
    if (block.length > options.maxChunkSize) {
      const subChunks = splitLargeBlock(block, options.maxChunkSize);
      let subOffset = 0;
      
      for (const subBlock of subChunks) {
        const subLines = (subBlock.match(/\n/g) || []).length;
        chunks.push({
          id: `${artifactId}-chunk-${chunkIndex}`,
          content: subBlock,
          type: 'block',
          startLine: lineNumber + (content.slice(charOffset, charOffset + subOffset).match(/\n/g) || []).length,
          endLine: lineNumber + (content.slice(charOffset, charOffset + subOffset + subBlock.length).match(/\n/g) || []).length,
          startChar: charOffset + subOffset,
          endChar: charOffset + subOffset + subBlock.length,
        });
        chunkIndex++;
        subOffset += subBlock.length;
      }
    } else {
      const blockLines = (block.match(/\n/g) || []).length;
      chunks.push({
        id: `${artifactId}-chunk-${chunkIndex}`,
        content: block,
        type: 'block',
        startLine: lineNumber,
        endLine: lineNumber + blockLines,
        startChar: charOffset,
        endChar: charOffset + block.length,
      });
      chunkIndex++;
    }
    
    charOffset += block.length + 2;
    lineNumber += (block.match(/\n/g) || []).length + 2;
  }
  
  return chunks;
}

function splitLargeBlock(block: string, maxSize: number): string[] {
  const chunks: string[] = [];
  let remaining = block;
  
  while (remaining.length > maxSize) {
    // Try to split at a sentence boundary
    let splitPoint = remaining.lastIndexOf('. ', maxSize);
    if (splitPoint === -1 || splitPoint < maxSize / 2) {
      // Try newline
      splitPoint = remaining.lastIndexOf('\n', maxSize);
    }
    if (splitPoint === -1 || splitPoint < maxSize / 2) {
      // Force split at space
      splitPoint = remaining.lastIndexOf(' ', maxSize);
    }
    if (splitPoint === -1) {
      // Hard split
      splitPoint = maxSize;
    }
    
    chunks.push(remaining.slice(0, splitPoint + 1).trim());
    remaining = remaining.slice(splitPoint + 1).trim();
  }
  
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  
  return chunks;
}

// =============================================================================
// Transcript Parsing (Per-Message Chunks)
// =============================================================================

/**
 * Parse transcript content into per-message chunks.
 * Each message becomes a separate chunk with ID based on sequence number.
 * This enables per-message RX caching for incremental processing.
 * 
 * Input format (from discoverTranscriptArtifacts):
 *   [speaker/role] text
 *   ---
 *   [speaker/role] text
 *   ---
 *   ...
 */
function parseTranscript(
  content: string,
  artifactId: string,
  _options: Required<InStageOptions>
): SemanticChunk[] {
  const chunks: SemanticChunk[] = [];
  
  // Split by unique message separator (matches registry.ts)
  const MESSAGE_SEPARATOR = '\n\n<<<IW_MSG_SEP>>>\n\n';
  const messages = content.split(MESSAGE_SEPARATOR);
  
  let lineNumber = 1;
  let charOffset = 0;
  
  for (let seq = 0; seq < messages.length; seq++) {
    const message = messages[seq];
    if (!message.trim()) continue;
    
    const messageLines = (message.match(/\n/g) || []).length + 1;
    
    // Extract speaker/role from header like [user/intent] or [assistant/spec]
    const headerMatch = message.match(/^\[([^/]+)\/([^\]]+)\]/);
    const speaker = headerMatch?.[1] ?? 'unknown';
    const role = headerMatch?.[2] ?? 'unknown';
    
    // Chunk ID is based on artifact ID and sequence number
    // This provides stable identity for per-message caching
    const chunkId = `${artifactId}:m:${seq}`;
    
    chunks.push({
      id: chunkId,
      content: message,
      type: 'block',
      title: `[${speaker}/${role}]`,  // Store speaker/role for filtering
      startLine: lineNumber,
      endLine: lineNumber + messageLines - 1,
      startChar: charOffset,
      endChar: charOffset + message.length,
    });
    
    // Account for message + separator
    // Separator: '\n\n<<<IW_MSG_SEP>>>\n\n' = 21 chars, 4 lines
    charOffset += message.length + MESSAGE_SEPARATOR.length;
    lineNumber += messageLines + 4; // 4 lines for separator
  }
  
  return chunks;
}

// =============================================================================
// IN Stage Entry Point
// =============================================================================

/**
 * Run IN stage on an artifact
 */
export async function runInStage(
  input: InStageInput,
  ctx: PipelineContext,
  options: InStageOptions = {}
): Promise<InStageOutput> {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  const { artifactId, filePath, content } = input;
  
  // Detect format and role
  const artifactFormat = input.artifactFormat ?? detectArtifactFormat(filePath);
  const detectedRole = input.artifactRole ?? detectArtifactRole(filePath, content);
  // Normalize to WX-compatible roles
  const artifactRole = normalizeArtifactRole(detectedRole);
  
  // Parse content into chunks
  let chunks: SemanticChunk[];
  
  if (artifactFormat === 'transcript') {
    // Per-message chunks for chat transcripts (enables per-message caching)
    chunks = parseTranscript(content, artifactId, opts);
  } else if (artifactFormat === 'markdown') {
    chunks = parseMarkdown(content, artifactId, opts);
  } else {
    chunks = parseGenericText(content, artifactId, opts);
  }
  
  // Calculate line/char counts
  const totalLines = (content.match(/\n/g) || []).length + 1;
  const totalChars = content.length;
  
  const processingTimeMs = Date.now() - startTime;
  
  const output: InStageOutput = {
    $schema: 'intentweave://schemas/in-graph/v1',
    schemaVersion: '0.1',
    stage: 'IN',
    artifactId,
    filePath,
    artifactFormat,
    artifactRole,
    chunks,
    meta: {
      chunkCount: chunks.length,
      totalLines,
      totalChars,
      processingTimeMs,
    },
  };
  
  ctx.logger.debug(`IN stage complete for ${artifactId}`, {
    chunks: chunks.length,
    lines: totalLines,
    format: artifactFormat,
    role: artifactRole,
  });
  
  return output;
}

/**
 * Convert IN stage output chunks to RX-compatible chunks
 * 
 * Includes chunk type in metadata for type-specific extraction prompts.
 */
export function toRxChunks(inOutput: InStageOutput): Array<{
  id: string;
  content: string;
  index: number;
  filePath: string;
  startLine: number;
  endLine: number;
  metadata?: Record<string, unknown>;
}> {
  return inOutput.chunks.map((chunk, index) => ({
    id: chunk.id,
    content: chunk.content,
    index,
    filePath: inOutput.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    metadata: {
      chunkType: chunk.type,
      title: chunk.title,
      sourceFile: inOutput.filePath,
      artifactRole: inOutput.artifactRole,
      ...(chunk.tableData && { tableData: chunk.tableData }),
    },
  }));
}
