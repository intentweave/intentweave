/**
 * Transcript Storage Utilities
 * 
 * File I/O for transcripts, import state, and role overrides.
 * Uses JSONL format for transcripts (append-friendly).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import * as readline from 'node:readline';
import type {
  TranscriptMessage,
  ImportState,
  ImportStateFile,
  RoleOverrides,
  RoleOverride,
} from './types.js';

// =============================================================================
// Path Utilities
// =============================================================================

/** Base directory for IntentWeave data */
const IW_DIR = '.iw';

/**
 * Get the transcript directory path.
 * @param workspaceRoot - Workspace root directory
 */
export function getTranscriptDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, IW_DIR, 'transcripts');
}

/**
 * Get the transcript file path for a source/session.
 * @param workspaceRoot - Workspace root directory
 * @param source - Adapter name (e.g., 'specstory')
 * @param sessionId - Session identifier
 */
export function getTranscriptPath(
  workspaceRoot: string,
  source: string,
  sessionId: string
): string {
  return path.join(getTranscriptDir(workspaceRoot), source, `${sessionId}.jsonl`);
}

/**
 * Get the import state file path.
 * @param workspaceRoot - Workspace root directory
 */
export function getImportStatePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, IW_DIR, 'import', 'state.json');
}

/**
 * Get the role overrides file path.
 * @param workspaceRoot - Workspace root directory
 */
export function getRolesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, IW_DIR, 'roles.json');
}

// =============================================================================
// Import State I/O
// =============================================================================

/**
 * Load import state from disk.
 * Returns empty object if file doesn't exist.
 */
export async function loadImportState(workspaceRoot: string): Promise<ImportStateFile> {
  const statePath = getImportStatePath(workspaceRoot);
  
  try {
    const content = await fs.readFile(statePath, 'utf-8');
    return JSON.parse(content) as ImportStateFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/**
 * Save import state for a specific source file.
 * Merges with existing state file.
 */
export async function saveImportState(
  workspaceRoot: string,
  sourcePath: string,
  state: ImportState
): Promise<void> {
  const statePath = getImportStatePath(workspaceRoot);
  
  // Load existing state
  const stateFile = await loadImportState(workspaceRoot);
  
  // Update with new state
  stateFile[sourcePath] = state;
  
  // Write atomically
  await writeJsonAtomic(statePath, stateFile);
}

// =============================================================================
// Transcript I/O (JSONL)
// =============================================================================

/**
 * Load transcript from JSONL file.
 * Returns empty array if file doesn't exist.
 */
export async function loadTranscript(transcriptPath: string): Promise<TranscriptMessage[]> {
  if (!existsSync(transcriptPath)) {
    return [];
  }
  
  const messages: TranscriptMessage[] = [];
  
  const fileStream = createReadStream(transcriptPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        messages.push(JSON.parse(trimmed) as TranscriptMessage);
      } catch {
        // Skip malformed lines
        console.warn(`Skipping malformed JSONL line: ${trimmed.slice(0, 50)}...`);
      }
    }
  }
  
  return messages;
}

/**
 * Append messages to transcript file.
 * Creates file and parent directories if needed.
 */
export async function appendToTranscript(
  transcriptPath: string,
  messages: TranscriptMessage[]
): Promise<void> {
  if (messages.length === 0) return;
  
  // Ensure directory exists
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  
  // Build JSONL content
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  
  // Append to file
  await fs.appendFile(transcriptPath, lines, 'utf-8');
}

/**
 * Write full transcript to file (replaces existing content).
 * Used for full reimport or rewrite scenarios.
 */
export async function writeTranscript(
  transcriptPath: string,
  messages: TranscriptMessage[]
): Promise<void> {
  // Ensure directory exists
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  
  // Build JSONL content
  const lines = messages.map(m => JSON.stringify(m)).join('\n');
  const content = messages.length > 0 ? lines + '\n' : '';
  
  // Write atomically
  await writeAtomic(transcriptPath, content);
}

// =============================================================================
// Role Overrides I/O
// =============================================================================

/**
 * Load role overrides from disk.
 * Returns empty object if file doesn't exist.
 */
export async function loadRoleOverrides(workspaceRoot: string): Promise<RoleOverrides> {
  const rolesPath = getRolesPath(workspaceRoot);
  
  try {
    const content = await fs.readFile(rolesPath, 'utf-8');
    return JSON.parse(content) as RoleOverrides;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/**
 * Save a single role override.
 * Merges with existing overrides.
 */
export async function saveRoleOverride(
  workspaceRoot: string,
  sourceKey: string,
  override: RoleOverride
): Promise<void> {
  const rolesPath = getRolesPath(workspaceRoot);
  
  // Load existing overrides
  const overrides = await loadRoleOverrides(workspaceRoot);
  
  // Update with new override
  overrides[sourceKey] = override;
  
  // Write atomically
  await writeJsonAtomic(rolesPath, overrides);
}

/**
 * Delete a role override.
 */
export async function deleteRoleOverride(
  workspaceRoot: string,
  sourceKey: string
): Promise<boolean> {
  const rolesPath = getRolesPath(workspaceRoot);
  
  // Load existing overrides
  const overrides = await loadRoleOverrides(workspaceRoot);
  
  // Check if exists
  if (!(sourceKey in overrides)) {
    return false;
  }
  
  // Delete
  delete overrides[sourceKey];
  
  // Write atomically
  await writeJsonAtomic(rolesPath, overrides);
  return true;
}

/**
 * Get role overrides for a specific session.
 */
export async function getRoleOverridesForSession(
  workspaceRoot: string,
  sessionId: string
): Promise<RoleOverrides> {
  const overrides = await loadRoleOverrides(workspaceRoot);
  
  const sessionOverrides: RoleOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key.includes(sessionId)) {
      sessionOverrides[key] = value;
    }
  }
  
  return sessionOverrides;
}

// =============================================================================
// Atomic File Writes
// =============================================================================

/**
 * Write content to file atomically (write to temp, then rename).
 * Creates parent directories if needed.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  
  // Write to temp file
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  await fs.writeFile(tempPath, content, 'utf-8');
  
  // Rename to target (atomic on POSIX)
  await fs.rename(tempPath, filePath);
}

/**
 * Write JSON to file atomically with pretty formatting.
 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + '\n';
  await writeAtomic(filePath, content);
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * List all transcript sessions for a source.
 */
export async function listTranscriptSessions(
  workspaceRoot: string,
  source: string
): Promise<string[]> {
  const sourceDir = path.join(getTranscriptDir(workspaceRoot), source);
  
  try {
    const files = await fs.readdir(sourceDir);
    return files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * List all transcript sources.
 */
export async function listTranscriptSources(workspaceRoot: string): Promise<string[]> {
  const transcriptDir = getTranscriptDir(workspaceRoot);
  
  try {
    const entries = await fs.readdir(transcriptDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Delete a transcript and its import state.
 */
export async function deleteTranscript(
  workspaceRoot: string,
  source: string,
  sessionId: string
): Promise<void> {
  const transcriptPath = getTranscriptPath(workspaceRoot, source, sessionId);
  
  // Delete transcript file
  try {
    await fs.unlink(transcriptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  
  // Note: Import state cleanup would require knowing the source path
  // This is handled separately when needed
}
