// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-Layer Linker
 *
 * Connects IntentWeave's semantic knowledge graph (Canon entities) to actual
 * source code in a workspace.  Creates `:CodeRef` nodes and `:REALIZED_BY`
 * relationships in Neo4j so that every concept, technology, component, or
 * decision can be traced to the code that implements it — and vice-versa.
 *
 * Matching strategies (ordered by precision):
 *
 *   1. dep      — match Canon "technology" entities against package.json deps
 *   2. import   — match Canon entities against import source modules in TS/JS
 *   3. name     — match Canon entities against exported function/class/type names
 *   4. path     — match Canon entities against file/directory paths
 *
 * Usage:
 *   iw xlink <codebase-dir> --session <id> [--persist] [-v]
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Neo4jRunner } from '../context/index.js';

// =============================================================================
// Types
// =============================================================================

export type MatchStrategy = 'dep' | 'import' | 'name' | 'path';

export interface CodeRef {
  /** Workspace-relative file path */
  filePath: string;
  /** Symbol / import / dependency name */
  name: string;
  /** What this code ref represents */
  kind: 'package-dep' | 'import' | 'symbol' | 'file' | 'directory';
  /** Language (ts, tsx, js, json, etc.) */
  language?: string;
  /** Line range in the file (1-based) */
  range?: { startLine: number; endLine: number };
}

export interface CrossLink {
  /** Canon entity name */
  canonName: string;
  /** Canon entity type */
  canonType: string;
  /** Canon entity canonId */
  canonId: string;
  /** Code reference */
  codeRef: CodeRef;
  /** Which strategy produced this match */
  strategy: MatchStrategy;
  /** Confidence 0.0–1.0 */
  confidence: number;
  /** Human-readable explanation */
  detail: string;
}

export interface XLinkResult {
  /** All discovered cross-links */
  links: CrossLink[];
  /** Stats */
  stats: {
    totalCanonEntities: number;
    linkedEntities: number;
    unlinkedEntities: number;
    totalCodeRefs: number;
    byStrategy: Record<MatchStrategy, number>;
    byEntityType: Record<string, { linked: number; total: number }>;
  };
  /** Canon entities that had no code match */
  unlinked: Array<{ name: string; type: string }>;
}

export interface XLinkOptions {
  /** Neo4j runner for reading Canon entities */
  runner: Neo4jRunner;
  /** IntentWeave session ID */
  sessionId: string;
  /** Root of the codebase to scan */
  codebaseDir: string;
  /** Strategies to run (default: all) */
  strategies?: MatchStrategy[];
  /** Min confidence to report (default: 0.4) */
  minConfidence?: number;
  /** Log callback */
  log?: (msg: string) => void;
}

// =============================================================================
// Main entry point
// =============================================================================

export async function runCrossLayerLinker(options: XLinkOptions): Promise<XLinkResult> {
  const {
    runner,
    sessionId,
    codebaseDir,
    strategies = ['dep', 'import', 'name', 'path'],
    minConfidence = 0.4,
    log,
  } = options;

  // 1. Load Canon entities
  log?.('Loading Canon entities from Neo4j…');
  const canonEntities = await loadCanonEntities(runner, sessionId);
  log?.(`  ${canonEntities.length} entities loaded`);

  if (canonEntities.length === 0) {
    return emptyResult();
  }

  // 2. Scan codebase
  log?.('Scanning codebase…');
  const codeData = await scanCodebase(codebaseDir, log);

  // 3. Run matching strategies
  const allLinks: CrossLink[] = [];

  if (strategies.includes('dep')) {
    log?.('Strategy: package dependencies…');
    const depLinks = matchByDependencies(canonEntities, codeData.packageDeps);
    allLinks.push(...depLinks);
    log?.(`  ${depLinks.length} matches`);
  }

  if (strategies.includes('import')) {
    log?.('Strategy: import statements…');
    const importLinks = matchByImports(canonEntities, codeData.imports);
    allLinks.push(...importLinks);
    log?.(`  ${importLinks.length} matches`);
  }

  if (strategies.includes('name')) {
    log?.('Strategy: symbol names…');
    const nameLinks = matchByNames(canonEntities, codeData.symbols);
    allLinks.push(...nameLinks);
    log?.(`  ${nameLinks.length} matches`);
  }

  if (strategies.includes('path')) {
    log?.('Strategy: file/directory paths…');
    const pathLinks = matchByPaths(canonEntities, codeData.filePaths);
    allLinks.push(...pathLinks);
    log?.(`  ${pathLinks.length} matches`);
  }

  // 4. Deduplicate and filter
  const filtered = deduplicateLinks(allLinks).filter(l => l.confidence >= minConfidence);

  // 5. Compute stats
  const linkedNames = new Set(filtered.map(l => l.canonName));
  const byStrategy: Record<MatchStrategy, number> = { dep: 0, import: 0, name: 0, path: 0 };
  for (const l of filtered) byStrategy[l.strategy]++;

  const byEntityType: Record<string, { linked: number; total: number }> = {};
  for (const e of canonEntities) {
    if (!byEntityType[e.type]) byEntityType[e.type] = { linked: 0, total: 0 };
    byEntityType[e.type].total++;
    if (linkedNames.has(e.name)) byEntityType[e.type].linked++;
  }

  const unlinked = canonEntities
    .filter(e => !linkedNames.has(e.name))
    .map(e => ({ name: e.name, type: e.type }));

  return {
    links: filtered,
    stats: {
      totalCanonEntities: canonEntities.length,
      linkedEntities: linkedNames.size,
      unlinkedEntities: unlinked.length,
      totalCodeRefs: filtered.length,
      byStrategy,
      byEntityType,
    },
    unlinked,
  };
}

// =============================================================================
// Neo4j: Load Canon entities
// =============================================================================

interface CanonEntity {
  canonId: string;
  name: string;
  type: string;
  aliases: string[];
}

async function loadCanonEntities(runner: Neo4jRunner, sessionId: string): Promise<CanonEntity[]> {
  const rows = await runner.run(
    `MATCH (n:Canon)
     WHERE n.session_id = $sid
     RETURN n.canonId AS canonId, n.name AS name, n.type AS type,
            coalesce(n.aliases, []) AS aliases
     ORDER BY n.type, n.name`,
    { sid: sessionId },
  );

  return rows.map(r => ({
    canonId: String(r.canonId ?? ''),
    name: String(r.name ?? ''),
    type: String(r.type ?? ''),
    aliases: Array.isArray(r.aliases) ? r.aliases.map(String) : [],
  }));
}

// =============================================================================
// Codebase scanner
// =============================================================================

interface PackageDep {
  /** package name as listed in package.json */
  packageName: string;
  /** 'dependency' | 'devDependency' */
  depType: string;
  /** path to the package.json */
  packageJsonPath: string;
}

interface ImportRef {
  /** The module source: 'react', './utils', '@modelcontextprotocol/sdk' */
  source: string;
  /** Imported names (named imports) */
  names: string[];
  /** File that contains the import */
  filePath: string;
  /** Line number */
  line: number;
}

interface SymbolRef {
  /** Symbol name */
  name: string;
  /** Kind: function, class, interface, type, variable */
  kind: string;
  /** Is exported? */
  isExported: boolean;
  /** File path */
  filePath: string;
  /** Line number */
  line: number;
}

interface CodebaseData {
  packageDeps: PackageDep[];
  imports: ImportRef[];
  symbols: SymbolRef[];
  filePaths: string[];
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.iw', 'coverage']);
/** Directories to ignore in path matching (data/output dirs, not source) */
const PATH_MATCH_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.iw', 'cg', '.specstory', 'runs', 'artifacts', 'golden', 'captures']);

async function scanCodebase(dir: string, log?: (msg: string) => void): Promise<CodebaseData> {
  const packageDeps: PackageDep[] = [];
  const imports: ImportRef[] = [];
  const symbols: SymbolRef[] = [];
  const filePaths: string[] = [];

  await walkDirectory(dir, dir, filePaths, imports, symbols, packageDeps);

  log?.(`  ${filePaths.length} files, ${packageDeps.length} deps, ${imports.length} imports, ${symbols.length} symbols`);

  return { packageDeps, imports, symbols, filePaths };
}

async function walkDirectory(
  currentDir: string,
  rootDir: string,
  filePaths: string[],
  imports: ImportRef[],
  symbols: SymbolRef[],
  packageDeps: PackageDep[],
): Promise<void> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      filePaths.push(relPath + '/');
      await walkDirectory(fullPath, rootDir, filePaths, imports, symbols, packageDeps);
    } else if (entry.isFile()) {
      filePaths.push(relPath);
      const ext = path.extname(entry.name);

      if (entry.name === 'package.json') {
        await extractPackageDeps(fullPath, relPath, packageDeps);
      }

      if (CODE_EXTENSIONS.has(ext)) {
        await extractImportsAndSymbols(fullPath, relPath, imports, symbols);
      }
    }
  }
}

async function extractPackageDeps(
  fullPath: string,
  relPath: string,
  out: PackageDep[],
): Promise<void> {
  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const pkg = JSON.parse(content);

    for (const [name] of Object.entries(pkg.dependencies ?? {})) {
      out.push({ packageName: name, depType: 'dependency', packageJsonPath: relPath });
    }
    for (const [name] of Object.entries(pkg.devDependencies ?? {})) {
      out.push({ packageName: name, depType: 'devDependency', packageJsonPath: relPath });
    }
  } catch {
    // skip invalid package.json
  }
}

/**
 * Lightweight regex-based extraction of imports and top-level symbols.
 * No AST parser needed — this is fast and handles 90%+ of cases.
 */
async function extractImportsAndSymbols(
  fullPath: string,
  relPath: string,
  imports: ImportRef[],
  symbols: SymbolRef[],
): Promise<void> {
  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      // Import patterns
      // import X from 'source'
      // import { X, Y } from 'source'
      // import * as X from 'source'
      // import 'source'
      const importMatch = line.match(
        /^\s*import\s+(?:(?:\{([^}]+)\}|(\*\s+as\s+\w+)|(\w+))\s+from\s+)?['"]([^'"]+)['"]/,
      );
      if (importMatch) {
        const namedImports = importMatch[1]
          ? importMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
          : [];
        const defaultImport = importMatch[3];
        const source = importMatch[4];

        const names = [...namedImports];
        if (defaultImport) names.push(defaultImport);

        imports.push({ source, names, filePath: relPath, line: lineNo });
        continue;
      }

      // Require patterns
      // const X = require('source')
      const requireMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/);
      if (requireMatch) {
        imports.push({
          source: requireMatch[2],
          names: [requireMatch[1]],
          filePath: relPath,
          line: lineNo,
        });
        continue;
      }

      // Exported symbols
      // export function foo(
      const exportFnMatch = line.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)/);
      if (exportFnMatch) {
        symbols.push({ name: exportFnMatch[1], kind: 'function', isExported: true, filePath: relPath, line: lineNo });
        continue;
      }

      // export class Foo
      const exportClassMatch = line.match(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/);
      if (exportClassMatch) {
        symbols.push({ name: exportClassMatch[1], kind: 'class', isExported: true, filePath: relPath, line: lineNo });
        continue;
      }

      // export interface Foo
      const exportIntfMatch = line.match(/^\s*export\s+interface\s+(\w+)/);
      if (exportIntfMatch) {
        symbols.push({ name: exportIntfMatch[1], kind: 'interface', isExported: true, filePath: relPath, line: lineNo });
        continue;
      }

      // export type Foo
      const exportTypeMatch = line.match(/^\s*export\s+type\s+(\w+)/);
      if (exportTypeMatch) {
        symbols.push({ name: exportTypeMatch[1], kind: 'type', isExported: true, filePath: relPath, line: lineNo });
        continue;
      }

      // export const/let/var foo
      const exportVarMatch = line.match(/^\s*export\s+(?:const|let|var)\s+(\w+)/);
      if (exportVarMatch) {
        symbols.push({ name: exportVarMatch[1], kind: 'variable', isExported: true, filePath: relPath, line: lineNo });
        continue;
      }

      // Non-exported top-level declarations (only if at col 0)
      if (line.match(/^(?:async\s+)?function\s+(\w+)/)) {
        const name = line.match(/^(?:async\s+)?function\s+(\w+)/)![1];
        symbols.push({ name, kind: 'function', isExported: false, filePath: relPath, line: lineNo });
      } else if (line.match(/^class\s+(\w+)/)) {
        const name = line.match(/^class\s+(\w+)/)![1];
        symbols.push({ name, kind: 'class', isExported: false, filePath: relPath, line: lineNo });
      }
    }
  } catch {
    // skip unreadable files
  }
}

// =============================================================================
// Matching strategies
// =============================================================================

/**
 * Normalize a name for comparison.
 * "React" → "react", "Cloudflare Workers" → "cloudflare-workers"
 */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Get all name variants for a Canon entity (name + aliases).
 */
function entityVariants(entity: CanonEntity): string[] {
  const variants = [entity.name, ...entity.aliases];
  return [...new Set(variants.map(normalize).filter(v => v.length > 1))];
}

// ── Strategy 1: Package dependency matching ──────────────────────────

function matchByDependencies(entities: CanonEntity[], deps: PackageDep[]): CrossLink[] {
  const links: CrossLink[] = [];

  // Build dep lookup: normalized package name → PackageDep[]
  const depMap = new Map<string, PackageDep[]>();
  for (const dep of deps) {
    // "react" → "react"
    // "@vitejs/plugin-react" → index by both "vite" and "vitejs/plugin-react"
    const normalized = normalize(dep.packageName);
    if (!depMap.has(normalized)) depMap.set(normalized, []);
    depMap.get(normalized)!.push(dep);

    // For scoped packages, also index by the scope name
    if (dep.packageName.startsWith('@')) {
      const scope = dep.packageName.split('/')[0].slice(1);
      const scopeNorm = normalize(scope);
      if (!depMap.has(scopeNorm)) depMap.set(scopeNorm, []);
      depMap.get(scopeNorm)!.push(dep);
    }
  }

  // Only match technology-type entities
  const techEntities = entities.filter(e =>
    e.type === 'technology' || e.type === 'component' || e.type === 'resource',
  );

  for (const entity of techEntities) {
    for (const variant of entityVariants(entity)) {
      const matchedDeps = depMap.get(variant);
      if (matchedDeps) {
        for (const dep of matchedDeps) {
          links.push({
            canonName: entity.name,
            canonType: entity.type,
            canonId: entity.canonId,
            codeRef: {
              filePath: dep.packageJsonPath,
              name: dep.packageName,
              kind: 'package-dep',
              language: 'json',
            },
            strategy: 'dep',
            confidence: dep.depType === 'dependency' ? 0.95 : 0.85,
            detail: `${entity.name} matches ${dep.depType} "${dep.packageName}" in ${dep.packageJsonPath}`,
          });
        }
      }

      // Also check for partial matches (e.g. "Vite" matches "@vitejs/plugin-react")
      for (const dep of deps) {
        const depNorm = normalize(dep.packageName);
        if (depNorm !== variant && depNorm.includes(variant) && variant.length >= 3) {
          // Avoid duplicates
          if (!links.some(l => l.canonName === entity.name && l.codeRef.name === dep.packageName)) {
            links.push({
              canonName: entity.name,
              canonType: entity.type,
              canonId: entity.canonId,
              codeRef: {
                filePath: dep.packageJsonPath,
                name: dep.packageName,
                kind: 'package-dep',
                language: 'json',
              },
              strategy: 'dep',
              confidence: 0.75,
              detail: `${entity.name} partially matches "${dep.packageName}" in ${dep.packageJsonPath}`,
            });
          }
        }
      }
    }
  }

  return links;
}

// ── Strategy 2: Import matching ──────────────────────────────────────

function matchByImports(entities: CanonEntity[], imports: ImportRef[]): CrossLink[] {
  const links: CrossLink[] = [];

  // Build import source lookup
  const importBySource = new Map<string, ImportRef[]>();
  for (const imp of imports) {
    // Normalize source: 'react' → 'react', '@modelcontextprotocol/sdk/server/mcp.js' → 'modelcontextprotocol'
    const normalized = normalize(imp.source.split('/')[0].replace(/^@/, ''));
    if (!importBySource.has(normalized)) importBySource.set(normalized, []);
    importBySource.get(normalized)!.push(imp);

    // Also full source
    const fullNorm = normalize(imp.source);
    if (fullNorm !== normalized) {
      if (!importBySource.has(fullNorm)) importBySource.set(fullNorm, []);
      importBySource.get(fullNorm)!.push(imp);
    }
  }

  for (const entity of entities) {
    for (const variant of entityVariants(entity)) {
      const matched = importBySource.get(variant);
      if (matched) {
        // Group by unique source to avoid per-file spam
        const bySource = new Map<string, ImportRef[]>();
        for (const imp of matched) {
          if (!bySource.has(imp.source)) bySource.set(imp.source, []);
          bySource.get(imp.source)!.push(imp);
        }

        for (const [source, imps] of bySource) {
          // Pick up to 5 representative files
          const sampleFiles = imps.slice(0, 5);
          for (const imp of sampleFiles) {
            links.push({
              canonName: entity.name,
              canonType: entity.type,
              canonId: entity.canonId,
              codeRef: {
                filePath: imp.filePath,
                name: source,
                kind: 'import',
                language: path.extname(imp.filePath).slice(1) || 'ts',
                range: { startLine: imp.line, endLine: imp.line },
              },
              strategy: 'import',
              confidence: 0.85,
              detail: `${entity.name} imported as "${source}" in ${imp.filePath}:${imp.line}` +
                (imps.length > 5 ? ` (+${imps.length - 5} more files)` : ''),
            });
          }
        }
      }
    }
  }

  return links;
}

// ── Strategy 3: Symbol name matching ─────────────────────────────────

function matchByNames(entities: CanonEntity[], symbols: SymbolRef[]): CrossLink[] {
  const links: CrossLink[] = [];

  // Build symbol lookup
  const symbolMap = new Map<string, SymbolRef[]>();
  for (const sym of symbols) {
    const normalized = normalize(sym.name);
    if (!symbolMap.has(normalized)) symbolMap.set(normalized, []);
    symbolMap.get(normalized)!.push(sym);
  }

  // Only match entities whose names could plausibly be code identifiers
  for (const entity of entities) {
    // Skip very generic names
    if (entity.name.length < 3) continue;

    for (const variant of entityVariants(entity)) {
      if (variant.length < 3) continue;

      const matched = symbolMap.get(variant);
      if (matched) {
        for (const sym of matched.slice(0, 3)) {
          links.push({
            canonName: entity.name,
            canonType: entity.type,
            canonId: entity.canonId,
            codeRef: {
              filePath: sym.filePath,
              name: sym.name,
              kind: 'symbol',
              language: path.extname(sym.filePath).slice(1) || 'ts',
              range: { startLine: sym.line, endLine: sym.line },
            },
            strategy: 'name',
            confidence: sym.isExported ? 0.75 : 0.6,
            detail: `${entity.name} matches ${sym.kind} "${sym.name}" in ${sym.filePath}:${sym.line}`,
          });
        }
      }
    }
  }

  return links;
}

// ── Strategy 4: File/directory path matching ─────────────────────────

function matchByPaths(entities: CanonEntity[], filePaths: string[]): CrossLink[] {
  const links: CrossLink[] = [];

  // Only match component, feature, and concept entities
  const relevantEntities = entities.filter(e =>
    ['component', 'feature', 'concept', 'technology'].includes(e.type),
  );

  // Filter out data/run output directories — only match source paths
  const sourcePaths = filePaths.filter(fp => {
    const firstSeg = fp.split('/')[0];
    return !PATH_MATCH_IGNORE.has(firstSeg);
  });

  for (const entity of relevantEntities) {
    const entityLinks: CrossLink[] = [];

    for (const variant of entityVariants(entity)) {
      // Require at least 5 chars for path matching to reduce noise
      if (variant.length < 5) continue;

      for (const fp of sourcePaths) {
        // Check path segments — require EXACT segment match (no substring)
        const segments = fp.split('/').map(normalize).filter(Boolean);
        const matched = segments.some(seg => seg === variant);

        if (matched) {
          const isDir = fp.endsWith('/');
          entityLinks.push({
            canonName: entity.name,
            canonType: entity.type,
            canonId: entity.canonId,
            codeRef: {
              filePath: fp,
              name: path.basename(fp.replace(/\/$/, '')),
              kind: isDir ? 'directory' : 'file',
              language: isDir ? undefined : (path.extname(fp).slice(1) || undefined),
            },
            strategy: 'path',
            confidence: isDir ? 0.65 : 0.55,
            detail: `${entity.name} matches ${isDir ? 'directory' : 'file'} "${fp}"`,
          });
        }
      }
    }

    // Cap at 5 path refs per entity to avoid noise
    links.push(...entityLinks.slice(0, 5));
  }

  return links;
}

// =============================================================================
// Deduplication
// =============================================================================

function deduplicateLinks(links: CrossLink[]): CrossLink[] {
  // Key: canonName + codeRef.filePath + strategy
  const seen = new Map<string, CrossLink>();

  for (const link of links) {
    const key = `${link.canonName}|${link.codeRef.filePath}|${link.codeRef.name}|${link.strategy}`;
    const existing = seen.get(key);
    if (!existing || link.confidence > existing.confidence) {
      seen.set(key, link);
    }
  }

  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

// =============================================================================
// Neo4j persistence
// =============================================================================

export async function persistCrossLinks(
  runner: Neo4jRunner,
  sessionId: string,
  links: CrossLink[],
  log?: (msg: string) => void,
): Promise<void> {
  if (links.length === 0) return;

  log?.(`Persisting ${links.length} cross-links to Neo4j…`);

  // Clean previous cross-links for this session
  await runner.run(
    `MATCH (cr:CodeRef {session_id: $sid})
     DETACH DELETE cr`,
    { sid: sessionId },
  );

  // Create CodeRef nodes and REALIZED_BY relationships in batches
  const BATCH_SIZE = 50;
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);

    await runner.run(
      `UNWIND $batch AS link
       MATCH (c:Canon {session_id: $sid, name: link.canonName})
       WITH c, link
       ORDER BY c.confidence DESC
       WITH link, head(collect(c)) AS c
       WHERE c IS NOT NULL
       MERGE (cr:CodeRef {
         session_id: $sid,
         filePath: link.filePath,
         name: link.codeName,
         kind: link.kind
       })
       ON CREATE SET
         cr.language = link.language,
         cr.createdAt = datetime()
       MERGE (c)-[r:REALIZED_BY]->(cr)
       ON CREATE SET
         r.strategy = link.strategy,
         r.confidence = link.confidence,
         r.detail = link.detail,
         r.createdAt = datetime()
       ON MATCH SET
         r.confidence = CASE WHEN link.confidence > r.confidence THEN link.confidence ELSE r.confidence END,
         r.strategy = CASE WHEN link.confidence > r.confidence THEN link.strategy ELSE r.strategy END`,
      {
        sid: sessionId,
        batch: batch.map(l => ({
          canonName: l.canonName,
          filePath: l.codeRef.filePath,
          codeName: l.codeRef.name,
          kind: l.codeRef.kind,
          language: l.codeRef.language ?? null,
          strategy: l.strategy,
          confidence: l.confidence,
          detail: l.detail,
        })),
      },
    );
  }

  // Create indexes for CodeRef if they don't exist
  try {
    await runner.run('CREATE INDEX IF NOT EXISTS FOR (cr:CodeRef) ON (cr.session_id)');
    await runner.run('CREATE INDEX IF NOT EXISTS FOR (cr:CodeRef) ON (cr.filePath)');
  } catch {
    // Indexes may already exist
  }

  log?.(`  Persisted ${links.length} links`);
}

// =============================================================================
// Formatting
// =============================================================================

export function formatXLinkReport(result: XLinkResult): string {
  const lines: string[] = [];

  lines.push('# Cross-Layer Link Report');
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Canon entities: ${result.stats.totalCanonEntities}`);
  lines.push(`- Linked to code: ${result.stats.linkedEntities} (${pct(result.stats.linkedEntities, result.stats.totalCanonEntities)})`);
  lines.push(`- Unlinked: ${result.stats.unlinkedEntities}`);
  lines.push(`- Total code references: ${result.stats.totalCodeRefs}`);
  lines.push('');

  // By strategy
  lines.push('## Matches by Strategy');
  for (const [strategy, count] of Object.entries(result.stats.byStrategy)) {
    if (count > 0) {
      const label = { dep: 'Package deps', import: 'Imports', name: 'Symbol names', path: 'File paths' }[strategy] ?? strategy;
      lines.push(`- **${label}**: ${count}`);
    }
  }
  lines.push('');

  // By entity type
  lines.push('## Coverage by Entity Type');
  for (const [type, stat] of Object.entries(result.stats.byEntityType).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`- **${type}**: ${stat.linked}/${stat.total} linked (${pct(stat.linked, stat.total)})`);
  }
  lines.push('');

  // Top links grouped by Canon entity
  const byCanon = new Map<string, CrossLink[]>();
  for (const l of result.links) {
    if (!byCanon.has(l.canonName)) byCanon.set(l.canonName, []);
    byCanon.get(l.canonName)!.push(l);
  }

  lines.push('## Linked Entities');
  for (const [name, entityLinks] of [...byCanon.entries()].sort()) {
    const type = entityLinks[0].canonType;
    const topLink = entityLinks[0];
    lines.push(`### ${name} (${type})`);
    for (const l of entityLinks.slice(0, 8)) {
      const confStr = l.confidence < 0.9 ? ` [${Math.round(l.confidence * 100)}%]` : '';
      lines.push(`- \`${l.codeRef.kind}\` ${l.codeRef.filePath}${l.codeRef.range ? ':' + l.codeRef.range.startLine : ''}${confStr}`);
      lines.push(`  ${l.detail}`);
    }
    if (entityLinks.length > 8) {
      lines.push(`  _+${entityLinks.length - 8} more references_`);
    }
    lines.push('');
  }

  // Unlinked
  if (result.unlinked.length > 0) {
    lines.push('## Unlinked Entities');
    lines.push('_Canon entities with no code references:_');
    const byType = new Map<string, string[]>();
    for (const u of result.unlinked) {
      if (!byType.has(u.type)) byType.set(u.type, []);
      byType.get(u.type)!.push(u.name);
    }
    for (const [type, names] of [...byType.entries()].sort()) {
      lines.push(`- **${type}**: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` (+${names.length - 10} more)` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function pct(a: number, b: number): string {
  return b === 0 ? '0%' : `${Math.round((a / b) * 100)}%`;
}

function emptyResult(): XLinkResult {
  return {
    links: [],
    stats: {
      totalCanonEntities: 0,
      linkedEntities: 0,
      unlinkedEntities: 0,
      totalCodeRefs: 0,
      byStrategy: { dep: 0, import: 0, name: 0, path: 0 },
      byEntityType: {},
    },
    unlinked: [],
  };
}
