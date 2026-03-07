// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Report Generator
 * 
 * Generates RunReport from pipeline run outputs.
 */

import { existsSync } from 'fs';
import { readFile, readdir, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type {
  RunReport,
  Issue,
  ReportEvidence,
  SuggestedAction,
  ReportPolicy,
  ReportSummary,
  ReportInputs,
  StageTimings,
  RunDelta,
  GeneratorMetadata,
  IssueKind,
  IssueFingerprint,
  IssueRegistry,
  ProblemsReport,
  ReportImportState,
} from './types.js';
import { DEFAULT_REPORT_POLICY } from './types.js';
import { 
  loadIssueRegistry, 
  saveIssueRegistry, 
  getOrAllocateIssueId,
  markUnseenAsResolved,
  computeIssueTrend,
  type IssueIdResult,
} from './registry.js';
import { computeSeverity, rankActions } from './severity.js';
import { loadImportState } from '../transcripts/storage.js';
import { 
  createErrorFingerprint,
  createOpenEndFingerprint,
  createNeedsReviewFingerprint,
} from './fingerprint.js';

// =============================================================================
// Types
// =============================================================================

export interface RunMetadata {
  $schema: string;
  schemaVersion: string;
  runId: string;
  workspaceKey: string;
  workspaceId: string;
  startedAt: string;
  status: string;
  profile: string;
  stages: string[];
  artifacts: string[];
  extractionConfig?: {
    requested?: Record<string, unknown>;
    effective?: Record<string, unknown>;
  };
  completedAt?: string;
  durationMs?: number;
  summary?: {
    entityCount: number;
    statementCount: number;
    artifactCount: number;
  };
}

export interface Finding {
  id: string;
  severity: string;
  category: string;
  message: string;
  entities?: string[];
  sourceKeys?: string[];
}

export interface FindingsFile {
  $schema: string;
  schemaVersion: string;
  stage: string;
  findings: Finding[];
  summary: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
  };
}

export interface CoverageArtifact {
  artifactId: string;
  artifactRole: string;
  conceptCount: number;
  transitionCount: number;
  kindCounts: Record<string, number>;
  avgConfidence: number;
}

export interface CoverageFile {
  $schema: string;
  schemaVersion: string;
  stage: string;
  summary: {
    totalArtifacts: number;
    totalConcepts: number;
    totalTransitions: number;
    avgConfidence: number;
    kindCounts: Record<string, number>;
    roleCounts: Record<string, number>;
  };
  artifacts: CoverageArtifact[];
}

export interface ReportGeneratorOptions {
  iwDir: string;
  runId: string;
  sessionKey?: string;
  policy?: Partial<ReportPolicy>;
}

// =============================================================================
// Generator
// =============================================================================

/**
 * Generate a report from a pipeline run.
 */
export async function generateReport(
  options: ReportGeneratorOptions
): Promise<RunReport> {
  const { iwDir, runId, sessionKey } = options;
  const policy: ReportPolicy = {
    ...DEFAULT_REPORT_POLICY,
    ...options.policy,
  };
  
  // Load run metadata
  const runDir = join(iwDir, 'runs', runId);
  const runMeta = await loadRunMetadata(runDir);
  
  // Load findings and coverage
  const aggregateDir = join(runDir, 'aggregate');
  const findings = await loadFindings(aggregateDir);
  const coverage = await loadCoverage(aggregateDir);
  
  // Determine session key (use first chat artifact or workspace key)
  const effectiveSessionKey = sessionKey ?? deriveSessionKey(runMeta);
  
  // Load issue registry
  const registry = await loadIssueRegistry(iwDir, effectiveSessionKey);
  
  // Convert findings to issues
  const { issues, idResults } = await convertFindingsToIssues(
    findings,
    registry,
    effectiveSessionKey,
    runId,
    policy
  );
  
  // Mark unseen issues as resolved
  const seenFingerprints = new Set(idResults.map(r => r.fingerprint));
  const resolvedCount = markUnseenAsResolved(registry, seenFingerprints);
  
  // Compute trend
  const trend = computeIssueTrend(idResults, resolvedCount);
  
  // Save updated registry
  await saveIssueRegistry(iwDir, effectiveSessionKey, registry);
  
  // Generate suggested actions from issues
  const rawActions = generateActionsFromIssues(issues);
  const actions = rankActions(rawActions, issues);
  
  // Build summary
  const summary = buildSummary(runMeta, coverage, issues, trend);
  
  // Load import state and compute transcript fingerprint
  const { importState, transcriptFingerprint } = await loadImportStateForReport(iwDir, runMeta);
  
  // Build inputs with import state
  const inputs = buildInputs(runMeta, policy, importState, transcriptFingerprint);
  
  // Apply compact mode if enabled
  const compactIssues = policy.maxIssues || policy.maxIssuesPerKind 
    ? applyCompactMode(issues, policy)
    : issues;
  
  // Build timings (placeholder - would need stage timing data)
  const timings: StageTimings = {
    total: runMeta.durationMs ?? 0,
  };
  
  // Build generator metadata
  const generator = buildGeneratorMetadata();
  
  const report: RunReport = {
    $schema: 'intentweave://schemas/report/v1',
    schemaVersion: '0.1',
    run: {
      id: runMeta.runId,
      ts: runMeta.startedAt,
      mode: 'full', // TODO: detect incremental
      durationMs: runMeta.durationMs ?? 0,
    },
    inputs,
    summary,
    issues: compactIssues,
    actions,
    timings,
    generator,
  };
  
  return report;
}

// =============================================================================
// Loaders
// =============================================================================

async function loadRunMetadata(runDir: string): Promise<RunMetadata> {
  const path = join(runDir, 'run.meta.json');
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as RunMetadata;
}

async function loadFindings(aggregateDir: string): Promise<FindingsFile | null> {
  const path = join(aggregateDir, 'findings.json');
  if (!existsSync(path)) return null;
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as FindingsFile;
}

async function loadCoverage(aggregateDir: string): Promise<CoverageFile | null> {
  const path = join(aggregateDir, 'coverage.json');
  if (!existsSync(path)) return null;
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as CoverageFile;
}

async function loadImportStateForReport(
  iwDir: string,
  runMeta: RunMetadata
): Promise<{ importState?: ReportImportState; transcriptFingerprint?: string }> {
  try {
    const workspaceRoot = dirname(iwDir);
    const stateFile = await loadImportState(workspaceRoot);
    
    if (!stateFile || Object.keys(stateFile).length === 0) {
      return {};
    }
    
    // Compute transcript fingerprint from state
    const transcriptFingerprint = createHash('sha256')
      .update(JSON.stringify(stateFile))
      .digest('hex')
      .slice(0, 16);
    
    // Aggregate import state from all sources
    const sources = Object.values(stateFile);
    const aggregated: ReportImportState = {
      lastOffset: Math.max(...sources.map(s => s.lastOffset || 0)),
      lastSize: sources.reduce((sum, s) => sum + (s.lastSize || 0), 0),
      prefixHash: sources.length > 0 ? sources[0].prefixHash64k : '',
      lastProcessedSeq: Math.max(...sources.map(s => s.lastProcessedSeq || 0)),
      sourceCount: sources.length,
    };
    
    return { importState: aggregated, transcriptFingerprint };
  } catch {
    return {};
  }
}

function applyCompactMode(issues: Issue[], policy: ReportPolicy): Issue[] {
  let result = [...issues];
  
  // Apply maxIssuesPerKind first
  if (policy.maxIssuesPerKind) {
    const byKind = new Map<string, Issue[]>();
    for (const issue of result) {
      const list = byKind.get(issue.kind) || [];
      list.push(issue);
      byKind.set(issue.kind, list);
    }
    
    result = [];
    for (const [, kindIssues] of byKind) {
      // Sort by severity (blocker > warning > info) then by confidence
      const sorted = kindIssues.sort((a, b) => {
        const sevOrder = { blocker: 0, warning: 1, info: 2 };
        const sevDiff = sevOrder[a.severity] - sevOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return (b.confidence || 0) - (a.confidence || 0);
      });
      result.push(...sorted.slice(0, policy.maxIssuesPerKind));
    }
  }
  
  // Apply maxIssues overall
  if (policy.maxIssues && result.length > policy.maxIssues) {
    // Sort by severity then confidence
    result.sort((a, b) => {
      const sevOrder = { blocker: 0, warning: 1, info: 2 };
      const sevDiff = sevOrder[a.severity] - sevOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return (b.confidence || 0) - (a.confidence || 0);
    });
    result = result.slice(0, policy.maxIssues);
  }
  
  // Apply evidence and excerpt limits
  if (policy.maxEvidencePerIssue || policy.maxExcerptChars) {
    result = result.map(issue => {
      let evidence = issue.evidence || [];
      
      if (policy.maxEvidencePerIssue && evidence.length > policy.maxEvidencePerIssue) {
        evidence = evidence.slice(0, policy.maxEvidencePerIssue);
      }
      
      if (policy.maxExcerptChars) {
        const maxChars = policy.maxExcerptChars;
        evidence = evidence.map(e => ({
          ...e,
          excerpt: e.excerpt && e.excerpt.length > maxChars
            ? e.excerpt.slice(0, maxChars) + '...'
            : e.excerpt,
        }));
      }
      
      return { ...issue, evidence };
    });
  }
  
  return result;
}

// =============================================================================
// Converters
// =============================================================================

function deriveSessionKey(runMeta: RunMetadata): string {
  // Check for chat artifacts
  const chatArtifact = runMeta.artifacts.find(a => a.startsWith('chat:'));
  if (chatArtifact) {
    return chatArtifact;
  }
  // Fall back to workspace key
  return `workspace:${runMeta.workspaceKey}`;
}

interface ConversionResult {
  issues: Issue[];
  idResults: IssueIdResult[];
}

async function convertFindingsToIssues(
  findings: FindingsFile | null,
  registry: IssueRegistry,
  sessionKey: string,
  runId: string,
  policy: ReportPolicy
): Promise<ConversionResult> {
  const issues: Issue[] = [];
  const idResults: IssueIdResult[] = [];
  
  if (!findings) {
    return { issues, idResults };
  }
  
  for (const finding of findings.findings) {
    // Map finding to issue kind
    const kind = mapFindingToIssueKind(finding);
    if (!policy.includeKinds.includes(kind)) continue;
    
    // Create fingerprint
    const fingerprint = createFindingFingerprint(finding, kind);
    
    // Get or allocate issue ID
    const idResult = getOrAllocateIssueId(registry, sessionKey, runId, fingerprint);
    idResults.push(idResult);
    
    // Map finding severity
    const confidence = mapFindingSeverityToConfidence(finding.severity);
    if (confidence < policy.minConfidence) continue;
    
    // Compute severity
    const severity = computeSeverity(kind, confidence, policy);
    
    // Build evidence
    const evidence = buildFindingEvidence(finding, policy);
    
    // Build issue
    const issue: Issue = {
      id: idResult.id,
      issueKey: idResult.issueKey,
      fingerprint: idResult.fingerprint,
      severity,
      kind,
      title: finding.message,
      confidence,
      status: idResult.previousStatus === 'resolved' ? 'regressed' : 'active',
      firstSeenRunId: runId, // Will be overwritten if not new
      lastSeenRunId: runId,
      evidence,
    };
    
    issues.push(issue);
  }
  
  return { issues, idResults };
}

function mapFindingToIssueKind(finding: Finding): IssueKind {
  // Map categories to issue kinds
  switch (finding.category) {
    case 'deduplication':
      return 'needs_review';
    case 'graph':
      return 'open_end';
    case 'validation':
      return finding.severity === 'error' ? 'error' : 'needs_review';
    case 'contradiction':
      return 'contradiction';
    default:
      return 'needs_review';
  }
}

function createFindingFingerprint(finding: Finding, kind: IssueKind): IssueFingerprint {
  switch (kind) {
    case 'error':
      return createErrorFingerprint(finding.id, finding.category);
    case 'open_end':
      return createOpenEndFingerprint('spec', 'implementation', finding.entities?.[0]);
    case 'needs_review':
      return createNeedsReviewFingerprint(finding.category, finding.entities?.[0]);
    default:
      return createNeedsReviewFingerprint(finding.category, finding.entities?.[0]);
  }
}

function mapFindingSeverityToConfidence(severity: string): number {
  switch (severity) {
    case 'error': return 0.95;
    case 'warning': return 0.75;
    case 'info': return 0.5;
    default: return 0.5;
  }
}

function buildFindingEvidence(finding: Finding, policy: ReportPolicy): ReportEvidence[] {
  const evidence: ReportEvidence[] = [];
  const maxEvidence = policy.maxEvidencePerIssue ?? 5;
  
  // Use entities as evidence
  const entities = finding.entities ?? [];
  for (let i = 0; i < Math.min(entities.length, maxEvidence); i++) {
    const entity = entities[i];
    evidence.push({
      sourceKey: `finding:${finding.id}:e:${i}`,
      seq: i,
      excerpt: truncate(entity, policy.maxExcerptChars ?? 500),
      ref: `iw://finding/${finding.id}#e${i}`,
    });
  }
  
  return evidence;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// =============================================================================
// Action Generation
// =============================================================================

function generateActionsFromIssues(issues: Issue[]): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  
  for (const issue of issues) {
    // Generate action based on issue kind
    const action = generateActionForIssue(issue);
    if (action) {
      actions.push(action);
    }
  }
  
  return actions;
}

function generateActionForIssue(issue: Issue): SuggestedAction | null {
  switch (issue.kind) {
    case 'contradiction':
      return {
        rank: 0, // Will be set by rankActions
        issueId: issue.id,
        description: `Resolve contradiction: ${issue.title}`,
        estimatedEffort: '0.5d',
        command: `iw explain ${issue.id}`,
      };
    case 'open_end':
      return {
        rank: 0,
        issueId: issue.id,
        description: `Add missing link: ${issue.title}`,
        estimatedEffort: '0.25d',
        command: `iw explain ${issue.id}`,
      };
    case 'needs_review':
      return {
        rank: 0,
        issueId: issue.id,
        description: `Review: ${issue.title}`,
        estimatedEffort: '2h',
        command: `iw explain ${issue.id}`,
      };
    case 'error':
      return {
        rank: 0,
        issueId: issue.id,
        description: `Fix error: ${issue.title}`,
        estimatedEffort: '0.5d',
        command: `iw explain ${issue.id}`,
      };
    default:
      return null;
  }
}

// =============================================================================
// Builders
// =============================================================================

function buildSummary(
  runMeta: RunMetadata,
  coverage: CoverageFile | null,
  issues: Issue[],
  trend: ReturnType<typeof computeIssueTrend>
): ReportSummary {
  const contradictions = issues.filter(i => i.kind === 'contradiction').length;
  const openEnds = issues.filter(i => i.kind === 'open_end').length;
  const needsReview = issues.filter(i => i.kind === 'needs_review').length;
  const errors = issues.filter(i => i.kind === 'error').length;
  
  // Find top issue (highest severity, then confidence)
  const sorted = [...issues].sort((a, b) => {
    const sevOrder = { blocker: 0, warning: 1, info: 2 };
    const sevDiff = sevOrder[a.severity] - sevOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.confidence - a.confidence;
  });
  
  return {
    totalMessages: 0, // Would need transcript data
    totalEntities: runMeta.summary?.entityCount ?? 0,
    totalStatements: runMeta.summary?.statementCount ?? 0,
    roleDistribution: coverage?.summary.roleCounts ?? {},
    intentToSpecCoverage: 0, // Would need LX data
    specToImplCoverage: 0, // Would need LX data
    contradictions,
    openEnds,
    needsReview,
    errors,
    trend: {
      newIssues: trend.newIssues,
      resolvedIssues: trend.resolvedIssues,
      recurringIssues: trend.recurringIssues,
    },
    topIssue: sorted[0]?.title,
  };
}

function buildInputs(
  runMeta: RunMetadata, 
  policy: ReportPolicy,
  importState?: ReportImportState,
  transcriptFingerprint?: string
): ReportInputs {
  return {
    artifacts: runMeta.artifacts.map(a => ({
      id: a,
      type: a.startsWith('chat:') ? 'chat' as const : 'file' as const,
      source: a.split(':')[1] ?? 'file',
    })),
    profile: runMeta.profile,
    configHash: '', // Would need to compute
    reportPolicy: policy,
    importState,
    transcriptFingerprint,
  };
}

function buildGeneratorMetadata(): GeneratorMetadata {
  return {
    version: 'iw@0.6.0', // TODO: read from package.json
    heuristicsVersion: '1.0',
    adapterVersions: {
      specstory: '0.1.0',
    },
  };
}

// =============================================================================
// Report Output
// =============================================================================

/**
 * Save report files to .iw/reports/
 */
export async function saveReport(
  iwDir: string,
  report: RunReport,
  problemsMd: string,
  fullMd: string
): Promise<void> {
  const reportsDir = join(iwDir, 'reports');
  await mkdir(reportsDir, { recursive: true });
  
  // Save latest files
  await writeFile(join(reportsDir, 'latest.json'), JSON.stringify(report, null, 2));
  await writeFile(join(reportsDir, 'latest.problems.md'), problemsMd);
  await writeFile(join(reportsDir, 'latest.full.md'), fullMd);
  
  // Archive by run ID
  const archiveDir = join(reportsDir, 'archive');
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, `${report.run.id}.json`), JSON.stringify(report, null, 2));
}

/**
 * Load latest report.
 */
export async function loadLatestReport(iwDir: string): Promise<RunReport | null> {
  const path = join(iwDir, 'reports', 'latest.json');
  if (!existsSync(path)) return null;
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as RunReport;
}

/**
 * Extract problems report subset.
 */
export function extractProblemsReport(report: RunReport): ProblemsReport {
  return {
    run: {
      id: report.run.id,
      ts: report.run.ts,
      mode: report.run.mode,
    },
    summary: {
      contradictions: report.summary.contradictions,
      openEnds: report.summary.openEnds,
      needsReview: report.summary.needsReview,
      errors: report.summary.errors,
    },
    issues: report.issues,
    actions: report.actions,
  };
}

/**
 * Find latest run ID in .iw/runs/
 */
export async function findLatestRunId(iwDir: string): Promise<string | null> {
  const runsDir = join(iwDir, 'runs');
  if (!existsSync(runsDir)) return null;
  
  const entries = await readdir(runsDir, { withFileTypes: true });
  const runDirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith('run-'))
    .map(e => e.name)
    .sort()
    .reverse();
  
  return runDirs[0] ?? null;
}
