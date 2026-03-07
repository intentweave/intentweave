// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * watch command — Continuously monitor files and re-run the open-track
 * pipeline when they change.
 *
 * Uses chokidar for efficient file watching and the incremental
 * OpenTrackCache so unchanged files skip FX + KX entirely.
 *
 * Usage:
 *   iw watch [files...]                      # Watch files, smart-mock
 *   iw watch docs/ --provider openai -v      # Watch docs with OpenAI
 *   iw watch . --persist --debounce 1000     # Auto-persist to Neo4j
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import {
  runOpenTrackBatch,
  OpenTrackCache,
  runGxStage,
  type OpenTrackResult,
  type GxStageOutput,
} from '@intentweave/analyzer';
import { sumTokenUsage, formatCost, formatTokens, type TokenUsage } from '@intentweave/core';
import { IW_DIR, CLI_NAME } from '../constants.js';
import {
  generateRunId,
  generateArtifactId,
  collectFiles,
  loadWorkspaceInfo,
  resolveProfile,
  createLLMProvider,
  buildPipelineContext,
  buildArtifacts,
} from './run-shared.js';

// ── Helpers ─────────────────────────────────────────────────

/** Coalesce rapid file-system events into a single batch. */
function createDebouncer(fn: (paths: string[]) => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();

  return {
    /** Record one changed path.  The batch fires after `delayMs` of quiet. */
    push(p: string) {
      pending.add(p);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const batch = [...pending];
        pending.clear();
        fn(batch);
      }, delayMs);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending.size > 0) {
        const batch = [...pending];
        pending.clear();
        fn(batch);
      }
    },
  };
}

/** Pretty-print a compact timestamp for log lines. */
function ts(): string {
  return chalk.dim(new Date().toLocaleTimeString());
}

// ── Default ignore globs for the watcher itself ─────────────

const WATCH_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.iw/**',
  '**/coverage/**',
  '**/*.min.js',
  '**/*.map',
];

// ── Command definition ──────────────────────────────────────

export const watchCommand = new Command('watch')
  .description('Watch files and re-run the open-track pipeline on changes')
  .argument('[files...]', 'Files, directories, or globs to watch')
  .option('-p, --profile <name>', 'Extraction profile', 'standard')
  .option('--provider <name>', 'LLM provider (smart-mock|openai)', 'smart-mock')
  .option('--model <name>', 'Model to use', 'gpt-5-mini')
  .option('--api-key <key>', 'API key override')
  .option('--timeout <ms>', 'API timeout in ms', parseInt)
  .option('--concurrency <n>', 'Parallel API calls', parseInt)
  .option('--debounce <ms>', 'Debounce delay in ms (default: 500)', parseInt)
  .option('--persist', 'Auto-persist to Neo4j after each cycle')
  .option('--neo4j-uri <uri>', 'Neo4j URI (default: bolt://localhost:7687)')
  .option('-v, --verbose', 'Verbose output')
  .option('--clear', 'Clear terminal between runs')
  .action(async (files: string[], options) => {
    const {
      profile: profileName,
      provider: providerName,
      model: modelName,
      apiKey: apiKeyOverride,
      timeout: timeoutMs,
      concurrency: concurrencyOpt,
      debounce: debounceMs,
      persist: shouldPersist,
      neo4jUri,
      verbose,
      clear: clearScreen,
    } = options;

    const cwd = process.cwd();

    // ── Workspace check ─────────────────────────────────────
    const iwDir = path.join(cwd, IW_DIR);
    try {
      await fs.access(iwDir);
    } catch {
      console.error(chalk.red('No IntentWeave workspace found.'));
      console.log(`Run ${chalk.blue(`${CLI_NAME} init`)} first.`);
      process.exit(1);
    }

    // ── Resolve profile & providers ─────────────────────────
    const profile = resolveProfile(profileName);
    const wsInfo = await loadWorkspaceInfo(cwd);
    const llmProvider = createLLMProvider({
      providerName,
      modelName,
      apiKeyOverride,
      timeoutMs,
      verbose,
      workspaceKey: wsInfo.workspaceKey,
    });

    // ── Initial file set (determines watcher scope) ─────────
    const patterns = files.length > 0 ? files : ['.'];
    const initialFiles = await collectFiles(patterns, cwd);
    if (initialFiles.length === 0) {
      console.log(chalk.yellow('No files matched.  Nothing to watch.'));
      return;
    }

    // ── Determine watch paths ───────────────────────────────
    // Watch the glob roots so new files are also detected.
    const watchPaths = files.length > 0 ? files.map(f => (path.isAbsolute(f) ? f : path.join(cwd, f))) : [cwd];

    // ── Banner ──────────────────────────────────────────────
    console.log(chalk.blue(`\n${CLI_NAME} watch — continuous open-track pipeline`));
    console.log(chalk.blue('═'.repeat(48)));
    console.log(`  Watching:    ${patterns.join(', ')}`);
    console.log(`  Files:       ${initialFiles.length}`);
    console.log(`  Profile:     ${profile.name}`);
    console.log(`  Provider:    ${providerName}${providerName === 'openai' ? ` (${modelName})` : ''}`);
    console.log(`  Debounce:    ${debounceMs ?? 500}ms`);
    console.log(`  Persist:     ${shouldPersist ? chalk.green('on') : 'off'}`);
    console.log(`  Incremental: ${chalk.green('always')}`);
    console.log('');
    console.log(chalk.dim('Press Ctrl+C to stop.\n'));

    // ── Incremental cache (always on in watch mode) ─────────
    const cache = new OpenTrackCache(cwd);
    await cache.init();

    // ── Processing state ────────────────────────────────────
    let running = false;
    let pendingPaths: string[] | null = null;
    let cycleCount = 0;

    /** Run the open track on a batch of changed files. */
    async function runCycle(changedAbsPaths: string[]) {
      if (running) {
        // Queue a follow-up cycle with merged paths
        pendingPaths = [...(pendingPaths ?? []), ...changedAbsPaths];
        return;
      }
      running = true;

      try {
        cycleCount++;
        const runId = generateRunId();

        if (clearScreen) {
          process.stdout.write('\x1Bc');
        }

        const relPaths = changedAbsPaths.map(p => path.relative(cwd, p));
        console.log(`${ts()} ${chalk.magenta(`Cycle #${cycleCount}`)} — ${changedAbsPaths.length} file(s) changed`);
        if (verbose) {
          for (const rp of relPaths) {
            console.log(`  ${chalk.dim(rp)}`);
          }
        }

        // Build artifacts for changed files
        const artifacts = await buildArtifacts(changedAbsPaths, cwd);

        // Build pipeline context
        const { ctx, outputDir } = buildPipelineContext({
          workspaceKey: wsInfo.workspaceKey,
          workspaceId: wsInfo.workspaceId,
          iwDir: wsInfo.iwDir,
          runId,
          profile,
          llmProvider: llmProvider as any,
          concurrency: concurrencyOpt,
        });

        const startTime = Date.now();

        // Run the open track (incremental)
        const openResults: OpenTrackResult[] = await runOpenTrackBatch(artifacts, ctx, {
          llmProvider: llmProvider as any,
          writeOutputs: true,
          cache,
          concurrency: concurrencyOpt ?? 5,
        });

        // GX merge when > 1 artifact
        let gxOutput: GxStageOutput | undefined;
        if (openResults.length > 1) {
          const kxOutputs = openResults.map(r => r.kx);
          gxOutput = runGxStage(kxOutputs, {
            fuzzyThreshold: 0.8,
            logger: verbose ? ctx.logger : undefined,
          });
        }

        // Persist to Neo4j
        if (shouldPersist && openResults.length > 0) {
          try {
            const { persistKxToNeo4j } = await import('./persist-neo4j.js');
            let kxOutputs;
            if (gxOutput) {
              const syntheticKx = {
                $schema: 'intentweave://schemas/kx/v0.1' as const,
                schemaVersion: '0.1' as const,
                stage: 'KX' as const,
                artifactId: '__merged__',
                filePath: '__merged__',
                rawTriples: openResults.flatMap(r => r.kx.rawTriples),
                canonEntities: gxOutput.entities,
                canonTriples: gxOutput.triples,
                entityResolutions: openResults.flatMap(r => r.kx.entityResolutions),
                predicateMappings: openResults.flatMap(r => r.kx.predicateMappings),
                evidence: openResults.flatMap(r => r.kx.evidence),
                meta: {
                  provider: openResults[0]?.kx.meta.provider ?? 'unknown',
                  latencyMs: gxOutput.meta.latencyMs,
                  rawTripleCount: gxOutput.meta.inputTripleCount,
                  canonTripleCount: gxOutput.meta.outputTripleCount,
                  canonEntityCount: gxOutput.meta.outputEntityCount,
                  entitiesMerged: gxOutput.meta.exactMerges + gxOutput.meta.fuzzyMerges,
                  predicatesFallback: 0,
                  droppedCount: 0,
                },
              };
              kxOutputs = [syntheticKx];
            } else {
              kxOutputs = openResults.map(r => r.kx);
            }

            const persistResult = await persistKxToNeo4j(kxOutputs, {
              sessionId: wsInfo.workspaceKey,
              runId,
              workspaceId: wsInfo.workspaceId,
              uri: neo4jUri,
              mode: 'delta',
              log: verbose ? (msg: string) => console.log(chalk.dim(`  ${msg}`)) : undefined,
            });

            const d = persistResult.delta;
            if (d) {
              console.log(`  ${chalk.cyan('Neo4j:')} +${d.entities.added} ~${d.entities.updated} -${d.entities.removed} entities, +${d.relationships.added} -${d.relationships.removed} rels`);
            } else {
              console.log(`  ${chalk.cyan('Neo4j:')} ${persistResult.canonEntitiesWritten} entities, ${persistResult.canonRelationshipsWritten} rels`);
            }
          } catch (persistErr) {
            console.error(chalk.yellow(`  ⚠ Persist failed: ${(persistErr as Error).message}`));
          }
        }

        // ── Summary line ──────────────────────────────────────
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const totalTriples = openResults.reduce((s, r) => s + r.kx.canonTriples.length, 0);
        const totalEntities = openResults.reduce((s, r) => s + r.kx.canonEntities.length, 0);

        const fxCached = openResults.filter(r => r.meta.stages.FX.cached).length;
        const kxCached = openResults.filter(r => r.meta.stages.KX.cached).length;
        const cacheNote =
          fxCached > 0 || kxCached > 0
            ? chalk.green(` (${fxCached}/${openResults.length} FX cached, ${kxCached}/${openResults.length} KX cached)`)
            : '';

        // Token usage
        const usages = openResults.map(r => r.tokenUsage).filter((u): u is TokenUsage => u != null);
        const costNote = usages.length > 0 ? ` ${formatCost(sumTokenUsage(...usages).costUsd)}` : '';

        console.log(
          `${ts()} ${chalk.green('✓')} ${totalEntities} entities, ${totalTriples} triples in ${duration}s${cacheNote}${costNote}`,
        );

        if (gxOutput) {
          console.log(
            `  ${chalk.magenta('GX:')} ${gxOutput.meta.inputEntityCount} → ${gxOutput.meta.outputEntityCount} entities (${gxOutput.meta.exactMerges} exact, ${gxOutput.meta.fuzzyMerges} fuzzy)`,
          );
        }

        // Write latest run marker
        try {
          const openDir = path.join(outputDir, 'runs', runId, 'open-track');
          await fs.mkdir(openDir, { recursive: true });
          await fs.writeFile(
            path.join(openDir, 'kx-results.json'),
            JSON.stringify({
              $schema: 'intentweave://schemas/kx-results/v1',
              schemaVersion: '0.1',
              runId,
              track: 'open',
              artifacts: openResults.map(r => ({
                artifactId: r.artifactId,
                rawTriples: r.kx.rawTriples,
                canonEntities: r.kx.canonEntities,
                canonTriples: r.kx.canonTriples,
              })),
            }, null, 2),
          );
        } catch {
          // non-critical
        }

        console.log('');
      } catch (err) {
        console.error(`${ts()} ${chalk.red('✗')} Cycle failed: ${(err as Error).message}`);
        if (verbose) {
          console.error(chalk.dim((err as Error).stack));
        }
        console.log('');
      } finally {
        running = false;

        // Drain queued changes
        if (pendingPaths && pendingPaths.length > 0) {
          const next = [...new Set(pendingPaths)];
          pendingPaths = null;
          await runCycle(next);
        }
      }
    }

    // ── Initial run ─────────────────────────────────────────
    await runCycle(initialFiles);

    // ── Start watcher ───────────────────────────────────────
    const watcher: FSWatcher = chokidarWatch(watchPaths, {
      ignored: WATCH_IGNORE,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    const debouncer = createDebouncer(
      (paths) => void runCycle(paths),
      debounceMs ?? 500,
    );

    watcher.on('change', (filePath) => {
      debouncer.push(path.resolve(filePath));
    });
    watcher.on('add', (filePath) => {
      debouncer.push(path.resolve(filePath));
    });

    // ── Graceful shutdown ───────────────────────────────────
    const shutdown = async () => {
      console.log(`\n${ts()} ${chalk.yellow('Shutting down…')}`);
      debouncer.flush();
      await watcher.close();
      console.log(chalk.dim('Watcher stopped.'));
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
