// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for `iw run` and `iw watch`.
 *
 * Moved out of run.ts so that watch.ts can reuse them
 * without duplicating code.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import chalk from "chalk";
import { glob } from "glob";
import {
  createPipelineContext,
  createFileStore,
  createDefaultExtractionProvider,
  convertProfileForAnalyzer,
  type ArtifactInput,
  type Profile,
} from "@intentweave/analyzer";
import {
  SmartMockLLMProvider,
  OpenAILLMProvider,
} from "@intentweave/analyzer/llm";
import type { LLMProvider } from "@intentweave/core";
import { createWorkspaceRef } from "@intentweave/core";
import { profileRegistry } from "@intentweave/profiles";
import { IW_DIR } from "../constants.js";

// ── Run ID / artifact ID ────────────────────────────────────

/**
 * Generate a run ID based on timestamp + random suffix.
 */
export function generateRunId(): string {
  const now = new Date();
  const dateStr = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const suffix = crypto.randomBytes(4).toString("hex");
  return `run-${dateStr}-${suffix}`;
}

/**
 * Generate artifact ID from file path.
 */
export function generateArtifactId(filePath: string, basePath: string): string {
  const relativePath = path.relative(basePath, filePath);
  return relativePath
    .replace(/\\/g, "/")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "_");
}

// ── File collection ─────────────────────────────────────────

/** Default ignore patterns (always excluded). */
const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.iw/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
];

/**
 * Collect files to analyse using glob patterns.
 * Respects a default ignore list (node_modules, .git, etc.).
 */
export async function collectFiles(
  patterns: string[],
  basePath: string,
  includeIgnored = false,
): Promise<string[]> {
  const files: string[] = [];

  for (const pattern of patterns) {
    const absolutePattern = path.isAbsolute(pattern)
      ? pattern
      : path.join(basePath, pattern);

    const stat = await fs.stat(absolutePattern).catch(() => null);

    if (stat?.isFile()) {
      files.push(absolutePattern);
    } else if (stat?.isDirectory()) {
      const dirFiles = await glob("**/*", {
        cwd: absolutePattern,
        nodir: true,
        absolute: true,
        ignore: includeIgnored ? [] : DEFAULT_IGNORE,
        dot: false,
      });
      files.push(...dirFiles);
    } else {
      const matched = await glob(pattern, {
        cwd: basePath,
        nodir: true,
        absolute: true,
        ignore: includeIgnored ? [] : DEFAULT_IGNORE,
        dot: false,
      });
      files.push(...matched);
    }
  }

  return [...new Set(files)]; // deduplicate
}

// ── Artifact building ───────────────────────────────────────

/**
 * Build `ArtifactInput[]` from absolute file paths.
 * Reads each file from disk.
 */
export async function buildArtifacts(
  files: string[],
  basePath: string,
  roleOverride?: string,
): Promise<ArtifactInput[]> {
  return Promise.all(
    files.map(async (filePath) => ({
      artifactId: generateArtifactId(filePath, basePath),
      filePath,
      content: await fs.readFile(filePath, "utf-8"),
      ...(roleOverride && { artifactRole: roleOverride }),
    })),
  );
}

// ── Provider / context bootstrap ────────────────────────────

export interface ProviderSetupOptions {
  providerName: string;
  modelName: string;
  apiKeyOverride?: string;
  timeoutMs?: number;
  verbose?: boolean;
  workspaceKey?: string;
}

/**
 * Create the LLM provider based on CLI flags.
 * Returns the provider.  Exits the process if keys are missing.
 */
export function createLLMProvider(opts: ProviderSetupOptions): LLMProvider {
  if (opts.providerName === "openai") {
    const apiKey = opts.apiKeyOverride ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error(
        chalk.red(
          "OpenAI API key required.  Set OPENAI_API_KEY or use --api-key.",
        ),
      );
      process.exit(1);
    }
    const timeout = opts.timeoutMs ?? 60_000;
    const provider = new OpenAILLMProvider({
      apiKey,
      model: opts.modelName,
      timeoutMs: timeout,
    });
    if (opts.verbose) {
      console.log(
        chalk.blue(
          `Using OpenAI provider with model: ${opts.modelName}${timeout !== 60_000 ? `, timeout: ${timeout}ms` : ""}`,
        ),
      );
    }
    return provider as unknown as LLMProvider;
  }

  const provider = new SmartMockLLMProvider({
    workspaceKey: opts.workspaceKey ?? "default",
  });
  if (opts.verbose) {
    console.log(
      chalk.blue("Using SmartMock provider (deterministic, no API key needed)"),
    );
  }
  return provider as unknown as LLMProvider;
}

export interface WorkspaceInfo {
  workspaceKey: string;
  workspaceId: string;
  iwDir: string;
}

/**
 * Read workspace config from `.iw/config.json` and return normalised keys.
 */
export async function loadWorkspaceInfo(cwd: string): Promise<WorkspaceInfo> {
  const iwDir = path.join(cwd, IW_DIR);
  let workspaceKey = "default";
  let workspaceId = "ws_default";

  try {
    const configPath = path.join(iwDir, "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
    workspaceKey =
      (config.name || workspaceKey)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64) || "default";
    workspaceId = config.id || workspaceId;
  } catch {
    // Use defaults
  }

  return { workspaceKey, workspaceId, iwDir };
}

/**
 * Resolve a profile name to the analyzer Profile type.
 * Exits the process on unknown profile.
 */
export function resolveProfile(profileName: string): Profile {
  const registryProfile = profileRegistry.resolve(profileName);
  if (!registryProfile) {
    console.error(chalk.red(`Unknown profile: ${profileName}`));
    console.log("Available profiles:", profileRegistry.list().join(", "));
    process.exit(1);
  }
  return convertProfileForAnalyzer(registryProfile);
}

/**
 * Create a pipeline context (workspace ref, store, providers).
 */
export function buildPipelineContext(opts: {
  workspaceKey: string;
  workspaceId: string;
  iwDir: string;
  runId: string;
  profile: Profile;
  llmProvider: LLMProvider;
  concurrency?: number;
  output?: string;
}) {
  const workspace = createWorkspaceRef(opts.workspaceKey, opts.workspaceId);
  const outputDir = opts.output ?? opts.iwDir;
  const store = createFileStore({ rootDir: outputDir, runId: opts.runId });
  const extractionProvider = createDefaultExtractionProvider(
    opts.llmProvider as any,
    { parallelChunks: opts.concurrency ?? 5 },
  );

  const ctx = createPipelineContext({
    workspace,
    runId: opts.runId,
    store,
    profile: opts.profile,
    providers: {
      llm: opts.llmProvider as any,
      extraction: extractionProvider,
    },
  });

  return { ctx, store, workspace, outputDir };
}

// ── Progress formatting ─────────────────────────────────────

/**
 * Format a simple ASCII progress bar.
 */
export function formatProgress(progress: number, width = 30): string {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${(progress * 100).toFixed(0)}%`;
}
