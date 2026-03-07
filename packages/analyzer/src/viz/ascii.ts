/**
 * ASCII renderer using beautiful-mermaid
 * 
 * Converts Mermaid syntax to ASCII art for terminal/MD display.
 */

import { renderMermaidAscii } from 'beautiful-mermaid';

export interface AsciiRenderOptions {
  /** Wrap output in a code block */
  wrapInCodeBlock?: boolean;
  /** Code block language (default: none) */
  codeBlockLang?: string;
}

export interface AsciiRenderResult {
  /** ASCII art output */
  ascii: string;
  /** Whether rendering succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Render Mermaid diagram to ASCII art
 */
export function renderAscii(
  mermaidSyntax: string,
  options: AsciiRenderOptions = {}
): AsciiRenderResult {
  const { wrapInCodeBlock = false, codeBlockLang = '' } = options;
  
  try {
    // beautiful-mermaid expects clean mermaid syntax without the ```mermaid wrapper
    let cleanSyntax = mermaidSyntax;
    
    // Remove markdown code block wrapper if present
    if (cleanSyntax.includes('```mermaid')) {
      cleanSyntax = cleanSyntax
        .replace(/```mermaid\n?/g, '')
        .replace(/```\n?/g, '');
    }
    
    // Remove YAML frontmatter (title, etc.)
    if (cleanSyntax.startsWith('---')) {
      const endOfFrontmatter = cleanSyntax.indexOf('---', 3);
      if (endOfFrontmatter !== -1) {
        cleanSyntax = cleanSyntax.substring(endOfFrontmatter + 3).trim();
      }
    }
    
    // Remove style definitions (classDef) - beautiful-mermaid doesn't support them
    cleanSyntax = cleanSyntax
      .split('\n')
      .filter(line => !line.trim().startsWith('classDef'))
      .filter(line => !line.trim().startsWith('class '))
      .filter(line => !line.trim().startsWith('%%'))
      .join('\n');
    
    const ascii = renderMermaidAscii(cleanSyntax);
    
    if (!ascii || ascii.trim() === '') {
      return {
        ascii: '',
        success: false,
        error: 'Empty output from renderer',
      };
    }
    
    let output = ascii;
    if (wrapInCodeBlock) {
      output = '```' + codeBlockLang + '\n' + ascii + '\n```';
    }
    
    return {
      ascii: output,
      success: true,
    };
  } catch (err) {
    return {
      ascii: '',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Render Mermaid to both ASCII and original syntax
 * Returns combined markdown with ASCII art displayed, original syntax in details
 */
export function renderDualOutput(
  mermaidSyntax: string,
  title?: string
): string {
  const asciiResult = renderAscii(mermaidSyntax);
  
  const lines: string[] = [];
  
  // Title if provided
  if (title) {
    lines.push(`### ${title}`);
    lines.push('');
  }
  
  // ASCII art (primary display)
  if (asciiResult.success) {
    lines.push('```');
    lines.push(asciiResult.ascii);
    lines.push('```');
  } else {
    lines.push(`> *ASCII rendering failed: ${asciiResult.error}*`);
  }
  
  lines.push('');
  
  // Original Mermaid in collapsible details
  lines.push('<details>');
  lines.push('<summary>Mermaid source</summary>');
  lines.push('');
  lines.push('```mermaid');
  // Clean up the mermaid syntax for the details block
  let cleanMermaid = mermaidSyntax;
  if (cleanMermaid.includes('```mermaid')) {
    cleanMermaid = cleanMermaid
      .replace(/```mermaid\n?/g, '')
      .replace(/```\n?$/g, '');
  }
  lines.push(cleanMermaid.trim());
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  
  return lines.join('\n');
}
