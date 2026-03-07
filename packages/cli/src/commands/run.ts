/**
 * run command - Execute the full analysis pipeline
 * 
 * Runs the full IN → RX → CX → MX → PX pipeline on the specified files,
 * then aggregates results (LX, coverage, validation).
 * 
 * Supports incremental mode with content-addressed caching.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  runPipeline,
  createPipelineContext,
  createFileStore,
  createDefaultExtractionProvider,
  convertProfileForAnalyzer,
  runOpenTrackBatch,
  runKxFromFxOutput,
  OpenTrackCache,
  computeContentHash,
  FX_PROMPT_VERSION,
  KX_PROMPT_VERSION,
  type ArtifactInput,
  type PipelineProgress,
  type Profile,
  type OpenTrackResult,
  type PipelineTrack,
  type FxStageOutput,
  // GX - cross-document entity merge
  runGxStage,
  type GxStageOutput,
  // Incremental cache imports
  IncrementalExecutor,
  createDefaultPipelineConfig,
  formatRunPlan,
} from '@intentweave/analyzer';
import { SmartMockLLMProvider, OpenAILLMProvider } from '@intentweave/analyzer/llm';
import { generateBundle } from '@intentweave/core';
import { sumTokenUsage, formatCost, formatTokens, estimateTokenCost, formatEstimate, type TokenUsage } from '@intentweave/core';
import { profileRegistry } from '@intentweave/profiles';
import { createWorkspaceRef } from '@intentweave/core';
import { IW_DIR, CLI_NAME } from '../constants.js';
import {
  generateRunId,
  generateArtifactId,
  collectFiles,
  formatProgress,
} from './run-shared.js';

// generateRunId, generateArtifactId, collectFiles, formatProgress
// are imported from ./run-shared.js

/**
 * Load cached FX output from a previous run.
 *
 * @param source - Either a run ID (e.g. "run-2026-03-01_12-30-29-850dfbc6")
 *                 or a path to an fx-results.json file.
 * @param cwd - Current working directory (workspace root)
 * @param iwDir - .iw directory path
 * @returns Array of FxStageOutput objects (one per artifact)
 */
async function loadCachedFxOutputs(
  source: string,
  cwd: string,
  iwDir: string,
): Promise<FxStageOutput[]> {
  let fxPath: string;

  // Determine if source is a path or a run ID
  if (source.endsWith('.json') || source.includes('/') || source.includes('\\')) {
    // It's a path — resolve relative to cwd
    fxPath = path.isAbsolute(source) ? source : path.join(cwd, source);
  } else {
    // It's a run ID — try open-track/fx-results.json first, then fall back to store format
    const fxResultsPath = path.join(iwDir, 'runs', source, 'open-track', 'fx-results.json');
    try {
      await fs.access(fxResultsPath);
      fxPath = fxResultsPath;
    } catch {
      // Fall back: scan artifacts/*/fx.json in the run directory
      const artifactsDir = path.join(iwDir, 'runs', source, 'artifacts');
      try {
        const dirs = await fs.readdir(artifactsDir);
        const outputs: FxStageOutput[] = [];
        for (const dir of dirs) {
          const storeFxPath = path.join(artifactsDir, dir, 'fx.json');
          try {
            const raw = await fs.readFile(storeFxPath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.stage === 'FX' && data.triples) {
              outputs.push(data as FxStageOutput);
            }
          } catch {
            // skip this artifact
          }
        }
        if (outputs.length > 0) {
          return outputs;
        }
      } catch {
        // artifacts dir doesn't exist
      }
      throw new Error(
        `FX results not found for run: ${source}\n` +
        `  Looked in: ${fxResultsPath}\n` +
        `  And: ${artifactsDir}/*/fx.json\n` +
        `  Hint: run with --track open first, then use --from-fx <run-id>`
      );
    }
  }

  try {
    const raw = await fs.readFile(fxPath, 'utf-8');
    const data = JSON.parse(raw);

    // fx-results.json envelope format:  { artifacts: FxStageOutput[] }
    if (data.artifacts && Array.isArray(data.artifacts)) {
      return data.artifacts as FxStageOutput[];
    }

    // Single FxStageOutput (e.g., direct fx.json from store)
    if (data.stage === 'FX' && data.triples) {
      return [data as FxStageOutput];
    }

    throw new Error(`Unrecognized format in ${fxPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`FX results not found at: ${fxPath}\n` +
        `  Hint: run with --track open first, then use --from-fx <run-id>`);
    }
    throw err;
  }
}

export const runCommand = new Command('run')
  .description('Run the full analysis pipeline on files')
  .argument('[files...]', 'Files or directories to analyze')
  .option('-p, --profile <name>', 'Profile to use', 'standard')
  .option('--run-id <id>', 'Custom run ID (default: timestamp-based)')
  .option('--provider <name>', 'LLM provider to use (smart-mock|openai)', 'smart-mock')
  .option('--model <name>', 'Model to use (for OpenAI: gpt-5-mini|gpt-4o|gpt-4o-mini)', 'gpt-5-mini')
  .option('--api-key <key>', 'API key override (uses OPENAI_API_KEY env var by default)')
  .option('--timeout <ms>', 'API request timeout in milliseconds (default: 60000)', parseInt)
  .option('--concurrency <n>', 'Number of parallel API calls (default: 5)', parseInt)
  .option('--skip-agg', 'Skip aggregation step')
  .option('-o, --output <dir>', 'Output directory override')
  .option('-v, --verbose', 'Verbose output')
  .option('--dry-run', 'Show what would be done without running')
  // Incremental mode options
  .option('-i, --incremental', 'Enable incremental mode (cache and reuse)')
  .option('--plan', 'Show execution plan without running (requires --incremental)')
  .option('--force', 'Force full recomputation (with --incremental)')
  .option('--force-from <stage>', 'Force recomputation from stage (IN|RX|CX|MX|PX)')
  // Transcript options
  .option('--no-transcripts', 'Exclude transcript sessions from discovery')
  .option('--transcript-limit <n>', 'Limit number of transcripts to process', parseInt)
  .option('--transcripts-only', 'Process only transcripts, skip file artifacts')
  // Ignore options
  .option('--include-ignored', 'Include files normally ignored (node_modules, dist, etc.)')
  .option('--max-artifacts <n>', 'Maximum number of artifacts to process', parseInt)
  // Role override
  .option('-r, --role <role>', 'Override artifact role (intent|spec|implementation|test|config)')
  // Track selection
  .option('-t, --track <track>', 'Pipeline track: main (schema-constrained), open (schema-free), or both', 'main')
  .option('--from-fx <source>', 'Skip FX, load cached FX output and run only KX. Value: run ID or path to fx-results.json')
  // Neo4j persistence
  .option('--persist', 'Persist open track (KX) results to Neo4j (requires NEO4J_PASSWORD env var)')
  .option('--neo4j-uri <uri>', 'Neo4j connection URI (default: bolt://localhost:7687)')
  .action(async (files: string[], options) => {
    const { 
      profile: profileName, 
      runId: customRunId, 
      provider: providerName,
      model: modelName,
      apiKey: apiKeyOverride,
      timeout: timeoutMs,
      concurrency: concurrencyOpt,
      skipAgg, 
      output, 
      verbose, 
      dryRun,
      // Incremental options
      incremental: incrementalMode,
      plan: planOnly,
      force: forceAll,
      forceFrom,
      // Transcript options
      transcripts: includeTranscripts,
      transcriptLimit,
      transcriptsOnly,
      // Ignore options
      includeIgnored,
      maxArtifacts,
      // Role override
      role: roleOverride,
      // Track selection
      track: trackSelection,
      // KX-only from cached FX
      fromFx: fromFxSource,
      // Neo4j persistence
      persist: shouldPersist,
      neo4jUri,
    } = options;
    
    // Validate track
    let track = (trackSelection ?? 'main') as PipelineTrack;
    if (!['main', 'open', 'both'].includes(track)) {
      console.error(chalk.red(`Invalid track: ${track}. Must be one of: main, open, both`));
      process.exit(1);
    }
    
    // --from-fx implies open track
    if (fromFxSource && track === 'main') {
      track = 'open';
    }
    
    const cwd = process.cwd();
    
    // Check for workspace
    const iwDir = path.join(cwd, IW_DIR);
    try {
      await fs.access(iwDir);
    } catch {
      console.error(chalk.red(`No IntentWeave workspace found in this directory.`));
      console.log(`Run ${chalk.blue(`${CLI_NAME} init`)} to create one.`);
      process.exit(1);
    }
    
    // Resolve profile
    const registryProfile = profileRegistry.resolve(profileName);
    if (!registryProfile) {
      console.error(chalk.red(`Unknown profile: ${profileName}`));
      console.log('Available profiles:', profileRegistry.list().join(', '));
      process.exit(1);
    }
    
    const profile = convertProfileForAnalyzer(registryProfile);
    
    if (verbose) {
      console.log(chalk.blue(`Using profile: ${profile.name}`));
    }
    
    // Collect files to analyze (skip if transcripts-only mode)
    let filteredFiles: string[] = [];
    if (!transcriptsOnly) {
      const patterns = files.length > 0 ? files : ['**/*.ts', '**/*.md'];
      const filesToAnalyze = await collectFiles(patterns, cwd, includeIgnored);
      
      // Filter out files in .iw directory (extra safety)
      filteredFiles = filesToAnalyze.filter(f => !f.includes(`/${IW_DIR}/`));
      
      // Apply max-artifacts limit if specified
      if (maxArtifacts && filteredFiles.length > maxArtifacts) {
        console.log(chalk.yellow(`Limiting to ${maxArtifacts} artifacts (found ${filteredFiles.length})`));
        filteredFiles = filteredFiles.slice(0, maxArtifacts);
      }
    }
    
    // Check if we have anything to analyze
    if (filteredFiles.length === 0 && !includeTranscripts && !fromFxSource) {
      console.log(chalk.yellow('No files or transcripts to analyze'));
      return;
    }
    
    // Warn about large workspaces
    const MAX_RECOMMENDED = 200;
    if (filteredFiles.length > MAX_RECOMMENDED) {
      console.log(chalk.yellow(`\n⚠️  Large workspace detected: ${filteredFiles.length} files`));
      console.log(chalk.yellow(`   This may take a while and use significant memory.`));
      console.log(chalk.yellow(`   Consider using --max-artifacts ${MAX_RECOMMENDED} to limit scope.\n`));
    }
    
    if (dryRun) {
      console.log(chalk.yellow('Dry run - would analyze:'));
      filteredFiles.forEach(f => console.log(`  ${path.relative(cwd, f)}`));
      console.log(`\nTotal: ${filteredFiles.length} files`);
      console.log(`Profile: ${profile.name}`);
      console.log(`Track: ${track}`);

      // Token / cost estimation for open track
      if (track === 'open' || track === 'both') {
        const model = modelName ?? (providerName === 'openai' ? 'gpt-5-mini' : 'smart-mock');

        // Read file sizes
        const fileSizes = await Promise.all(
          filteredFiles.map(async (f) => {
            try {
              const stat = await fs.stat(f);
              return stat.size;
            } catch { return 0; }
          }),
        );

        // Check incremental cache if -i is set
        let cachedCount = 0;
        if (incrementalMode) {
          try {
            const cache = new OpenTrackCache(cwd);
            const checks = await Promise.all(
              filteredFiles.map(async (f) => {
                const content = await fs.readFile(f, 'utf-8');
                const hash = computeContentHash(content);
                const artifactKey = generateArtifactId(f, cwd);
                return cache.check(artifactKey, hash, false, FX_PROMPT_VERSION, KX_PROMPT_VERSION);
              }),
            );
            cachedCount = checks.filter(c => c.fxHit && c.kxHit).length;
          } catch {
            // Cache check failed — assume nothing cached
          }
        }

        const estimate = estimateTokenCost(fileSizes, model, cachedCount);

        console.log('');
        console.log(chalk.blue('Token / Cost Estimate (open track):'));
        console.log(chalk.blue('─'.repeat(40)));
        console.log(formatEstimate(estimate));
        if (estimate.cachedFiles > 0) {
          console.log(chalk.green(`\n✓ ${estimate.cachedFiles} files cached — will be skipped (0 tokens)`));
        }
        if (estimate.estimatedCostUsd === 0) {
          console.log(chalk.dim('\n(smart-mock provider — no real cost)'));
        } else {
          console.log(chalk.yellow('\n⚠ This is a conservative estimate. Actual cost may be lower.'));
        }
      }
      return;
    }
    
    console.log(chalk.blue(`\nIntentWeave Analysis Pipeline`));
    console.log(chalk.blue('═'.repeat(40)));
    console.log(`Files: ${filteredFiles.length}`);
    console.log(`Profile: ${profile.name}`);
    console.log(`Track: ${track === 'main' ? chalk.blue(track) : track === 'open' ? chalk.magenta(track) : chalk.yellow(track)}`);
    if (incrementalMode) {
      console.log(`Mode: ${chalk.green('Incremental')} (cached)`);
    }
    console.log('');
    
    // Generate run ID
    const runId = customRunId || generateRunId();
    console.log(`Run ID: ${chalk.cyan(runId)}`);
    console.log('');
    
    // ============================================================
    // INCREMENTAL MODE (main track only — open track handles -i inline)
    // ============================================================
    if (incrementalMode && (track === 'main' || track === 'both')) {
      await runIncremental(cwd, filteredFiles, {
        profile,
        profileName,
        runId,
        providerName,
        modelName,
        apiKeyOverride,
        skipAgg,
        output,
        verbose,
        planOnly,
        forceAll,
        forceFrom,
        includeTranscripts,
        transcriptLimit,
      });
      return;
    }
    
    // ============================================================
    // STANDARD MODE (no caching)
    // ============================================================
    
    // Prepare artifacts
    const artifacts: ArtifactInput[] = await Promise.all(
      filteredFiles.map(async (filePath) => ({
        artifactId: generateArtifactId(filePath, cwd),
        filePath,
        content: await fs.readFile(filePath, 'utf-8'),
        ...(roleOverride && { artifactRole: roleOverride }),
      }))
    );
    
    // Create store
    const outputDir = output || iwDir;
    const store = createFileStore({
      rootDir: outputDir,
      runId,
    });
    
    // Create workspace reference
    let workspaceKey = 'default';
    let workspaceId = 'ws_default';
    try {
      const configPath = path.join(iwDir, 'config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      // Normalize workspace key: lowercase, replace invalid chars with hyphens
      workspaceKey = (config.name || workspaceKey)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64) || 'default';
      workspaceId = config.id || workspaceId;
    } catch {
      // Use defaults
    }
    const workspace = createWorkspaceRef(workspaceKey, workspaceId);
    
    // Create providers based on configuration
    let llmProvider;
    if (providerName === 'openai') {
      const apiKey = apiKeyOverride ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error(chalk.red('OpenAI API key required. Set OPENAI_API_KEY environment variable or use --api-key flag.'));
        console.log(chalk.yellow('Tip: export OPENAI_API_KEY="sk-proj-..."'));
        console.log(chalk.yellow('Or use default provider: iw run (uses smart-mock, no API key needed)'));
        process.exit(1);
      }
      // Allow custom timeout — omit to use model-aware default (5min for reasoning, 60s for others)
      llmProvider = new OpenAILLMProvider({ apiKey, model: modelName, ...(timeoutMs ? { timeoutMs } : {}) });
      if (verbose) {
        console.log(chalk.blue(`Using OpenAI provider with model: ${modelName}${timeoutMs ? `, timeout: ${timeoutMs}ms` : ''}`));
      }
    } else {
      llmProvider = new SmartMockLLMProvider({ workspaceKey });
      if (verbose) {
        console.log(chalk.blue('Using SmartMock provider (deterministic, no API key needed)'));
      }
    }
    
    // Configure extraction with parallelChunks (default: 5)
    const parallelChunks = concurrencyOpt ?? 5;
    const extractionProvider = createDefaultExtractionProvider(llmProvider, { parallelChunks });
    if (verbose && parallelChunks !== 5) {
      console.log(chalk.blue(`Using ${parallelChunks} parallel API calls`));
    }
    
    // Create pipeline context
    const ctx = createPipelineContext({
      workspace,
      runId,
      store,
      profile,
      providers: {
        llm: llmProvider,
        extraction: extractionProvider,
      },
    });
    
    // Progress callback
    let lastStage = '';
    const onProgress = (progress: PipelineProgress) => {
      if (verbose) {
        if (progress.stage !== lastStage) {
          console.log(`  Stage: ${chalk.cyan(progress.stage)}`);
          lastStage = progress.stage;
        }
        console.log(`    ${progress.artifactId} ${formatProgress(progress.progress)}`);
      } else {
        process.stdout.write(`\r  Processing: ${formatProgress(progress.progress)} [${progress.stage}]`);
      }
    };
    
    // Run pipeline
    const trackLabel = track === 'main' ? 'main pipeline' : track === 'open' ? 'open track (schema-free)' : 'both tracks';
    console.log(chalk.blue(`Running ${trackLabel}...`));
    const startTime = Date.now();
    
    try {
      // --- Main track ---
      let result: Awaited<ReturnType<typeof runPipeline>> | undefined;
      if (track === 'main' || track === 'both') {
        result = await runPipeline(artifacts, ctx, {
          onProgress,
          continueOnError: true,
          writeOutputs: true,
        });
      }

      // --- Open track (schema-free: IN → FX → KX) ---
      let openResults: OpenTrackResult[] | undefined;
      if (track === 'open' || track === 'both') {
        if (!verbose) {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
        }

        // ─── KX-only mode: load cached FX output ───
        if (fromFxSource) {
          console.log(chalk.magenta('Running KX-only from cached FX output...'));
          const fxOutputs = await loadCachedFxOutputs(fromFxSource, cwd, outputDir);
          console.log(chalk.magenta(`  Loaded ${fxOutputs.length} artifact(s) with ${fxOutputs.reduce((s, f) => s + f.triples.length, 0)} raw triples`));

          openResults = [];
          for (const fxOut of fxOutputs) {
            const kxResult = await runKxFromFxOutput(fxOut, ctx, { llmProvider });
            openResults.push(kxResult);
          }

          // Write updated KX results
          const openDir = path.join(outputDir, 'runs', runId, 'open-track');
          await fs.mkdir(openDir, { recursive: true });
          await fs.writeFile(
            path.join(openDir, 'kx-results.json'),
            JSON.stringify({
              $schema: 'intentweave://schemas/kx-results/v1',
              schemaVersion: '0.1',
              runId,
              track: 'open',
              fromFx: fromFxSource,
              artifacts: openResults.map(r => ({
                artifactId: r.artifactId,
                rawTriples: r.kx.rawTriples,
                canonEntities: r.kx.canonEntities,
                canonTriples: r.kx.canonTriples,
              })),
            }, null, 2),
          );
        } else {
          // ─── Full open track: IN → FX → KX ───
          // Use incremental cache when -i is set
          const openTrackCache = incrementalMode ? new OpenTrackCache(cwd) : undefined;
          if (openTrackCache) {
            await openTrackCache.init();
            console.log(chalk.magenta('Running open track (IN → FX → KX) — incremental…'));
          } else {
            console.log(chalk.magenta('Running open track (IN → FX → KX)...'));
          }

          openResults = await runOpenTrackBatch(artifacts, ctx, {
            llmProvider,
            writeOutputs: true,
            cache: openTrackCache,
            force: forceAll,
            concurrency: concurrencyOpt ?? 5,
          });

          // Write open track outputs to disk
          const openDir = path.join(outputDir, 'runs', runId, 'open-track');
          await fs.mkdir(openDir, { recursive: true });

          // Save FX results for reuse (--from-fx)
          await fs.writeFile(
            path.join(openDir, 'fx-results.json'),
            JSON.stringify({
              $schema: 'intentweave://schemas/fx-results/v1',
              schemaVersion: '0.1',
              runId,
              artifacts: openResults.map(r => r.fx),
            }, null, 2),
          );

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
        }
      }

      // --- GX: Cross-document entity merge ---
      let gxOutput: GxStageOutput | undefined;
      if (openResults && openResults.length > 1) {
        console.log(chalk.magenta('\nRunning GX (cross-document entity merge)...'));
        const kxOutputs = openResults.map(r => r.kx);
        gxOutput = runGxStage(kxOutputs, {
          fuzzyThreshold: 0.8,
          logger: verbose ? ctx.logger : undefined,
        });

        console.log(chalk.green(`✓ GX merge complete:`));
        console.log(`  Entities: ${gxOutput.meta.inputEntityCount} → ${gxOutput.meta.outputEntityCount} (${gxOutput.meta.exactMerges} exact, ${gxOutput.meta.fuzzyMerges} fuzzy merges)`);
        console.log(`  Triples:  ${gxOutput.meta.inputTripleCount} → ${gxOutput.meta.outputTripleCount} (${gxOutput.meta.inputTripleCount - gxOutput.meta.outputTripleCount} deduped)`);

        // Save merged output
        if (openResults.length > 0) {
          const openDir = path.join(outputDir, 'runs', runId, 'open-track');
          await fs.writeFile(
            path.join(openDir, 'gx-merged.json'),
            JSON.stringify({
              $schema: 'intentweave://schemas/gx-merged/v1',
              schemaVersion: '0.1',
              runId,
              entities: gxOutput.entities,
              triples: gxOutput.triples,
              merges: gxOutput.merges,
              meta: gxOutput.meta,
            }, null, 2),
          );
        }
      }

      // --- Persist to Neo4j ---
      if (shouldPersist && openResults && openResults.length > 0) {
        try {
          const { persistKxToNeo4j } = await import('./persist-neo4j.js');
          console.log('');

          let kxOutputs;
          if (gxOutput) {
            // Use GX-merged graph: wrap as a synthetic KxStageOutput for persistence
            console.log(chalk.cyan('Persisting GX-merged graph to Neo4j...'));
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
            console.log(chalk.cyan('Persisting open track results to Neo4j...'));
            kxOutputs = openResults.map(r => r.kx);
          }
          const persistResult = await persistKxToNeo4j(kxOutputs, {
            sessionId: workspaceKey,
            runId,
            workspaceId: workspaceId,
            uri: neo4jUri,
            mode: 'delta',
            log: verbose ? (msg: string) => console.log(chalk.dim(`  ${msg}`)) : undefined,
          });

          console.log(chalk.green(`✓ Neo4j persistence complete (${(persistResult.durationMs / 1000).toFixed(1)}s)`));
          if (persistResult.delta) {
            const d = persistResult.delta;
            console.log(`  Entities:      +${d.entities.added} ~${d.entities.updated} -${d.entities.removed} =${d.entities.unchanged}`);
            console.log(`  Relationships: +${d.relationships.added} -${d.relationships.removed} =${d.relationships.unchanged}`);
            console.log(`  Raw triples:   +${d.rawTriples.added} -${d.rawTriples.removed} =${d.rawTriples.unchanged}`);
          } else {
            console.log(`  Canon entities: ${persistResult.canonEntitiesWritten}`);
            console.log(`  Canon relationships: ${persistResult.canonRelationshipsWritten}`);
            console.log(`  Raw triples: ${persistResult.rawTriplesWritten}`);
          }
        } catch (persistErr) {
          console.error(chalk.yellow(`\n⚠ Neo4j persistence failed: ${(persistErr as Error).message}`));
          if (verbose) {
            console.error(chalk.dim((persistErr as Error).stack));
          }
          console.log(chalk.dim('  Results are still saved to disk. You can persist later with --from-fx.'));
        }
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      // Write aggregation outputs to disk
      if (result?.aggregate && !skipAgg) {
        const aggregateDir = path.join(outputDir, 'runs', runId, 'aggregate');
        await fs.mkdir(aggregateDir, { recursive: true });
        
        // Write link proposals
        if (result.aggregate.lxProposals) {
          const proposalsPath = path.join(aggregateDir, 'lx.proposals.json');
          await fs.writeFile(proposalsPath, JSON.stringify({
            $schema: 'intentweave://schemas/lx-proposals/v1',
            schemaVersion: '0.1',
            runId,
            proposals: result.aggregate.lxProposals,
          }, null, 2));
        }
        
        // Write coverage report (already has $schema and schemaVersion)
        if (result.aggregate.coverage) {
          const coveragePath = path.join(aggregateDir, 'coverage.json');
          await fs.writeFile(coveragePath, JSON.stringify(result.aggregate.coverage, null, 2));
        }
        
        // Write findings (already has $schema and schemaVersion)
        if (result.aggregate.findings) {
          const findingsPath = path.join(aggregateDir, 'findings.json');
          await fs.writeFile(findingsPath, JSON.stringify(result.aggregate.findings, null, 2));
        }
        
        // Generate consolidated bundle (overview.json + bundle/graph.json)
        const runDir = path.join(outputDir, 'runs', runId);
        try {
          await generateBundle({ runDir });
        } catch (bundleErr) {
          if (verbose) {
            console.error(chalk.yellow(`Warning: Could not generate bundle: ${(bundleErr as Error).message}`));
          }
        }
      }
      
      // Clear progress line
      if (!verbose) {
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
      }
      
      console.log('');
      console.log(chalk.green('✓ Pipeline completed'));
      console.log('');
      console.log(chalk.blue('Results:'));
      if (result) {
        console.log(`  Artifacts processed: ${result.artifacts.length}`);
      }
      console.log(`  Duration: ${duration}s`);
      
      if (result && result.errors.size > 0) {
        console.log(chalk.yellow(`  Errors: ${result.errors.size}`));
        if (verbose) {
          result.errors.forEach((err: Error, artifactId: string) => {
            console.log(chalk.red(`    ${artifactId}: ${err.message}`));
          });
        }
      }
      
      // Summary from metadata (main track)
      if (result?.meta.summary) {
        console.log('');
        console.log(chalk.blue('Main Track Summary:'));
        console.log(`  Entities: ${result.meta.summary.entityCount}`);
        console.log(`  Statements: ${result.meta.summary.statementCount}`);
      }

      // Open track summary
      if (openResults && openResults.length > 0) {
        const totalRaw = openResults.reduce((s, r) => s + r.kx.rawTriples.length, 0);
        const totalCanonTriples = openResults.reduce((s, r) => s + r.kx.canonTriples.length, 0);
        const totalCanonEntities = openResults.reduce((s, r) => s + r.kx.canonEntities.length, 0);
        const totalLatency = openResults.reduce((s, r) => s + r.meta.totalLatencyMs, 0);

        console.log('');
        console.log(chalk.magenta('Open Track Summary (schema-free):'));
        console.log(`  Raw triples extracted: ${totalRaw}`);
        console.log(`  Canonical entities: ${totalCanonEntities}`);
        console.log(`  Canonical triples: ${totalCanonTriples}`);
        console.log(`  Latency: ${(totalLatency / 1000).toFixed(2)}s`);

        // Token usage / cost
        const artifactUsages = openResults
          .map(r => r.tokenUsage)
          .filter((u): u is TokenUsage => u != null);
        if (artifactUsages.length > 0) {
          const totalUsage = sumTokenUsage(...artifactUsages);
          console.log(`  Tokens: ${formatTokens(totalUsage.totalTokens)} (${formatTokens(totalUsage.promptTokens)} prompt + ${formatTokens(totalUsage.completionTokens)} completion)`);
          console.log(`  Est. cost: ${formatCost(totalUsage.costUsd)}`);
        }

        // Show incremental cache stats
        const fxCached = openResults.filter(r => r.meta.stages.FX.cached).length;
        const kxCached = openResults.filter(r => r.meta.stages.KX.cached).length;
        if (fxCached > 0 || kxCached > 0) {
          console.log(`  Cache: ${chalk.green(`${fxCached}/${openResults.length} FX cached`)}, ${chalk.green(`${kxCached}/${openResults.length} KX cached`)}`);
        }

        if (verbose) {
          // Show per-artifact breakdown
          for (const r of openResults) {
            console.log(`    ${chalk.dim(r.artifactId)}: ${r.kx.rawTriples.length} raw → ${r.kx.canonTriples.length} canon triples, ${r.kx.canonEntities.length} entities`);
          }

          // Show top canonical entities
          const allEntities = openResults.flatMap(r => r.kx.canonEntities);
          if (allEntities.length > 0) {
            console.log('');
            console.log(chalk.magenta('  Top Canonical Entities:'));
            const sorted = [...allEntities].sort((a, b) => b.confidence - a.confidence).slice(0, 15);
            for (const e of sorted) {
              console.log(`    ${chalk.cyan(e.name)} (${e.type}) [${(e.confidence * 100).toFixed(0)}%]`);
            }
          }

          // Show sample canonical triples
          const allTriples = openResults.flatMap(r => r.kx.canonTriples);
          if (allTriples.length > 0) {
            console.log('');
            console.log(chalk.magenta('  Sample Canonical Triples:'));
            const sample = allTriples.slice(0, 10);
            for (const t of sample) {
              console.log(`    ${chalk.cyan(t.subjectCanonId)} ${chalk.yellow(`─[${t.predicate}]→`)} ${chalk.cyan(t.objectCanonId)}`);
            }
            if (allTriples.length > 10) {
              console.log(chalk.dim(`    ... and ${allTriples.length - 10} more`));
            }
          }
        }
        // GX merge summary
        if (gxOutput) {
          console.log('');
          console.log(chalk.magenta('Cross-Document Merge (GX):'));
          console.log(`  Entities: ${gxOutput.meta.inputEntityCount} → ${gxOutput.meta.outputEntityCount}`);
          console.log(`  Triples:  ${gxOutput.meta.inputTripleCount} → ${gxOutput.meta.outputTripleCount}`);
          console.log(`  Exact merges: ${gxOutput.meta.exactMerges}, Fuzzy merges: ${gxOutput.meta.fuzzyMerges}`);

          if (verbose && gxOutput.merges.filter(m => m.method === 'fuzzy').length > 0) {
            console.log(chalk.dim('  Fuzzy merges:'));
            for (const m of gxOutput.merges.filter(m => m.method === 'fuzzy')) {
              console.log(chalk.dim(`    ${m.mergedIds.join(', ')} → ${m.survivorId} (${((m.similarity ?? 0) * 100).toFixed(0)}%)`));
            }
          }
        }
      }
      
      // Aggregation results
      if (result?.aggregate && !skipAgg) {
        console.log('');
        console.log(chalk.blue('Aggregation:'));
        if (result.aggregate.lxProposals) {
          console.log(`  Link proposals: ${result.aggregate.lxProposals.length}`);
        }
        if (result.aggregate.coverage) {
          console.log(`  Coverage: ${result.aggregate.coverage.summary.totalConcepts} concepts across ${result.aggregate.coverage.summary.totalArtifacts} artifacts`);
        }
        if (result.aggregate.findings) {
          console.log(`  Findings: ${result.aggregate.findings.findings?.length ?? 0}`);
        }
      }
      
      console.log('');
      console.log(chalk.green(`Output written to: ${outputDir}/runs/${runId}/`));
      if (result) {
        console.log(chalk.dim(`  overview.json - Quick summary`));
        console.log(chalk.dim(`  bundle/graph.json - Consolidated entities/statements/lx`));
      }
      if (openResults) {
        console.log(chalk.dim(`  open-track/kx-results.json - Raw + canonical triples`));
        if (gxOutput) {
          console.log(chalk.dim(`  open-track/gx-merged.json - Cross-document merged graph`));
        }
      }
      console.log('');
      console.log('Next steps:');
      console.log(`  ${chalk.blue(`${CLI_NAME} status`)} - View run status`);
      console.log(`  ${chalk.blue(`${CLI_NAME} report`)} - Generate analysis report`);
      
    } catch (error) {
      console.error('');
      console.error(chalk.red('Pipeline failed:'));
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// ============================================================================
// Incremental Mode Implementation
// ============================================================================

interface IncrementalOptions {
  profile: Profile;
  profileName: string;
  runId: string;
  providerName: string;
  modelName: string;
  apiKeyOverride?: string;
  skipAgg?: boolean;
  output?: string;
  verbose?: boolean;
  planOnly?: boolean;
  forceAll?: boolean;
  forceFrom?: string;
  includeTranscripts?: boolean;
  transcriptLimit?: number;
}

async function runIncremental(
  cwd: string,
  files: string[],
  options: IncrementalOptions
): Promise<void> {
  const {
    profile,
    profileName,
    runId,
    providerName,
    modelName,
    apiKeyOverride,
    skipAgg,
    output,
    verbose,
    planOnly,
    forceAll,
    forceFrom,
    includeTranscripts,
    transcriptLimit,
  } = options;
  
  const iwDir = path.join(cwd, IW_DIR);
  const outputDir = output || iwDir;
  
  // Initialize the incremental executor
  const executor = new IncrementalExecutor(cwd);
  await executor.init();
  
  // Create pipeline config
  const pipelineConfig = createDefaultPipelineConfig({
    model: modelName,
    profile: profileName,
  });
  
  // Discover artifacts
  console.log(chalk.blue('Discovering artifacts...'));
  
  // Convert file paths to patterns
  const patterns = files.map(f => path.relative(cwd, f));
  await executor.discoverArtifacts({
    patterns,
    exclude: [`${IW_DIR}/**`],
    includeTranscripts,
    transcriptLimit,
  });
  
  const registry = executor.getRegistry();
  console.log(`  Found ${registry.size()} artifacts`);
  console.log('');
  
  // Generate the plan
  const forceFromStage = forceFrom as 'IN' | 'RX' | 'CX' | 'MX' | 'PX' | undefined;
  const plan = await executor.plan({
    config: pipelineConfig,
    forceFrom: forceAll ? 'IN' : forceFromStage,
  });
  
  // Display the plan
  console.log(formatRunPlan(plan));
  
  // If plan-only mode, exit here
  if (planOnly) {
    console.log(chalk.yellow('Plan-only mode - no work performed'));
    return;
  }
  
  // Create workspace reference
  let workspaceKey = 'default';
  let workspaceId = 'ws_default';
  try {
    const configPath = path.join(iwDir, 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    // Normalize workspace key: lowercase, replace invalid chars with hyphens
    workspaceKey = (config.name || workspaceKey)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'default';
    workspaceId = config.id || workspaceId;
  } catch {
    // Use defaults
  }
  const workspace = createWorkspaceRef(workspaceKey, workspaceId);
  
  // Create providers
  let llmProvider;
  if (providerName === 'openai') {
    const apiKey = apiKeyOverride ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(chalk.red('OpenAI API key required. Set OPENAI_API_KEY environment variable or use --api-key flag.'));
      process.exit(1);
    }
    llmProvider = new OpenAILLMProvider({ apiKey, model: modelName });
    if (verbose) {
      console.log(chalk.blue(`Using OpenAI provider with model: ${modelName}`));
    }
  } else {
    llmProvider = new SmartMockLLMProvider({ workspaceKey });
    if (verbose) {
      console.log(chalk.blue('Using SmartMock provider'));
    }
  }
  const extractionProvider = createDefaultExtractionProvider(llmProvider);
  
  // Create store
  const store = createFileStore({
    rootDir: outputDir,
    runId,
  });
  
  // Create pipeline context
  const ctx = createPipelineContext({
    workspace,
    runId,
    store,
    profile,
    providers: {
      llm: llmProvider,
      extraction: extractionProvider,
    },
  });
  
  // Progress callback
  let lastStage = '';
  const onProgress = (progress: PipelineProgress) => {
    if (verbose) {
      if (progress.stage !== lastStage) {
        console.log(`  Stage: ${chalk.cyan(progress.stage)}`);
        lastStage = progress.stage;
      }
      console.log(`    ${progress.artifactId} ${formatProgress(progress.progress)}`);
    } else {
      process.stdout.write(`\r  Processing: ${formatProgress(progress.progress)} [${progress.stage}]`);
    }
  };
  
  // Execute
  console.log('');
  console.log(chalk.blue('Executing incremental pipeline...'));
  const startTime = Date.now();
  
  try {
    const result = await executor.execute(ctx, {
      config: pipelineConfig,
      onProgress,
      continueOnError: true,
      skipAgg,
      forceFrom: forceAll ? 'IN' : forceFromStage,
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // Clear progress line
    if (!verbose) {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }
    
    console.log('');
    console.log(chalk.green('✓ Incremental pipeline completed'));
    console.log('');
    
    // Cache performance
    console.log(chalk.blue('Cache Performance:'));
    console.log(`  Artifacts reused: ${chalk.green(result.cacheStats.cacheHits.toString())}/${plan.totalArtifacts}`);
    console.log(`  Artifacts recomputed: ${chalk.yellow(result.cacheStats.cacheMisses.toString())}/${plan.totalArtifacts}`);
    console.log(`  Stages reused: ${chalk.green(result.cacheStats.stageHits.toString())}`);
    console.log(`  Stages recomputed: ${chalk.yellow(result.cacheStats.stageMisses.toString())}`);
    console.log(`  Duration: ${duration}s`);
    console.log('');
    
    // Results
    console.log(chalk.blue('Results:'));
    console.log(`  Artifacts processed: ${result.artifacts.length}`);
    
    if (result.errors.size > 0) {
      console.log(chalk.yellow(`  Errors: ${result.errors.size}`));
      if (verbose) {
        result.errors.forEach((err: Error, artifactId: string) => {
          console.log(chalk.red(`    ${artifactId}: ${err.message}`));
        });
      }
    }
    
    if (result.meta.summary) {
      console.log('');
      console.log(chalk.blue('Summary:'));
      console.log(`  Entities: ${result.meta.summary.entityCount}`);
      console.log(`  Statements: ${result.meta.summary.statementCount}`);
    }
    
    // Aggregation results
    if (result.aggregate && !skipAgg) {
      console.log('');
      console.log(chalk.blue('Aggregation:'));
      if (result.aggregate.lxProposals) {
        console.log(`  Link proposals: ${result.aggregate.lxProposals.length}`);
      }
      if (result.aggregate.coverage) {
        console.log(`  Coverage: ${result.aggregate.coverage.summary.totalConcepts} concepts`);
      }
      if (result.aggregate.findings) {
        console.log(`  Findings: ${result.aggregate.findings.findings?.length ?? 0}`);
      }
    }
    
    console.log('');
    console.log(chalk.green(`Output written to: ${outputDir}/runs/${runId}/`));
    console.log(chalk.green(`Cache directory: ${executor.getCache().getCacheDir()}`));
    console.log('');
    console.log('Next steps:');
    console.log(`  ${chalk.blue(`${CLI_NAME} status`)} - View run status`);
    console.log(`  ${chalk.blue(`${CLI_NAME} run -i`)} - Re-run with caching`);
    console.log(`  ${chalk.blue(`${CLI_NAME} run -i --plan`)} - Preview next run`);
    
  } catch (error) {
    console.error('');
    console.error(chalk.red('Incremental pipeline failed:'));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
