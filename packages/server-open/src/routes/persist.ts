// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { KxStageOutput } from "@intentweave/analyzer";
import { loadWorkspaceInfo } from "@intentweave/cli/run-shared";

/**
 * POST /api/persist — Write KX results to Neo4j.
 *
 * Supports:
 *   - Persist a specific run (by runId)
 *   - Persist the latest run (latest: true)
 *   - Delta mode (diff-only) or full mode
 *
 * Requires `workspaceRoot` in server config to find run outputs.
 * Wraps the same logic as `iw persist` CLI command.
 */
export async function registerPersistRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/api/persist",
    {
      schema: {
        tags: ["pipeline"],
        description: "Persist extraction results to Neo4j",
        body: {
          type: "object",
          properties: {
            runId: { type: "string", description: "Run ID to persist" },
            latest: {
              type: "boolean",
              default: false,
              description: "Persist the latest run",
            },
            session: { type: "string", description: "Session ID" },
            mode: { type: "string", enum: ["delta", "full"], default: "delta" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              canonEntitiesWritten: { type: "integer" },
              canonRelationshipsWritten: { type: "integer" },
              rawTriplesWritten: { type: "integer" },
              durationMs: { type: "number" },
              mode: { type: "string" },
              delta: { type: "object", additionalProperties: true },
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
        runId?: string;
        latest?: boolean;
        session?: string;
        mode?: "delta" | "full";
      };

      const reqCtx = (request as any).ctx as { sessionId: string };
      const sessionId = body.session ?? reqCtx.sessionId;
      const persistMode = body.mode ?? "delta";

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { iwDir } = await loadWorkspaceInfo(workspaceRoot);
      const runsDir = path.join(iwDir, "runs");

      // ── Resolve run ID ───────────────────────────────────
      let targetRunId = body.runId;

      if (!targetRunId) {
        if (body.latest) {
          try {
            const runs = await fs.readdir(runsDir);
            const sorted = runs
              .filter((r) => r.startsWith("run-"))
              .sort()
              .reverse();

            for (const run of sorted) {
              const kxPath = path.join(
                runsDir,
                run,
                "open-track",
                "kx-results.json",
              );
              try {
                await fs.access(kxPath);
                targetRunId = run;
                break;
              } catch {
                // try next
              }
            }

            if (!targetRunId) {
              return (reply as any).status(404).send({
                error: "No runs with open track output found",
              });
            }
          } catch {
            return (reply as any).status(404).send({
              error: "No runs directory found. Run the pipeline first.",
            });
          }
        } else {
          return (reply as any).status(400).send({
            error: "Specify runId or set latest: true",
          });
        }
      }

      // ── Load KX results ──────────────────────────────────
      const kxPath = path.join(
        runsDir,
        targetRunId,
        "open-track",
        "kx-results.json",
      );
      let kxOutputs: KxStageOutput[];

      try {
        const raw = await fs.readFile(kxPath, "utf-8");
        const data = JSON.parse(raw);

        if (data.artifacts && Array.isArray(data.artifacts)) {
          kxOutputs = data.artifacts as KxStageOutput[];
        } else {
          return (reply as any).status(400).send({
            error: `Unexpected format in ${kxPath}`,
          });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return (reply as any).status(404).send({
            error: `KX results not found for run: ${targetRunId}`,
            hint: 'Run the pipeline with track: "open" first.',
          });
        }
        throw err;
      }

      // ── Check for GX-merged output ───────────────────────
      const gxPath = path.join(
        runsDir,
        targetRunId,
        "open-track",
        "gx-merged.json",
      );
      try {
        const gxRaw = await fs.readFile(gxPath, "utf-8");
        const gxData = JSON.parse(gxRaw);

        if (gxData.entities && gxData.triples) {
          // Use GX-merged graph as a single synthetic KxStageOutput
          kxOutputs = [
            {
              $schema: "intentweave://schemas/kx/v0.1" as const,
              schemaVersion: "0.1" as const,
              stage: "KX" as const,
              artifactId: "__merged__",
              filePath: "__merged__",
              rawTriples: kxOutputs.flatMap((k: any) => k.rawTriples ?? []),
              canonEntities: gxData.entities,
              canonTriples: gxData.triples,
              entityResolutions: kxOutputs.flatMap(
                (k: any) => k.entityResolutions ?? [],
              ),
              predicateMappings: kxOutputs.flatMap(
                (k: any) => k.predicateMappings ?? [],
              ),
              evidence: kxOutputs.flatMap((k: any) => k.evidence ?? []),
              meta: {
                provider: (kxOutputs[0] as any)?.meta?.provider ?? "unknown",
                latencyMs: 0,
                rawTripleCount: gxData.meta?.inputTripleCount ?? 0,
                canonTripleCount: gxData.meta?.outputTripleCount ?? 0,
                canonEntityCount: gxData.meta?.outputEntityCount ?? 0,
                entitiesMerged: 0,
                predicatesFallback: 0,
                droppedCount: 0,
              },
            },
          ];
        }
      } catch {
        // No GX output — use per-artifact KX outputs directly
      }

      // ── Persist to Neo4j ─────────────────────────────────
      const { persistKxToNeo4j } =
        await import("@intentweave/cli/persist-neo4j");

      const result = await persistKxToNeo4j(kxOutputs, {
        sessionId,
        runId: targetRunId,
        workspaceId: `ws_${sessionId}`,
        uri: config.neo4j?.uri,
        mode: persistMode,
        log: (msg: string) => fastify.log.debug(msg),
      });

      return {
        runId: targetRunId,
        canonEntitiesWritten: result.canonEntitiesWritten,
        canonRelationshipsWritten: result.canonRelationshipsWritten,
        rawTriplesWritten: result.rawTriplesWritten,
        durationMs: result.durationMs,
        mode: persistMode,
        delta: result.delta,
      };
    },
  );
}
