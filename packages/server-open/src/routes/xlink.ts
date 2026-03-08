// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import {
  runCrossLayerLinker,
  persistCrossLinks,
  formatXLinkReport,
} from "@intentweave/cli/linker";
import { createRunnerFromDriver } from "../helpers/index.js";

/**
 * POST /api/xlink — Cross-layer code linking.
 *
 * Connects semantic KG entities to source code using 4 strategies:
 *   - dep: package.json dependency matching
 *   - import: TypeScript/JavaScript import matching
 *   - name: Exported symbol name matching
 *   - path: File/directory path matching
 *
 * Creates CodeRef nodes and REALIZED_BY relationships.
 * Wraps the same logic as `iw xlink` CLI command.
 */
export async function registerXlinkRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/api/xlink",
    {
      schema: {
        tags: ["xlink"],
        description:
          "Cross-layer code linking — connect semantic KG to source code",
        body: {
          type: "object",
          required: ["directory"],
          properties: {
            directory: {
              type: "string",
              description: "Root directory of the codebase to link",
            },
            session: { type: "string", description: "Session ID" },
            strategies: {
              type: "array",
              items: {
                type: "string",
                enum: ["dep", "import", "name", "path"],
              },
              default: ["dep", "import", "name", "path"],
              description: "Matching strategies to use",
            },
            persist: {
              type: "boolean",
              default: false,
              description: "Write CodeRef nodes to Neo4j",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              matched: { type: "number" },
              total: { type: "number" },
              codeRefs: { type: "number" },
              realizedBy: { type: "number" },
              byStrategy: { type: "object" },
              summary: { type: "string" },
            },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as {
        directory: string;
        session?: string;
        strategies?: ("dep" | "import" | "name" | "path")[];
        persist?: boolean;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = body.session ?? ctx.sessionId;
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      const result = await runCrossLayerLinker({
        runner,
        sessionId,
        codebaseDir: body.directory,
        strategies: body.strategies as any,
        log: (msg: string) => fastify.log.debug(msg),
      });

      // Persist if requested
      if (body.persist) {
        await persistCrossLinks(
          runner,
          sessionId,
          result.links,
          (msg: string) => fastify.log.debug(msg),
        );
      }

      return {
        matched: result.stats.linkedEntities,
        total: result.stats.totalCanonEntities,
        codeRefs: result.stats.totalCodeRefs,
        realizedBy: result.links.length,
        byStrategy: result.stats.byStrategy,
        summary: formatXLinkReport(result),
      };
    },
  );
}
