// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * build kwg command — Build the KWG (Keyword Graph) evidence layer.
 *
 * Pipeline: IN → KWX → COX → CLX → (optional) Neo4j persist
 *
 * Usage:
 *   iw build kwg <paths...> --session <name> [--persist] [--force] [-v]
 *
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  runInStage,
  type InStageInput,
} from "@intentweave/analyzer";
import {
  runKwxStage,
  runCoxStage,
  runClxStage,
} from "@intentweave/analyzer";
import {
  persistKwg,
  createNeo4jDriver,
} from "../kwg/persistKwg.js";
import type {
  KwxStageOutput,
  KwgPipelineOutput,
} from "@intentweave/core";
import { ConsoleLogger, NoopLogger } from "@intentweave/analyzer";

// =============================================================================
// File Discovery
// =============================================================================

/** Supported file extensions for KWG processing */
const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

/**
 * Recursively discover files from paths (files and directories).
 */
async function discoverFiles(
  paths: string[],
  cwd: string,
  log: (msg: string) => void,
): Promise<string[]> {
  const files: string[] = [];

  for (const p of paths) {
    const fullPath = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(fullPath, {
          recursive: true,
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
          // Skip hidden and common ignore patterns
          const entryPath = path.join(
            entry.parentPath ?? entry.path,
            entry.name,
          );
          if (entryPath.includes("node_modules")) continue;
          if (entryPath.includes(".git/")) continue;
          files.push(entryPath);
        }
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    } catch {
      log(`Warning: ${p} not found, skipping`);
    }
  }

  // Deduplicate and sort
  return [...new Set(files)].sort();
}

/**
 * Generate an artifact ID from a file path.
 */
function toArtifactId(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel.replace(/[/\\]/g, ".").replace(/\.[^.]+$/, "");
}

// =============================================================================
// Minimal PipelineContext for IN stage
// =============================================================================

/**
 * Create a minimal pipeline context for the IN stage.
 * IN stage only uses ctx.logger, so we provide a lightweight wrapper.
 */
function createMinimalContext(verbose: boolean) {
  const logger = verbose ? new ConsoleLogger("[kwg]") : new NoopLogger();
  // The IN stage signature requires PipelineContext, but only accesses .logger
  // We cast to satisfy the type while only providing what's needed
  return {
    logger,
    workspace: { root: process.cwd(), key: "kwg" },
    runId: `kwg-${Date.now()}`,
    store: null as any,
    profile: null as any,
    providers: null as any,
    now: () => new Date(),
    timestamp: () => new Date().toISOString(),
  };
}

// =============================================================================
// Progress Display
// =============================================================================

function progressBar(current: number, total: number, width = 32): string {
  const ratio = total > 0 ? current / total : 0;
  const filled = Math.round(width * ratio);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return bar;
}

// =============================================================================
// Command
// =============================================================================

const kwgSubcommand = new Command("kwg")
  .description("Build the KWG (keyword graph) evidence layer")
  .argument("<paths...>", "Files or directories to process")
  .requiredOption("-s, --session <name>", "Session name")
  .option("--persist", "Write results to Neo4j")
  .option("--force", "Force full rewrite (no MERGE, delete everything first)")
  .option("-v, --verbose", "Verbose output with stage details")
  .option("-o, --output <dir>", "Output directory override")
  .action(
    async (
      paths: string[],
      opts: {
        session: string;
        persist?: boolean;
        force?: boolean;
        verbose?: boolean;
        output?: string;
      },
    ) => {
      const cwd = process.cwd();
      const verbose = opts.verbose ?? false;
      const log = verbose
        ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
        : (_msg: string) => {};

      console.log(
        chalk.bold(`\n  ▸ KWG Pipeline — session: ${opts.session}`),
      );

      // ── 1. Discover files ──────────────────────────────────────
      const files = await discoverFiles(paths, cwd, log);
      if (files.length === 0) {
        console.log(chalk.yellow("  No supported files found."));
        return;
      }
      console.log(`  ▸ Files: ${files.length} discovered\n`);

      const pipelineStart = performance.now();
      const ctx = createMinimalContext(verbose);

      // ── 2. IN + KWX (per-file) ────────────────────────────────
      const kwxOutputs = new Map<string, KwxStageOutput>();
      let totalMentions = 0;
      let totalEntities = 0;
      let totalQualified = 0;

      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const relPath = path.relative(cwd, filePath);
        const content = await fs.readFile(filePath, "utf-8");
        const artifactId = toArtifactId(filePath, cwd);

        // IN stage
        const inInput: InStageInput = {
          artifactId,
          filePath: relPath,
          content,
        };
        const inOutput = await runInStage(
          inInput,
          ctx as any,
        );

        // KWX stage
        const kwxOutput = await runKwxStage({ inOutput });
        kwxOutputs.set(relPath, kwxOutput);

        totalMentions += kwxOutput.meta.mentionCount;
        totalEntities += kwxOutput.meta.entityCount;
        totalQualified += kwxOutput.meta.qualifiedMentionCount;

        if (verbose) {
          process.stdout.write(
            `\r  KWX  ${progressBar(i + 1, files.length)}  ${i + 1}/${files.length} files`,
          );
        }
      }

      // Deduplicate entity count (entities appear in multiple files)
      const uniqueEntities = new Set<string>();
      for (const kwx of kwxOutputs.values()) {
        for (const e of kwx.entities) uniqueEntities.add(e.name);
      }

      if (verbose) process.stdout.write("\n");
      console.log(
        `  KWX  ${progressBar(files.length, files.length)}  ${files.length}/${files.length} files`,
      );
      console.log(
        chalk.gray(
          `       → ${uniqueEntities.size} entities, ${totalMentions} mentions, ${totalQualified} qualified\n`,
        ),
      );

      // ── 3. COX (session-level) ─────────────────────────────────
      const coxOutput = await runCoxStage({
        kwxOutputs: [...kwxOutputs.values()],
      });

      console.log(`  COX  ${progressBar(1, 1)}`);
      console.log(
        chalk.gray(
          `       → ${coxOutput.edges.length} co-occurrence edges (${coxOutput.meta.windowType}, min=2)\n`,
        ),
      );

      // ── 4. CLX (session-level) ─────────────────────────────────
      const clxOutput = await runClxStage({
        coxOutput,
        kwxOutputs: [...kwxOutputs.values()],
      });

      console.log(`  CLX  ${progressBar(1, 1)}`);
      console.log(
        chalk.gray(
          `       → ${clxOutput.clusters.length} clusters, ${clxOutput.unclustered.length} singletons\n`,
        ),
      );

      // ── Build pipeline output ──────────────────────────────────
      const totalTimeMs = Math.round(performance.now() - pipelineStart);

      const pipelineOutput: KwgPipelineOutput = {
        kwxOutputs,
        coxOutput,
        clxOutput,
        meta: {
          totalFiles: files.length,
          totalTimeMs,
        },
      };

      // ── 5. Write JSON output ───────────────────────────────────
      const runId = `kwg-${Date.now()}`;
      const outputDir =
        opts.output ?? path.join(cwd, ".iw", "runs", runId, "kwg");
      await fs.mkdir(outputDir, { recursive: true });

      // Write per-file KWX outputs
      for (const [fp, kwx] of kwxOutputs) {
        const safeFilename = fp.replace(/[/\\]/g, "__");
        await fs.writeFile(
          path.join(outputDir, `kwx-${safeFilename}.json`),
          JSON.stringify(kwx, null, 2),
        );
      }

      // Write COX output
      await fs.writeFile(
        path.join(outputDir, "cox-output.json"),
        JSON.stringify(coxOutput, null, 2),
      );

      // Write CLX output
      await fs.writeFile(
        path.join(outputDir, "clx-output.json"),
        JSON.stringify(clxOutput, null, 2),
      );

      log(`Output written to ${outputDir}`);

      // ── 6. Neo4j persist (optional) ────────────────────────────
      if (opts.persist) {
        try {
          const driver = await createNeo4jDriver();
          try {
            const result = await persistKwg(
              pipelineOutput,
              opts.session,
              driver,
              {
                force: opts.force,
                log,
              },
            );

            console.log(
              `  NEO  ${progressBar(1, 1)}  ${opts.force ? "full rewrite" : "delta persist"}`,
            );
            console.log(
              chalk.gray(
                `       → ${result.nodesCreated} nodes created, ${result.relsCreated} rels, ${result.durationMs}ms\n`,
              ),
            );
          } finally {
            await driver.close();
          }
        } catch (err: any) {
          console.error(
            chalk.red(`\n  ✗ Neo4j persist failed: ${err.message}`),
          );
          if (verbose) console.error(err);
          process.exitCode = 1;
          return;
        }
      }

      // ── Done ───────────────────────────────────────────────────
      const totalSec = (totalTimeMs / 1000).toFixed(1);
      console.log(
        chalk.green(`  ✓ KWG build complete in ${totalSec}s\n`),
      );
    },
  );

import { tcgSubcommand } from "./buildTcg.js";
import { scgSubcommand } from "./buildScg.js";
import { cheapSubcommand } from "./buildCheap.js";
import { fullSubcommand } from "./buildFull.js";

// Parent "build" command group
export const buildCommand = new Command("build")
  .description("Build derived artifacts (kwg, tcg, scg, cheap, full)")
  .addCommand(kwgSubcommand)
  .addCommand(tcgSubcommand)
  .addCommand(scgSubcommand)
  .addCommand(cheapSubcommand)
  .addCommand(fullSubcommand);
