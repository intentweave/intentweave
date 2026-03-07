/**
 * @file Profile Pack Loader
 * @description Loads and validates profile packs from disk
 *
 * Profile packs are directories containing:
 * - profile.yaml: Main profile configuration
 * - shapes.yaml (optional): Entity shape definitions
 * - rules/*.yaml (optional): Validation rules
 *
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'yaml';

// =============================================================================
// Types
// =============================================================================

/**
 * Entity kind definition in a profile pack
 */
export interface KindDefinition {
  /** Kind identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Description */
  description?: string;
  /** Parent kind (for inheritance) */
  extends?: string;
  /** Expected artifact roles */
  roles?: string[];
  /** Color for visualization */
  color?: string;
  /** Icon name */
  icon?: string;
}

/**
 * Shape definition - what relationships an entity kind can have
 */
export interface ShapeDefinition {
  /** Subject kind */
  subject: string;
  /** Allowed predicates */
  predicates: ShapePredicate[];
}

/**
 * Predicate in a shape
 */
export interface ShapePredicate {
  /** Predicate name */
  name: string;
  /** Target kind(s) */
  targets: string[];
  /** Minimum cardinality */
  minCard?: number;
  /** Maximum cardinality */
  maxCard?: number;
  /** Whether this predicate is required */
  required?: boolean;
}

/**
 * Validation rule definition
 */
export interface RuleDefinition {
  /** Rule identifier */
  id: string;
  /** Rule name */
  name: string;
  /** Rule description */
  description: string;
  /** Rule type */
  type:
    | 'missing-edge'
    | 'shape-violation'
    | 'coverage-target'
    | 'forbidden-kind'
    | 'cardinality-violation'
    | 'orphan-entity'
    | 'semantic-contradiction'
    | 'semantic-ambiguity'
    | 'semantic-tension'
    | 'semantic-coverage'
    | 'issue-entity'
    | 'custom';
  /** Severity */
  severity: 'error' | 'warning' | 'info';
  /** Condition parameters */
  condition: Record<string, unknown>;
  /** Rule message template */
  message: string;
  /** Whether rule is enabled */
  enabled?: boolean;
}

/**
 * Kind-to-kind linking rule for LX stage
 */
export interface LinkingRule {
  /** Source artifact role */
  sourceRole: string;
  /** Target artifact role */
  targetRole: string;
  /** Source kind */
  sourceKind?: string;
  /** Target kind */
  targetKind?: string;
  /** Link predicate */
  predicate: string;
  /** Base confidence for this rule */
  confidence: number;
}

/**
 * Complete profile pack loaded from disk
 */
export interface ProfilePack {
  /** Pack metadata */
  meta: {
    /** Pack name */
    name: string;
    /** Pack version */
    version: string;
    /** Description */
    description?: string;
    /** Author */
    author?: string;
    /** Base pack to extend */
    extends?: string;
  };

  /** Kind definitions */
  kinds: KindDefinition[];

  /** Shape definitions */
  shapes: ShapeDefinition[];

  /** Validation rules */
  rules: RuleDefinition[];

  /** Linking rules */
  linkingRules: LinkingRule[];

  /** Pack directory path */
  packPath: string;
}

/**
 * YAML structure for profile.yaml
 */
interface ProfileYaml {
  name: string;
  version: string;
  description?: string;
  author?: string;
  extends?: string;
  kinds?: Array<{
    id: string;
    label: string;
    description?: string;
    extends?: string;
    roles?: string[];
    color?: string;
    icon?: string;
  }>;
  linking?: Array<{
    sourceRole: string;
    targetRole: string;
    sourceKind?: string;
    targetKind?: string;
    predicate: string;
    confidence?: number;
  }>;
}

/**
 * YAML structure for shapes.yaml
 */
interface ShapesYaml {
  shapes: Array<{
    subject: string;
    predicates: Array<{
      name: string;
      targets: string | string[];
      minCard?: number;
      maxCard?: number;
      required?: boolean;
    }>;
  }>;
}

/**
 * YAML structure for rule files
 */
interface RulesYaml {
  rules: Array<{
    id: string;
    name: string;
    description: string;
    type: string;
    severity?: string;
    condition: Record<string, unknown>;
    message: string;
    enabled?: boolean;
  }>;
}

/**
 * Options for profile pack loading
 */
export interface LoadPackOptions {
  /** Validate the pack structure */
  validate?: boolean;
  /** Resolve extends inheritance */
  resolveExtends?: boolean;
  /** Base directory for resolving extends */
  baseDir?: string;
}

// =============================================================================
// Pack Loader
// =============================================================================

/**
 * Load a profile pack from a directory
 */
export async function loadProfilePack(
  packPath: string,
  options: LoadPackOptions = {}
): Promise<ProfilePack> {
  const { validate = true, resolveExtends = true, baseDir } = options;

  // Check if directory exists
  const stats = await fs.stat(packPath);
  if (!stats.isDirectory()) {
    throw new Error(`Profile pack path is not a directory: ${packPath}`);
  }

  // Load profile.yaml (required)
  const profilePath = path.join(packPath, 'profile.yaml');
  const profileYaml = await loadYamlFile<ProfileYaml>(profilePath);

  // Load shapes.yaml (optional)
  const shapesPath = path.join(packPath, 'shapes.yaml');
  const shapesYaml = await loadYamlFileSafe<ShapesYaml>(shapesPath);

  // Load rules from rules/*.yaml (optional)
  const rulesDir = path.join(packPath, 'rules');
  const rules = await loadRulesFromDir(rulesDir);

  // Build the pack
  let pack: ProfilePack = {
    meta: {
      name: profileYaml.name,
      version: profileYaml.version,
      description: profileYaml.description,
      author: profileYaml.author,
      extends: profileYaml.extends,
    },
    kinds: (profileYaml.kinds ?? []).map(k => ({
      id: k.id,
      label: k.label,
      description: k.description,
      extends: k.extends,
      roles: k.roles,
      color: k.color,
      icon: k.icon,
    })),
    shapes: (shapesYaml?.shapes ?? []).map(s => ({
      subject: s.subject,
      predicates: s.predicates.map(p => ({
        name: p.name,
        targets: Array.isArray(p.targets) ? p.targets : [p.targets],
        minCard: p.minCard,
        maxCard: p.maxCard,
        required: p.required,
      })),
    })),
    rules,
    linkingRules: (profileYaml.linking ?? []).map(l => ({
      sourceRole: l.sourceRole,
      targetRole: l.targetRole,
      sourceKind: l.sourceKind,
      targetKind: l.targetKind,
      predicate: l.predicate,
      confidence: l.confidence ?? 0.8,
    })),
    packPath,
  };

  // Resolve extends
  if (resolveExtends && pack.meta.extends) {
    const basePath = baseDir ?? path.dirname(packPath);
    const basePackPath = path.join(basePath, pack.meta.extends);
    try {
      const basePack = await loadProfilePack(basePackPath, {
        validate: false,
        resolveExtends: true,
        baseDir: basePath,
      });
      pack = mergeProfilePacks(basePack, pack);
    } catch (error) {
      throw new Error(
        `Failed to load base pack "${pack.meta.extends}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Validate
  if (validate) {
    validateProfilePack(pack);
  }

  return pack;
}

/**
 * Merge two profile packs (base and overlay)
 */
function mergeProfilePacks(base: ProfilePack, overlay: ProfilePack): ProfilePack {
  // Merge kinds - overlay wins for duplicates
  const kindsById = new Map<string, KindDefinition>();
  for (const kind of base.kinds) {
    kindsById.set(kind.id, kind);
  }
  for (const kind of overlay.kinds) {
    kindsById.set(kind.id, kind);
  }

  // Merge shapes - overlay wins for duplicates
  const shapesBySubject = new Map<string, ShapeDefinition>();
  for (const shape of base.shapes) {
    shapesBySubject.set(shape.subject, shape);
  }
  for (const shape of overlay.shapes) {
    shapesBySubject.set(shape.subject, shape);
  }

  // Merge rules - overlay wins for duplicates
  const rulesById = new Map<string, RuleDefinition>();
  for (const rule of base.rules) {
    rulesById.set(rule.id, rule);
  }
  for (const rule of overlay.rules) {
    rulesById.set(rule.id, rule);
  }

  // Merge linking rules (concatenate, no dedup)
  const linkingRules = [...base.linkingRules, ...overlay.linkingRules];

  return {
    meta: {
      ...base.meta,
      ...overlay.meta,
      extends: undefined, // Already resolved
    },
    kinds: Array.from(kindsById.values()),
    shapes: Array.from(shapesBySubject.values()),
    rules: Array.from(rulesById.values()),
    linkingRules,
    packPath: overlay.packPath,
  };
}

// =============================================================================
// YAML Loading Helpers
// =============================================================================

/**
 * Load a YAML file and parse it
 */
async function loadYamlFile<T>(filePath: string): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.parse(content) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`Required file not found: ${filePath}`);
    }
    throw new Error(`Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load a YAML file, returning null if not found
 */
async function loadYamlFileSafe<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.parse(content) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Load all rule files from a directory
 */
async function loadRulesFromDir(rulesDir: string): Promise<RuleDefinition[]> {
  const rules: RuleDefinition[] = [];

  try {
    const entries = await fs.readdir(rulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        const rulePath = path.join(rulesDir, entry.name);
        const rulesYaml = await loadYamlFile<RulesYaml>(rulePath);
        for (const rule of rulesYaml.rules ?? []) {
          rules.push({
            id: rule.id,
            name: rule.name,
            description: rule.description,
            type: rule.type as RuleDefinition['type'],
            severity: (rule.severity as RuleDefinition['severity']) ?? 'warning',
            condition: rule.condition,
            message: rule.message,
            enabled: rule.enabled ?? true,
          });
        }
      }
    }
  } catch (error) {
    // Rules directory doesn't exist - that's fine
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return rules;
}

/**
 * Type guard for Node.js errors
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a profile pack structure
 */
export function validateProfilePack(pack: ProfilePack): void {
  const errors: string[] = [];

  // Validate meta
  if (!pack.meta.name) {
    errors.push('Profile pack must have a name');
  }
  if (!pack.meta.version) {
    errors.push('Profile pack must have a version');
  }

  // Validate kinds
  const kindIds = new Set<string>();
  for (const kind of pack.kinds) {
    if (!kind.id) {
      errors.push('Kind must have an id');
    }
    if (!kind.label) {
      errors.push(`Kind "${kind.id}" must have a label`);
    }
    if (kindIds.has(kind.id)) {
      errors.push(`Duplicate kind id: ${kind.id}`);
    }
    kindIds.add(kind.id);

    if (kind.extends && !kindIds.has(kind.extends)) {
      // Check if extends exists in the pack
      const extendsExists = pack.kinds.some(k => k.id === kind.extends);
      if (!extendsExists) {
        errors.push(`Kind "${kind.id}" extends unknown kind "${kind.extends}"`);
      }
    }
  }

  // Validate shapes reference valid kinds
  for (const shape of pack.shapes) {
    if (!kindIds.has(shape.subject)) {
      errors.push(`Shape subject "${shape.subject}" is not a defined kind`);
    }
    for (const pred of shape.predicates) {
      for (const target of pred.targets) {
        if (!kindIds.has(target)) {
          errors.push(
            `Shape predicate "${pred.name}" on "${shape.subject}" references undefined kind "${target}"`
          );
        }
      }
    }
  }

  // Validate rules
  const ruleIds = new Set<string>();
  for (const rule of pack.rules) {
    if (!rule.id) {
      errors.push('Rule must have an id');
    }
    if (!rule.name) {
      errors.push(`Rule "${rule.id}" must have a name`);
    }
    if (!rule.type) {
      errors.push(`Rule "${rule.id}" must have a type`);
    }
    if (ruleIds.has(rule.id)) {
      errors.push(`Duplicate rule id: ${rule.id}`);
    }
    ruleIds.add(rule.id);
  }

  if (errors.length > 0) {
    throw new Error(`Profile pack validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

// =============================================================================
// Pack Discovery
// =============================================================================

/**
 * Discover profile packs in a directory
 */
export async function discoverProfilePacks(searchDir: string): Promise<string[]> {
  const packs: string[] = [];

  try {
    const entries = await fs.readdir(searchDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const packPath = path.join(searchDir, entry.name);
        const profilePath = path.join(packPath, 'profile.yaml');
        try {
          await fs.access(profilePath);
          packs.push(packPath);
        } catch {
          // Not a pack directory
        }
      }
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return packs;
}

/**
 * Create an empty profile pack structure
 */
export function createEmptyProfilePack(name: string, version = '1.0.0'): ProfilePack {
  return {
    meta: {
      name,
      version,
    },
    kinds: [],
    shapes: [],
    rules: [],
    linkingRules: [],
    packPath: '',
  };
}

// =============================================================================
// Default Pack
// =============================================================================

/**
 * Get the default built-in profile pack
 */
export function getDefaultProfilePack(): ProfilePack {
  return {
    meta: {
      name: 'default',
      version: '1.0.0',
      description: 'Default IntentWeave profile pack',
    },
    kinds: [
      { id: 'resource', label: 'Resource', description: 'A domain resource or entity' },
      { id: 'state', label: 'State', description: 'A state an entity can be in' },
      { id: 'action', label: 'Action', description: 'An action that can be performed' },
      { id: 'event', label: 'Event', description: 'A domain event' },
      { id: 'role', label: 'Role', description: 'An actor or user role' },
      { id: 'service', label: 'Service', description: 'A service or component' },
      { id: 'transition', label: 'Transition', description: 'A state transition' },
    ],
    shapes: [
      {
        subject: 'resource',
        predicates: [
          { name: 'HAS_STATE', targets: ['state'], required: false },
          { name: 'TRIGGERS', targets: ['event'], required: false },
        ],
      },
      {
        subject: 'role',
        predicates: [
          { name: 'CAN', targets: ['action'], required: false },
          { name: 'OWNS', targets: ['resource'], required: false },
        ],
      },
      {
        subject: 'action',
        predicates: [
          { name: 'AFFECTS', targets: ['resource'], required: false },
          { name: 'TRIGGERS', targets: ['event'], required: false },
        ],
      },
      {
        subject: 'transition',
        predicates: [
          { name: 'FROM_STATE', targets: ['state'], required: true },
          { name: 'TO_STATE', targets: ['state'], required: true },
          { name: 'WHEN', targets: ['event'], required: false },
        ],
      },
    ],
    rules: [],
    linkingRules: [
      { sourceRole: 'intent', targetRole: 'spec', predicate: 'REFINES', confidence: 0.9 },
      { sourceRole: 'spec', targetRole: 'code', predicate: 'IMPLEMENTS', confidence: 0.85 },
      { sourceRole: 'code', targetRole: 'test', predicate: 'TESTED_BY', confidence: 0.8 },
    ],
    packPath: '<built-in>',
  };
}
