// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile Loader
 *
 * Unified profile loading with discovery order:
 * 1. CLI flag (--profile <path>)
 * 2. Workspace-local (.iw/profiles/)
 * 3. Global (~/.iw/profiles/)
 * 4. Built-in (starter, planpling)
 *
 * Supports both built-in profiles and YAML profile packs.
 */
import type { Profile, ShapeRule } from '../pipeline/context.js';
import { type ProfilePack } from '@intentweave/profiles';
/**
 * Convert a ProfilePack (YAML-loaded) to the pipeline Profile interface
 */
export declare function profilePackToProfile(pack: ProfilePack): Profile;
/**
 * Discovery order for profile resolution
 */
export interface ProfileDiscoveryOptions {
    /** Explicit profile path (highest priority) */
    explicitPath?: string;
    /** Workspace root directory (for .iw/profiles/) */
    workspaceRoot?: string;
    /** Additional search paths */
    searchPaths?: string[];
    /** Skip built-in profiles */
    skipBuiltin?: boolean;
}
/**
 * Profile loader options
 */
export interface ProfileLoaderOptions {
    /** Additional profile directories to search */
    searchPaths?: string[];
    /** Workspace root for discovery */
    workspaceRoot?: string;
    /** Explicit profile path (overrides discovery) */
    explicitPath?: string;
    /** Whether to allow unknown profiles (return null instead of throwing) */
    allowUnknown?: boolean;
}
/**
 * Profile loader result
 */
export interface ProfileLoaderResult {
    /** Loaded profile */
    profile: Profile;
    /** Source of the profile */
    source: 'builtin' | 'file' | 'package';
    /** Path to profile if loaded from file */
    path?: string;
}
/**
 * Load a profile by name using discovery order:
 * 1. Explicit path (CLI --profile <path>)
 * 2. Workspace-local (.iw/profiles/)
 * 3. Global (~/.iw/profiles/)
 * 4. Built-in (starter, planpling)
 */
export declare function loadProfile(name: string, options?: ProfileLoaderOptions): ProfileLoaderResult;
/**
 * Load a profile by name (async version with full pack loading)
 *
 * Discovery order:
 * 1. Explicit path (CLI --profile <path>)
 * 2. Workspace-local (.iw/profiles/)
 * 3. Global (~/.iw/profiles/)
 * 4. Built-in (starter, planpling)
 */
export declare function loadProfileAsync(name: string, options?: ProfileLoaderOptions): Promise<ProfileLoaderResult>;
/**
 * Load multiple profiles and merge them (async version)
 */
export declare function loadProfilesAsync(names: string[], options?: ProfileLoaderOptions): Promise<Profile>;
/**
 * Load multiple profiles and merge them
 * Later profiles override earlier ones for conflicting values.
 */
export declare function loadProfiles(names: string[], options?: ProfileLoaderOptions): Profile;
/**
 * List available profile names
 */
export declare function listProfiles(): string[];
/**
 * Get the default profile
 */
export declare function getDefaultProfile(): Profile;
/**
 * Check if a profile exists
 */
export declare function hasProfile(name: string): boolean;
/**
 * Merge two profiles
 * The second profile's values override the first where they conflict.
 */
export declare function mergeProfiles(base: Profile, override: Profile): Profile;
/**
 * Infer entity kind based on shape rules and relationships
 */
export declare function inferKindFromShapes(entityCgId: string, currentKind: string, relationships: Array<{
    predicate: string;
    isSubject: boolean;
}>, profile: Profile): {
    inferredKind: string;
    rule?: ShapeRule;
} | null;
/**
 * Get artifact role from file path based on profile mappings
 */
export declare function inferArtifactRole(filePath: string, profile: Profile): string | undefined;
//# sourceMappingURL=loader.d.ts.map