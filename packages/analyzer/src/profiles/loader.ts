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

import * as path from "node:path";
import * as fs from "node:fs";
import type {
  Profile,
  ShapeRule,
  ArtifactMapping,
} from "../pipeline/context.js";
import { DEFAULT_PROFILE } from "../pipeline/context.js";
import {
  loadProfilePack,
  type ProfilePack,
  type LoadPackOptions,
} from "@intentweave/profiles";

// =============================================================================
// Built-in Profiles
// =============================================================================

/**
 * Starter profile - general purpose intent analysis
 */
const STARTER_PROFILE: Profile = DEFAULT_PROFILE;

/**
 * Planpling profile - IAM/permission domain
 */
const PLANPLING_PROFILE: Profile = {
  name: "planpling",
  version: "0.1.0",
  kinds: [
    "role",
    "permission",
    "action",
    "resource",
    "state",
    "transition",
    "policy",
    "constraint",
  ],
  predicates: [
    "ROLE_CAN",
    "HAS_PERMISSION",
    "REQUIRES_ROLE",
    "GRANTS",
    "REVOKES",
    "HAS_STATE",
    "TRANSITIONS_TO",
    "TRIGGERS",
    "GUARDS",
    "CONSTRAINS",
  ],
  shapes: [
    {
      participatesIn: ["ROLE_CAN", "REQUIRES_ROLE", "HAS_PERMISSION"],
      position: "subject",
      inferredKind: "role",
    },
    {
      participatesIn: ["ROLE_CAN"],
      position: "object",
      inferredKind: "action",
    },
    {
      participatesIn: ["GRANTS", "REVOKES"],
      position: "object",
      inferredKind: "permission",
    },
    {
      participatesIn: ["HAS_STATE"],
      position: "object",
      inferredKind: "state",
    },
    {
      participatesIn: ["TRANSITIONS_TO"],
      position: "any",
      inferredKind: "state",
    },
    {
      participatesIn: ["CONSTRAINS"],
      position: "subject",
      inferredKind: "constraint",
    },
  ],
  artifactMappings: [
    {
      role: "prompt",
      kinds: ["requirement", "concept", "question"],
      patterns: ["**/prompt*.md", "**/intent*.md"],
    },
    {
      role: "spec",
      kinds: ["requirement", "role", "permission", "policy", "constraint"],
      patterns: ["**/spec*.md", "**/design*.md", "**/policy*.md"],
    },
    {
      role: "impl",
      kinds: ["function", "class", "module", "interface"],
      patterns: ["**/*.ts", "**/*.js", "**/*.py"],
    },
  ],
  confidenceThreshold: 0.5,
};

/**
 * Registry of built-in profiles
 */
const BUILTIN_PROFILES: Map<string, Profile> = new Map([
  ["starter", STARTER_PROFILE],
  ["planpling", PLANPLING_PROFILE],
]);

// =============================================================================
// Profile Pack Adapter
// =============================================================================

/**
 * Convert a ProfilePack (YAML-loaded) to the pipeline Profile interface
 */
export function profilePackToProfile(pack: ProfilePack): Profile {
  // Convert kind definitions to string array
  const kinds = pack.kinds.map((k: { id: string }) => k.id);

  // Extract predicates from shapes
  const predicateSet = new Set<string>();
  for (const shape of pack.shapes) {
    for (const pred of shape.predicates) {
      predicateSet.add(pred.name);
    }
  }
  const predicates = Array.from(predicateSet);

  // Convert shape definitions to ShapeRule format
  const shapes: ShapeRule[] = [];
  for (const shape of pack.shapes) {
    for (const pred of shape.predicates) {
      // Create shape rule for subject
      shapes.push({
        participatesIn: [pred.name],
        position: "subject",
        inferredKind: shape.subject,
      });
      // Create shape rules for targets
      for (const target of pred.targets) {
        shapes.push({
          participatesIn: [pred.name],
          position: "object",
          inferredKind: target,
        });
      }
    }
  }

  // Convert linking rules to artifact mappings
  const artifactMappings: ArtifactMapping[] = [];
  const roleKinds = new Map<string, Set<string>>();

  for (const rule of pack.linkingRules) {
    // Add source role
    if (!roleKinds.has(rule.sourceRole)) {
      roleKinds.set(rule.sourceRole, new Set());
    }
    if (rule.sourceKind) {
      roleKinds.get(rule.sourceRole)!.add(rule.sourceKind);
    }

    // Add target role
    if (!roleKinds.has(rule.targetRole)) {
      roleKinds.set(rule.targetRole, new Set());
    }
    if (rule.targetKind) {
      roleKinds.get(rule.targetRole)!.add(rule.targetKind);
    }
  }

  for (const [role, kindsSet] of roleKinds) {
    artifactMappings.push({
      role,
      kinds: Array.from(kindsSet),
    });
  }

  // If no artifact mappings from linking rules, use defaults
  if (artifactMappings.length === 0) {
    artifactMappings.push(
      { role: "prompt", kinds: ["requirement", "concept", "question"] },
      { role: "spec", kinds: ["requirement", "component", "role", "action"] },
      { role: "impl", kinds: ["function", "class", "module", "interface"] },
    );
  }

  return {
    name: pack.meta.name,
    version: pack.meta.version,
    kinds,
    predicates,
    shapes,
    artifactMappings,
    confidenceThreshold: 0.5,
  };
}

// =============================================================================
// Profile Discovery
// =============================================================================

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
 * Get profile search paths in discovery order
 */
function getProfileSearchPaths(options: ProfileDiscoveryOptions): string[] {
  const paths: string[] = [];

  // 1. Explicit path (CLI --profile <path>)
  if (options.explicitPath) {
    paths.push(options.explicitPath);
  }

  // 2. Workspace-local (.iw/profiles/)
  if (options.workspaceRoot) {
    paths.push(path.join(options.workspaceRoot, ".iw", "profiles"));
  }

  // 3. Additional search paths
  if (options.searchPaths) {
    paths.push(...options.searchPaths);
  }

  // 4. Global (~/.iw/profiles/)
  const homeDir = process.env.HOME ?? process.env.USERPROFILE;
  if (homeDir) {
    paths.push(path.join(homeDir, ".iw", "profiles"));
  }

  return paths;
}

/**
 * Try to load a profile pack from a directory
 */
async function tryLoadPackFromPath(
  profileName: string,
  basePath: string,
): Promise<ProfilePack | null> {
  // Try: basePath/<profileName>/v1/profile.yaml
  const packPath = path.join(basePath, profileName, "v1");
  const profileYamlPath = path.join(packPath, "profile.yaml");

  if (fs.existsSync(profileYamlPath)) {
    try {
      return await loadProfilePack(packPath, { validate: true });
    } catch {
      return null;
    }
  }

  // Try: basePath/<profileName>/profile.yaml
  const altPackPath = path.join(basePath, profileName);
  const altProfileYamlPath = path.join(altPackPath, "profile.yaml");

  if (fs.existsSync(altProfileYamlPath)) {
    try {
      return await loadProfilePack(altPackPath, { validate: true });
    } catch {
      return null;
    }
  }

  return null;
}

// =============================================================================
// Profile Loader Interface
// =============================================================================

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
  source: "builtin" | "file" | "package";
  /** Path to profile if loaded from file */
  path?: string;
}

// =============================================================================
// Profile Loader Functions
// =============================================================================

/**
 * Load a profile by name using discovery order:
 * 1. Explicit path (CLI --profile <path>)
 * 2. Workspace-local (.iw/profiles/)
 * 3. Global (~/.iw/profiles/)
 * 4. Built-in (starter, planpling)
 */
export function loadProfile(
  name: string,
  options: ProfileLoaderOptions = {},
): ProfileLoaderResult {
  const { allowUnknown = false } = options;

  // Discovery order for profile packs
  const searchPaths = getProfileSearchPaths({
    explicitPath: options.explicitPath,
    workspaceRoot: options.workspaceRoot,
    searchPaths: options.searchPaths,
  });

  // Try each search path (sync for backward compat)
  for (const basePath of searchPaths) {
    if (!fs.existsSync(basePath)) continue;

    // Try: basePath/<name>/v1/profile.yaml
    const packPathV1 = path.join(basePath, name, "v1");
    const profileYamlV1 = path.join(packPathV1, "profile.yaml");

    if (fs.existsSync(profileYamlV1)) {
      // Return placeholder - actual loading is async via loadProfileAsync
      return {
        profile: { ...STARTER_PROFILE, name },
        source: "package",
        path: packPathV1,
      };
    }

    // Try: basePath/<name>/profile.yaml
    const packPath = path.join(basePath, name);
    const profileYaml = path.join(packPath, "profile.yaml");

    if (fs.existsSync(profileYaml)) {
      return {
        profile: { ...STARTER_PROFILE, name },
        source: "package",
        path: packPath,
      };
    }
  }

  // Check built-in profiles
  const builtin = BUILTIN_PROFILES.get(name);
  if (builtin) {
    return {
      profile: builtin,
      source: "builtin",
    };
  }

  // Unknown profile
  if (allowUnknown) {
    return {
      profile: { ...STARTER_PROFILE, name },
      source: "builtin",
    };
  }

  throw new Error(
    `Unknown profile: "${name}". Available profiles: ${listProfiles().join(", ")}`,
  );
}

/**
 * Load a profile by name (async version with full pack loading)
 *
 * Discovery order:
 * 1. Explicit path (CLI --profile <path>)
 * 2. Workspace-local (.iw/profiles/)
 * 3. Global (~/.iw/profiles/)
 * 4. Built-in (starter, planpling)
 */
export async function loadProfileAsync(
  name: string,
  options: ProfileLoaderOptions = {},
): Promise<ProfileLoaderResult> {
  const { allowUnknown = false } = options;

  // Discovery order for profile packs
  const searchPaths = getProfileSearchPaths({
    explicitPath: options.explicitPath,
    workspaceRoot: options.workspaceRoot,
    searchPaths: options.searchPaths,
  });

  // Try each search path
  for (const basePath of searchPaths) {
    if (!fs.existsSync(basePath)) continue;

    const pack = await tryLoadPackFromPath(name, basePath);
    if (pack) {
      return {
        profile: profilePackToProfile(pack),
        source: "package",
        path: pack.packPath,
      };
    }
  }

  // Check built-in profiles
  const builtin = BUILTIN_PROFILES.get(name);
  if (builtin) {
    return {
      profile: builtin,
      source: "builtin",
    };
  }

  // Unknown profile
  if (allowUnknown) {
    return {
      profile: { ...STARTER_PROFILE, name },
      source: "builtin",
    };
  }

  throw new Error(
    `Unknown profile: "${name}". Available profiles: ${listProfiles().join(", ")}`,
  );
}

/**
 * Load multiple profiles and merge them (async version)
 */
export async function loadProfilesAsync(
  names: string[],
  options: ProfileLoaderOptions = {},
): Promise<Profile> {
  if (names.length === 0) {
    return STARTER_PROFILE;
  }

  const results = await Promise.all(
    names.map((name) => loadProfileAsync(name, options)),
  );
  const profiles = results.map((r) => r.profile);

  // Merge profiles (later overrides earlier)
  return profiles.reduce((merged, profile) => mergeProfiles(merged, profile));
}

/**
 * Load multiple profiles and merge them
 * Later profiles override earlier ones for conflicting values.
 */
export function loadProfiles(
  names: string[],
  options: ProfileLoaderOptions = {},
): Profile {
  if (names.length === 0) {
    return STARTER_PROFILE;
  }

  const profiles = names.map((name) => loadProfile(name, options).profile);

  // Merge profiles (later overrides earlier)
  return profiles.reduce((merged, profile) => mergeProfiles(merged, profile));
}

/**
 * List available profile names
 */
export function listProfiles(): string[] {
  return Array.from(BUILTIN_PROFILES.keys());
}

/**
 * Get the default profile
 */
export function getDefaultProfile(): Profile {
  return STARTER_PROFILE;
}

/**
 * Check if a profile exists
 */
export function hasProfile(name: string): boolean {
  return BUILTIN_PROFILES.has(name);
}

// =============================================================================
// Profile Merging
// =============================================================================

/**
 * Merge two profiles
 * The second profile's values override the first where they conflict.
 */
export function mergeProfiles(base: Profile, override: Profile): Profile {
  return {
    name: override.name,
    version: override.version,
    kinds: dedupeArray([...base.kinds, ...override.kinds]),
    predicates: dedupeArray([...base.predicates, ...override.predicates]),
    shapes: mergeShapes(base.shapes, override.shapes),
    artifactMappings: mergeArtifactMappings(
      base.artifactMappings,
      override.artifactMappings,
    ),
    confidenceThreshold:
      override.confidenceThreshold ?? base.confidenceThreshold,
  };
}

function dedupeArray<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function mergeShapes(base: ShapeRule[], override: ShapeRule[]): ShapeRule[] {
  // Simple concatenation with dedup by stringified rule
  const seen = new Set<string>();
  const result: ShapeRule[] = [];

  for (const rule of [...base, ...override]) {
    const key = JSON.stringify(rule);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(rule);
    }
  }

  return result;
}

function mergeArtifactMappings(
  base: ArtifactMapping[],
  override: ArtifactMapping[],
): ArtifactMapping[] {
  const byRole = new Map<string, ArtifactMapping>();

  // Add base mappings
  for (const mapping of base) {
    byRole.set(mapping.role, mapping);
  }

  // Override with new mappings (merge kinds and patterns)
  for (const mapping of override) {
    const existing = byRole.get(mapping.role);
    if (existing) {
      byRole.set(mapping.role, {
        role: mapping.role,
        kinds: dedupeArray([...existing.kinds, ...mapping.kinds]),
        patterns: dedupeArray([
          ...(existing.patterns ?? []),
          ...(mapping.patterns ?? []),
        ]),
      });
    } else {
      byRole.set(mapping.role, mapping);
    }
  }

  return Array.from(byRole.values());
}

// =============================================================================
// Shape Inference (used by CX stage)
// =============================================================================

/**
 * Infer entity kind based on shape rules and relationships
 */
export function inferKindFromShapes(
  entityCgId: string,
  currentKind: string,
  relationships: Array<{ predicate: string; isSubject: boolean }>,
  profile: Profile,
): { inferredKind: string; rule?: ShapeRule } | null {
  for (const rule of profile.shapes) {
    // Check if entity participates in any of the required predicates
    for (const rel of relationships) {
      if (!rule.participatesIn.includes(rel.predicate)) {
        continue;
      }

      // Check position constraint
      const positionMatches =
        rule.position === "any" ||
        (rule.position === "subject" && rel.isSubject) ||
        (rule.position === "object" && !rel.isSubject);

      if (positionMatches) {
        // Only infer if current kind is generic or wrong
        if (currentKind !== rule.inferredKind) {
          return { inferredKind: rule.inferredKind, rule };
        }
      }
    }
  }

  return null;
}

/**
 * Get artifact role from file path based on profile mappings
 */
export function inferArtifactRole(
  filePath: string,
  profile: Profile,
): string | undefined {
  const fileName = filePath.split("/").pop() ?? filePath;

  for (const mapping of profile.artifactMappings) {
    if (!mapping.patterns) continue;

    for (const pattern of mapping.patterns) {
      // Simple pattern matching (Phase 2: basic glob-like)
      if (matchPattern(filePath, pattern) || matchPattern(fileName, pattern)) {
        return mapping.role;
      }
    }
  }

  return undefined;
}

/**
 * Simple pattern matching (Phase 2 implementation)
 * Supports: *, **, .ext
 */
function matchPattern(path: string, pattern: string): boolean {
  // Convert glob pattern to regex
  // Order matters: escape dots first, then replace globs
  const regexPattern = pattern
    .replace(/\./g, "\\.") // Escape dots first
    .replace(/\*\*/g, ".*") // Then ** becomes .*
    .replace(/\*/g, "[^/]*"); // Then * becomes [^/]*

  try {
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  } catch {
    return false;
  }
}
