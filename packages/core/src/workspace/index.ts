// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace - Types and utilities for IntentWeave workspace management
 * 
 * Workspace Identity Architecture:
 * - Every workspace has a unique `workspaceKey` (human-readable) and `workspaceId` (stable)
 * - The workspaceId is used in cgIds: intentweave|<workspaceId>|kg|entity/name
 * - The workspaceKey is used for CLI/UI: `iw workspace use my-project`
 * - All storage paths are scoped by workspaceKey
 * 
 * Directory Structure:
 * .iw/
 * └── workspaces/
 *     └── <workspaceKey>/
 *         ├── workspace.json      # WorkspaceManifest
 *         └── runs/
 *             └── <runId>/...
 */

import type { RunMeta } from '../types/index.js';
import { generateWorkspaceId, isStableWorkspaceId } from '../cgId/index.js';

// ============================================================================
// Workspace Reference (Lightweight Reference)
// ============================================================================

/**
 * WorkspaceRef - Lightweight reference to a workspace
 * 
 * Used for passing workspace identity without full config.
 * Can be resolved to full WorkspaceManifest via WorkspaceRegistry.
 */
export interface WorkspaceRef {
  /** Human-readable workspace key (e.g., "my-project", "acme-backend") */
  key: string;
  
  /** Stable workspace ID used in cgIds (e.g., "ws_8f3a") */
  id: string;
  
  /** Optional alias for quick access */
  alias?: string;
}

/**
 * Create a WorkspaceRef from key and optional id
 * If id is not provided, generates a new stable workspace ID
 */
export function createWorkspaceRef(key: string, id?: string): WorkspaceRef {
  if (!isValidWorkspaceKey(key)) {
    throw new Error(`Invalid workspace key: "${key}". Must be lowercase alphanumeric with hyphens, 2-64 chars.`);
  }
  return {
    key,
    id: id ?? generateWorkspaceId(),
  };
}

// ============================================================================
// Workspace Manifest (Persisted Config)
// ============================================================================

/**
 * WorkspaceManifest - Full workspace configuration stored in workspace.json
 * 
 * Schema version is required for forward compatibility.
 */
export interface WorkspaceManifest {
  /** Schema version for this manifest */
  schemaVersion: '0.1';
  
  /** Workspace reference (key + id) */
  workspace: WorkspaceRef;
  
  /** Human-readable display name */
  displayName: string;
  
  /** Optional description */
  description?: string;
  
  /** Root directory path (absolute or relative to .iw) */
  rootPath: string;
  
  /** Default profile pack to use */
  defaultProfile?: string;
  
  /** Configuration overrides */
  config?: WorkspaceConfigOverrides;
  
  /** Created timestamp */
  createdAt: string;
  
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Workspace-specific configuration overrides
 */
export interface WorkspaceConfigOverrides {
  /** Run retention count (default: 10) */
  runRetention?: number;
  
  /** Auto-aggregate after PX completes */
  autoAggregate?: boolean;
  
  /** Database URI for server mode */
  databaseUri?: string;
  
  /** Extraction provider (openai, mock, ollama) */
  extractionProvider?: string;
  
  /** Additional overrides */
  [key: string]: unknown;
}

// ============================================================================
// Workspace Config (Legacy/Runtime)
// ============================================================================

/**
 * Workspace configuration (runtime)
 * @deprecated Use WorkspaceManifest for persistence
 */
export interface WorkspaceConfig {
  /** Unique workspace identifier */
  id: string;
  
  /** Human-readable workspace name */
  name: string;
  
  /** Root directory path */
  rootPath: string;
  
  /** Database connection string or path */
  databaseUri?: string;
  
  /** Configuration overrides */
  overrides?: Record<string, unknown>;
  
  /** Created timestamp */
  createdAt: string;
  
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Workspace state - runtime information
 */
export interface WorkspaceState {
  /** Current workspace config */
  config: WorkspaceConfig;
  
  /** Is the workspace initialized */
  isInitialized: boolean;
  
  /** Is the database connected */
  isConnected: boolean;
  
  /** Current active run (if any) */
  activeRun?: RunMeta;
  
  /** Entity count in staging */
  stagedEntityCount: number;
  
  /** Statement count in staging */
  stagedStatementCount: number;
}

/**
 * Workspace session - represents an active session
 */
export interface WorkspaceSession {
  /** Session ID */
  sessionId: string;
  
  /** Workspace ID */
  workspaceId: string;
  
  /** Session start time */
  startedAt: string;
  
  /** Current run ID */
  currentRunId?: string;
  
  /** Files being processed */
  activeFiles: string[];
}

/**
 * File processing status
 */
export interface FileStatus {
  /** File path relative to workspace root */
  path: string;
  
  /** Processing status */
  status: 'pending' | 'processing' | 'parsed' | 'analyzed' | 'error';
  
  /** Error message if status is 'error' */
  error?: string;
  
  /** Last modified time */
  lastModified: string;
  
  /** Last processed time */
  lastProcessed?: string;
  
  /** Entity count extracted from this file */
  entityCount?: number;
  
  /** Statement count extracted from this file */
  statementCount?: number;
}

/**
 * Workspace statistics
 */
export interface WorkspaceStats {
  /** Total entity count */
  totalEntities: number;
  
  /** Total statement count */
  totalStatements: number;
  
  /** Entity count by type */
  entitiesByType: Record<string, number>;
  
  /** Statement count by predicate */
  statementsByPredicate: Record<string, number>;
  
  /** File count by status */
  filesByStatus: Record<string, number>;
  
  /** Last analysis run time */
  lastAnalysisAt?: string;
}

/**
 * Create a new workspace config
 */
export function createWorkspaceConfig(
  id: string,
  name: string,
  rootPath: string,
  options?: Partial<WorkspaceConfig>
): WorkspaceConfig {
  const now = new Date().toISOString();
  return {
    id,
    name,
    rootPath,
    createdAt: now,
    updatedAt: now,
    ...options,
  };
}

/**
 * Create initial workspace state
 */
export function createInitialState(config: WorkspaceConfig): WorkspaceState {
  return {
    config,
    isInitialized: false,
    isConnected: false,
    stagedEntityCount: 0,
    stagedStatementCount: 0,
  };
}

/**
 * Validate workspace config
 */
export function validateWorkspaceConfig(config: unknown): config is WorkspaceConfig {
  if (!config || typeof config !== 'object') return false;
  
  const c = config as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    typeof c.name === 'string' &&
    typeof c.rootPath === 'string' &&
    typeof c.createdAt === 'string' &&
    typeof c.updatedAt === 'string'
  );
}

/**
 * Get workspace directory for a given workspace ID
 */
export function getWorkspaceDir(baseDir: string, workspaceId: string): string {
  return `${baseDir}/workspaces/${workspaceId}`;
}

/**
 * Get staging directory for a workspace
 */
export function getStagingDir(workspaceDir: string): string {
  return `${workspaceDir}/staging`;
}

/**
 * Get runs directory for a workspace
 */
export function getRunsDir(workspaceDir: string): string {
  return `${workspaceDir}/runs`;
}
// ============================================================================
// Workspace Key Validation
// ============================================================================

/** Workspace key pattern: lowercase alphanumeric, hyphens allowed, 2-64 chars */
const WORKSPACE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Check if a string is a valid workspace key
 */
export function isValidWorkspaceKey(key: string): boolean {
  return WORKSPACE_KEY_PATTERN.test(key) && !key.includes('--') && !key.endsWith('-');
}

/**
 * Sanitize a string to be a valid workspace key
 */
export function sanitizeWorkspaceKey(input: string): string {
  const sanitized = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  
  if (!sanitized || sanitized.length < 2) {
    throw new Error(`Cannot create valid workspace key from: "${input}"`);
  }
  
  // Ensure starts with letter
  if (!/^[a-z]/.test(sanitized)) {
    return `ws-${sanitized}`.slice(0, 64);
  }
  
  return sanitized;
}

// ============================================================================
// Key → Path Mapping
// ============================================================================

/**
 * Options for workspace path resolution
 */
export interface WorkspacePathOptions {
  /** Base directory (defaults to .iw) */
  baseDir?: string;
}

/**
 * Get the directory path for a workspace by key
 */
export function getWorkspacePath(workspaceKey: string, options: WorkspacePathOptions = {}): string {
  const baseDir = options.baseDir ?? '.iw';
  if (!isValidWorkspaceKey(workspaceKey)) {
    throw new Error(`Invalid workspace key: "${workspaceKey}"`);
  }
  return `${baseDir}/workspaces/${workspaceKey}`;
}

/**
 * Get the manifest file path for a workspace
 */
export function getManifestPath(workspaceKey: string, options: WorkspacePathOptions = {}): string {
  return `${getWorkspacePath(workspaceKey, options)}/workspace.json`;
}

/**
 * Get the runs directory for a workspace by key
 */
export function getWorkspaceRunsPath(workspaceKey: string, options: WorkspacePathOptions = {}): string {
  return `${getWorkspacePath(workspaceKey, options)}/runs`;
}

/**
 * Get a specific run directory for a workspace
 */
export function getRunPath(workspaceKey: string, runId: string, options: WorkspacePathOptions = {}): string {
  return `${getWorkspaceRunsPath(workspaceKey, options)}/${runId}`;
}

/**
 * Get the curated directory for a workspace (persistent promotions)
 */
export function getCuratedPath(workspaceKey: string, options: WorkspacePathOptions = {}): string {
  return `${getWorkspacePath(workspaceKey, options)}/curated`;
}

// ============================================================================
// Workspace Manifest Functions
// ============================================================================

/**
 * Create a new workspace manifest
 */
export function createWorkspaceManifest(
  key: string,
  displayName: string,
  rootPath: string,
  options?: Partial<Omit<WorkspaceManifest, 'schemaVersion' | 'workspace' | 'createdAt' | 'updatedAt'>>
): WorkspaceManifest {
  const now = new Date().toISOString();
  const ref = createWorkspaceRef(key);
  
  return {
    schemaVersion: '0.1',
    workspace: ref,
    displayName,
    rootPath,
    ...options,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Validate a workspace manifest object
 */
export function validateWorkspaceManifest(manifest: unknown): manifest is WorkspaceManifest {
  if (!manifest || typeof manifest !== 'object') return false;
  
  const m = manifest as Record<string, unknown>;
  
  // Check required fields
  if (m.schemaVersion !== '0.1') return false;
  if (typeof m.displayName !== 'string') return false;
  if (typeof m.rootPath !== 'string') return false;
  if (typeof m.createdAt !== 'string') return false;
  if (typeof m.updatedAt !== 'string') return false;
  
  // Check workspace ref
  const ws = m.workspace as Record<string, unknown> | undefined;
  if (!ws || typeof ws !== 'object') return false;
  if (typeof ws.key !== 'string' || !isValidWorkspaceKey(ws.key)) return false;
  if (typeof ws.id !== 'string' || !isStableWorkspaceId(ws.id)) return false;
  
  return true;
}

/**
 * Get WorkspaceRef from a manifest
 */
export function getWorkspaceRefFromManifest(manifest: WorkspaceManifest): WorkspaceRef {
  return manifest.workspace;
}

// ============================================================================
// Workspace Registry Types
// ============================================================================

/**
 * Workspace registry entry for tracking multiple workspaces
 */
export interface WorkspaceRegistryEntry {
  /** Workspace key */
  key: string;
  
  /** Workspace ID */
  id: string;
  
  /** Path to workspace directory */
  path: string;
  
  /** Optional alias */
  alias?: string;
  
  /** Last accessed timestamp */
  lastAccessed?: string;
}

/**
 * Global workspace registry (stored in ~/.iw/workspaces.json)
 */
export interface WorkspaceRegistry {
  schemaVersion: '0.1';
  
  /** Default workspace key */
  defaultWorkspace?: string;
  
  /** Registered workspaces */
  workspaces: WorkspaceRegistryEntry[];
}

/**
 * Create an empty workspace registry
 */
export function createWorkspaceRegistry(): WorkspaceRegistry {
  return {
    schemaVersion: '0.1',
    workspaces: [],
  };
}

/**
 * Find a workspace in the registry by key or alias
 */
export function findWorkspaceInRegistry(
  registry: WorkspaceRegistry,
  keyOrAlias: string
): WorkspaceRegistryEntry | undefined {
  return registry.workspaces.find(
    (ws) => ws.key === keyOrAlias || ws.alias === keyOrAlias
  );
}

/**
 * Add or update a workspace in the registry
 */
export function upsertWorkspaceInRegistry(
  registry: WorkspaceRegistry,
  entry: WorkspaceRegistryEntry
): WorkspaceRegistry {
  const existingIndex = registry.workspaces.findIndex((ws) => ws.key === entry.key);
  const updatedWorkspaces = [...registry.workspaces];
  
  if (existingIndex >= 0) {
    updatedWorkspaces[existingIndex] = { ...entry, lastAccessed: new Date().toISOString() };
  } else {
    updatedWorkspaces.push({ ...entry, lastAccessed: new Date().toISOString() });
  }
  
  return {
    ...registry,
    workspaces: updatedWorkspaces,
  };
}

// ============================================================================
// Run Meta Helpers
// ============================================================================

/**
 * Generate a unique run ID
 * Format: run-YYYY-MM-DD-HHMMSS-XXXX
 */
export function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  const random = Math.random().toString(36).slice(2, 6);
  return `run-${date}-${time}-${random}`;
}

/**
 * Create a new RunMeta for a workspace
 */
export function createRunMeta(
  workspace: WorkspaceRef,
  options?: {
    runId?: string;
    profile?: string;
  }
): import('../types/index.js').RunMeta {
  return {
    schemaVersion: '0.1',
    runId: options?.runId ?? generateRunId(),
    workspaceId: workspace.id,
    workspaceKey: workspace.key,
    startedAt: new Date().toISOString(),
    status: 'running',
    profile: options?.profile,
  };
}

/**
 * Update RunMeta to completed status
 */
export function completeRunMeta(
  meta: import('../types/index.js').RunMeta,
  stats?: {
    entityCount?: number;
    statementCount?: number;
    artifactCount?: number;
  }
): import('../types/index.js').RunMeta {
  return {
    ...meta,
    completedAt: new Date().toISOString(),
    status: 'completed',
    ...stats,
  };
}

/**
 * Update RunMeta to failed status
 */
export function failRunMeta(
  meta: import('../types/index.js').RunMeta,
  error: string
): import('../types/index.js').RunMeta {
  return {
    ...meta,
    completedAt: new Date().toISOString(),
    status: 'failed',
    error,
  };
}
