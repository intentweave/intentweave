// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw index enrich — Selective Semantic Enrichment (11.8)
 *
 * Uses CARI signals to identify high-value files, then runs
 * LLM extraction (FX → KX) on the top-N candidates and writes
 * results back into the same index.db.
 *
 * Usage:
 *   iw index enrich --budget 20 --provider openai
 *   iw index enrich --focus "packages/auth/" --provider openai -v
 *   iw index enrich --dry-run
 *   iw index enrich -i --provider openai
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  enrichmentScore,
  writeKgResults,
  bridgeKgEntities,
} from "@intentweave/index";
import type {
  EnrichResult,
  EnrichmentCandidate,
  KgWriteInput,
} from "@intentweave/index";
import {
  runInStage,
  runFxStage,
  runKxStage,
  NoopLogger,
  ConsoleLogger,
  type FxStageInput,
  type FxStageOutput,
  type KxStageInput,
  type PipelineContext,
} from "@intentweave/analyzer";
import {
  SmartMockLLMProvider,
  OpenAILLMProvider,
} from "@intentweave/analyzer/llm";
import type { LLMProvider, TokenUsage } from "@intentweave/core";
import { sumTokenUsage, zeroTokenUsage } from "@intentweave/core";

function resolveDbPath(output?: string): string {
  return output ?? path.join(process.cwd(), ".iw", "index.db");
}

/**
 * Create an LLM provider from CLI options.
 */
function createLlmProvider(
  providerName: string,
  opts: { model?: string; apiKey?: string; verbose?: boolean },
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
      model: opts.model ?? process.env.IW_LLM_MODEL ?? "gpt-4o-mini",
    });
  }
  return new SmartMockLLMProvider({ workspaceKey: "enrich" });
}

/**
 * Run FX + KX on a single file and return the KG write input.
 */
async function enrichFile(
  filePath: string,
  workspaceRoot: string,
  llmProvider: LLMProvider,
): Promise<{
  kgInput: KgWriteInput;
  tokenUsage?: TokenUsage;
}> {
  const absPath = path.resolve(workspaceRoot, filePath);
  const content = fs.readFileSync(absPath, "utf-8");
  const artifactId = filePath.replace(/[/\\]/g, ".").replace(/\.[^.]+$/, "");

  // IN stage — chunk the file (only uses ctx.logger)
  const minimalCtx = { logger: new NoopLogger() } as unknown as PipelineContext;
  const inResult = await runInStage({
    artifactId,
    filePath,
    content,
  }, minimalCtx);

  // FX stage — free extraction
  const fxInput: FxStageInput = {
    artifactId,
    filePath,
    chunks: inResult.chunks,
  };
  const fxOutput: FxStageOutput = await runFxStage(fxInput, {
    llmProvider,
    concurrency: 3,
  });

  // KX stage — canonicalization
  const kxInput: KxStageInput = {
    artifactId,
    fxOutput,
  };
  const kxOutput = await runKxStage(kxInput, llmProvider);

  // Combine token usage
  let tokenUsage: TokenUsage | undefined;
  if (fxOutput.tokenUsage || kxOutput.tokenUsage) {
    tokenUsage = sumTokenUsage(
      fxOutput.tokenUsage ?? zeroTokenUsage(),
      kxOutput.tokenUsage ?? zeroTokenUsage(),
    );
  }

  return {
    kgInput: {
      sourceFile: filePath,
      artifactId,
      canonEntities: kxOutput.canonEntities,
      canonTriples: kxOutput.canonTriples,
      rawTriples: fxOutput.triples.map((t) => ({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        subjectKind: t.subjectKind,
        objectKind: t.objectKind,
        confidence: t.confidence,
      })),
    },
    tokenUsage,
  };
}

export const indexEnrichSubcommand = new Command("enrich")
  .description(
    "Selective semantic enrichment — LLM-extract high-value files into the CARI index",
  )
  .option("--db <path>", "Path to index.db")
  .option(
    "-b, --budget <n>",
    "Maximum files to enrich (LLM calls)",
    "20",
  )
  .option(
    "-t, --threshold <n>",
    "Minimum impact score to qualify",
    "0.1",
  )
  .option("--focus <dir>", "Restrict to files under this directory prefix")
  .option(
    "--provider <name>",
    "LLM provider: openai or smart-mock",
    "smart-mock",
  )
  .option("--model <name>", "LLM model name")
  .option("--api-key <key>", "OpenAI API key (or set OPENAI_API_KEY)")
  .option("-i, --incremental", "Skip files unchanged since last enrichment")
  .option("-n, --dry-run", "Show candidates without running LLM")
  .option("-v, --verbose", "Verbose output")
  .option("-f, --format <format>", "Output format: text or json", "text")
  .action(async (opts) => {
    const dbPath = resolveDbPath(opts.db);
    const budget = parseInt(opts.budget, 10) || 20;
    const threshold = parseFloat(opts.threshold) || 0.1;
    const verbose = !!opts.verbose;

    if (!fs.existsSync(dbPath)) {
      console.error(
        chalk.red(
          `Index not found at ${dbPath}. Run \`iw index build\` first.`,
        ),
      );
      process.exit(1);
    }

    // ── 1. Score candidates ─────────────────────────────────────
    if (verbose) {
      console.log(chalk.blue("Scoring enrichment candidates..."));
    }

    const scoreResult = enrichmentScore(dbPath, {
      focus: opts.focus,
      incremental: opts.incremental,
    });

    // Filter by threshold and already-enriched
    const eligible = scoreResult.candidates.filter((c) => {
      if (c.impactScore < threshold) return false;
      if (opts.incremental && c.alreadyEnriched) return false;
      return true;
    });

    const selected = eligible.slice(0, budget);

    if (opts.format === "json" && opts.dryRun) {
      console.log(JSON.stringify({ candidates: selected, totalEvaluated: scoreResult.totalEvaluated }, null, 2));
      return;
    }

    // ── Dry run output ──────────────────────────────────────────
    if (opts.dryRun) {
      console.log(
        chalk.bold(
          `\n  Enrichment candidates (${selected.length} of ${scoreResult.totalEvaluated} files):\n`,
        ),
      );

      if (selected.length === 0) {
        console.log(
          chalk.yellow(
            "  No files qualify for enrichment. Try lowering --threshold.\n",
          ),
        );
        return;
      }

      for (const c of selected) {
        const signals = Object.entries(c.signals)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`)
          .join(", ");
        console.log(
          `  ${chalk.cyan(c.filePath)}  ${chalk.yellow(`score=${c.impactScore.toFixed(3)}`)}  ${chalk.gray(signals)}`,
        );
      }

      const skippedEnriched = scoreResult.candidates.filter(
        (c) => opts.incremental && c.alreadyEnriched,
      ).length;
      const belowThreshold = scoreResult.candidates.filter(
        (c) => c.impactScore < threshold,
      ).length;

      console.log(
        chalk.gray(
          `\n  ${belowThreshold} below threshold, ${skippedEnriched} already enriched\n`,
        ),
      );
      return;
    }

    if (selected.length === 0) {
      console.log(
        chalk.yellow(
          "\n  No files qualify for enrichment. Try lowering --threshold.\n",
        ),
      );
      return;
    }

    // ── 2. Run LLM enrichment ───────────────────────────────────
    const llmProvider = createLlmProvider(opts.provider, {
      model: opts.model,
      apiKey: opts.apiKey,
      verbose,
    });

    if (verbose) {
      console.log(
        chalk.blue(
          `\nEnriching ${selected.length} files (budget: ${budget}, provider: ${opts.provider})...\n`,
        ),
      );
    }

    const workspaceRoot = process.cwd();
    const kgInputs: KgWriteInput[] = [];
    const enrichedFiles: EnrichResult["enriched"] = [];
    const skippedFiles: EnrichResult["skipped"] = [];
    let totalTokenUsage = zeroTokenUsage();

    for (let i = 0; i < selected.length; i++) {
      const candidate = selected[i];
      const absPath = path.resolve(workspaceRoot, candidate.filePath);

      if (!fs.existsSync(absPath)) {
        skippedFiles.push({
          filePath: candidate.filePath,
          reason: "outside-focus",
        });
        if (verbose) {
          console.log(
            chalk.gray(`  [${i + 1}/${selected.length}] Skip (not found): ${candidate.filePath}`),
          );
        }
        continue;
      }

      try {
        if (verbose) {
          console.log(
            chalk.cyan(
              `  [${i + 1}/${selected.length}] ${candidate.filePath} (score=${candidate.impactScore.toFixed(3)})`,
            ),
          );
        }

        const { kgInput, tokenUsage } = await enrichFile(
          candidate.filePath,
          workspaceRoot,
          llmProvider,
        );

        kgInputs.push(kgInput);
        enrichedFiles.push({
          filePath: candidate.filePath,
          impactScore: candidate.impactScore,
          entityCount: kgInput.canonEntities.length,
          tripleCount: kgInput.canonTriples.length,
          tokensUsed: tokenUsage
            ? (tokenUsage.promptTokens ?? 0) + (tokenUsage.completionTokens ?? 0)
            : undefined,
        });

        if (tokenUsage) {
          totalTokenUsage = sumTokenUsage(totalTokenUsage, tokenUsage);
        }

        if (verbose) {
          console.log(
            chalk.gray(
              `           → ${kgInput.canonEntities.length} entities, ${kgInput.canonTriples.length} triples`,
            ),
          );
        }
      } catch (err) {
        console.error(
          chalk.red(
            `  Error enriching ${candidate.filePath}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    if (kgInputs.length === 0) {
      console.log(chalk.yellow("\n  No files were successfully enriched.\n"));
      return;
    }

    // ── 3. Write to kg_* tables ─────────────────────────────────
    if (verbose) {
      console.log(chalk.blue("\nWriting KG data to index.db..."));
    }

    const writeResult = writeKgResults(dbPath, kgInputs);

    // ── 4. Bridge into CARI ─────────────────────────────────────
    if (verbose) {
      console.log(chalk.blue("Bridging entities into CARI annotations..."));
    }

    const bridgeResult = bridgeKgEntities(dbPath);

    // ── 5. Output ───────────────────────────────────────────────
    const result: EnrichResult = {
      enriched: enrichedFiles,
      skipped: skippedFiles,
      totalEntities: writeResult.entityCount,
      totalRelationships: writeResult.relationshipCount,
      totalBridged: bridgeResult.entitiesWritten,
      tokenUsage: {
        prompt: totalTokenUsage.promptTokens ?? 0,
        completion: totalTokenUsage.completionTokens ?? 0,
        costUsd: totalTokenUsage.costUsd,
      },
    };

    if (opts.format === "json") {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(chalk.bold("\n  Enrichment complete:\n"));
    console.log(
      `  ${chalk.green("✓")} ${result.enriched.length} files enriched`,
    );
    console.log(
      `  ${chalk.green("✓")} ${result.totalEntities} entities written to kg_entities`,
    );
    console.log(
      `  ${chalk.green("✓")} ${result.totalRelationships} relationships written to kg_relationships`,
    );
    console.log(
      `  ${chalk.green("✓")} ${result.totalBridged} entities bridged into CARI`,
    );

    if (result.tokenUsage && (result.tokenUsage.prompt > 0 || result.tokenUsage.completion > 0)) {
      console.log(
        chalk.gray(
          `\n  Tokens: ${result.tokenUsage.prompt + result.tokenUsage.completion} (prompt: ${result.tokenUsage.prompt}, completion: ${result.tokenUsage.completion})`,
        ),
      );
      if (result.tokenUsage.costUsd != null) {
        console.log(
          chalk.gray(`  Cost: $${result.tokenUsage.costUsd.toFixed(4)}`),
        );
      }
    }

    if (result.skipped.length > 0) {
      console.log(chalk.gray(`\n  ${result.skipped.length} files skipped`));
    }

    console.log();
  });
