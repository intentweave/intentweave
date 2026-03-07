// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Weave Registry
 * 
 * Manages canonical key aliases and deprecations.
 * Stored in .iw/weave/registry.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { WeaveRegistry, WeaveOverrides } from './types.js';
import { NORMALIZATION_VERSION, generateCanonicalId } from './normalize.js';

// =============================================================================
// Registry Operations
// =============================================================================

const REGISTRY_FILENAME = 'registry.json';
const OVERRIDES_FILENAME = 'overrides.json';
const LOCK_SUFFIX = '.lock';
const LOCK_TIMEOUT_MS = 5000;

/**
 * Create an empty registry.
 */
export function createEmptyRegistry(): WeaveRegistry {
  return {
    version: '0.1',
    normalizationVersion: NORMALIZATION_VERSION,
    aliases: {},
    deprecated: {},
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Create empty overrides.
 */
export function createEmptyOverrides(): WeaveOverrides {
  return {
    forceMerge: [],
    forceSplit: [],
    aliases: [],
  };
}

/**
 * Load the weave registry from disk.
 * Returns empty registry if file doesn't exist.
 */
export async function loadRegistry(iwDir: string): Promise<WeaveRegistry> {
  const registryPath = join(iwDir, 'weave', REGISTRY_FILENAME);
  
  try {
    if (!existsSync(registryPath)) {
      return createEmptyRegistry();
    }
    
    const content = await readFile(registryPath, 'utf-8');
    const registry = JSON.parse(content) as WeaveRegistry;
    
    // Migrate if normalization version differs
    if (registry.normalizationVersion !== NORMALIZATION_VERSION) {
      console.warn(
        `[WX] Registry normalization version mismatch: ` +
        `${registry.normalizationVersion} vs ${NORMALIZATION_VERSION}. ` +
        `Aliases may need updating.`
      );
    }
    
    return registry;
  } catch (error) {
    console.error('[WX] Failed to load registry:', error);
    return createEmptyRegistry();
  }
}

/**
 * Save the weave registry to disk with atomic write.
 */
export async function saveRegistry(iwDir: string, registry: WeaveRegistry): Promise<void> {
  const weaveDir = join(iwDir, 'weave');
  const registryPath = join(weaveDir, REGISTRY_FILENAME);
  const lockPath = registryPath + LOCK_SUFFIX;
  const tempPath = registryPath + '.tmp';
  
  // Ensure directory exists
  await mkdir(weaveDir, { recursive: true });
  
  // Acquire lock
  await acquireLock(lockPath);
  
  try {
    // Update timestamp
    registry.lastUpdated = new Date().toISOString();
    
    // Write to temp file
    const content = JSON.stringify(registry, null, 2);
    await writeFile(tempPath, content, 'utf-8');
    
    // Atomic rename
    await writeFile(registryPath, content, 'utf-8');
    
    // Clean up temp (ignore errors)
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tempPath);
    } catch {
      // Ignore
    }
  } finally {
    // Release lock
    await releaseLock(lockPath);
  }
}

/**
 * Load overrides from disk.
 */
export async function loadOverrides(iwDir: string): Promise<WeaveOverrides> {
  const overridesPath = join(iwDir, 'weave', OVERRIDES_FILENAME);
  
  try {
    if (!existsSync(overridesPath)) {
      return createEmptyOverrides();
    }
    
    const content = await readFile(overridesPath, 'utf-8');
    return JSON.parse(content) as WeaveOverrides;
  } catch (error) {
    console.error('[WX] Failed to load overrides:', error);
    return createEmptyOverrides();
  }
}

// =============================================================================
// Alias Resolution
// =============================================================================

/**
 * Resolve a canonical key through the alias chain.
 * Returns the final resolved key.
 */
export function resolveCanonicalKey(
  key: string,
  registry: WeaveRegistry,
  overrides?: WeaveOverrides
): string {
  // First check overrides (take precedence)
  if (overrides) {
    for (const alias of overrides.aliases) {
      if (alias.fromKey === key) {
        // Recursive resolve
        return resolveCanonicalKey(alias.toKey, registry, overrides);
      }
    }
  }
  
  // Then check registry aliases
  if (key in registry.aliases) {
    const target = registry.aliases[key];
    // Recursive resolve (with depth limit)
    return resolveCanonicalKeyWithDepth(target, registry, 10);
  }
  
  return key;
}

function resolveCanonicalKeyWithDepth(
  key: string,
  registry: WeaveRegistry,
  maxDepth: number
): string {
  if (maxDepth <= 0) {
    console.warn(`[WX] Alias chain too deep for key: ${key}`);
    return key;
  }
  
  if (key in registry.aliases) {
    return resolveCanonicalKeyWithDepth(registry.aliases[key], registry, maxDepth - 1);
  }
  
  return key;
}

/**
 * Resolve a canonical key to its canonical ID.
 * Applies alias resolution first, then generates deterministic ID.
 */
export function resolveToCanonicalId(
  key: string,
  registry: WeaveRegistry,
  overrides?: WeaveOverrides
): string {
  const resolvedKey = resolveCanonicalKey(key, registry, overrides);
  return generateCanonicalId(resolvedKey);
}

/**
 * Check if a canonical ID is deprecated.
 */
export function isDeprecated(
  canonicalId: string,
  registry: WeaveRegistry
): { deprecated: boolean; replacedBy?: string[]; reason?: string } {
  const entry = registry.deprecated[canonicalId];
  if (!entry) {
    return { deprecated: false };
  }
  
  return {
    deprecated: true,
    replacedBy: entry.replacedBy,
    reason: entry.reason,
  };
}

// =============================================================================
// Registry Mutations
// =============================================================================

/**
 * Add an alias to the registry.
 */
export function addAlias(
  registry: WeaveRegistry,
  fromKey: string,
  toKey: string
): WeaveRegistry {
  return {
    ...registry,
    aliases: {
      ...registry.aliases,
      [fromKey]: toKey,
    },
  };
}

/**
 * Deprecate a canonical ID.
 */
export function deprecateCanonical(
  registry: WeaveRegistry,
  canonicalId: string,
  reason: 'split' | 'merged' | 'removed',
  replacedBy?: string[]
): WeaveRegistry {
  return {
    ...registry,
    deprecated: {
      ...registry.deprecated,
      [canonicalId]: {
        reason,
        replacedBy,
        deprecatedAt: new Date().toISOString(),
      },
    },
  };
}

// =============================================================================
// File Locking (Simple Implementation)
// =============================================================================

async function acquireLock(lockPath: string): Promise<void> {
  const startTime = Date.now();
  
  while (existsSync(lockPath)) {
    if (Date.now() - startTime > LOCK_TIMEOUT_MS) {
      // Force remove stale lock
      console.warn(`[WX] Removing stale lock: ${lockPath}`);
      await releaseLock(lockPath);
      break;
    }
    // Wait and retry
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  // Create lock file
  await writeFile(lockPath, String(process.pid), 'utf-8');
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(lockPath);
  } catch {
    // Ignore errors
  }
}
