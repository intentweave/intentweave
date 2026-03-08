// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * report command - Generate reports from pipeline runs
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import {
  generateReport,
  saveReport,
  loadLatestReport,
  findLatestRunId,
  formatProblemsReport,
  formatFullReport,
  extractProblemsReport,
  type ReportPolicy,
  DEFAULT_REPORT_POLICY,
} from "@intentweave/core";
import { IW_DIR } from "../constants.js";

type ReportFormat = "all" | "json" | "problems" | "full";

interface ReportOptions {
  run?: string;
  format: ReportFormat;
  stdout: boolean;
  compact: boolean;
  minConfidence?: string;
}

export const reportCommand = new Command("report")
  .description("Generate reports from pipeline runs")
  .option("--run <runId>", "Generate report for specific run (default: latest)")
  .option(
    "--format <format>",
    "Output format: all, json, problems, full",
    "all",
  )
  .option("--stdout", "Output to stdout instead of files", false)
  .option("--compact", "Apply compact mode limits", false)
  .option("--min-confidence <value>", "Minimum confidence threshold (0.0-1.0)")
  .action(async (options: ReportOptions) => {
    const iwDir = path.resolve(IW_DIR);

    // Find run ID
    let runId: string | undefined = options.run;
    if (!runId) {
      runId = (await findLatestRunId(iwDir)) ?? undefined;
      if (!runId) {
        console.error(
          chalk.red("No runs found. Run the pipeline first with `iw run`."),
        );
        process.exit(1);
      }
    }

    // Build policy
    const policy: Partial<ReportPolicy> = {};
    if (options.minConfidence) {
      const confidence = parseFloat(options.minConfidence);
      if (!isNaN(confidence) && confidence >= 0 && confidence <= 1) {
        policy.minConfidence = confidence;
      }
    }
    if (options.compact) {
      policy.maxIssues = 20;
      policy.maxIssuesPerKind = 5;
      policy.maxEvidencePerIssue = 3;
      policy.maxExcerptChars = 200;
    }

    try {
      console.log(chalk.blue(`Generating report for run: ${runId}`));

      // Generate report
      const report = await generateReport({
        iwDir,
        runId,
        policy,
      });

      // Format outputs
      const problemsMd = formatProblemsReport(report);
      const fullMd = formatFullReport(report);

      if (options.stdout) {
        // Output to stdout
        switch (options.format) {
          case "json":
            console.log(JSON.stringify(report, null, 2));
            break;
          case "problems":
            console.log(problemsMd);
            break;
          case "full":
            console.log(fullMd);
            break;
          case "all":
          default:
            console.log("=== latest.problems.md ===\n");
            console.log(problemsMd);
            console.log("\n=== latest.json ===\n");
            console.log(JSON.stringify(report, null, 2));
            break;
        }
      } else {
        // Save to files
        await saveReport(iwDir, report, problemsMd, fullMd);

        const reportsDir = path.join(iwDir, "reports");
        console.log(chalk.green("✓ Reports generated successfully"));
        console.log("");
        console.log("  Files:");
        console.log(`    ${chalk.cyan(path.join(reportsDir, "latest.json"))}`);
        console.log(
          `    ${chalk.cyan(path.join(reportsDir, "latest.problems.md"))}`,
        );
        console.log(
          `    ${chalk.cyan(path.join(reportsDir, "latest.full.md"))}`,
        );
        console.log("");

        // Summary
        console.log("  Summary:");
        console.log(`    Issues: ${report.issues.length} total`);
        if (report.summary.contradictions > 0) {
          console.log(
            `      ${chalk.red("●")} ${report.summary.contradictions} contradictions`,
          );
        }
        if (report.summary.openEnds > 0) {
          console.log(
            `      ${chalk.yellow("●")} ${report.summary.openEnds} open ends`,
          );
        }
        if (report.summary.needsReview > 0) {
          console.log(
            `      ${chalk.blue("●")} ${report.summary.needsReview} needs review`,
          );
        }
        if (report.summary.errors > 0) {
          console.log(
            `      ${chalk.red("●")} ${report.summary.errors} errors`,
          );
        }

        if (report.summary.trend) {
          console.log("");
          console.log("  Trend:");
          if (report.summary.trend.newIssues > 0) {
            console.log(`    +${report.summary.trend.newIssues} new`);
          }
          if (report.summary.trend.resolvedIssues > 0) {
            console.log(`    -${report.summary.trend.resolvedIssues} resolved`);
          }
        }
      }
    } catch (error) {
      console.error(chalk.red("Failed to generate report:"), error);
      process.exit(1);
    }
  });

/**
 * explain subcommand - Show detailed evidence for an issue
 */
export const explainCommand = new Command("explain")
  .description("Show detailed evidence for an issue")
  .argument("<issueId>", "Issue ID (e.g., C-1, O-2) or full issue key")
  .action(async (issueId: string) => {
    const iwDir = path.resolve(IW_DIR);

    try {
      // Load latest report
      const report = await loadLatestReport(iwDir);
      if (!report) {
        console.error(chalk.red("No report found. Run `iw report` first."));
        process.exit(1);
      }

      // Find issue
      let issue = report.issues.find((i) => i.id === issueId);
      if (!issue) {
        // Try matching by issueKey
        issue = report.issues.find((i) => i.issueKey === issueId);
      }
      if (!issue) {
        // Try matching by partial issueKey
        issue = report.issues.find((i) => i.issueKey.endsWith(`#${issueId}`));
      }

      if (!issue) {
        console.error(chalk.red(`Issue not found: ${issueId}`));
        console.log("");
        console.log("Available issues:");
        for (const i of report.issues.slice(0, 10)) {
          console.log(`  ${i.id}: ${i.title}`);
        }
        if (report.issues.length > 10) {
          console.log(`  ... and ${report.issues.length - 10} more`);
        }
        process.exit(1);
      }

      // Display issue details
      const severityColor = {
        blocker: chalk.red,
        warning: chalk.yellow,
        info: chalk.blue,
      }[issue.severity];

      console.log("");
      console.log(severityColor(`Issue ${issue.id}: ${issue.title}`));
      console.log("");

      // Metadata
      console.log(chalk.dim("Metadata"));
      console.log(`  Issue Key:   ${issue.issueKey}`);
      console.log(`  Fingerprint: ${issue.fingerprint}`);
      console.log(`  Kind:        ${issue.kind}`);
      console.log(`  Severity:    ${issue.severity}`);
      console.log(`  Confidence:  ${(issue.confidence * 100).toFixed(0)}%`);
      console.log(`  Status:      ${issue.status}`);
      console.log(`  First seen:  ${issue.firstSeenRunId}`);
      console.log(`  Last seen:   ${issue.lastSeenRunId}`);
      if (issue.resolvedAt) {
        console.log(`  Resolved:    ${issue.resolvedAt}`);
      }
      console.log("");

      // Description
      if (issue.description) {
        console.log(chalk.dim("Description"));
        console.log(`  ${issue.description}`);
        console.log("");
      }

      // Evidence
      if (issue.evidence.length > 0) {
        console.log(chalk.dim("Evidence"));
        for (let i = 0; i < issue.evidence.length; i++) {
          const ev = issue.evidence[i];
          console.log(`  ${i + 1}. [${ev.sourceKey}]`);
          console.log(`     "${ev.excerpt}"`);
          if (ev.charStart !== undefined && ev.charEnd !== undefined) {
            console.log(`     Chars: ${ev.charStart}-${ev.charEnd}`);
          }
          if (ev.transcriptPath) {
            console.log(`     File: ${ev.transcriptPath}`);
          }
        }
        console.log("");
      }

      // Graph refs
      if (issue.graphRefs && issue.graphRefs.length > 0) {
        console.log(chalk.dim("Graph References"));
        for (const ref of issue.graphRefs) {
          const parts: string[] = [];
          if (ref.nodeId) parts.push(`Node: ${ref.nodeId}`);
          if (ref.edgeId) parts.push(`Edge: ${ref.edgeId}`);
          if (ref.predicate) parts.push(`Predicate: ${ref.predicate}`);
          if (ref.entityName) parts.push(`Entity: ${ref.entityName}`);
          console.log(`  - ${parts.join(", ")}`);
        }
        console.log("");
      }

      // Suggested actions
      if (issue.suggestedActions && issue.suggestedActions.length > 0) {
        console.log(chalk.dim("Suggested Actions"));
        for (const action of issue.suggestedActions) {
          console.log(`  - ${chalk.bold(action.type)}: ${action.description}`);
          if (action.command) {
            console.log(`    Command: ${chalk.cyan(action.command)}`);
          }
        }
        console.log("");
      }

      // Commands
      console.log(chalk.dim("Commands"));
      console.log(
        `  iw role set <sourceKey> <role>  # Override role for evidence message`,
      );
      console.log(`  iw open <sourceKey>             # View message context`);
      console.log("");
    } catch (error) {
      console.error(chalk.red("Failed to load report:"), error);
      process.exit(1);
    }
  });
