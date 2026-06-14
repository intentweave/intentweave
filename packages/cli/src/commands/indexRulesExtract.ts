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
} from "@intentweave/plugin-llm";
import type { LLMProvider } from "@intentweave/core";
import type {
  RulesConfig,
  RuleDefinition,
  RulesAllowedEntry,
} from "@intentweave/index";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A layer hint extracted from ADR prose (17.3 --with-layer-hints). */
interface LayerHint {
  name: string;
  description: string;
  patterns: string[];
}

/**
 * Full extraction result — superset of RulesConfig.
 * `layer_hints` is stripped before writing rules.yaml; written to a
 * separate `--layers-output` file instead.
 */
interface ExtractedConfig extends RulesConfig {
  layer_hints?: LayerHint[];
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  withAllowed: boolean,
  withLayerHints: boolean,
): string {
  const allowedSchemaSection = withAllowed
    ? `
  "allowed": [           // NEW: explicit permission flows (§17.2)
    {
      "from_layer": "inferred-layer-name",  // source layer (kebab/slash-case, match ADR terminology)
      "to_layer": "inferred-layer-name",    // destination layer
      "description": "Verbatim or paraphrased permission from the ADR"
    }
  ],`
    : "";

  const layerHintsSchemaSection = withLayerHints
    ? `
  "layer_hints": [       // NEW: detected architectural tiers (§17.3)
    {
      "name": "inferred-layer-name",       // short slug, e.g. "apps/ui" or "packages/data"
      "description": "What this layer represents",
      "patterns": ["src/some/glob/**"]      // reasonable path-glob inferences
    }
  ]`
    : "";

  const allowedGuidance = withAllowed
    ? `
Allowed-entry guidance (--with-allowed):
- Extract explicit positive permissions: flows the ADR says ARE permitted between layers.
- Use the same layer names as in the forbidden rules for consistency.
- If the ADR says "X must only communicate with Y via Z", emit one allowed entry for each sanctioned path.
- If no explicit permissions are stated, emit an empty allowed array: "allowed": [].
`
    : "";

  const layerHintsGuidance = withLayerHints
    ? `
Layer-hint guidance (--with-layer-hints):
- Identify every named architectural tier, layer, or component group mentioned in the ADR.
- For each, infer a reasonable file-path glob (e.g. "apps/ui/**" for the UI layer).
- Use slash-separated paths that reflect a typical monorepo structure.
- Emit only layers that are clearly named; do not invent unnamed groupings.
- If no layers are identifiable, emit an empty array: "layer_hints": [].
`
    : "";

  return `You are an architectural rules extractor for software projects.
Given one or more ADR (Architecture Decision Record) markdown documents, identify all
technical/architectural constraints they express and translate each into a structured
rule definition that can be enforced by a static analysis tool.

Output ONLY a single JSON object — no explanation, no markdown fences. The schema is:

{${allowedSchemaSection}
  "version": 1,
  "rules": [
    {
      "id": "kebab-case-rule-id",
      "description": "Human-readable constraint description",
      "adr": "ADR-NNN",
      "domain": "structural",          // structural | behavioral | documentary (default: structural)
      "severity": "high",              // critical | high | medium | low
      "mode": "error",                 // error: CI exit code; warn: surfaced in reports only
      "forbidden": [
        {
          "type": "property_access" | "call" | "symbol_name" | "import_pattern" | "variable_assignment",
          "chain": "**.some.property",           // for property_access — glob pattern, ** crosses segments
          "callee": "functionName|otherFn",      // for call — pipe-separated names or regex
          "pattern": "regex-or-glob",            // for symbol_name/variable_assignment (regex) or import_pattern (glob)
          "in": "src/some/layer/**",             // restrict to files matching this glob
          "except": "src/some/layer/tests/**",   // exclude from scope (glob)
          "scope": "exported",                   // for symbol_name: "exported" (default) | "top-level" | "any"
          "context_access": "**.resource.path"   // for call: only flag when co-located with a matching property access
        }
      ]
    }
  ]${layerHintsSchemaSection}
}

Rule type guidance:
- "property_access": Use when the ADR forbids reading/writing a property chain (e.g. do not read entity.source.path directly). Use glob "**" for any leading segments.
- "call": Use when the ADR forbids calling specific functions by name. Pipe-separate alternatives: "match|exec". Use "context_access" to narrow to only calls on forbidden data (e.g. regex on internal fields).
- "symbol_name": Use when the ADR forbids declaring symbols matching a naming pattern (regex). Use "scope" to restrict to "exported" symbols, "top-level" declarations, or "any".
- "import_pattern": Use when the ADR forbids importing from a specific package or path pattern (glob).
- "variable_assignment": Use when the ADR forbids assigning to or creating variables matching a naming pattern (regex), e.g. inline lookup maps built in the wrong layer.

Domain guidance:
- "structural": Default. Import-graph and AST-level code pattern checks. These are deterministic and CI-blocking by default.
- "behavioral": Mermaid-derived call-flow checks. Use mode "warn" unless the calls table has been built.
- "documentary": Documentation coverage and freshness. Use mode "warn".

Mode guidance:
- "error": Violation causes CI exit code 1. Use for high/critical severity structural rules.
- "warn": Violation is surfaced in the Insights Book and reports but does not block CI. Use for behavioral and documentary rules, and for medium/low structural rules during adoption.

Severity guidelines:
- "critical": Security boundary or data integrity; must never be violated
- "high"    : Core architectural boundary; violating it would cause errors or regressions
- "medium"  : Technical debt or cross-layer inconsistency
- "low"     : Convention or style guideline
${allowedGuidance}${layerHintsGuidance}
Rules to follow:
1. Only emit rules for constraints that are clearly and explicitly stated in the ADR.
2. Do not invent constraints that are not written down.
3. Each forbidden entry should target the smallest possible scope (use "in" when the ADR specifies a layer).
4. Infer reasonable file-scope globs from the ADR context (e.g. "apps/ui/**" for UI-specific rules).
5. Default "mode" to "error" for structural rules at severity high/critical, and "warn" for medium/low or any behavioral/documentary rule.
6. If no machine-enforceable constraints are found, output: {"version": 1, "rules": []}.`;
}

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
  const fenceMatch = text.match(
    new RegExp("```(?:json)?\\s*([\\s\\S]*?)\\s*```"),
  );
  if (fenceMatch) return fenceMatch[1];
  // Find outermost { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text.trim();
}

function isValidRulesConfig(obj: unknown): obj is ExtractedConfig {
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
  .option(
    "--with-allowed",
    "Also synthesize explicit allowed: permission entries from ADR prose (§17.3)",
  )
  .option(
    "--with-layer-hints",
    "Also extract architectural layer hints and write to --layers-output (§17.3)",
  )
  .option(
    "--layers-output <path>",
    "Output path for layer hints YAML when --with-layer-hints is set (default: .iw/layers.hints.yaml)",
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
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        const dirFiles = fs
          .readdirSync(absPath)
          .filter((n) => n.endsWith(".md"))
          .sort()
          .map((n) => path.join(absPath, n));
        for (const fp of dirFiles) {
          contents.push({
            name: path.basename(fp),
            text: fs.readFileSync(fp, "utf-8"),
          });
        }
      } else {
        contents.push({
          name: path.basename(f),
          text: fs.readFileSync(absPath, "utf-8"),
        });
      }
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

    const systemPrompt = buildSystemPrompt(
      Boolean(opts.withAllowed),
      Boolean(opts.withLayerHints),
    );

    if (opts.verbose) {
      console.log(chalk.dim("  [prompt] system length:"), systemPrompt.length);
      console.log(chalk.dim("  [prompt] user length:"), userMessage.length);
      if (opts.withAllowed)
        console.log(chalk.dim("  [mode] --with-allowed enabled"));
      if (opts.withLayerHints)
        console.log(chalk.dim("  [mode] --with-layer-hints enabled"));
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
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.1,
        maxTokens: 4096,
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
    let extracted: ExtractedConfig;
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
        ) as ExtractedConfig;
        if (existing?.rules && Array.isArray(existing.rules)) {
          const existingIds = new Set(
            existing.rules.map((r: RuleDefinition) => r.id),
          );
          const newRules = extracted.rules.filter(
            (r) => !existingIds.has(r.id),
          );
          // Merge allowed: entries, deduplicating by from_layer+to_layer pair
          const existingAllowed: RulesAllowedEntry[] =
            existing.allowed && Array.isArray(existing.allowed)
              ? existing.allowed
              : [];
          const existingAllowedKeys = new Set(
            existingAllowed.map(
              (a: RulesAllowedEntry) => `${a.from_layer}→${a.to_layer}`,
            ),
          );
          const newAllowed = (extracted.allowed ?? []).filter(
            (a) => !existingAllowedKeys.has(`${a.from_layer}→${a.to_layer}`),
          );
          extracted = {
            version: 1,
            ...(existingAllowed.length + newAllowed.length > 0
              ? { allowed: [...existingAllowed, ...newAllowed] }
              : {}),
            rules: [...existing.rules, ...newRules],
          };
          if (opts.verbose) {
            console.log(
              chalk.dim(
                `  Merged: ${newRules.length} new rule(s), ${newAllowed.length} new allowed entry(s) appended.`,
              ),
            );
          }
        }
      }
    }

    // ── Write layer hints to separate file (if requested) ──────────
    const layerHints: LayerHint[] = extracted.layer_hints ?? [];
    if (opts.withLayerHints) {
      const layersOutPath = path.resolve(
        opts.layersOutput ?? ".iw/layers.hints.yaml",
      );
      const layersHeader = [
        "# IntentWeave layer hints — extracted from ADR prose (§17.3)",
        `# Generated by: iw index rules-extract --with-layer-hints (${new Date().toISOString().slice(0, 10)})`,
        "# Copy to .iw/layers.yaml and refine glob patterns before use.",
        "#   iw index layers-check   — validate imports against these layers",
        "#   iw index export --prescriptive  — visualize the layer topology",
        "#",
        "",
      ].join("\n");
      const layersBody = yamlDump(
        { layers: layerHints },
        { lineWidth: 120, quotingType: '"', noRefs: true },
      );
      fs.mkdirSync(path.dirname(layersOutPath), { recursive: true });
      fs.writeFileSync(layersOutPath, layersHeader + layersBody, "utf-8");
      console.log(
        chalk.green(
          `  ✓ ${layerHints.length} layer hint(s) written to ${layersOutPath}`,
        ),
      );
    }

    // ── Serialize rules (+ allowed) to YAML ────────────────────────
    // Strip layer_hints — those go to a separate file
    const { layer_hints: _layerHintsStripped, ...rulesOutput } = extracted;
    void _layerHintsStripped;

    const header = [
      "# IntentWeave semantic architectural rules",
      `# Generated by: iw index rules-extract (${new Date().toISOString().slice(0, 10)})`,
      "# Review and adjust before committing.",
      "#",
      "",
    ].join("\n");

    const yamlBody = yamlDump(rulesOutput, {
      lineWidth: 120,
      quotingType: '"',
      noRefs: true,
    });

    const yamlOutput = header + yamlBody;

    // ── Write output ────────────────────────────────────────────────
    const allowedCount = rulesOutput.allowed?.length ?? 0;
    if (opts.output) {
      const outPath = path.resolve(opts.output);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, yamlOutput, "utf-8");
      const summary = [
        `${extracted.rules.length} rule(s)`,
        allowedCount > 0 ? `${allowedCount} allowed entry(s)` : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(chalk.green(`  ✓ ${summary} written to ${outPath}\n`));
    } else {
      console.log(yamlOutput);
    }
  });
