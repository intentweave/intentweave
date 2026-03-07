// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Document Health Analyzer.
 *
 * Covers:
 * - analyzeDocHealth: staleness, drift, contradiction, undocumented detection
 * - formatDocHealthMarkdown: all sections, icons, sorting, recommendations
 * - formatDocHealthJson: serialization
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  analyzeDocHealth,
  formatDocHealthMarkdown,
  formatDocHealthJson,
  type DocHealthResult,
  type DocReport,
  type UndocumentedEntity,
} from '../../doc-health/index.js';
import {
  createMockRunner,
  createSequentialMockRunner,
} from '../helpers.js';

// =============================================================================
// Helpers — build result objects for formatter tests
// =============================================================================

function createDocReport(overrides: Partial<DocReport> = {}): DocReport {
  return {
    filePath: 'docs/ARCHITECTURE.md',
    status: 'fresh',
    freshCount: 10,
    totalCount: 10,
    freshnessPercent: 100,
    issues: [],
    ...overrides,
  };
}

function createResult(overrides: Partial<DocHealthResult> = {}): DocHealthResult {
  return {
    sessionId: 'test',
    reports: [],
    undocumented: [],
    stats: {
      docsAnalyzed: 0,
      freshDocs: 0,
      warningDocs: 0,
      rottenDocs: 0,
      totalIssues: 0,
      staleCount: 0,
      driftCount: 0,
      missingCount: 0,
      contradictionCount: 0,
      temporalCount: 0,
      undocumentedCount: 0,
    },
    ...overrides,
  };
}

// =============================================================================
// formatDocHealthMarkdown
// =============================================================================

describe('formatDocHealthMarkdown', () => {
  it('renders header with session and doc count', () => {
    const result = createResult({
      sessionId: 'planpling',
      stats: { ...createResult().stats, docsAnalyzed: 3 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('Documentation Health Report');
    expect(md).toContain('planpling');
    expect(md).toContain('3');
  });

  it('renders summary table with status counts', () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        docsAnalyzed: 5,
        freshDocs: 3,
        warningDocs: 1,
        rottenDocs: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('✅ Fresh | 3');
    expect(md).toContain('⚠️ Warning | 1');
    expect(md).toContain('🔴 Rotten | 1');
  });

  it('renders issue breakdown', () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 5,
        staleCount: 2,
        driftCount: 2,
        contradictionCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('5');
    expect(md).toContain('🪦 2 stale');
    expect(md).toContain('🔀 2 drift');
    expect(md).toContain('⚡ 1 contradiction');
  });

  it('renders per-document reports with freshness percentage', () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: 'docs/API.md',
          status: 'warning',
          freshCount: 7,
          totalCount: 10,
          freshnessPercent: 70,
          issues: [
            {
              severity: 'stale',
              message: '"MongoDB" was decided against by "Neo4j"',
              entityName: 'MongoDB',
              entityType: 'technology',
            },
          ],
        }),
      ],
      stats: { ...createResult().stats, docsAnalyzed: 1, warningDocs: 1, totalIssues: 1, staleCount: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('docs/API.md');
    expect(md).toContain('70%');
    expect(md).toContain('7/10');
    expect(md).toContain('🪦');
    expect(md).toContain('MongoDB');
    expect(md).toContain('decided against');
  });

  it('sorts documents worst-first (rotten > warning > fresh)', () => {
    const result = createResult({
      reports: [
        createDocReport({ filePath: 'fresh.md', status: 'fresh' }),
        createDocReport({ filePath: 'rotten.md', status: 'rotten' }),
        createDocReport({ filePath: 'warning.md', status: 'warning' }),
      ],
      stats: { ...createResult().stats, docsAnalyzed: 3, freshDocs: 1, warningDocs: 1, rottenDocs: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    const rottenIdx = md.indexOf('rotten.md');
    const warningIdx = md.indexOf('warning.md');
    const freshIdx = md.indexOf('fresh.md');
    expect(rottenIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(freshIdx);
  });

  it('renders undocumented entities table', () => {
    const result = createResult({
      undocumented: [
        { name: 'RateLimiter', type: 'component', relationshipCount: 5 },
        { name: 'WebSocket', type: 'technology', relationshipCount: 3 },
      ],
      stats: { ...createResult().stats, undocumentedCount: 2 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('Undocumented Entities');
    expect(md).toContain('RateLimiter');
    expect(md).toContain('component');
    expect(md).toContain('5');
    expect(md).toContain('WebSocket');
  });

  it('renders recommendations for stale issues', () => {
    const result = createResult({
      stats: { ...createResult().stats, totalIssues: 1, staleCount: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('Recommendations');
    expect(md).toContain('stale references');
  });

  it('renders recommendations for drift issues', () => {
    const result = createResult({
      stats: { ...createResult().stats, totalIssues: 1, driftCount: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('Document new relationships');
  });

  it('renders recommendations for undocumented entities', () => {
    const result = createResult({
      undocumented: [{ name: 'X', type: 'concept', relationshipCount: 3 }],
      stats: { ...createResult().stats, undocumentedCount: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('Document new entities');
  });

  it('renders clean output for no issues', () => {
    const result = createResult({
      reports: [createDocReport()],
      stats: { ...createResult().stats, docsAnalyzed: 1, freshDocs: 1 },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('No issues found');
    expect(md).not.toContain('Recommendations');
  });

  it('includes the tip/footer', () => {
    const md = formatDocHealthMarkdown(createResult());
    expect(md).toContain('iw doc-health');
    expect(md).toContain('iw context');
  });
});

// =============================================================================
// formatDocHealthJson
// =============================================================================

describe('formatDocHealthJson', () => {
  it('serializes as valid JSON', () => {
    const result = createResult({ sessionId: 'planpling' });
    const json = formatDocHealthJson(result);
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe('planpling');
  });

  it('preserves all fields', () => {
    const result = createResult({
      reports: [createDocReport({ filePath: 'a.md', status: 'warning' })],
      undocumented: [{ name: 'X', type: 'concept', relationshipCount: 2 }],
    });
    const parsed = JSON.parse(formatDocHealthJson(result));
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0].filePath).toBe('a.md');
    expect(parsed.undocumented).toHaveLength(1);
  });
});

// =============================================================================
// analyzeDocHealth — integration with mock runner
// =============================================================================

describe('analyzeDocHealth', () => {
  it('returns empty results when no documents found', async () => {
    const runner = createMockRunner(); // no matches → empty rows

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    expect(result.reports).toHaveLength(0);
    expect(result.stats.docsAnalyzed).toBe(0);
  });

  it('discovers documents from RawTriple sourceFile', async () => {
    const runner = createSequentialMockRunner([
      // Step 1: discover docs
      [{ filePath: 'docs/ARCH.md' }, { filePath: 'docs/API.md' }],
      // Step 2-4: first doc entities
      [{ name: 'React', type: 'technology', canonId: 'react' }],
      // stale check
      [],
      // drift check
      [],
      // contradiction check
      [],
      // Step 2-4: second doc entities
      [{ name: 'Vue', type: 'technology', canonId: 'vue' }],
      [],
      [],
      [],
      // Step 5: undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    expect(result.reports).toHaveLength(2);
    expect(result.reports[0].filePath).toBe('docs/ARCH.md');
    expect(result.reports[1].filePath).toBe('docs/API.md');
  });

  it('detects stale entities (DECIDED_AGAINST)', async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: 'docs/ARCH.md' }],
      // entities
      [
        { name: 'MongoDB', type: 'technology', canonId: 'mongodb' },
        { name: 'Neo4j', type: 'technology', canonId: 'neo4j' },
      ],
      // stale check: MongoDB was decided against (target of DECIDED_AGAINST)
      [{ entityName: 'MongoDB', predicate: 'DECIDED_AGAINST', decidedBy: 'Neo4j' }],
      // drift check
      [],
      // contradiction check
      [],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    expect(result.reports).toHaveLength(1);
    const report = result.reports[0];
    expect(report.status).not.toBe('fresh');
    expect(report.issues.length).toBeGreaterThanOrEqual(1);
    expect(report.issues[0].severity).toBe('stale');
    expect(report.issues[0].entityName).toBe('MongoDB');
    expect(report.issues[0].message).toContain('decided against');
  });

  it('detects structural drift', async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: 'docs/API.md' }],
      // entities
      [{ name: 'AuthService', type: 'component', canonId: 'auth-service' }],
      // stale check
      [],
      // drift check: AuthService gained new relationships
      [{ entityName: 'AuthService', newRels: ['DEPENDS_ON → RateLimiter', 'USES → JwtLib'] }],
      // contradiction check
      [],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    const report = result.reports[0];
    const driftIssues = report.issues.filter(i => i.severity === 'drift');
    expect(driftIssues.length).toBeGreaterThanOrEqual(1);
    expect(driftIssues[0].entityName).toBe('AuthService');
    expect(driftIssues[0].message).toContain('relationship');
  });

  it('detects contradictions', async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: 'docs/DECISIONS.md' }],
      // entities
      [{ name: 'React', type: 'technology', canonId: 'react' }],
      // stale check
      [],
      // drift check
      [],
      // contradiction check: doc says DECIDED_FOR but graph says DECIDED_AGAINST
      [{ entityName: 'React', docPred: 'DECIDED_FOR', graphPred: 'DECIDED_AGAINST', target: 'Vue' }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    const report = result.reports[0];
    const contradictions = report.issues.filter(i => i.severity === 'contradiction');
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0].message).toContain('DECIDED_FOR');
    expect(contradictions[0].message).toContain('DECIDED_AGAINST');
  });

  it('finds undocumented entities', async () => {
    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: 'docs/ARCH.md' }],
      // entities for doc
      [],
      // undocumented entities
      [
        { name: 'RateLimiter', type: 'component', relCount: 5 },
        { name: 'WebSocket', type: 'technology', relCount: 3 },
      ],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    expect(result.undocumented).toHaveLength(2);
    expect(result.undocumented[0].name).toBe('RateLimiter');
    expect(result.undocumented[0].relationshipCount).toBe(5);
  });

  it('filters to specified files', async () => {
    const runner = createSequentialMockRunner([
      // discover all docs
      [{ filePath: 'docs/ARCH.md' }, { filePath: 'docs/API.md' }, { filePath: 'docs/README.md' }],
      // only analyze docs/ARCH.md (filtered)
      [{ name: 'React', type: 'technology', canonId: 'react' }],
      [],
      [],
      [],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
      files: ['docs/ARCH.md'],
    });

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].filePath).toBe('docs/ARCH.md');
  });

  it('computes freshness percentage correctly', async () => {
    const runner = createSequentialMockRunner([
      // discover
      [{ filePath: 'docs/A.md' }],
      // entities: 4 entities
      [
        { name: 'A', type: 'concept', canonId: 'a' },
        { name: 'B', type: 'concept', canonId: 'b' },
        { name: 'C', type: 'concept', canonId: 'c' },
        { name: 'D', type: 'concept', canonId: 'd' },
      ],
      // stale: A was decided against (target of DECIDED_AGAINST)
      [{ entityName: 'A', predicate: 'DECIDED_AGAINST', decidedBy: 'E' }],
      [],
      [],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    const report = result.reports[0];
    // 3 of 4 entities are still fresh → 75%
    expect(report.freshCount).toBe(3);
    expect(report.totalCount).toBe(4);
    expect(report.freshnessPercent).toBe(75);
  });

  it('classifies document status correctly', async () => {
    // Rotten: <50% or >=3 stale issues
    const runner = createSequentialMockRunner([
      [{ filePath: 'docs/OLD.md' }],
      // 4 entities, 3 stale
      [
        { name: 'A', type: 'concept', canonId: 'a' },
        { name: 'B', type: 'concept', canonId: 'b' },
        { name: 'C', type: 'concept', canonId: 'c' },
        { name: 'D', type: 'concept', canonId: 'd' },
      ],
      // 3 stale entities (all returned by single target-direction query)
      [
        { entityName: 'A', predicate: 'DECIDED_AGAINST', decidedBy: 'X' },
        { entityName: 'B', predicate: 'SUPERSEDES', decidedBy: 'Y' },
        { entityName: 'C', predicate: 'REPLACES', decidedBy: 'Z' },
      ],
      [],
      [],
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
    });

    expect(result.reports[0].status).toBe('rotten');
  });
});

// =============================================================================
// Temporal staleness detection
// =============================================================================

describe('temporal staleness', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-dochealth-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects entities updated after document mtime', async () => {
    // Create a document file with an old mtime
    const docPath = path.join(tmpDir, 'docs', 'ARCH.md');
    await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.writeFile(docPath, '# Architecture');
    // Set mtime to 30 days ago
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(docPath, oldDate, oldDate);

    // The entity was "updated" after the doc mtime — we'll use a string date (tomorrow)
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: 'docs/ARCH.md' }],
      // entities
      [{ name: 'React', type: 'technology', canonId: 'react' }],
      // stale check
      [],
      // drift check
      [],
      // contradiction check
      [],
      // temporal check: entity updated after doc mtime
      [{ name: 'React', type: 'technology', updatedAt: futureDate }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
      cwd: tmpDir,
    });

    const report = result.reports[0];
    const temporalIssues = report.issues.filter(i => i.severity === 'stale-temporal');
    expect(temporalIssues.length).toBeGreaterThanOrEqual(1);
    expect(temporalIssues[0].entityName).toBe('React');
    expect(temporalIssues[0].message).toContain('updated in the graph');
    expect(temporalIssues[0].detail).toContain('Entity updated');
    expect(result.stats.temporalCount).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag entities updated before document mtime', async () => {
    // Create a fresh document file (just written now)
    const docPath = path.join(tmpDir, 'docs', 'API.md');
    await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    await fs.writeFile(docPath, '# API');

    // Entity was updated a year ago — well before the doc
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    const runner = createSequentialMockRunner([
      // discover docs
      [{ filePath: 'docs/API.md' }],
      // entities
      [{ name: 'FastAPI', type: 'technology', canonId: 'fastapi' }],
      // stale check
      [],
      // drift
      [],
      // contradiction
      [],
      // temporal: entity updated before doc mtime
      [{ name: 'FastAPI', type: 'technology', updatedAt: oldDate }],
      // undocumented
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
      cwd: tmpDir,
    });

    const temporalIssues = result.reports[0].issues.filter(i => i.severity === 'stale-temporal');
    expect(temporalIssues).toHaveLength(0);
  });

  it('skips temporal check when cwd is not provided', async () => {
    const runner = createSequentialMockRunner([
      [{ filePath: 'docs/X.md' }],
      [{ name: 'Vue', type: 'technology', canonId: 'vue' }],
      [],
      [],
      [],
      // No temporal query issued — only 5 queries per doc without cwd
      [],
    ]);

    const result = await analyzeDocHealth({
      runner,
      sessionId: 'test',
      // no cwd — temporal check should be skipped
    });

    // Should still work, just no temporal issues
    expect(result.reports).toHaveLength(1);
    const temporalIssues = result.reports[0].issues.filter(i => i.severity === 'stale-temporal');
    expect(temporalIssues).toHaveLength(0);
  });

  it('includes temporal count in stats', async () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 2,
        temporalCount: 2,
      },
    });
    expect(result.stats.temporalCount).toBe(2);
  });
});

// =============================================================================
// formatDocHealthMarkdown — temporal rendering
// =============================================================================

describe('formatDocHealthMarkdown — temporal', () => {
  it('renders temporal issue count in summary', () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 3,
        temporalCount: 3,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('🕐 3 temporal');
  });

  it('renders temporal recommendation', () => {
    const result = createResult({
      stats: {
        ...createResult().stats,
        totalIssues: 1,
        temporalCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('temporally stale');
  });

  it('renders stale-temporal icon in per-document issues', () => {
    const result = createResult({
      reports: [
        createDocReport({
          filePath: 'docs/OLD.md',
          status: 'warning',
          issues: [
            {
              severity: 'stale-temporal',
              message: '"React" was updated in the graph 15d after this document was last modified',
              entityName: 'React',
              entityType: 'technology',
              detail: 'Entity updated: 2026-03-01, Doc modified: 2026-02-14',
            },
          ],
        }),
      ],
      stats: {
        ...createResult().stats,
        docsAnalyzed: 1,
        warningDocs: 1,
        totalIssues: 1,
        temporalCount: 1,
      },
    });
    const md = formatDocHealthMarkdown(result);
    expect(md).toContain('🕐');
    expect(md).toContain('stale-temporal');
    expect(md).toContain('React');
  });
});
