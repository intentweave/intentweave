// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import {
  analyzeDocHealth,
  formatDocHealthMarkdown,
} from "@intentweave/cli/doc-health";
import { createRunnerFromDriver } from "../helpers/index.js";

/**
 * POST /api/doc-health — Documentation freshness analysis.
 *
 * Checks for:
 *   - Stale: entity DECIDED_AGAINST or SUPERSEDED since extraction
 *   - Drift: entity gained new relationships not in doc's triples
 *   - Temporal: file modified after extraction timestamp
 *   - Missing: canon entities with no doc provenance
 *
 * Wraps the same logic as `iw doc-health` CLI command.
 */
export async function registerDocHealthRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/api/doc-health",
    {
      schema: {
        tags: ["doc-health"],
        description:
          "Analyze documentation freshness — detect stale, drifted, and contradicted docs",
        body: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description: "Specific files to check (or omit for all)",
            },
            session: { type: "string", description: "Session ID" },
            format: {
              type: "string",
              enum: ["markdown", "json"],
              default: "json",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              reports: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    status: {
                      type: "string",
                      enum: ["fresh", "warning", "rotten"],
                    },
                    score: { type: "number" },
                    issues: { type: "array", items: { type: "object" } },
                  },
                },
              },
              summary: { type: "string" },
            },
          },
        },
      },
    },
    async (request) => {
      const { files, session } = request.body as {
        files?: string[];
        session?: string;
        format?: string;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = session ?? ctx.sessionId;
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      const result = await analyzeDocHealth({
        runner,
        sessionId,
        files,
        log: (msg: string) => fastify.log.debug(msg),
      });

      return {
        reports: result.reports.map((r: any) => ({
          file: r.filePath,
          status: r.status,
          score: r.freshnessPercent,
          issues: r.issues,
        })),
        summary: formatDocHealthMarkdown(result),
      };
    },
  );
}
