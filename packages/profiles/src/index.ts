/**
 * @intentweave/profiles
 * 
 * Analysis profile system for IntentWeave.
 * Profiles configure extraction strategies, LLM settings, and output formats.
 */

import type { EntityType } from '@intentweave/core';

// Re-export profile pack loader
export {
  loadProfilePack,
  validateProfilePack,
  discoverProfilePacks,
  createEmptyProfilePack,
  getDefaultProfilePack,
  type ProfilePack,
  type KindDefinition,
  type ShapeDefinition,
  type ShapePredicate,
  type RuleDefinition,
  type LinkingRule,
  type LoadPackOptions,
} from './loader.js';

/**
 * Profile definition
 */
export interface Profile {
  /** Unique profile name */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Profile version */
  version: string;
  
  /** Base profile to extend (optional) */
  extends?: string;
  
  /** Extractor configuration */
  extractors: ExtractorConfig[];
  
  /** Entity types to extract */
  entityTypes: EntityType[];
  
  /** LLM configuration */
  llm?: LLMConfig;
  
  /** Output configuration */
  output?: OutputConfig;
  
  /** File patterns to include/exclude */
  files?: FilePatterns;
}

/**
 * Extractor configuration within a profile
 */
export interface ExtractorConfig {
  /** Extractor name */
  name: string;
  
  /** Is this extractor enabled */
  enabled: boolean;
  
  /** Extractor-specific options */
  options?: Record<string, unknown>;
}

/**
 * LLM configuration
 */
export interface LLMConfig {
  /** LLM provider name */
  provider: string;
  
  /** Model name */
  model?: string;
  
  /** Temperature for generation */
  temperature?: number;
  
  /** Maximum tokens */
  maxTokens?: number;
  
  /** Enable LLM extraction */
  enabled: boolean;
  
  /** Provider-specific options */
  options?: Record<string, unknown>;
}

/**
 * Output configuration
 */
export interface OutputConfig {
  /** Output format */
  format: 'json' | 'cypher' | 'graphml';
  
  /** Pretty print output */
  prettyPrint?: boolean;
  
  /** Include evidence in output */
  includeEvidence?: boolean;
  
  /** Include metadata in output */
  includeMetadata?: boolean;
}

/**
 * File inclusion/exclusion patterns
 */
export interface FilePatterns {
  /** Glob patterns to include */
  include?: string[];
  
  /** Glob patterns to exclude */
  exclude?: string[];
  
  /** File extensions to process */
  extensions?: string[];
}

/**
 * Profile registry - manages available profiles
 */
export class ProfileRegistry {
  private profiles: Map<string, Profile> = new Map();
  
  /**
   * Register a profile
   */
  register(profile: Profile): void {
    this.profiles.set(profile.name, profile);
  }
  
  /**
   * Get a profile by name
   */
  get(name: string): Profile | undefined {
    return this.profiles.get(name);
  }
  
  /**
   * Get all profile names
   */
  list(): string[] {
    return Array.from(this.profiles.keys());
  }
  
  /**
   * Resolve a profile with inheritance
   */
  resolve(name: string): Profile | null {
    const profile = this.profiles.get(name);
    if (!profile) return null;
    
    if (!profile.extends) {
      return profile;
    }
    
    const base = this.resolve(profile.extends);
    if (!base) {
      return profile;
    }
    
    // Merge base profile with this profile
    const merged: Profile = {
      ...base,
      ...profile,
      extractors: [...base.extractors, ...profile.extractors],
      entityTypes: [...new Set([...base.entityTypes, ...profile.entityTypes])],
    };
    
    // Merge optional properties only if both exist
    if (base.llm || profile.llm) {
      merged.llm = {
        provider: profile.llm?.provider ?? base.llm?.provider ?? 'none',
        enabled: profile.llm?.enabled ?? base.llm?.enabled ?? false,
        ...base.llm,
        ...profile.llm,
      };
    }
    
    if (base.output || profile.output) {
      merged.output = {
        format: profile.output?.format ?? base.output?.format ?? 'json',
        ...base.output,
        ...profile.output,
      };
    }
    
    if (base.files || profile.files) {
      merged.files = {
        include: [...(base.files?.include ?? []), ...(profile.files?.include ?? [])],
        exclude: [...(base.files?.exclude ?? []), ...(profile.files?.exclude ?? [])],
        extensions: [...new Set([...(base.files?.extensions ?? []), ...(profile.files?.extensions ?? [])])],
      };
    }
    
    return merged;
  }
}

/**
 * Global profile registry
 */
export const profileRegistry = new ProfileRegistry();

/**
 * Built-in profiles
 */
export const BuiltInProfiles = {
  /** Minimal profile - fast extraction with no LLM */
  minimal: {
    name: 'minimal',
    description: 'Fast extraction without LLM assistance',
    version: '1.0.0',
    extractors: [
      { name: 'markdown', enabled: true },
    ],
    entityTypes: ['resource', 'state', 'action'] as EntityType[],
    llm: { provider: 'none', enabled: false },
    output: { format: 'json' as const },
  } satisfies Profile,
  
  /** Standard profile - balanced extraction */
  standard: {
    name: 'standard',
    description: 'Balanced extraction with optional LLM enhancement',
    version: '1.0.0',
    extractors: [
      { name: 'markdown', enabled: true },
      { name: 'transitions', enabled: true },
    ],
    entityTypes: ['resource', 'state', 'action', 'role', 'event', 'transition'] as EntityType[],
    llm: { provider: 'openai', enabled: false },
    output: { format: 'json' as const, includeEvidence: true },
  } satisfies Profile,
  
  /** Full profile - comprehensive extraction with LLM */
  full: {
    name: 'full',
    description: 'Comprehensive extraction with LLM assistance',
    version: '1.0.0',
    extends: 'standard',
    extractors: [
      { name: 'markdown', enabled: true },
      { name: 'transitions', enabled: true },
      { name: 'llm', enabled: true },
    ],
    entityTypes: [
      'resource', 'state', 'action', 'role', 'event', 
      'endpoint', 'condition', 'decision', 'transition',
      'service', 'store', 'topic',
    ] as EntityType[],
    llm: { provider: 'openai', enabled: true, model: 'gpt-4o' },
    output: { format: 'json' as const, includeEvidence: true, includeMetadata: true },
  } satisfies Profile,
};

// Register built-in profiles
Object.values(BuiltInProfiles).forEach(p => profileRegistry.register(p));

/**
 * Load a profile from a file path
 */
export async function loadProfile(filePath: string): Promise<Profile> {
  // TODO: Implement file loading with zod validation
  throw new Error('Not implemented: loadProfile');
}

/**
 * Validate a profile object
 */
export function validateProfile(profile: unknown): profile is Profile {
  if (!profile || typeof profile !== 'object') return false;
  
  const p = profile as Record<string, unknown>;
  return (
    typeof p.name === 'string' &&
    typeof p.description === 'string' &&
    typeof p.version === 'string' &&
    Array.isArray(p.extractors) &&
    Array.isArray(p.entityTypes)
  );
}
