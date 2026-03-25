// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * build tcg subcommand — Build the TCG (Temporal Change Graph).
 *
 * Pipeline: TCX (commits) → COC (co-change) → HOT (hotspots) → OWN (ownership) → STL (staleness)
 *            → (optional) Neo4j persist
 *
 * Usage:
 *   iw build tcg --session <name> [--persist] [--depth <full|N>] [--since <date>] [-v]
 *
 * @see PHASE-B-SPEC.md §10
 * @version 0.1
 */

import { Command } from "commander";
import chalk from "chalk";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  runTcxStage,
  runCocStage,
  runHotStage,
  runOwnStage,
  runStlStage,
} from "@intentweave/analyzer";
import type {
  TcxStageInput,
  CocStageInput,
  HotStageInput,
  OwnStageInput,
  StlStageInput,
  TcgPipelineOutput,
} from "@intentweave/core";
import { persistTcg } from "../tcg/persistTcg.js";
import { createNeo4jDriver } from "../kwg/persistKwg.js";

// =============================================================================
// TCG Subcommand
// =============================================================================

export const tcgSubcommand = new Command("tcg")
  .description(
    "Build TCG (Temporal Change Graph) — co-change, hotspots, ownership, staleness from git history",
  )
  .requiredOption("-s, --session <name>", "Session name")
  .option("--persist", "Persist results to Neo4j", false)
  .option(
    "--depth <value>",
    "Commit depth: 'full' (all history) or N (last N commits). Default: 6 months.",
  )
  .option(
    "--since <date>",
    "Include commits since date (ISO-8601). Overrides --depth.",
  )
  .option("-v, --verbose", "Verbose output", false)
  .action(async (opts) => {
    const { session, persist, depth: depthStr, since, verbose } = opts;

    const log = verbose
      ? (msg: string) => console.log(chalk.gray(`  ${msg}`))
      : undefined;

    const cwd = process.cwd();

    console.log(chalk.blue(`\n  ▸ TCG Pipeline — session: ${session}`));

    // ── Parse depth ────────────────────────────────────────────────────
    let depth: "full" | number = "full"; // placeholder, overridden below
    let depthLabel: string;

    if (since) {
      depthLabel = `since ${since}`;
      // depth is ignored when since is set; TCX uses since directly
    } else if (depthStr === "full") {
      depth = "full";
      depthLabel = "full history";
    } else if (depthStr && !isNaN(parseInt(depthStr, 10))) {
      depth = parseInt(depthStr, 10);
      depthLabel = `last ${depth} commits`;
    } else {
      // Default: 6 months (handled inside git log parser via default)
      depthLabel = "last 6 months";
    }

    console.log(chalk.blue(`  ▸ Depth: ${depthLabel}\n`));

    const pipelineStart = Date.now();

    // ── 1. TCX: Commit extraction ──────────────────────────────────────
    const tcxInput: TcxStageInput = {
      workspaceRoot: cwd,
      depth: since ? "full" : depth,
      since,
      log,
    };

    const tcxStart = Date.now();
    const tcxOutput = await runTcxStage(tcxInput);
    const tcxMs = Date.now() - tcxStart;

    console.log(`  TCX  ${chalk.green("████████████████████████████████")}`);
    console.log(
      chalk.gray(
        `       → ${tcxOutput.meta.commitCount} commits, ${tcxOutput.meta.authorCount} authors, ${tcxOutput.meta.fileCount} files  (${tcxMs}ms)`,
      ),
    );

    if (tcxOutput.commits.length === 0) {
      console.log(
        chalk.yellow("\n  ⚠ No commits found in range. Nothing to analyze.\n"),
      );
      return;
    }

    // ── 2. COC: Co-change analysis ─────────────────────────────────────
    const cocInput: CocStageInput = {
      tcxOutput,
      log,
    };

    const cocStart = Date.now();
    const cocOutput = runCocStage(cocInput);
    const cocMs = Date.now() - cocStart;

    console.log(`  COC  ${chalk.green("████████████████████████████████")}`);
    console.log(
      chalk.gray(
        `       → ${cocOutput.meta.edgeCount} co-change edges (min ${cocOutput.meta.minCoChangeThreshold} co-changes, min ${cocOutput.meta.minJaccardThreshold} Jaccard)  (${cocMs}ms)`,
      ),
    );

    // ── 3. HOT: Hotspot detection ──────────────────────────────────────
    const hotInput: HotStageInput = {
      tcxOutput,
      log,
    };

    const hotStart = Date.now();
    const hotOutput = runHotStage(hotInput);
    const hotMs = Date.now() - hotStart;

    console.log(`  HOT  ${chalk.green("████████████████████████████████")}`);
    console.log(
      chalk.gray(
        `       → ${hotOutput.meta.hotspotCount} hotspot files (z-score > ${hotOutput.meta.zScoreThreshold})  (${hotMs}ms)`,
      ),
    );

    if (verbose && hotOutput.hotspots.length > 0) {
      for (const hs of hotOutput.hotspots.slice(0, 10)) {
        console.log(
          chalk.gray(
            `         ${hs.filePath} — ${hs.commitCount} commits, z=${hs.zScore}, churn=${hs.churn}`,
          ),
        );
      }
      if (hotOutput.hotspots.length > 10) {
        console.log(
          chalk.gray(`         ... and ${hotOutput.hotspots.length - 10} more`),
        );
      }
    }

    // ── 4. OWN: Ownership mapping ──────────────────────────────────────
    const ownInput: OwnStageInput = {
      tcxOutput,
      log,
    };

    const ownStart = Date.now();
    const ownOutput = runOwnStage(ownInput);
    const ownMs = Date.now() - ownStart;

    console.log(`  OWN  ${chalk.green("████████████████████████████████")}`);
    console.log(
      chalk.gray(
        `       → ${ownOutput.meta.filesAnalyzed} files analyzed, ${ownOutput.meta.vacuumCount} ownership vacuums  (${ownMs}ms)`,
      ),
    );

    if (verbose && ownOutput.ownershipVacuums.length > 0) {
      for (const fp of ownOutput.ownershipVacuums.slice(0, 5)) {
        console.log(chalk.gray(`         ⚠ vacuum: ${fp}`));
      }
    }

    // ── 5. STL: Staleness detection ────────────────────────────────────
    // Try to load KWG entities from Neo4j for enhanced matching
    let kwgEntities: string[] | undefined;
    if (persist) {
      try {
        const driver = await createNeo4jDriver();
        const neo4jSess = driver.session();
        try {
          const result = await neo4jSess.run(
            `MATCH (e:KWEntity {session_id: $session})
             RETURN e.name AS name`,
            { session },
          );
          kwgEntities = result.records.map((r) => r.get("name") as string);
          log?.(`Loaded ${kwgEntities.length} KWG entities for STL matching`);
        } finally {
          await neo4jSess.close();
          await driver.close();
        }
      } catch {
        // KWG not available — STL will use directory proximity only
        log?.("KWG entities not available — STL uses directory matching only");
      }
    }

    const stlInput: StlStageInput = {
      tcxOutput,
      kwgEntities,
      workspaceRoot: cwd,
      log,
    };

    const stlStart = Date.now();
    const stlOutput = runStlStage(stlInput);
    const stlMs = Date.now() - stlStart;

    const stlCritical = stlOutput.signals.filter(
      (s) => s.severity === "critical",
    ).length;
    const stlWarning = stlOutput.signals.filter(
      (s) => s.severity === "warning",
    ).length;

    console.log(`  STL  ${chalk.green("████████████████████████████████")}`);
    console.log(
      chalk.gray(
        `       → ${stlOutput.meta.signalCount} stale doc signals (${stlCritical} critical, ${stlWarning} warning)  (${stlMs}ms)`,
      ),
    );

    if (verbose && stlOutput.signals.length > 0) {
      for (const s of stlOutput.signals.slice(0, 5)) {
        const sev =
          s.severity === "critical"
            ? chalk.red("●")
            : s.severity === "warning"
              ? chalk.yellow("●")
              : chalk.gray("●");
        console.log(
          chalk.gray(
            `         ${sev} ${s.filePath} — ${s.stalenessScore} days stale`,
          ),
        );
      }
    }

    // ── Assemble pipeline output ───────────────────────────────────────
    const totalMs = Date.now() - pipelineStart;
    const pipelineOutput: TcgPipelineOutput = {
      tcx: tcxOutput,
      coc: cocOutput,
      hot: hotOutput,
      own: ownOutput,
      stl: stlOutput,
      meta: {
        session,
        workspaceRoot: cwd,
        gitDepth: depthLabel,
        totalDurationMs: totalMs,
      },
    };

    // ── Persist to Neo4j ───────────────────────────────────────────────
    if (persist) {
      let driver: import("neo4j-driver").Driver;
      try {
        driver = await createNeo4jDriver();
      } catch (err) {
        console.error(
          chalk.red(`  Neo4j connection failed: ${(err as Error).message}`),
        );
        process.exit(1);
      }

      try {
        const result = await persistTcg(pipelineOutput, session, driver, {
          log,
        });

        console.log(
          `\n  NEO  ${chalk.green("████████████████████████████████")}  session rewrite`,
        );
        console.log(
          chalk.gray(
            `       → ${result.commitsCreated} commits, ${result.authorsCreated} authors, ${result.coChangeEdges} co-change, ${result.crossLayerLinks} cross-layer  (${result.durationMs}ms)`,
          ),
        );
      } finally {
        await driver.close();
      }
    }

    // ── Save JSON output ───────────────────────────────────────────────
    const iwDir = path.resolve(cwd, ".iw");
    const runId = `tcg-${Date.now()}`;
    const runDir = path.join(iwDir, "runs", runId, "tcg");

    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "tcg-pipeline.json"),
        JSON.stringify(pipelineOutput, null, 2),
      );
      if (verbose) {
        log?.(`Output written to ${runDir}/tcg-pipeline.json`);
      }
    } catch {
      // .iw directory might not exist; non-fatal
    }

    // ── Summary ────────────────────────────────────────────────────────
    const totalSec = (totalMs / 1000).toFixed(1);
    console.log("");
    console.log(
      chalk.green(
        `  ✓ TCG built  │  ${tcxOutput.meta.commitCount} commits  │  ${cocOutput.meta.edgeCount} co-change  │  ${hotOutput.meta.hotspotCount} hotspots  │  ${stlOutput.meta.signalCount} stale  │  ${totalSec}s  │  $0.00`,
      ),
    );
    console.log("");
  });
