// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw index rules-extract — ADR to Rule Config (13.4)
 *
 * Reads one or more ADR markdown files, uses an LLM to identify
 * architectural constraints stated in prose, and emits a structured
 * `.iw/rules.yaml` draft.
 *
 * Once the YAML is committed, all CI enforcement is $0 — no further
 * LLM calls needed.
 *
 * Usage:
 *   iw index rules-extract docs/ADR-003.md --provider openai --output .iw/rules.yaml
 *   iw index rules-extract docs/ADR-*.md --provider openai -v
 *   iw index rules-extract docs/ADR-003.md --provider smart-mock
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { dump as yamlDump } from "js-yaml";
import {
  SmartMockLLMProvider,
  OpenAILLMProvider,
} from "@intentweave/analyzer/llm";
import type { LLMProvider } from "@intentweave/core";
import type { RulesConfig, RuleDefinition } from "@intentweave/index";

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an architectural rules extractor for software projects.
Given one or more ADR (Architecture Decision Record) markdown documents, identify all
technical/architectural constraints they express and translate each into a structured
rule definition that can be enforced by a static analysis tool.

Output ONLY a single JSON object — no explanation, no markdown fences. The schema is:

{
  "version": 1,
  "rules": [
    {
      "id": "kebab-case-rule-id",
      "description": "Human-readable constraint description",
      "adr": "ADR-NNN",
      "severity": "high" | "medium" | "low",
      "forbidden": [
        {
          "type": "property_access" | "call" | "symbol_name" | "import_pattern",
          "chain": "**.some.property",           // for property_access — glob pattern
          "callee": "functionName|otherFn",      // for call — pipe-separated names or regex
          "pattern": "regex-or-glob",            // for symbol_name (regex) or import_pattern (glob)
          "in": "src/some/layer/**",             // optional — restrict to these files (glob)
          "except": "src/some/layer/tests/**"    // optional — exclude from scope (glob)
        }
      ]
    }
  ]
}

Rule type guidance:
- "property_access": Use when the ADR forbids reading/writing a property chain (e.g. do not read entity.source.path directly)
- "call": Use when the ADR forbids calling specific functions by name
- "symbol_name": Use when the ADR forbids declaring symbols matching a naming pattern
- "import_pattern": Use when the ADR forbids importing from a specific package or path pattern

Severity guidelines:
- "high"  : Core architectural boundary; violating it would cause errors or security issues
- "medium": Technical debt or cross-layer inconsistency
- "low"   : Convention or style guideline

Rules to follow:
1. Only emit rules for constraints that are clearly and explicitly stated in the ADR.
2. Do not invent constraints that are not written down.
3. Each forbidden entry should target the smallest possible scope (use "in:" when the ADR specifies a layer).
4. Infer reasonable file-scope globs from the ADR context (e.g. "apps/ui/**" for UI-specific rules).
5. If no machine-enforceable constraints are found, output: {"version": 1, "rules": []}.`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function createProvider(
  providerName: string,
  opts: { model?: string; apiKey?: string },
): LLMProvider {
  if (providerName === "openai") {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(
        chalk.red(
          "OpenAI API key required. Set OPENAI_API_KEY or use --api-key.",
        ),
      );
      process.exit(1);
    }
    return new OpenAILLMProvider({
      apiKey,
      model: opts.model ?? process.env.IW_LLM_MODEL ?? "gpt-4o",
    });
  }
  return new SmartMockLLMProvider({ workspaceKey: "rules-extract" });
}

/** Extract JSON from LLM response, tolerating markdown code fences. */
function extractJson(text: string): string {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];
  // Find outermost { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}

function isValidRulesConfig(obj: unknown): obj is RulesConfig {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>).version === 1 &&
    Array.isArray((obj as Record<string, unknown>).rules)
  );
}

// ── Command ───────────────────────────────────────────────────────────────────

export const indexRulesExtractSubcommand = new Command("rules-extract")
  .description(
    "Extract architectural rules from ADR markdown files using LLM (13.4)",
  )
  .argument("<files...>", "One or more ADR markdown files to analyze")
  .option("--provider <name>", "LLM provider: openai | smart-mock", "openai")
  .option("--model <name>", "LLM model name (default: gpt-4o)")
  .option("--api-key <key>", "LLM API key (overrides OPENAI_API_KEY)")
  .option(
    "--output <path>",
    "Output path for the rules.yaml draft (default: print to stdout)",
  )
  .option(
    "--append",
    "Append newly extracted rules to an existing output file, skipping duplicate IDs",
  )
  .option("-v, --verbose", "Show prompt/response details")
  .action(async (files: string[], opts) => {
    // ── Read ADR files ──────────────────────────────────────────────
    const contents: Array<{ name: string; text: string }> = [];
    for (const f of files) {
      const absPath = path.resolve(f);
      if (!fs.existsSync(absPath)) {
        console.error(chalk.red(`  ✗ File not found: ${absPath}`));
        process.exitCode = 1;
        return;
      }
      contents.push({
        name: path.basename(f),
        text: fs.readFileSync(absPath, "utf-8"),
      });
    }

    console.log(
      chalk.blue(
        `\n  Analyzing ${contents.length} ADR file(s) with ${opts.provider}…\n`,
      ),
    );

    // ── Build user message ──────────────────────────────────────────
    const userMessage = contents
      .map((c) => `=== ${c.name} ===\n\n${c.text}`)
      .join("\n\n---\n\n");

    if (opts.verbose) {
      console.log(chalk.dim("  [prompt] system length:"), SYSTEM_PROMPT.length);
      console.log(chalk.dim("  [prompt] user length:"), userMessage.length);
    }

    // ── Create and validate LLM provider ───────────────────────────
    const provider = createProvider(opts.provider, {
      model: opts.model,
      apiKey: opts.apiKey,
    });

    if (!(await provider.isAvailable())) {
      console.error(
        chalk.red(
          `  ✗ LLM provider '${opts.provider}' is not available.\n    Check your API key or environment variables.\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }

    // ── Run LLM extraction ──────────────────────────────────────────
    let responseText: string;
    try {
      const response = await provider.complete({
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.1,
        maxTokens: 2048,
      });
      responseText = response.content;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  ✗ LLM call failed: ${msg}\n`));
      process.exitCode = 1;
      return;
    }

    if (opts.verbose) {
      console.log(
        chalk.dim(`  [response] (${responseText.length} chars):\n`),
        responseText,
        "\n",
      );
    }

    // ── Parse and validate JSON response ───────────────────────────
    let extracted: RulesConfig;
    try {
      const json = extractJson(responseText);
      const parsed: unknown = JSON.parse(json);
      if (!isValidRulesConfig(parsed)) {
        throw new Error(
          "Response does not match RulesConfig schema (expected {version:1, rules:[...]})",
        );
      }
      extracted = parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  ✗ Failed to parse LLM response: ${msg}\n`));
      if (!opts.verbose) {
        console.error(
          chalk.dim("  Raw response:\n"),
          responseText.slice(0, 500),
        );
      }
      process.exitCode = 1;
      return;
    }

    // ── Optionally merge with existing config ───────────────────────
    if (opts.append && opts.output) {
      const outPath = path.resolve(opts.output);
      if (fs.existsSync(outPath)) {
        const { load: yamlLoad } = await import("js-yaml");
        const existing = yamlLoad(
          fs.readFileSync(outPath, "utf-8"),
        ) as RulesConfig;
        if (existing?.rules && Array.isArray(existing.rules)) {
          const existingIds = new Set(
            existing.rules.map((r: RuleDefinition) => r.id),
          );
          const newRules = extracted.rules.filter(
            (r) => !existingIds.has(r.id),
          );
          extracted = { version: 1, rules: [...existing.rules, ...newRules] };
          if (opts.verbose) {
            console.log(
              chalk.dim(`  Merged: ${newRules.length} new rule(s) appended.`),
            );
          }
        }
      }
    }

    // ── Serialize to YAML ───────────────────────────────────────────
    const header = [
      "# IntentWeave semantic architectural rules",
      `# Generated by: iw index rules-extract (${new Date().toISOString().slice(0, 10)})`,
      "# Review and adjust before committing.",
      "#",
      "",
    ].join("\n");

    const yamlBody = yamlDump(extracted, {
      lineWidth: 120,
      quotingType: '"',
      noRefs: true,
    });

    const yamlOutput = header + yamlBody;

    // ── Write output ────────────────────────────────────────────────
    if (opts.output) {
      const outPath = path.resolve(opts.output);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, yamlOutput, "utf-8");
      console.log(
        chalk.green(
          `  ✓ ${extracted.rules.length} rule(s) written to ${outPath}\n`,
        ),
      );
    } else {
      console.log(yamlOutput);
    }
  });
