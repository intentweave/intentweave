// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Graph Bundle Generator
 * 
 * Generates consolidated bundle files from run artifacts.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  RunOverview,
  GraphBundle,
  BundleArtifact,
  BundleEntity,
  BundleStatement,
  BundleLinkProposal,
  BundleOptions,
} from './types.js';
import { DEFAULT_BUNDLE_OPTIONS } from './types.js';

// =============================================================================
// Overview Generation
// =============================================================================

export interface GenerateOverviewInput {
  runDir: string;
}

export async function generateOverview(input: GenerateOverviewInput): Promise<RunOverview> {
  const { runDir } = input;
  
  // Load run metadata
  const metaPath = join(runDir, 'run.meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
  
  // Load aggregate data
  const aggregateDir = join(runDir, 'aggregate');
  let lxProposals: unknown[] = [];
  let findings: unknown[] = [];
  
  if (existsSync(join(aggregateDir, 'lx.proposals.json'))) {
    const lxData = JSON.parse(await readFile(join(aggregateDir, 'lx.proposals.json'), 'utf-8'));
    lxProposals = lxData.proposals || [];
  }
  
  if (existsSync(join(aggregateDir, 'findings.json'))) {
    const findingsData = JSON.parse(await readFile(join(aggregateDir, 'findings.json'), 'utf-8'));
    findings = findingsData.findings || [];
  }
  
  // Scan artifacts
  const artifactsDir = join(runDir, 'artifacts');
  const artifacts: BundleArtifact[] = [];
  const entityTypes: Record<string, number> = {};
  const artifactRoles: Record<string, number> = {};
  let totalEntities = 0;
  let totalStatements = 0;
  
  if (existsSync(artifactsDir)) {
    const artifactDirs = await readdir(artifactsDir, { withFileTypes: true });
    
    for (const dir of artifactDirs.filter(d => d.isDirectory())) {
      const pxPath = join(artifactsDir, dir.name, 'px.json');
      if (!existsSync(pxPath)) continue;
      
      try {
        const px = JSON.parse(await readFile(pxPath, 'utf-8'));
        const entityCount = px.entities?.length || 0;
        const statementCount = px.statements?.length || 0;
        const role = px.artifactRole || 'unknown';
        
        artifacts.push({
          id: dir.name,
          path: dir.name.replace(/_/g, '/'),
          role,
          entityCount,
          statementCount,
        });
        
        totalEntities += entityCount;
        totalStatements += statementCount;
        
        // Count by role
        artifactRoles[role] = (artifactRoles[role] || 0) + 1;
        
        // Count entity types
        for (const entity of px.entities || []) {
          const type = entity.type || 'unknown';
          entityTypes[type] = (entityTypes[type] || 0) + 1;
        }
      } catch {
        // Skip invalid artifacts
      }
    }
  }
  
  // Sort by entity count and take top 20
  artifacts.sort((a, b) => b.entityCount - a.entityCount);
  const topArtifacts = artifacts.slice(0, 20);
  
  return {
    $schema: 'intentweave://schemas/run-overview/v1',
    schemaVersion: '0.1',
    runId: meta.runId,
    workspaceKey: meta.workspaceKey,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    durationMs: meta.durationMs,
    status: meta.status,
    profile: meta.profile,
    stages: meta.stages || [],
    counts: {
      artifacts: artifacts.length,
      entities: totalEntities,
      statements: totalStatements,
      lxProposals: lxProposals.length,
      findings: findings.length,
    },
    entityTypes,
    artifactRoles,
    topArtifacts,
  };
}

// =============================================================================
// Bundle Generation
// =============================================================================

export interface GenerateBundleInput {
  runDir: string;
  options?: BundleOptions;
}

export interface GenerateBundleResult {
  overview: RunOverview;
  bundlePath: string;
  format: 'json' | 'jsonl';
  entityCount: number;
  statementCount: number;
  lxCount: number;
}

export async function generateBundle(input: GenerateBundleInput): Promise<GenerateBundleResult> {
  const { runDir, options: userOptions } = input;
  const options = { ...DEFAULT_BUNDLE_OPTIONS, ...userOptions };
  
  // Generate overview first
  const overview = await generateOverview({ runDir });
  
  // Create bundle directory
  const bundleDir = join(runDir, 'bundle');
  await mkdir(bundleDir, { recursive: true });
  
  // Write overview
  const overviewPath = join(runDir, 'overview.json');
  await writeFile(overviewPath, JSON.stringify(overview, null, 2));
  
  // Collect all data
  const entities: BundleEntity[] = [];
  const statements: BundleStatement[] = [];
  const artifacts: BundleArtifact[] = [];
  
  const artifactsDir = join(runDir, 'artifacts');
  if (existsSync(artifactsDir)) {
    const artifactDirs = await readdir(artifactsDir, { withFileTypes: true });
    
    for (const dir of artifactDirs.filter(d => d.isDirectory())) {
      const pxPath = join(artifactsDir, dir.name, 'px.json');
      if (!existsSync(pxPath)) continue;
      
      try {
        const px = JSON.parse(await readFile(pxPath, 'utf-8'));
        const artifactId = dir.name;
        const artifactRole = px.artifactRole || 'unknown';
        
        artifacts.push({
          id: artifactId,
          path: dir.name.replace(/_/g, '/'),
          role: artifactRole,
          entityCount: px.entities?.length || 0,
          statementCount: px.statements?.length || 0,
        });
        
        // Add entities
        for (const e of px.entities || []) {
          entities.push({
            cgId: e.cgId,
            name: e.name,
            type: e.type,
            artifactId,
            artifactRole,
            confidence: e.confidence,
            aliases: e.aliases,
          });
        }
        
        // Add statements
        for (const s of px.statements || []) {
          statements.push({
            id: s.id || `${artifactId}:${statements.length}`,
            subjectCgId: s.subjectCgId,
            predicate: s.predicate,
            objectCgId: s.objectCgId,
            objectLiteral: s.objectLiteral,
            artifactId,
            confidence: s.confidence,
            evidenceSourceKey: s.evidence?.[0]?.sourceKey,
          });
        }
      } catch {
        // Skip invalid artifacts
      }
    }
  }
  
  // Load LX proposals
  const lx: BundleLinkProposal[] = [];
  const lxPath = join(runDir, 'aggregate', 'lx.proposals.json');
  if (existsSync(lxPath)) {
    try {
      const lxData = JSON.parse(await readFile(lxPath, 'utf-8'));
      for (const p of lxData.proposals || []) {
        lx.push({
          id: p.id,
          sourceCgId: p.sourceCgId,
          targetCgId: p.targetCgId,
          predicate: p.predicate,
          confidence: p.confidence,
          matchMethod: p.matchMethod,
        });
      }
    } catch {
      // Skip invalid LX file
    }
  }
  
  // Decide format based on size
  const totalRecords = entities.length + statements.length + lx.length;
  const useJsonl = totalRecords > options.jsonlThreshold;
  
  let bundlePath: string;
  
  if (useJsonl) {
    // Write JSONL files
    bundlePath = bundleDir;
    
    // Artifacts (always JSON, small)
    await writeFile(join(bundleDir, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
    
    // Entities JSONL
    const entitiesStream = createWriteStream(join(bundleDir, 'entities.jsonl'));
    for (const e of entities) {
      entitiesStream.write(JSON.stringify({ _type: 'entity', ...e }) + '\n');
    }
    entitiesStream.end();
    
    // Statements JSONL
    const statementsStream = createWriteStream(join(bundleDir, 'statements.jsonl'));
    for (const s of statements) {
      statementsStream.write(JSON.stringify({ _type: 'statement', ...s }) + '\n');
    }
    statementsStream.end();
    
    // LX JSONL
    const lxStream = createWriteStream(join(bundleDir, 'lx.jsonl'));
    for (const l of lx) {
      lxStream.write(JSON.stringify({ _type: 'lx', ...l }) + '\n');
    }
    lxStream.end();
  } else {
    // Write single JSON bundle
    bundlePath = join(bundleDir, 'graph.json');
    
    const bundle: GraphBundle = {
      $schema: 'intentweave://schemas/graph-bundle/v1',
      schemaVersion: '0.1',
      runId: overview.runId,
      sessionKey: overview.sessionKey,
      generatedAt: new Date().toISOString(),
      artifacts,
      entities,
      statements,
      lx,
    };
    
    await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
  }
  
  return {
    overview,
    bundlePath,
    format: useJsonl ? 'jsonl' : 'json',
    entityCount: entities.length,
    statementCount: statements.length,
    lxCount: lx.length,
  };
}

// =============================================================================
// Bundle Loading
// =============================================================================

export interface LoadBundleResult {
  overview: RunOverview;
  bundle?: GraphBundle;
  format: 'json' | 'jsonl';
}

export async function loadBundle(runDir: string): Promise<LoadBundleResult | null> {
  const overviewPath = join(runDir, 'overview.json');
  
  if (!existsSync(overviewPath)) {
    return null;
  }
  
  const overview = JSON.parse(await readFile(overviewPath, 'utf-8')) as RunOverview;
  
  // Try to load graph.json
  const graphPath = join(runDir, 'bundle', 'graph.json');
  if (existsSync(graphPath)) {
    const bundle = JSON.parse(await readFile(graphPath, 'utf-8')) as GraphBundle;
    return { overview, bundle, format: 'json' };
  }
  
  // Check for JSONL format
  const entitiesPath = join(runDir, 'bundle', 'entities.jsonl');
  if (existsSync(entitiesPath)) {
    return { overview, format: 'jsonl' };
  }
  
  return { overview, format: 'json' };
}
