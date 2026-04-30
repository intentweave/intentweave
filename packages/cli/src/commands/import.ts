// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Import Command
 *
 * Imports transcripts from various sources (SpecStory, ChatGPT, etc.)
 * into the IntentWeave transcript format.
 */

import { Command } from "commander";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "tinyglobby";
import { watch, type FSWatcher } from "chokidar";
import {
  specstoryAdapter,
  SPECSTORY_ADAPTER_NAME,
  type ImportResult,
  type ImportOptions,
} from "@intentweave/core";

// =============================================================================
// Command Definition
// =============================================================================

export const importCommand = new Command("import")
  .description("Import transcripts from conversation sources")
  .argument("[source]", "Source file or directory to import")
  .option(
    "-a, --adapter <name>",
    "Adapter to use (specstory, chatgpt)",
    "specstory",
  )
  .option("-f, --full", "Force full reimport (ignore incremental state)")
  .option("-p, --plan", "Plan only, show what would be imported")
  .option("-s, --session <id>", "Override session ID")
  .option("-v, --verbose", "Verbose output")
  .option("-w, --workspace <path>", "Workspace root directory")
  .option("--watch", "Watch for file changes and auto-import")
  .option(
    "--debounce <ms>",
    "Debounce delay for watch mode (default: 500ms)",
    "500",
  )
  .action(async (source, options) => {
    try {
      if (options.watch) {
        await runWatch(source, options);
      } else {
        await runImport(source, options);
      }
    } catch (error) {
      console.error(
        "Import failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

// =============================================================================
// Import Logic
// =============================================================================

interface ImportCommandOptions {
  adapter: string;
  full?: boolean;
  plan?: boolean;
  session?: string;
  verbose?: boolean;
  workspace?: string;
  watch?: boolean;
  debounce?: string;
}

async function runImport(
  source: string | undefined,
  options: ImportCommandOptions,
): Promise<void> {
  const workspaceRoot = options.workspace ?? process.cwd();

  // Determine source files
  const sourcePaths = await resolveSourcePaths(
    source,
    options.adapter,
    workspaceRoot,
  );

  if (sourcePaths.length === 0) {
    console.log("No source files found to import.");
    return;
  }

  if (options.verbose) {
    console.log(`Found ${sourcePaths.length} source file(s) to import.`);
  }

  // Get adapter
  const adapter = getAdapter(options.adapter);
  if (!adapter) {
    console.error(`Unknown adapter: ${options.adapter}`);
    console.log("Available adapters: specstory");
    process.exit(1);
  }

  // Import options
  const importOptions: ImportOptions = {
    full: options.full,
    planOnly: options.plan,
    sessionId: options.session,
    verbose: options.verbose,
  };

  // Process each source file
  let totalNew = 0;
  let totalImported = 0;
  const results: ImportResult[] = [];

  for (const sourcePath of sourcePaths) {
    if (options.verbose) {
      console.log(`\nProcessing: ${sourcePath}`);
    }

    try {
      const result = await adapter.import(sourcePath, importOptions);
      results.push(result);
      totalNew += result.newMessages;
      totalImported += result.messagesImported;

      if (result.newMessages > 0 || options.verbose) {
        printImportResult(
          result,
          options.plan ?? false,
          options.verbose ?? false,
        );
      }
    } catch (error) {
      console.error(
        `  Error: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // Summary
  console.log("");
  if (options.plan) {
    console.log(
      `Plan: Would import ${totalNew} new message(s) from ${sourcePaths.length} file(s).`,
    );
  } else {
    console.log(
      `Imported ${totalNew} new message(s) from ${sourcePaths.length} file(s).`,
    );
    console.log(`Total messages in transcripts: ${totalImported}`);
  }
}

/**
 * Resolve source paths from argument or discover automatically.
 */
async function resolveSourcePaths(
  source: string | undefined,
  adapter: string,
  workspaceRoot: string,
): Promise<string[]> {
  if (source) {
    // Explicit source provided
    const absPath = path.resolve(workspaceRoot, source);
    const stats = await fs.stat(absPath);

    if (stats.isDirectory()) {
      // Discover files in directory
      return discoverSourceFiles(absPath, adapter);
    }

    return [absPath];
  }

  // Auto-discover based on adapter
  return discoverSourceFiles(workspaceRoot, adapter);
}

/**
 * Discover source files for an adapter.
 */
async function discoverSourceFiles(
  directory: string,
  adapter: string,
): Promise<string[]> {
  const adapterImpl = getAdapter(adapter);
  if (!adapterImpl) {
    return [];
  }

  const patterns = adapterImpl.patterns;
  const files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: directory,
      absolute: true,
    });
    files.push(...matches);
  }

  // Sort by modification time (newest first)
  const filesWithStats = await Promise.all(
    files.map(async (f) => {
      const stats = await fs.stat(f);
      return { path: f, mtime: stats.mtimeMs };
    }),
  );

  filesWithStats.sort((a, b) => b.mtime - a.mtime);

  return filesWithStats.map((f) => f.path);
}

/**
 * Get adapter by name.
 */
function getAdapter(name: string) {
  switch (name.toLowerCase()) {
    case "specstory":
      return specstoryAdapter;
    // Future: case 'chatgpt': return chatgptAdapter;
    default:
      return null;
  }
}

/**
 * Print import result.
 */
function printImportResult(
  result: ImportResult,
  planOnly: boolean,
  verbose: boolean,
): void {
  const action = planOnly ? "Would import" : "Imported";
  const sessionInfo = `session: ${result.sessionId}`;

  if (result.newMessages === 0) {
    console.log(`  ${sessionInfo}: No new messages`);
  } else {
    console.log(
      `  ${sessionInfo}: ${action} ${result.newMessages} new message(s)`,
    );
  }

  if (verbose && result.roleStats) {
    const { intent, spec, implementation, runlog, meta, unknown } =
      result.roleStats;
    const parts: string[] = [];
    if (intent > 0) parts.push(`intent:${intent}`);
    if (spec > 0) parts.push(`spec:${spec}`);
    if (implementation > 0) parts.push(`impl:${implementation}`);
    if (runlog > 0) parts.push(`runlog:${runlog}`);
    if (meta > 0) parts.push(`meta:${meta}`);
    if (unknown > 0) parts.push(`unknown:${unknown}`);

    if (parts.length > 0) {
      console.log(`    Roles: ${parts.join(", ")}`);
    }
  }

  if (verbose) {
    console.log(`    Transcript: ${result.transcriptPath}`);
    console.log(`    Total messages: ${result.messagesImported}`);
  }
}

// =============================================================================
// Watch Mode
// =============================================================================

/**
 * Run import in watch mode - monitors for file changes and auto-imports.
 */
async function runWatch(
  source: string | undefined,
  options: ImportCommandOptions,
): Promise<void> {
  const workspaceRoot = options.workspace ?? process.cwd();
  const debounceMs = parseInt(options.debounce ?? "500", 10);

  // Get adapter
  const adapter = getAdapter(options.adapter);
  if (!adapter) {
    console.error(`Unknown adapter: ${options.adapter}`);
    console.log("Available adapters: specstory");
    process.exit(1);
  }

  // Determine watch patterns
  let watchPatterns: string[];
  if (source) {
    const absPath = path.resolve(workspaceRoot, source);
    try {
      const stats = await fs.stat(absPath);
      if (stats.isDirectory()) {
        watchPatterns = adapter.patterns.map((p) => path.join(absPath, p));
      } else {
        watchPatterns = [absPath];
      }
    } catch {
      console.error(`Source not found: ${source}`);
      process.exit(1);
    }
  } else {
    watchPatterns = adapter.patterns.map((p) => path.join(workspaceRoot, p));
  }

  console.log(`👀 Watching for changes...`);
  console.log(`   Patterns: ${watchPatterns.join(", ")}`);
  console.log(`   Debounce: ${debounceMs}ms`);
  console.log(`   Press Ctrl+C to stop.\n`);

  // Initial import
  console.log("📥 Running initial import...");
  await runImport(source, { ...options, watch: false });
  console.log("");

  // Track pending imports for debouncing
  const pendingImports = new Map<string, NodeJS.Timeout>();

  // Create watcher
  const watcher = watch(watchPatterns, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  const importFile = async (filePath: string) => {
    const importOptions: ImportOptions = {
      full: false, // Never force full reimport in watch mode
      planOnly: false,
      verbose: options.verbose,
    };

    try {
      const result = await adapter.import(filePath, importOptions);

      if (result.newMessages > 0) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(
          `[${timestamp}] 📄 ${path.basename(filePath)}: +${result.newMessages} message(s)`,
        );
      } else if (options.verbose) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(
          `[${timestamp}] 📄 ${path.basename(filePath)}: No new messages`,
        );
      }
    } catch (error) {
      const timestamp = new Date().toLocaleTimeString();
      console.error(
        `[${timestamp}] ❌ ${path.basename(filePath)}: ${error instanceof Error ? error.message : error}`,
      );
    }
  };

  const handleChange = (filePath: string) => {
    // Clear existing timeout for this file
    const existing = pendingImports.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new debounced import
    const timeout = setTimeout(() => {
      pendingImports.delete(filePath);
      importFile(filePath);
    }, debounceMs);

    pendingImports.set(filePath, timeout);
  };

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);

  watcher.on("error", (error) => {
    console.error("Watch error:", error);
  });

  // Handle graceful shutdown
  const cleanup = () => {
    console.log("\n👋 Stopping watch mode...");
    watcher.close();
    for (const timeout of pendingImports.values()) {
      clearTimeout(timeout);
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep process alive
  await new Promise(() => {});
}
