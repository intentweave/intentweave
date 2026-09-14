// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import Database from "@intentweave/sqlite-compat";
import {
  migrateSchemaToCurrent,
  rulesCheck,
  type RulesCheckResult,
  type RulesConfig,
} from "@intentweave/index";
import {
  formatClaimsCheckText,
  runClaimsCheck,
  type ClaimsCheckExecution,
} from "./claims.js";
import {
  INTENT_CHECK_PRESETS,
  loadIwConfig,
  loadRulesConfig,
} from "./indexBuild.js";
import {
  aggregateIntentExitCode,
  governedArchitectureViolationClaims,
  partitionGovernedRuleViolations,
  type GovernedArchitectureViolation,
} from "../intent/gate.js";

type IntentDomain = "structural" | "behavioral" | "documentary" | "all";
type IntentSeverity = "high" | "medium" | "low";

interface IntentCheckOptions {
  db?: string;
  config: string;
  severity: string;
  ruleId?: string;
  changed?: string;
  limit: string;
  format: string;
  domain?: string;
  preset?: string;
  since?: string;
  scope?: string;
  refresh?: boolean;
  rulesOnly?: boolean;
  claimsOnly?: boolean;
}

interface IntentRulesGate {
  gateStatus: "evaluated" | "not_evaluated";
  result: RulesCheckResult | null;
  suppressedDuplicateViolations: number;
}

function validatedChoice<T extends string>(
  value: string | undefined,
  choices: readonly T[],
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) {
    throw new Error(`${label} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

function hasErrorViolations(result: RulesCheckResult): boolean {
  return result.violations.some(
    (violation) => (violation.ruleMode ?? "error") === "error",
  );
}

function renderRulesGate(gate: IntentRulesGate): string[] {
  if (!gate.result) return ["Rules gate: not evaluated"];
  const status = hasErrorViolations(gate.result) ? "failed" : "passed";
  const lines = [
    `Rules gate: ${status}`,
    `  ${gate.result.totalViolations} independent violation${gate.result.totalViolations === 1 ? "" : "s"} across ${gate.result.rulesChecked} checked rule${gate.result.rulesChecked === 1 ? "" : "s"}`,
  ];
  for (const violation of gate.result.violations) {
    lines.push(
      `  [${violation.ruleId}] ${violation.filePath}${violation.line == null ? "" : `:${violation.line}`}`,
    );
    lines.push(`    ${violation.detail}`);
  }
  for (const warning of gate.result.scopeWarnings ?? []) {
    lines.push(
      `  Scope warning: ${warning.ruleId} matched no indexed file for ${warning.pattern}`,
    );
  }
  if (gate.suppressedDuplicateViolations > 0) {
    lines.push(
      `  ${gate.suppressedDuplicateViolations} governed Architecture violation${gate.suppressedDuplicateViolations === 1 ? "" : "s"} reported by the Claims gate`,
    );
  }
  return lines;
}

function renderClaimsGate(
  claims: ClaimsCheckExecution | undefined,
  governed: GovernedArchitectureViolation[],
): string[] {
  if (!claims || claims.output.gateStatus === "no_active_claims") {
    return ["Claims gate: not evaluated (no active Claims)"];
  }
  const claimsStatus =
    claims.exitCode === 1
      ? "failed"
      : claims.exitCode === 2
        ? "inconclusive"
        : claims.exitCode === 4
          ? "review required"
          : claims.exitCode === 3
            ? "not applicable"
            : "passed";
  const activeCount = claims.output.claims.length + claims.output.scopes.length;
  const actionableClaims = claims.output.claims.filter(
    (claim) =>
      claim.ruleStatuses.some(
        (status) => !["passed", "not_applicable"].includes(status),
      ) || claim.assessmentStatuses.some((status) => status !== "supported"),
  );
  const actionableScopes = claims.output.scopes.filter(
    (scope) =>
      scope.ruleStatuses.some(
        (status) => !["passed", "not_applicable"].includes(status),
      ) || scope.assessmentStatuses.some((status) => status !== "supported"),
  );
  const lines = [
    `Claims gate: ${claimsStatus}`,
    `  ${activeCount} active Claim${activeCount === 1 ? "" : "s"}; ${actionableClaims.length + actionableScopes.length} require attention`,
  ];
  const detail = formatClaimsCheckText({
    claims: actionableClaims,
    scopes: actionableScopes,
    retiredClaims: claims.output.retiredClaims,
    portableStateIssues: claims.output.portableStateIssues,
  });
  if (detail) lines.push(...detail.split("\n").map((line) => `  ${line}`));
  for (const item of governed) {
    const violation = item.violation;
    lines.push(
      `  Governed violation: ${violation.filePath}${violation.line == null ? "" : `:${violation.line}`}`,
    );
    lines.push(`    ${violation.detail}`);
    lines.push(`    Claim: ${item.claimIdentityId}`);
  }
  return lines;
}

function intentResultLabel(exitCode: number): string {
  if (exitCode === 0) return "passed";
  if (exitCode === 1) return "failed";
  if (exitCode === 2) return "inconclusive";
  if (exitCode === 4) return "review required";
  if (exitCode === 3) return "not applicable";
  return "invalid";
}

export async function runIntentCheck(
  options: IntentCheckOptions,
): Promise<void> {
  try {
    if (options.rulesOnly && options.claimsOnly) {
      throw new Error("--rules-only and --claims-only cannot be combined");
    }
    const preset = options.preset
      ? INTENT_CHECK_PRESETS[options.preset]
      : undefined;
    if (options.preset && !preset) {
      throw new Error(`Unknown preset ${options.preset}`);
    }
    const domain = validatedChoice<IntentDomain>(
      options.domain ?? preset?.domain,
      ["structural", "behavioral", "documentary", "all"],
      "Intent domain",
    );
    const severity =
      validatedChoice<IntentSeverity>(
        options.severity === "low"
          ? (preset?.severity ?? "low")
          : options.severity,
        ["high", "medium", "low"],
        "Severity",
      ) ?? "low";
    const format = validatedChoice(options.format, ["text", "json"], "Format");
    const limit = Number.parseInt(options.limit, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Limit must be a positive integer");
    }
    const workspaceRoot = process.cwd();
    const dbPath = path.resolve(options.db ?? path.join(".iw", "index.db"));
    if (!existsSync(dbPath)) {
      console.error(
        `Index not found at ${dbPath}. Run \`iw index build\` first.`,
      );
      process.exitCode = 2;
      return;
    }
    const schemaDatabase = new Database(dbPath);
    try {
      migrateSchemaToCurrent(schemaDatabase);
    } finally {
      schemaDatabase.close();
    }

    const claims = options.rulesOnly
      ? undefined
      : await runClaimsCheck({
          scope: options.scope,
          since: options.since,
          refresh: options.refresh,
          format: "json",
          emit: false,
          setExitCode: false,
          throwOnError: true,
        });

    let rulesGate: IntentRulesGate = {
      gateStatus: "not_evaluated",
      result: null,
      suppressedDuplicateViolations: 0,
    };
    let governed: GovernedArchitectureViolation[] = [];
    if (!options.claimsOnly) {
      const configPath = path.resolve(options.config);
      if (existsSync(configPath)) {
        const config: RulesConfig = await loadRulesConfig(configPath);
        const iwConfig = await loadIwConfig(path.dirname(configPath));
        const changed = options.changed
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const rawRules = rulesCheck(dbPath, config, {
          severity,
          ruleId: options.ruleId,
          changed,
          limit,
          domain,
          iwConfig,
          workspaceRoot,
        });
        const database = new Database(dbPath, { readonly: true });
        try {
          const partition = partitionGovernedRuleViolations(
            rawRules,
            options.rulesOnly
              ? new Map()
              : governedArchitectureViolationClaims(database),
          );
          governed = partition.governed;
          rulesGate = {
            gateStatus: "evaluated",
            result: partition.rules,
            suppressedDuplicateViolations: governed.length,
          };
        } finally {
          database.close();
        }
      }
    }

    const rulesExit =
      rulesGate.result && hasErrorViolations(rulesGate.result) ? 1 : 0;
    const claimsExit =
      !claims || claims.output.gateStatus === "no_active_claims"
        ? 0
        : claims.exitCode;
    const exitCode = aggregateIntentExitCode(rulesExit, claimsExit);
    const claimsOutput = claims
      ? {
          ...claims.output,
          gateStatus:
            claims.output.gateStatus === "no_active_claims"
              ? ("not_evaluated" as const)
              : claims.output.gateStatus,
          governedArchitectureViolations: governed,
        }
      : { gateStatus: "not_evaluated" as const };
    if (format === "json") {
      console.log(
        JSON.stringify(
          {
            gate: "intent",
            rules: rulesGate,
            claims: claimsOutput,
            summary: { exitCode },
          },
          null,
          2,
        ),
      );
    } else {
      const lines = [
        "Intent gate",
        ...renderRulesGate(rulesGate),
        ...renderClaimsGate(claims, governed),
        `Result: ${intentResultLabel(exitCode)} (exit ${exitCode})`,
      ];
      console.log(lines.join("\n"));
    }
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 64;
  }
}

export const intentCheckSubcommand = new Command("check")
  .description("Run existing Intent rules and promoted Claims as one CI gate")
  .option("--db <path>", "Path to index.db")
  .option("--config <path>", "Path to rules.yaml", ".iw/rules.yaml")
  .option(
    "--severity <level>",
    "Minimum Rules severity: high | medium | low",
    "low",
  )
  .option("--rule-id <id>", "Only check a specific existing Intent rule")
  .option("--changed <files>", "Comma-separated files for incremental Rules")
  .option("-n, --limit <n>", "Maximum independent Rules violations", "100")
  .option("-f, --format <format>", "Output format: text | json", "text")
  .option(
    "--domain <domain>",
    "Rules domain: structural | behavioral | documentary | all",
  )
  .option("--preset <id>", "Existing Intent check preset")
  .option("--since <ref>", "Compare Claims with the Git merge-base of a ref")
  .option("--scope <scope>", "Registered Claims scope to evaluate")
  .option("--refresh", "Reconcile current auto-discovered Claims")
  .option("--rules-only", "Run only existing Intent rules")
  .option("--claims-only", "Run only promoted Claims")
  .action(runIntentCheck);
