// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Problems Report Markdown Formatter
 * 
 * Generates latest.problems.md from RunReport.
 * Optimized for AI assistant consumption.
 */

import type { RunReport, Issue, SuggestedAction, IssueSeverity } from '../types.js';

/**
 * Format RunReport as problems.md
 */
export function formatProblemsReport(report: RunReport): string {
  const lines: string[] = [];
  
  // Assistant instruction block
  lines.push('<!-- iw:assistant-instructions');
  lines.push('Read sections 2–5 only. Propose concrete code/spec changes.');
  lines.push('Prefer smallest fixes. If something is ambiguous, propose a role override command.');
  lines.push('Commands are provided inline with each issue — execute them directly.');
  lines.push('-->');
  lines.push('');
  
  // Header
  lines.push('# IntentWeave Problem Report');
  lines.push('');
  lines.push(`Run: ${report.run.ts}`);
  lines.push(`Mode: ${report.run.mode} (${formatDuration(report.run.durationMs)})`);
  if (report.run.reuse) {
    const { reusedChunks, totalChunks } = report.run.reuse;
    lines.push(`Cache: reused ${reusedChunks}/${totalChunks} chunks`);
  }
  lines.push('');
  
  // TL;DR
  lines.push('## 0) TL;DR');
  lines.push('');
  lines.push(formatTldr(report));
  lines.push('');
  if (report.summary.topIssue) {
    lines.push(`Top fix: ${report.summary.topIssue}`);
    lines.push('');
  }
  
  // What changed
  if (report.summary.trend || report.delta) {
    lines.push('## 1) What changed since last run');
    lines.push('');
    lines.push(formatDelta(report));
    lines.push('');
  }
  
  // Blocking issues
  const blockers = report.issues.filter(i => i.severity === 'blocker');
  if (blockers.length > 0) {
    lines.push('## 2) Blocking issues (must fix)');
    lines.push('');
    
    // Contradictions
    const contradictions = blockers.filter(i => i.kind === 'contradiction');
    if (contradictions.length > 0) {
      for (const issue of contradictions) {
        lines.push(formatIssue(issue));
        lines.push('');
      }
    }
    
    // Errors
    const errors = blockers.filter(i => i.kind === 'error');
    if (errors.length > 0) {
      for (const issue of errors) {
        lines.push(formatIssue(issue));
        lines.push('');
      }
    }
    
    // Other blockers
    const others = blockers.filter(i => i.kind !== 'contradiction' && i.kind !== 'error');
    for (const issue of others) {
      lines.push(formatIssue(issue));
      lines.push('');
    }
  }
  
  // Open ends
  const openEnds = report.issues.filter(i => i.kind === 'open_end' && i.severity !== 'blocker');
  if (openEnds.length > 0) {
    lines.push('## 3) Open ends (missing links)');
    lines.push('');
    for (const issue of openEnds) {
      lines.push(formatIssue(issue));
      lines.push('');
    }
  }
  
  // Needs review
  const needsReview = report.issues.filter(i => i.kind === 'needs_review');
  if (needsReview.length > 0) {
    lines.push('## 4) Needs review (uncertain semantics)');
    lines.push('');
    for (const issue of needsReview) {
      lines.push(formatIssue(issue));
      lines.push('');
    }
  }
  
  // Next actions
  if (report.actions.length > 0) {
    lines.push('## 5) Next actions (ranked)');
    lines.push('');
    lines.push(formatActionsTable(report.actions));
    lines.push('');
  }
  
  // Appendix: Quick commands
  lines.push('## Appendix: Quick Commands');
  lines.push('');
  lines.push('```bash');
  lines.push('# Re-run pipeline');
  const firstArtifact = report.inputs.artifacts[0];
  if (firstArtifact?.type === 'chat') {
    lines.push(`iw run -i ${firstArtifact.id}`);
  } else {
    lines.push('iw run');
  }
  lines.push('');
  lines.push('# Generate fresh report');
  lines.push('iw report');
  if (report.issues.length > 0) {
    lines.push('');
    lines.push('# Explain specific issue');
    lines.push(`iw explain ${report.issues[0].id}`);
  }
  lines.push('```');
  lines.push('');
  
  return lines.join('\n');
}

// =============================================================================
// Formatters
// =============================================================================

function formatTldr(report: RunReport): string {
  const parts: string[] = [];
  
  if (report.summary.contradictions > 0) {
    parts.push(`🔴 ${report.summary.contradictions} contradiction${report.summary.contradictions > 1 ? 's' : ''} (spec ↔ implementation)`);
  }
  if (report.summary.openEnds > 0) {
    parts.push(`🟠 ${report.summary.openEnds} open end${report.summary.openEnds > 1 ? 's' : ''} (missing link)`);
  }
  if (report.summary.needsReview > 0) {
    parts.push(`🟡 ${report.summary.needsReview} needs-review item${report.summary.needsReview > 1 ? 's' : ''}`);
  }
  if (report.summary.errors > 0) {
    parts.push(`⛔ ${report.summary.errors} error${report.summary.errors > 1 ? 's' : ''}`);
  }
  
  if (parts.length === 0) {
    return '✅ No issues found!';
  }
  
  return parts.map(p => `- ${p}`).join('\n');
}

function formatDelta(report: RunReport): string {
  const parts: string[] = [];
  
  if (report.summary.trend) {
    const { newIssues, resolvedIssues, recurringIssues } = report.summary.trend;
    if (newIssues > 0) parts.push(`+${newIssues} new issue${newIssues > 1 ? 's' : ''}`);
    if (resolvedIssues > 0) parts.push(`-${resolvedIssues} resolved`);
    if (recurringIssues > 0) parts.push(`${recurringIssues} recurring`);
  }
  
  if (report.delta) {
    if (report.delta.newMessages > 0) {
      parts.push(`+${report.delta.newMessages} new message${report.delta.newMessages > 1 ? 's' : ''} imported`);
    }
    if (report.delta.roleOverrides > 0) {
      parts.push(`${report.delta.roleOverrides} role override${report.delta.roleOverrides > 1 ? 's' : ''}`);
    }
    if (report.delta.stagesRecomputed.length > 0) {
      parts.push(`Recomputed: ${report.delta.stagesRecomputed.join(', ')}`);
    }
  }
  
  if (parts.length === 0) {
    return '- No changes detected';
  }
  
  return parts.map(p => `- ${p}`).join('\n');
}

function formatIssue(issue: Issue): string {
  const lines: string[] = [];
  
  // Header with ID and title
  lines.push(`### ${issue.id}: ${issue.title}`);
  lines.push('');
  
  // Description if present
  if (issue.description) {
    lines.push(`**Symptom**: ${issue.description}`);
  }
  
  // Why it matters (based on kind)
  const whyMatters = getWhyItMatters(issue);
  if (whyMatters) {
    lines.push(`**Why it matters**: ${whyMatters}`);
  }
  
  // Suggested action
  if (issue.suggestedActions && issue.suggestedActions.length > 0) {
    const action = issue.suggestedActions[0];
    lines.push(`**Minimal fix**: ${action.description}`);
    if (action.command) {
      lines.push(`**Command**: \`${action.command}\``);
    }
  } else {
    // Default command
    lines.push(`**Command**: \`iw explain ${issue.id}\``);
  }
  
  // Confidence
  lines.push(`**Confidence**: ${(issue.confidence * 100).toFixed(0)}%`);
  
  // Evidence (first one only for brevity)
  if (issue.evidence.length > 0) {
    const ev = issue.evidence[0];
    lines.push(`**Evidence**: [${ev.sourceKey}] "${truncate(ev.excerpt, 80)}"`);
  }
  
  return lines.join('  \n');
}

function getWhyItMatters(issue: Issue): string | null {
  switch (issue.kind) {
    case 'contradiction':
      return 'Spec and implementation are inconsistent';
    case 'open_end':
      return 'Missing traceability link';
    case 'needs_review':
      return 'Ambiguous semantics may cause incorrect behavior';
    case 'error':
      return 'Pipeline stage may have failed or produced partial results';
    default:
      return null;
  }
}

function formatActionsTable(actions: SuggestedAction[]): string {
  const lines: string[] = [];
  
  lines.push('| # | Score | Action | Issue | ETA |');
  lines.push('|---|-------|--------|-------|-----|');
  
  for (const action of actions.slice(0, 10)) { // Limit to top 10
    const score = action.actionScore?.toFixed(1) ?? '-';
    const issue = action.issueId ?? '-';
    const eta = action.estimatedEffort ?? '-';
    lines.push(`| ${action.rank} | ${score} | ${action.description} | ${issue} | ${eta} |`);
  }
  
  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}
