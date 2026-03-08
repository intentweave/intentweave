// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import {
  runOpenTrackBatch,
  createFileStore,
  createPipelineContext,
  createDefaultExtractionProvider,
  convertProfileForAnalyzer,
  OpenTrackCache,
  runGxStage,
  type OpenTrackResult,
  type KxStageOutput,
  type GxStageOutput,
} from "@intentweave/analyzer";
import {
  SmartMockLLMProvider,
  OpenAILLMProvider,
} from "@intentweave/analyzer/llm";
import type { LLMProvider } from "@intentweave/core";
import { createWorkspaceRef } from "@intentweave/core";
import { profileRegistry } from "@intentweave/profiles";
import {
  generateRunId,
  collectFiles,
  buildArtifacts,
  loadWorkspaceInfo,
} from "@intentweave/cli/run-shared";

/**
 * POST /api/run — Execute the extraction pipeline.
 * GET  /api/runs/:runId — Check run status.
 *
 * Runs the open track pipeline (IN → FX → KX → GX) on the server.
 * Requires `workspaceRoot` in the server config so files can be read.
 * Progress is published to the SSE stream.
 */
export async function registerRunRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // ── POST /api/run ─────────────────────────────────────────
  fastify.post(
    "/api/run",
    {
      schema: {
        tags: ["pipeline"],
        description: "Execute the extraction pipeline on files",
        body: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description:
                "File paths or glob patterns (default: all .ts + .md)",
            },
            track: {
              type: "string",
              enum: ["open", "main", "both"],
              default: "open",
            },
            provider: {
              type: "string",
              enum: ["smart-mock", "openai"],
              default: "smart-mock",
            },
            model: {
              type: "string",
              description: "LLM model name (e.g., gpt-4o-mini)",
            },
            incremental: {
              type: "boolean",
              default: true,
              description: "Enable incremental caching",
            },
            concurrency: { type: "integer", default: 5 },
            persist: {
              type: "boolean",
              default: false,
              description: "Persist results to Neo4j after run",
            },
            session: {
              type: "string",
              description: "Session ID (overrides server default)",
            },
            profile: {
              type: "string",
              default: "standard",
              description: "Extraction profile name",
            },
            force: {
              type: "boolean",
              default: false,
              description: "Force recomputation (ignore cache)",
            },
            apiKey: {
              type: "string",
              description:
                "OpenAI API key (uses OPENAI_API_KEY env if omitted)",
            },
          },
        },
        response: {
          202: {
            type: "object",
            additionalProperties: true,
            properties: {
              runId: { type: "string" },
              status: { type: "string" },
              track: { type: "string" },
              artifactCount: { type: "integer" },
              message: { type: "string" },
              durationMs: { type: "number" },
              openTrack: { type: "object", additionalProperties: true },
              gx: { type: "object", additionalProperties: true },
              persist: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const config = (fastify as any).config;
      const workspaceRoot: string | undefined = config?.workspaceRoot;

      if (!workspaceRoot) {
        return (reply as any).status(400).send({
          error:
            "Server not configured with a workspaceRoot. Set IW_WORKSPACE_ROOT env variable.",
        });
      }

      const body = request.body as {
        files?: string[];
        track?: string;
        provider?: string;
        model?: string;
        incremental?: boolean;
        concurrency?: number;
        persist?: boolean;
        session?: string;
        profile?: string;
        force?: boolean;
        apiKey?: string;
      };

      const track = body.track ?? "open";
      const providerName = body.provider ?? "smart-mock";
      const modelName = body.model ?? "gpt-5-mini";
      const concurrency = body.concurrency ?? 5;
      const incrementalMode = body.incremental ?? true;
      const shouldPersist = body.persist ?? false;
      const profileName = body.profile ?? "standard";
      const forceAll = body.force ?? false;
      const reqCtx = (request as any).ctx as { sessionId: string };
      const sessionId = body.session ?? reqCtx.sessionId;

      // Only open track supported server-side currently
      if (track === "main" || track === "both") {
        return (reply as any).status(501).send({
          error:
            "Main track not yet supported server-side. Use `iw run --track main` CLI.",
          hint: 'POST with track: "open" to run the open track.',
        });
      }

      // ── Resolve profile ──────────────────────────────────
      const registryProfile = profileRegistry.resolve(profileName);
      if (!registryProfile) {
        return (reply as any).status(400).send({
          error: `Unknown profile: ${profileName}`,
          available: profileRegistry.list(),
        });
      }
      const profile = convertProfileForAnalyzer(registryProfile);

      // ── Collect files ────────────────────────────────────
      const patterns = body.files ?? ["**/*.ts", "**/*.md"];
      let filesToAnalyze: string[];
      try {
        filesToAnalyze = await collectFiles(patterns, workspaceRoot);
      } catch (err) {
        return (reply as any).status(400).send({
          error: `Failed to collect files: ${(err as Error).message}`,
        });
      }

      if (filesToAnalyze.length === 0) {
        return (reply as any).status(400).send({
          error: "No files matched the given patterns",
          patterns,
        });
      }

      // ── Build artifacts ──────────────────────────────────
      const artifacts = await buildArtifacts(filesToAnalyze, workspaceRoot);

      // ── Create LLM provider ──────────────────────────────
      let llmProvider: LLMProvider;
      if (providerName === "openai") {
        const apiKey = body.apiKey ?? process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return (reply as any).status(400).send({
            error:
              "OpenAI API key required. Pass apiKey in body or set OPENAI_API_KEY env.",
          });
        }
        llmProvider = new OpenAILLMProvider({
          apiKey,
          model: modelName,
        }) as unknown as LLMProvider;
      } else {
        llmProvider = new SmartMockLLMProvider({
          workspaceKey: sessionId,
        }) as unknown as LLMProvider;
      }

      // ── Build pipeline context ───────────────────────────
      const runId = generateRunId();
      const { iwDir } = await loadWorkspaceInfo(workspaceRoot);
      const workspace = createWorkspaceRef(sessionId, `ws_${sessionId}`);
      const store = createFileStore({ rootDir: iwDir, runId });
      const extractionProvider = createDefaultExtractionProvider(
        llmProvider as any,
        {
          parallelChunks: concurrency,
        },
      );
      const pipelineCtx = createPipelineContext({
        workspace,
        runId,
        store,
        profile,
        providers: { llm: llmProvider as any, extraction: extractionProvider },
      });

      // ── Publish start event via SSE ──────────────────────
      const sseHub = (fastify as any).sseHub;
      sseHub?.broadcast?.(
        "run:start",
        JSON.stringify({ runId, artifactCount: artifacts.length, track }),
      );

      // ── Run open track ───────────────────────────────────
      const startTime = Date.now();
      let openResults: OpenTrackResult[];

      try {
        const cache = incrementalMode
          ? new OpenTrackCache(workspaceRoot)
          : undefined;
        if (cache) await cache.init();

        openResults = await runOpenTrackBatch(artifacts, pipelineCtx, {
          llmProvider,
          writeOutputs: true,
          cache,
          force: forceAll,
          concurrency,
        });
      } catch (err) {
        sseHub?.broadcast?.(
          "run:error",
          JSON.stringify({ runId, error: (err as Error).message }),
        );
        throw err;
      }

      // ── GX merge (when >1 artifact) ─────────────────────
      let gxOutput: GxStageOutput | undefined;
      if (openResults.length > 1) {
        const kxOutputs = openResults.map((r) => r.kx);
        gxOutput = runGxStage(kxOutputs, { fuzzyThreshold: 0.8 });
      }

      // ── Persist if requested ─────────────────────────────
      let persistResultData: Record<string, unknown> | undefined;
      if (shouldPersist && openResults.length > 0) {
        try {
          const { persistKxToNeo4j } =
            await import("@intentweave/cli/persist-neo4j");
          const kxOutputs: KxStageOutput[] = gxOutput
            ? [
                {
                  $schema: "intentweave://schemas/kx/v0.1" as const,
                  schemaVersion: "0.1" as const,
                  stage: "KX" as const,
                  artifactId: "__merged__",
                  filePath: "__merged__",
                  rawTriples: openResults.flatMap((r) => r.kx.rawTriples),
                  canonEntities: gxOutput.entities,
                  canonTriples: gxOutput.triples,
                  entityResolutions: openResults.flatMap(
                    (r) => r.kx.entityResolutions,
                  ),
                  predicateMappings: openResults.flatMap(
                    (r) => r.kx.predicateMappings,
                  ),
                  evidence: openResults.flatMap((r) => r.kx.evidence),
                  meta: {
                    provider: openResults[0]?.kx.meta.provider ?? "unknown",
                    latencyMs: gxOutput.meta.latencyMs,
                    rawTripleCount: gxOutput.meta.inputTripleCount,
                    canonTripleCount: gxOutput.meta.outputTripleCount,
                    canonEntityCount: gxOutput.meta.outputEntityCount,
                    entitiesMerged:
                      gxOutput.meta.exactMerges + gxOutput.meta.fuzzyMerges,
                    predicatesFallback: 0,
                    droppedCount: 0,
                  },
                },
              ]
            : openResults.map((r) => r.kx);

          const result = await persistKxToNeo4j(kxOutputs, {
            sessionId,
            runId,
            workspaceId: `ws_${sessionId}`,
            uri: config.neo4j?.uri,
            mode: "delta",
          });
          persistResultData = {
            entitiesPersisted: result.canonEntitiesWritten,
            relationshipsPersisted: result.canonRelationshipsWritten,
            rawTriplesPersisted: result.rawTriplesWritten,
            durationMs: result.durationMs,
            delta: result.delta,
          };
        } catch (err) {
          persistResultData = { error: (err as Error).message };
        }
      }

      const durationMs = Date.now() - startTime;

      // ── SSE completion ───────────────────────────────────
      sseHub?.broadcast?.(
        "run:complete",
        JSON.stringify({
          runId,
          durationMs,
          artifactCount: openResults.length,
        }),
      );

      // ── Response (202 Accepted) ──────────────────────────
      const totalRaw = openResults.reduce(
        (s, r) => s + r.kx.rawTriples.length,
        0,
      );
      const totalCanon = openResults.reduce(
        (s, r) => s + r.kx.canonEntities.length,
        0,
      );
      const totalTriples = openResults.reduce(
        (s, r) => s + r.kx.canonTriples.length,
        0,
      );

      const response: Record<string, unknown> = {
        runId,
        status: "completed",
        track,
        artifactCount: openResults.length,
        durationMs,
        message: `Pipeline completed: ${openResults.length} artifacts, ${totalCanon} entities, ${totalTriples} triples`,
        openTrack: {
          artifacts: openResults.length,
          rawTriples: totalRaw,
          canonEntities: totalCanon,
          canonTriples: totalTriples,
        },
      };

      if (gxOutput) {
        response.gx = {
          inputEntities: gxOutput.meta.inputEntityCount,
          outputEntities: gxOutput.meta.outputEntityCount,
          exactMerges: gxOutput.meta.exactMerges,
          fuzzyMerges: gxOutput.meta.fuzzyMerges,
        };
      }

      if (persistResultData) {
        response.persist = persistResultData;
      }

      return (reply as any).status(202).send(response);
    },
  );

  // ── GET /api/runs/:runId ──────────────────────────────────
  fastify.get(
    "/api/runs/:runId",
    {
      schema: {
        tags: ["pipeline"],
        description: "Get the status and results of a pipeline run",
        params: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              runId: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const config = (fastify as any).config;
      const workspaceRoot: string | undefined = config?.workspaceRoot;

      if (!workspaceRoot) {
        return (reply as any).status(400).send({
          error: "Server not configured with a workspaceRoot.",
        });
      }

      const { runId } = request.params as { runId: string };
      const { iwDir } = await loadWorkspaceInfo(workspaceRoot);

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const runDir = path.join(iwDir, "runs", runId);

      try {
        await fs.access(runDir);
      } catch {
        return (reply as any)
          .status(404)
          .send({ error: `Run not found: ${runId}` });
      }

      // Check for open-track outputs
      const kxPath = path.join(runDir, "open-track", "kx-results.json");
      let kxData: Record<string, unknown> | undefined;
      try {
        const raw = await fs.readFile(kxPath, "utf-8");
        kxData = JSON.parse(raw);
      } catch {
        // No KX output yet
      }

      return {
        runId,
        status: kxData ? "completed" : "in-progress",
        hasKxResults: !!kxData,
        artifactCount: (kxData as any)?.artifacts?.length ?? 0,
      };
    },
  );
}
