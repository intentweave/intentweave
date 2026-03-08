// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Full Report Markdown Formatter
 *
 * Generates latest.full.md from RunReport.
 * Complete audit trail for humans.
 */

import type { RunReport, Issue, IssueKind } from "../types.js";

/**
 * Format RunReport as full.md
 */
export function formatFullReport(report: RunReport): string {
  const lines: string[] = [];

  // Header
  lines.push("# IntentWeave Full Report");
  lines.push("");
  lines.push(`Run ID: \`${report.run.id}\``);
  lines.push(`Timestamp: ${report.run.ts}`);
  lines.push(`Mode: ${report.run.mode}`);
  lines.push(`Duration: ${formatDuration(report.run.durationMs)}`);
  lines.push("");

  // Inputs
  lines.push("## 1) Inputs");
  lines.push("");
  lines.push("| Input | Value |");
  lines.push("|-------|-------|");
  lines.push(`| Profile | ${report.inputs.profile} |`);
  if (report.inputs.transcriptPath) {
    lines.push(`| Transcript | \`${report.inputs.transcriptPath}\` |`);
  }
  if (report.inputs.rolesPath) {
    lines.push(`| Roles | \`${report.inputs.rolesPath}\` |`);
  }
  if (report.inputs.configHash) {
    lines.push(
      `| Config hash | \`${report.inputs.configHash.substring(0, 12)}...\` |`,
    );
  }
  lines.push("");

  // Artifacts
  lines.push("### Artifacts");
  lines.push("");
  for (const artifact of report.inputs.artifacts) {
    lines.push(`- \`${artifact.id}\` (${artifact.type})`);
    if (artifact.messageCount) {
      lines.push(`  - ${artifact.messageCount} messages`);
    }
  }
  lines.push("");

  // Cache reuse
  if (report.run.reuse) {
    lines.push("## 2) Cache Reuse");
    lines.push("");
    const { totalChunks, reusedChunks, recomputedChunks } = report.run.reuse;
    const reusePercent =
      totalChunks > 0 ? ((reusedChunks / totalChunks) * 100).toFixed(0) : 0;
    lines.push(`- Total chunks: ${totalChunks}`);
    lines.push(`- Reused: ${reusedChunks} (${reusePercent}%)`);
    lines.push(`- Recomputed: ${recomputedChunks}`);
    lines.push("");
  }

  // Stage timings
  lines.push("## 3) Stage Timings");
  lines.push("");
  lines.push("| Stage | Duration |");
  lines.push("|-------|----------|");
  for (const [stage, ms] of Object.entries(report.timings)) {
    if (stage !== "total" && ms !== undefined) {
      lines.push(`| ${stage} | ${formatDuration(ms)} |`);
    }
  }
  lines.push(`| **Total** | **${formatDuration(report.timings.total)}** |`);
  lines.push("");

  // Summary
  lines.push("## 4) Summary");
  lines.push("");
  lines.push(`- Total entities: ${report.summary.totalEntities}`);
  lines.push(`- Total statements: ${report.summary.totalStatements}`);
  if (report.summary.totalMessages > 0) {
    lines.push(`- Total messages: ${report.summary.totalMessages}`);
  }
  lines.push("");

  // Role distribution
  if (Object.keys(report.summary.roleDistribution).length > 0) {
    lines.push("### Role Distribution");
    lines.push("");
    lines.push("| Role | Count |");
    lines.push("|------|-------|");
    for (const [role, count] of Object.entries(
      report.summary.roleDistribution,
    )) {
      lines.push(`| ${role} | ${count} |`);
    }
    lines.push("");
  }

  // Coverage metrics
  lines.push("### Coverage Metrics");
  lines.push("");
  lines.push(
    `- Intent → Spec: ${(report.summary.intentToSpecCoverage * 100).toFixed(0)}%`,
  );
  lines.push(
    `- Spec → Implementation: ${(report.summary.specToImplCoverage * 100).toFixed(0)}%`,
  );
  lines.push("");

  // Issue summary
  lines.push("## 5) Issue Summary");
  lines.push("");
  lines.push("| Kind | Count |");
  lines.push("|------|-------|");
  lines.push(`| Contradictions | ${report.summary.contradictions} |`);
  lines.push(`| Open Ends | ${report.summary.openEnds} |`);
  lines.push(`| Needs Review | ${report.summary.needsReview} |`);
  lines.push(`| Errors | ${report.summary.errors} |`);
  lines.push(`| **Total** | **${report.issues.length}** |`);
  lines.push("");

  // Trend
  if (report.summary.trend) {
    lines.push("### Trend vs Previous Run");
    lines.push("");
    lines.push(`- New issues: ${report.summary.trend.newIssues}`);
    lines.push(`- Resolved: ${report.summary.trend.resolvedIssues}`);
    lines.push(`- Recurring: ${report.summary.trend.recurringIssues}`);
    lines.push("");
  }

  // All issues (grouped by kind)
  lines.push("## 6) All Issues");
  lines.push("");

  const issuesByKind = groupBy(report.issues, (i: Issue) => i.kind);

  const contradictions = issuesByKind.contradiction ?? [];
  if (contradictions.length > 0) {
    lines.push("### Contradictions");
    lines.push("");
    for (const issue of contradictions) {
      lines.push(formatFullIssue(issue));
      lines.push("");
    }
  }

  const openEnds = issuesByKind.open_end ?? [];
  if (openEnds.length > 0) {
    lines.push("### Open Ends");
    lines.push("");
    for (const issue of openEnds) {
      lines.push(formatFullIssue(issue));
      lines.push("");
    }
  }

  const needsReview = issuesByKind.needs_review ?? [];
  if (needsReview.length > 0) {
    lines.push("### Needs Review");
    lines.push("");
    for (const issue of needsReview) {
      lines.push(formatFullIssue(issue));
      lines.push("");
    }
  }

  const errors = issuesByKind.error ?? [];
  if (errors.length > 0) {
    lines.push("### Errors");
    lines.push("");
    for (const issue of errors) {
      lines.push(formatFullIssue(issue));
      lines.push("");
    }
  }

  // Actions
  if (report.actions.length > 0) {
    lines.push("## 7) Suggested Actions");
    lines.push("");
    lines.push("| Rank | Score | Action | Issue | Effort |");
    lines.push("|------|-------|--------|-------|--------|");
    for (const action of report.actions) {
      const score = action.actionScore?.toFixed(2) ?? "-";
      lines.push(
        `| ${action.rank} | ${score} | ${action.description} | ${action.issueId ?? "-"} | ${action.estimatedEffort ?? "-"} |`,
      );
    }
    lines.push("");
  }

  // Generator metadata
  lines.push("## 8) Generator");
  lines.push("");
  lines.push(`- Version: ${report.generator.version}`);
  if (report.generator.gitSha) {
    lines.push(`- Git SHA: \`${report.generator.gitSha}\``);
  }
  lines.push(`- Heuristics: v${report.generator.heuristicsVersion}`);
  if (Object.keys(report.generator.adapterVersions).length > 0) {
    lines.push("- Adapter versions:");
    for (const [adapter, version] of Object.entries(
      report.generator.adapterVersions,
    )) {
      lines.push(`  - ${adapter}: ${version}`);
    }
  }
  lines.push("");

  // Report policy
  lines.push("## 9) Report Policy");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("|---------|-------|");
  lines.push(`| minConfidence | ${report.inputs.reportPolicy.minConfidence} |`);
  lines.push(
    `| blockerConfidence | ${report.inputs.reportPolicy.blockerConfidence} |`,
  );
  lines.push(
    `| warningConfidence | ${report.inputs.reportPolicy.warningConfidence} |`,
  );
  lines.push(
    `| includeKinds | ${report.inputs.reportPolicy.includeKinds.join(", ")} |`,
  );
  lines.push(
    `| includeRoles | ${report.inputs.reportPolicy.includeRoles.join(", ")} |`,
  );
  if (report.inputs.reportPolicy.maxIssues) {
    lines.push(`| maxIssues | ${report.inputs.reportPolicy.maxIssues} |`);
  }
  if (report.inputs.reportPolicy.maxEvidencePerIssue) {
    lines.push(
      `| maxEvidencePerIssue | ${report.inputs.reportPolicy.maxEvidencePerIssue} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

// =============================================================================
// Helpers
// =============================================================================

function formatFullIssue(issue: Issue): string {
  const lines: string[] = [];

  // Header
  const severityIcon = { blocker: "🔴", warning: "🟠", info: "🟡" }[
    issue.severity
  ];
  lines.push(`#### ${severityIcon} ${issue.id}: ${issue.title}`);
  lines.push("");

  // Metadata table
  lines.push("| Property | Value |");
  lines.push("|----------|-------|");
  lines.push(`| Issue Key | \`${issue.issueKey}\` |`);
  lines.push(`| Fingerprint | \`${issue.fingerprint}\` |`);
  lines.push(`| Severity | ${issue.severity} |`);
  lines.push(`| Kind | ${issue.kind} |`);
  lines.push(`| Confidence | ${(issue.confidence * 100).toFixed(0)}% |`);
  lines.push(`| Status | ${issue.status} |`);
  lines.push(`| First Seen | ${issue.firstSeenRunId} |`);
  lines.push(`| Last Seen | ${issue.lastSeenRunId} |`);
  if (issue.resolvedAt) {
    lines.push(`| Resolved At | ${issue.resolvedAt} |`);
  }
  if (issue.stage) {
    lines.push(`| Stage | ${issue.stage} |`);
  }
  lines.push("");

  // Description
  if (issue.description) {
    lines.push("**Description**");
    lines.push("");
    lines.push(issue.description);
    lines.push("");
  }

  // Evidence
  if (issue.evidence.length > 0) {
    lines.push("**Evidence**");
    lines.push("");
    for (let i = 0; i < issue.evidence.length; i++) {
      const ev = issue.evidence[i];
      lines.push(`${i + 1}. \`${ev.sourceKey}\``);
      lines.push(`   > ${ev.excerpt}`);
      if (ev.charStart !== undefined && ev.charEnd !== undefined) {
        lines.push(`   > Chars: ${ev.charStart}-${ev.charEnd}`);
      }
      if (ev.transcriptPath) {
        lines.push(`   > File: \`${ev.transcriptPath}\``);
      }
    }
    lines.push("");
  }

  // Graph refs
  if (issue.graphRefs && issue.graphRefs.length > 0) {
    lines.push("**Graph References**");
    lines.push("");
    for (const ref of issue.graphRefs) {
      const parts: string[] = [];
      if (ref.nodeId) parts.push(`Node: \`${ref.nodeId}\``);
      if (ref.edgeId) parts.push(`Edge: \`${ref.edgeId}\``);
      if (ref.predicate) parts.push(`Predicate: ${ref.predicate}`);
      if (ref.entityName) parts.push(`Entity: ${ref.entityName}`);
      lines.push(`- ${parts.join(", ")}`);
    }
    lines.push("");
  }

  // Suggested actions
  if (issue.suggestedActions && issue.suggestedActions.length > 0) {
    lines.push("**Suggested Actions**");
    lines.push("");
    for (const action of issue.suggestedActions) {
      lines.push(`- **${action.type}**: ${action.description}`);
      if (action.command) {
        lines.push(`  - Command: \`${action.command}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function groupBy<T, K extends string>(
  items: T[],
  keyFn: (item: T) => K,
): Partial<Record<K, T[]>> {
  const result: Partial<Record<K, T[]>> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key]!.push(item);
  }
  return result;
}
