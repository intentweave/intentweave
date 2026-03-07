// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Artifact Registry
 * 
 * Discovers and registers artifacts for pipeline processing.
 * Computes stable artifact keys and content hashes.
 * 
 * Supports:
 * - File artifacts (markdown, yaml, etc.)
 * - Chat turn artifacts (from chat-turns.jsonl)
 * - Bundle artifacts (future: code bundles)
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ArtifactKey,
  DiscoveredArtifact,
  DiscoveryOptions,
} from './types.js';
import {
  fileArtifactKey,
  chatArtifactKey,
  transcriptArtifactKey,
  serializeArtifactKey,
} from './types.js';
import {
  computeTranscriptFingerprint,
  computeRolesHash,
  loadRoleOverrides,
  HEURISTICS_VERSION,
  SPECSTORY_ADAPTER_VERSION,
  type TranscriptMessage,
  type RoleOverrides,
} from '@intentweave/core';

// =============================================================================
// Content Canonicalization
// =============================================================================

/**
 * Canonicalize content for hashing
 * 
 * Rules:
 * - Normalize line endings to \n
 * - Strip trailing whitespace from each line
 * - Remove trailing newlines
 * - For JSON: parse and re-stringify with sorted keys
 */
export function canonicalizeContent(content: string, isJson: boolean = false): string {
  if (isJson) {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(sortObjectKeys(parsed));
    } catch {
      // If JSON parse fails, treat as text
    }
  }
  
  // Text canonicalization
  return content
    .replace(/\r\n/g, '\n')           // CRLF → LF
    .replace(/\r/g, '\n')             // CR → LF
    .split('\n')
    .map(line => line.trimEnd())      // Strip trailing whitespace per line
    .join('\n')
    .replace(/\n+$/, '');             // Remove trailing newlines
}

/**
 * Recursively sort object keys for stable JSON serialization
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Compute SHA256 hash of content
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute content hash with canonicalization
 */
export function computeContentHash(content: string, isJson: boolean = false): string {
  const canonical = canonicalizeContent(content, isJson);
  return hashContent(canonical);
}

// =============================================================================
// File Artifact Discovery
// =============================================================================

/**
 * Infer artifact format from file extension
 */
function inferFormat(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.json':
      return 'json';
    case '.txt':
      return 'text';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
      return 'javascript';
    case '.py':
      return 'python';
    default:
      return 'text';
  }
}

/**
 * Infer artifact role from file path
 */
function inferRole(relativePath: string): string | undefined {
  const lower = relativePath.toLowerCase();
  
  if (lower.includes('spec/') || lower.includes('specs/')) {
    return 'spec';
  }
  if (lower.includes('doc/') || lower.includes('docs/')) {
    return 'docs';
  }
  if (lower.includes('test/') || lower.includes('tests/') || lower.includes('__tests__/')) {
    return 'test';
  }
  if (lower.includes('src/') || lower.includes('lib/')) {
    return 'code';
  }
  
  // Check filename patterns
  const filename = path.basename(lower);
  if (filename === 'readme.md') {
    return 'docs';
  }
  if (filename.includes('spec')) {
    return 'spec';
  }
  
  return undefined;
}

/**
 * Simple glob pattern matcher
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.')       // Escape dots
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')  // Temp placeholder for **
    .replace(/\*/g, '[^/]*')     // * matches anything except /
    .replace(/<<<GLOBSTAR>>>/g, '.*')    // ** matches anything
    .replace(/\?/g, '.');        // ? matches single char
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

/**
 * Check if path should be excluded
 */
function shouldExclude(filePath: string, excludePatterns: string[]): boolean {
  return excludePatterns.some(pattern => matchesPattern(filePath, pattern));
}

/**
 * Recursively walk a directory
 */
async function walkDirectory(
  dir: string,
  basePath: string,
  excludePatterns: string[]
): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(basePath, fullPath);
      
      // Check exclusions
      if (shouldExclude(relativePath, excludePatterns)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        // Skip common directories early for performance
        if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) {
          continue;
        }
        const subFiles = await walkDirectory(fullPath, basePath, excludePatterns);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  
  return files;
}

/**
 * Discover file artifacts from patterns
 * 
 * Patterns can be:
 * - Exact file paths (relative to basePath)
 * - Glob-like patterns: *.md, **\/*.ts, src/**
 */
export async function discoverFileArtifacts(
  options: DiscoveryOptions
): Promise<DiscoveredArtifact[]> {
  const { basePath, patterns = ['**/*.md'], exclude = [] } = options;
  
  const artifacts: DiscoveredArtifact[] = [];
  
  // Default excludes (common patterns to skip)
  const defaultExcludes = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.iw/cache/**',
    '**/.iw/runs/**',
  ];
  
  const allExcludes = [...defaultExcludes, ...exclude];
  
  // Walk directory to get all files
  const allFiles = await walkDirectory(basePath, basePath, allExcludes);
  
  // Filter files by patterns
  const matchedFiles = allFiles.filter(file => 
    patterns.some(pattern => matchesPattern(file, pattern))
  );
  
  // Process matched files
  for (const relativePath of matchedFiles) {
    const absolutePath = path.join(basePath, relativePath);
    
    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const format = inferFormat(relativePath);
      const isJson = format === 'json';
      const contentHash = computeContentHash(content, isJson);
      
      const key = fileArtifactKey(relativePath);
      
      artifacts.push({
        key,
        keyString: serializeArtifactKey(key),
        filePath: absolutePath,
        content,
        contentHash,
        format,
        role: inferRole(relativePath),
      });
    } catch (error) {
      // Skip files that can't be read
      console.warn(`Warning: Could not read file ${absolutePath}:`, error);
    }
  }
  
  return artifacts;
}

// =============================================================================
// Chat Turn Artifact Discovery
// =============================================================================

/**
 * Chat turn from chat-turns.jsonl
 */
interface ChatTurn {
  conversationId: string;
  turnId: string;
  role: string;
  content: string;
  createdAt?: string;
}

/**
 * Discover chat turn artifacts from a JSONL file
 */
export async function discoverChatArtifacts(
  chatTurnsPath: string
): Promise<DiscoveredArtifact[]> {
  const artifacts: DiscoveredArtifact[] = [];
  
  try {
    const content = await fs.readFile(chatTurnsPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      try {
        const turn = JSON.parse(line) as ChatTurn;
        
        if (!turn.conversationId || !turn.turnId || !turn.content) {
          continue;
        }
        
        // Canonical JSON for hashing (only what affects extraction)
        const canonical = JSON.stringify({
          role: turn.role,
          content: turn.content,
        });
        const contentHash = hashContent(canonical);
        
        const key = chatArtifactKey(turn.conversationId, turn.turnId);
        
        artifacts.push({
          key,
          keyString: serializeArtifactKey(key),
          content: turn.content,
          contentHash,
          format: 'chat',
          role: turn.role === 'user' ? 'chat-user' : 'chat-assistant',
        });
      } catch {
        // Skip invalid lines
      }
    }
  } catch (error) {
    // File doesn't exist or can't be read
    console.warn(`Warning: Could not read chat turns from ${chatTurnsPath}:`, error);
  }
  
  return artifacts;
}

// =============================================================================
// Transcript Artifact Discovery
// =============================================================================

/**
 * Options for transcript discovery
 */
export interface TranscriptDiscoveryOptions {
  /** Limit to specific session IDs */
  sessionIds?: string[];
  /** Maximum number of transcripts to include */
  limit?: number;
}

/**
 * Discover transcript artifacts from .iw/transcripts directory
 * Each session becomes an artifact, messages become the content
 * 
 * Content hash includes:
 * - Message content hashes
 * - Roles overrides hash (for cache invalidation when roles change)
 * - Heuristics version (for cache invalidation when heuristics change)
 * - Adapter version (for cache invalidation when parser changes)
 */
export async function discoverTranscriptArtifacts(
  basePath: string,
  options: TranscriptDiscoveryOptions = {}
): Promise<DiscoveredArtifact[]> {
  const { sessionIds, limit } = options;
  const artifacts: DiscoveredArtifact[] = [];
  const transcriptDir = path.join(basePath, '.iw', 'transcripts');

  // Load role overrides for fingerprint computation
  let roleOverrides: RoleOverrides = {};
  try {
    roleOverrides = await loadRoleOverrides(basePath);
  } catch {
    // No roles.json - that's fine
  }

  try {
    // List source directories (e.g., specstory)
    const sources = await fs.readdir(transcriptDir, { withFileTypes: true });

    for (const sourceEntry of sources) {
      if (!sourceEntry.isDirectory()) continue;
      const source = sourceEntry.name;
      const sourceDir = path.join(transcriptDir, source);

      // List session files
      const sessionFiles = await fs.readdir(sourceDir);

      for (const filename of sessionFiles) {
        if (!filename.endsWith('.jsonl')) continue;
        const sessionId = filename.replace('.jsonl', '');

        // Filter by session ID if specified
        if (sessionIds && sessionIds.length > 0 && !sessionIds.includes(sessionId)) {
          continue;
        }

        const sessionPath = path.join(sourceDir, filename);

        try {
          const content = await fs.readFile(sessionPath, 'utf-8');
          const lines = content.split('\n').filter(line => line.trim());

          // Parse messages
          const messages: TranscriptMessage[] = [];
          for (const line of lines) {
            try {
              const msg = JSON.parse(line) as TranscriptMessage;
              if (msg.sourceKey && msg.text) {
                messages.push(msg);
              }
            } catch {
              // Skip invalid lines
            }
          }

          if (messages.length === 0) continue;

          // Create artifact with concatenated message content
          // For the pipeline, each message can become a chunk
          // Use unique separator that won't appear in content (unlike '---' which is common in markdown)
          const MESSAGE_SEPARATOR = '\n\n<<<IW_MSG_SEP>>>\n\n';
          const combinedText = messages
            .map(m => `[${m.speaker}/${m.messageRole}] ${m.text}`)
            .join(MESSAGE_SEPARATOR);

          // Compute fingerprint including version inputs for cache correctness
          const lastMessages = messages.slice(-10);
          const rolesHash = computeRolesHash(roleOverrides, sessionId);
          
          // Determine adapter version based on source
          const adapterVersion = source === 'specstory' 
            ? SPECSTORY_ADAPTER_VERSION 
            : messages[0]?.parserVersion ?? '1.0.0';
          
          const contentHash = computeTranscriptFingerprint({
            sessionId,
            count: messages.length,
            lastSeq: messages[messages.length - 1]?.seq ?? 0,
            lastContentHashes: lastMessages.map(m => m.contentHash),
            rolesHash,
            heuristicsVersion: HEURISTICS_VERSION,
            adapterVersion,
          });

          const key = transcriptArtifactKey(source, sessionId);

          artifacts.push({
            key,
            keyString: serializeArtifactKey(key),
            filePath: sessionPath,
            content: combinedText,
            contentHash,
            format: 'transcript',
            role: 'chat',
            // Store metadata for reference and debugging
            metadata: {
              source,
              sessionId,
              messageCount: messages.length,
              lastSeq: messages[messages.length - 1]?.seq ?? 0,
              rolesHash,
              heuristicsVersion: HEURISTICS_VERSION,
              adapterVersion,
            },
          } as DiscoveredArtifact);
        } catch (error) {
          console.warn(`Warning: Could not read transcript ${sessionPath}:`, error);
        }
      }
    }
  } catch {
    // Transcript directory doesn't exist - that's fine
  }

  // Sort by content length (smallest first) - this reflects actual processing load
  artifacts.sort((a, b) => a.content.length - b.content.length);

  // Apply limit after sorting
  if (limit !== undefined && artifacts.length > limit) {
    return artifacts.slice(0, limit);
  }

  return artifacts;
}

// =============================================================================
// Artifact Registry Class
// =============================================================================

/**
 * Artifact Registry
 * 
 * Manages discovered artifacts and provides lookup by key.
 */
export class ArtifactRegistry {
  private artifacts: Map<string, DiscoveredArtifact> = new Map();
  private basePath: string;
  
  constructor(basePath: string) {
    this.basePath = basePath;
  }
  
  /**
   * Get the base path for this registry
   */
  getBasePath(): string {
    return this.basePath;
  }
  
  /**
   * Discover and register artifacts
   */
  async discover(options: Omit<DiscoveryOptions, 'basePath'>): Promise<void> {
    const fullOptions: DiscoveryOptions = {
      ...options,
      basePath: this.basePath,
    };
    
    // Discover file artifacts
    const fileArtifacts = await discoverFileArtifacts(fullOptions);
    for (const artifact of fileArtifacts) {
      this.artifacts.set(artifact.keyString, artifact);
    }
    
    // Discover chat artifacts if enabled
    if (options.includeChatTurns && options.chatTurnsPath) {
      const chatArtifacts = await discoverChatArtifacts(options.chatTurnsPath);
      for (const artifact of chatArtifacts) {
        this.artifacts.set(artifact.keyString, artifact);
      }
    }

    // Discover transcript artifacts if enabled (default: true)
    if (options.includeTranscripts !== false) {
      const transcriptArtifacts = await discoverTranscriptArtifacts(this.basePath, {
        sessionIds: options.transcriptSessionIds,
        limit: options.transcriptLimit,
      });
      for (const artifact of transcriptArtifacts) {
        this.artifacts.set(artifact.keyString, artifact);
      }
    }
  }
  
  /**
   * Register a single artifact
   */
  register(artifact: DiscoveredArtifact): void {
    this.artifacts.set(artifact.keyString, artifact);
  }
  
  /**
   * Get an artifact by key string
   */
  get(keyString: string): DiscoveredArtifact | undefined {
    return this.artifacts.get(keyString);
  }
  
  /**
   * Get an artifact by key
   */
  getByKey(key: ArtifactKey): DiscoveredArtifact | undefined {
    return this.artifacts.get(serializeArtifactKey(key));
  }
  
  /**
   * Check if an artifact exists
   */
  has(keyString: string): boolean {
    return this.artifacts.has(keyString);
  }
  
  /**
   * Get all artifacts
   */
  all(): DiscoveredArtifact[] {
    return Array.from(this.artifacts.values());
  }
  
  /**
   * Get artifact count
   */
  size(): number {
    return this.artifacts.size;
  }
  
  /**
   * Get artifacts by role
   */
  byRole(role: string): DiscoveredArtifact[] {
    return this.all().filter(a => a.role === role);
  }
  
  /**
   * Get artifacts by format
   */
  byFormat(format: string): DiscoveredArtifact[] {
    return this.all().filter(a => a.format === format);
  }
  
  /**
   * Clear all artifacts
   */
  clear(): void {
    this.artifacts.clear();
  }
}
