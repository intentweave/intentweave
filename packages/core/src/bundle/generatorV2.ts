// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Graph Bundle V2 Generator
 * 
 * Generates consolidated bundle files with evidence and weave layers.
 * 
 * V2 adds:
 * - Evidence table with dual anchoring
 * - Raw layer (entities/statements as extracted)
 * - Weave layer (canonical entities/statements)
 * - LX links with canonical references
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import type {
  GraphBundleV2,
  ArtifactSummary,
  RawEntity,
  RawStatement,
  EvidenceRecord,
  WeaveResult,
  LxLink,
} from '../weave/types.js';
import type { ArtifactRole } from '../weave/normalize.js';
import { executeWeave } from '../weave/executor.js';
import { loadRegistry, loadOverrides, createEmptyRegistry } from '../weave/registry.js';

// =============================================================================
// Types
// =============================================================================

export interface GenerateBundleV2Input {
  /** Path to the run directory */
  runDir: string;
  /** Path to the .iw directory (for registry/overrides) */
  iwDir?: string;
  /** Bundle generation options */
  options?: BundleV2Options;
}

export interface BundleV2Options {
  /** Run the WX (weave) stage */
  weave?: boolean;
  /** Include LX proposals */
  includeLx?: boolean;
  /** Threshold for switching to JSONL format */
  jsonlThreshold?: number;
  /** Pretty print JSON output */
  prettyPrint?: boolean;
}

const DEFAULT_OPTIONS: Required<BundleV2Options> = {
  weave: true,
  includeLx: true,
  jsonlThreshold: 10000,
  prettyPrint: true,
};

export interface GenerateBundleV2Result {
  bundle: GraphBundleV2;
  bundlePath: string;
  format: 'json' | 'jsonl';
  stats: {
    artifactCount: number;
    rawEntityCount: number;
    rawStatementCount: number;
    canonicalEntityCount: number;
    canonicalStatementCount: number;
    evidenceCount: number;
    lxCount: number;
  };
}

// =============================================================================
// Generator
// =============================================================================

export async function generateBundleV2(
  input: GenerateBundleV2Input
): Promise<GenerateBundleV2Result> {
  const { runDir, iwDir } = input;
  const options = { ...DEFAULT_OPTIONS, ...input.options };

  // Load run metadata
  const metaPath = join(runDir, 'run.meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf-8'));

  // Collect raw data from artifacts
  const { artifacts, rawEntities, rawStatements, evidence } = await collectRawData(runDir);

  // Run WX (weave) if enabled
  let weaveResult: WeaveResult | undefined;
  if (options.weave && rawEntities.length > 0) {
    const registry = iwDir ? await loadRegistry(iwDir) : createEmptyRegistry();
    const overrides = iwDir ? await loadOverrides(iwDir) : undefined;

    weaveResult = executeWeave(
      {
        entities: rawEntities,
        statements: rawStatements,
        evidence,
        registry,
        overrides,
      },
      { sameRoleOnly: true, warnOnConflict: true }
    );
  }

  // Load LX proposals
  let lxLinks: LxLink[] = [];
  if (options.includeLx) {
    lxLinks = await loadLxLinks(runDir, weaveResult);
  }

  // Build bundle
  const bundle: GraphBundleV2 = {
    $schema: 'intentweave://schemas/graph-bundle/v2',
    schemaVersion: '0.2',
    runId: meta.runId,
    sessionKey: meta.sessionKey,
    generatedAt: new Date().toISOString(),
    artifacts,
    evidence: weaveResult?.evidence ?? evidence,
    raw: {
      entities: rawEntities,
      statements: rawStatements,
    },
    weave: weaveResult,
    lx: lxLinks.length > 0 ? { links: lxLinks } : undefined,
  };

  // Create bundle directory
  const bundleDir = join(runDir, 'bundle');
  await mkdir(bundleDir, { recursive: true });

  // Determine format and write
  const totalRecords =
    rawEntities.length +
    rawStatements.length +
    evidence.length +
    (weaveResult?.entities.length ?? 0) +
    (weaveResult?.statements.length ?? 0) +
    lxLinks.length;

  const useJsonl = totalRecords > options.jsonlThreshold;
  let bundlePath: string;

  if (useJsonl) {
    bundlePath = await writeJsonlBundle(bundleDir, bundle);
  } else {
    bundlePath = await writeJsonBundle(bundleDir, bundle, options.prettyPrint);
  }

  return {
    bundle,
    bundlePath,
    format: useJsonl ? 'jsonl' : 'json',
    stats: {
      artifactCount: artifacts.length,
      rawEntityCount: rawEntities.length,
      rawStatementCount: rawStatements.length,
      canonicalEntityCount: weaveResult?.entities.length ?? 0,
      canonicalStatementCount: weaveResult?.statements.length ?? 0,
      evidenceCount: bundle.evidence.length,
      lxCount: lxLinks.length,
    },
  };
}

// =============================================================================
// Data Collection
// =============================================================================

interface CollectedData {
  artifacts: ArtifactSummary[];
  rawEntities: RawEntity[];
  rawStatements: RawStatement[];
  evidence: EvidenceRecord[];
}

async function collectRawData(runDir: string): Promise<CollectedData> {
  const artifacts: ArtifactSummary[] = [];
  const rawEntities: RawEntity[] = [];
  const rawStatements: RawStatement[] = [];
  const evidence: EvidenceRecord[] = [];
  const evidenceIdSet = new Set<string>();

  const artifactsDir = join(runDir, 'artifacts');
  if (!existsSync(artifactsDir)) {
    return { artifacts, rawEntities, rawStatements, evidence };
  }

  const artifactDirs = await readdir(artifactsDir, { withFileTypes: true });

  for (const dir of artifactDirs.filter((d) => d.isDirectory())) {
    const pxPath = join(artifactsDir, dir.name, 'px.json');
    if (!existsSync(pxPath)) continue;

    try {
      const px = JSON.parse(await readFile(pxPath, 'utf-8'));
      const artifactId = dir.name;
      const artifactRole = (px.artifactRole || 'unknown') as ArtifactRole;

      artifacts.push({
        id: artifactId,
        path: dir.name.replace(/_/g, '/'),
        role: artifactRole,
        versionId: px.versionId,
        entityCount: px.entities?.length || 0,
        statementCount: px.statements?.length || 0,
      });

      // Convert entities to RawEntity format
      for (const e of px.entities || []) {
        const entityEvidenceIds: string[] = [];
        
        // Extract evidence from entity if present
        if (e.evidence) {
          for (const ev of e.evidence) {
            const evRecord = convertToEvidenceRecord(ev, artifactId, px.versionId);
            if (evRecord && !evidenceIdSet.has(evRecord.id)) {
              evidence.push(evRecord);
              evidenceIdSet.add(evRecord.id);
            }
            if (evRecord) {
              entityEvidenceIds.push(evRecord.id);
            }
          }
        }

        rawEntities.push({
          cgId: e.cgId,
          artifactId,
          artifactRole,
          type: e.type || 'unknown',
          name: e.name,
          evidenceIds: entityEvidenceIds.length > 0 ? entityEvidenceIds : undefined,
          properties: e.properties,
        });
      }

      // Convert statements to RawStatement format
      for (const s of px.statements || []) {
        const stmtEvidenceIds: string[] = [];

        // Extract evidence from statement if present
        if (s.evidence) {
          for (const ev of s.evidence) {
            const evRecord = convertToEvidenceRecord(ev, artifactId, px.versionId);
            if (evRecord && !evidenceIdSet.has(evRecord.id)) {
              evidence.push(evRecord);
              evidenceIdSet.add(evRecord.id);
            }
            if (evRecord) {
              stmtEvidenceIds.push(evRecord.id);
            }
          }
        }

        rawStatements.push({
          id: s.id || `${artifactId}:stmt:${rawStatements.length}`,
          subjectCgId: s.subjectCgId,
          predicate: s.predicate,
          objectCgId: s.objectCgId,
          objectLiteral: s.objectLiteral,
          evidenceIds: stmtEvidenceIds.length > 0 ? stmtEvidenceIds : undefined,
        });
      }
    } catch {
      // Skip invalid artifacts
    }
  }

  return { artifacts, rawEntities, rawStatements, evidence };
}

/**
 * Convert legacy evidence format to EvidenceRecord.
 */
function convertToEvidenceRecord(
  ev: unknown,
  artifactId: string,
  versionId?: string
): EvidenceRecord | null {
  if (!ev || typeof ev !== 'object') return null;

  const legacy = ev as Record<string, unknown>;
  const sourceKey = legacy.sourceKey as string | undefined;
  const excerpt = (legacy.excerpt as string | undefined) ?? '';

  if (!sourceKey && !excerpt) return null;

  // Generate a simple evidence ID
  const idInput = [
    artifactId,
    versionId ?? 'unknown',
    sourceKey ?? '',
    excerpt.slice(0, 50),
  ].join('|');
  
  const id = `ev_${simpleHash(idInput)}`;

  // Generate logical key from content
  const logicalKey = simpleHash([artifactId, excerpt].join('|'));

  // Generate excerpt hash
  const excerptHash = simpleHash(excerpt);

  return {
    id,
    logicalKey,
    kind: 'file',
    ref: {
      artifactId,
      artifactVersionId: versionId,
      uri: sourceKey ?? artifactId,
    },
    locator: legacy.lineStart !== undefined ? {
      lineStart: legacy.lineStart as number,
      lineEnd: legacy.lineEnd as number,
    } : undefined,
    excerpt: excerpt.slice(0, 200),
    excerptHash,
  };
}

/**
 * Simple hash function for ID generation.
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// =============================================================================
// LX Loading
// =============================================================================

async function loadLxLinks(
  runDir: string,
  weaveResult?: WeaveResult
): Promise<LxLink[]> {
  const links: LxLink[] = [];
  const lxPath = join(runDir, 'aggregate', 'lx.proposals.json');

  if (!existsSync(lxPath)) {
    return links;
  }

  try {
    const lxData = JSON.parse(await readFile(lxPath, 'utf-8'));

    // Build cgId -> canonicalId map if weave result exists
    const cgIdToCanonical = new Map<string, string>();
    if (weaveResult) {
      for (const ce of weaveResult.entities) {
        for (const cgId of ce.memberCgIds) {
          cgIdToCanonical.set(cgId, ce.canonicalId);
        }
      }
    }

    for (const p of lxData.proposals || []) {
      // Resolve to canonical if possible
      const sourceCanonical = cgIdToCanonical.get(p.sourceCgId);
      const targetCanonical = cgIdToCanonical.get(p.targetCgId);

      links.push({
        id: p.id,
        sourceId: sourceCanonical ?? p.sourceCgId,
        sourceIsCanonical: !!sourceCanonical,
        targetId: targetCanonical ?? p.targetCgId,
        targetIsCanonical: !!targetCanonical,
        predicate: p.predicate,
        confidence: p.confidence,
        matchMethod: p.matchMethod,
        evidenceIds: p.evidenceIds,
      });
    }
  } catch {
    // Skip invalid LX file
  }

  return links;
}

// =============================================================================
// Bundle Writing
// =============================================================================

async function writeJsonBundle(
  bundleDir: string,
  bundle: GraphBundleV2,
  prettyPrint: boolean
): Promise<string> {
  const bundlePath = join(bundleDir, 'graph.v2.json');
  const content = prettyPrint
    ? JSON.stringify(bundle, null, 2)
    : JSON.stringify(bundle);
  await writeFile(bundlePath, content);
  return bundlePath;
}

async function writeJsonlBundle(
  bundleDir: string,
  bundle: GraphBundleV2
): Promise<string> {
  // Write meta
  const metaPath = join(bundleDir, 'meta.v2.json');
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        $schema: bundle.$schema,
        schemaVersion: bundle.schemaVersion,
        runId: bundle.runId,
        sessionKey: bundle.sessionKey,
        generatedAt: bundle.generatedAt,
        stats: {
          artifactCount: bundle.artifacts.length,
          rawEntityCount: bundle.raw.entities.length,
          rawStatementCount: bundle.raw.statements.length,
          canonicalEntityCount: bundle.weave?.entities.length ?? 0,
          canonicalStatementCount: bundle.weave?.statements.length ?? 0,
          evidenceCount: bundle.evidence.length,
          lxCount: bundle.lx?.links.length ?? 0,
        },
      },
      null,
      2
    )
  );

  // Write artifacts (small, use JSON)
  await writeFile(
    join(bundleDir, 'artifacts.v2.json'),
    JSON.stringify(bundle.artifacts, null, 2)
  );

  // Write evidence JSONL
  const evidenceStream = createWriteStream(join(bundleDir, 'evidence.v2.jsonl'));
  for (const ev of bundle.evidence) {
    evidenceStream.write(JSON.stringify({ _type: 'evidence', ...ev }) + '\n');
  }
  evidenceStream.end();

  // Write raw entities JSONL
  const rawEntitiesStream = createWriteStream(join(bundleDir, 'raw.entities.v2.jsonl'));
  for (const e of bundle.raw.entities) {
    rawEntitiesStream.write(JSON.stringify({ _type: 'raw_entity', ...e }) + '\n');
  }
  rawEntitiesStream.end();

  // Write raw statements JSONL
  const rawStatementsStream = createWriteStream(join(bundleDir, 'raw.statements.v2.jsonl'));
  for (const s of bundle.raw.statements) {
    rawStatementsStream.write(JSON.stringify({ _type: 'raw_statement', ...s }) + '\n');
  }
  rawStatementsStream.end();

  // Write canonical entities JSONL (if weave exists)
  if (bundle.weave) {
    const canonicalEntitiesStream = createWriteStream(
      join(bundleDir, 'canonical.entities.v2.jsonl')
    );
    for (const e of bundle.weave.entities) {
      canonicalEntitiesStream.write(
        JSON.stringify({ _type: 'canonical_entity', ...e }) + '\n'
      );
    }
    canonicalEntitiesStream.end();

    const canonicalStatementsStream = createWriteStream(
      join(bundleDir, 'canonical.statements.v2.jsonl')
    );
    for (const s of bundle.weave.statements) {
      canonicalStatementsStream.write(
        JSON.stringify({ _type: 'canonical_statement', ...s }) + '\n'
      );
    }
    canonicalStatementsStream.end();
  }

  // Write LX links JSONL
  if (bundle.lx) {
    const lxStream = createWriteStream(join(bundleDir, 'lx.v2.jsonl'));
    for (const l of bundle.lx.links) {
      lxStream.write(JSON.stringify({ _type: 'lx_link', ...l }) + '\n');
    }
    lxStream.end();
  }

  return bundleDir;
}

// =============================================================================
// Bundle Loading
// =============================================================================

export interface LoadBundleV2Result {
  bundle: GraphBundleV2;
  format: 'json' | 'jsonl';
}

export async function loadBundleV2(runDir: string): Promise<LoadBundleV2Result | null> {
  const bundleDir = join(runDir, 'bundle');

  // Try v2 JSON format
  const jsonPath = join(bundleDir, 'graph.v2.json');
  if (existsSync(jsonPath)) {
    const bundle = JSON.parse(await readFile(jsonPath, 'utf-8')) as GraphBundleV2;
    return { bundle, format: 'json' };
  }

  // Try v2 JSONL format
  const metaPath = join(bundleDir, 'meta.v2.json');
  if (existsSync(metaPath)) {
    const bundle = await loadJsonlBundle(bundleDir);
    return { bundle, format: 'jsonl' };
  }

  return null;
}

async function loadJsonlBundle(bundleDir: string): Promise<GraphBundleV2> {
  const meta = JSON.parse(await readFile(join(bundleDir, 'meta.v2.json'), 'utf-8'));
  const artifacts = JSON.parse(
    await readFile(join(bundleDir, 'artifacts.v2.json'), 'utf-8')
  ) as ArtifactSummary[];

  // Load JSONL files
  const evidence = await loadJsonlFile<EvidenceRecord>(
    join(bundleDir, 'evidence.v2.jsonl')
  );
  const rawEntities = await loadJsonlFile<RawEntity>(
    join(bundleDir, 'raw.entities.v2.jsonl')
  );
  const rawStatements = await loadJsonlFile<RawStatement>(
    join(bundleDir, 'raw.statements.v2.jsonl')
  );

  // Load canonical (optional)
  const canonicalEntitiesPath = join(bundleDir, 'canonical.entities.v2.jsonl');
  const canonicalStatementsPath = join(bundleDir, 'canonical.statements.v2.jsonl');
  
  let weave: WeaveResult | undefined;
  if (existsSync(canonicalEntitiesPath)) {
    const entities = await loadJsonlFile(canonicalEntitiesPath);
    const statements = existsSync(canonicalStatementsPath)
      ? await loadJsonlFile(canonicalStatementsPath)
      : [];
    
    weave = {
      entities: entities as WeaveResult['entities'],
      statements: statements as WeaveResult['statements'],
      evidence: [],
      conflicts: [],
      stats: meta.stats ?? {
        rawEntityCount: rawEntities.length,
        rawStatementCount: rawStatements.length,
        canonicalEntityCount: entities.length,
        canonicalStatementCount: statements.length,
        mergedEntityGroups: entities.length,
        conflictCount: 0,
      },
    };
  }

  // Load LX (optional)
  const lxPath = join(bundleDir, 'lx.v2.jsonl');
  const lxLinks = existsSync(lxPath)
    ? await loadJsonlFile<LxLink>(lxPath)
    : [];

  return {
    $schema: meta.$schema,
    schemaVersion: meta.schemaVersion,
    runId: meta.runId,
    sessionKey: meta.sessionKey,
    generatedAt: meta.generatedAt,
    artifacts,
    evidence,
    raw: {
      entities: rawEntities,
      statements: rawStatements,
    },
    weave,
    lx: lxLinks.length > 0 ? { links: lxLinks } : undefined,
  };
}

async function loadJsonlFile<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];

  const content = await readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim());

  return lines.map((line) => {
    const record = JSON.parse(line);
    delete record._type;
    return record as T;
  });
}
