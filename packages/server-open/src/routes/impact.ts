// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import { analyzeImpact, formatImpactMarkdown } from "@intentweave/cli/impact";
import { createRunnerFromDriver } from "../helpers/index.js";

/**
 * POST /api/impact — Semantic impact analysis.
 *
 * Given file paths, traverses CodeRef → Canon → CANON_REL to find:
 *   - Direct impact: which semantic concepts are realized by the file
 *   - Ripple impact: what depends on those concepts (N hops)
 *   - Risks: RISKS/BLOCKS predicates in the ripple zone
 *
 * Wraps the same logic as `iw impact` CLI command.
 */
export async function registerImpactRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/api/impact",
    {
      schema: {
        tags: ["impact"],
        description:
          "Semantic impact analysis — what concepts are affected by changing a file",
        body: {
          type: "object",
          required: ["files"],
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description: "File paths to analyze",
            },
            session: { type: "string", description: "Session ID" },
            hops: {
              type: "integer",
              default: 2,
              description: "Ripple analysis depth",
            },
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
              directImpact: { type: "array", items: { type: "object" } },
              rippleImpact: { type: "array", items: { type: "object" } },
              risks: { type: "array", items: { type: "object" } },
              summary: { type: "string" },
            },
          },
        },
      },
    },
    async (request) => {
      const {
        files,
        session,
        hops = 2,
      } = request.body as {
        files: string[];
        session?: string;
        hops?: number;
        format?: string;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = session ?? ctx.sessionId;
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      const result = await analyzeImpact(files, {
        runner,
        sessionId,
        hops,
        log: (msg: string) => fastify.log.debug(msg),
      });

      return {
        directImpact: result.directEntities,
        rippleImpact: result.rippleEntities,
        risks: result.risks,
        summary: formatImpactMarkdown(result),
      };
    },
  );
}
