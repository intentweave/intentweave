// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import type { ServerConfig } from "@intentweave/server-core";
import { createRunnerFromDriver } from "../helpers/index.js";
import { buildDecisionTree } from "../insight/index.js";

/**
 * POST /api/insight — Generate a purpose-built visualization from the knowledge graph.
 *
 * The insight system queries the KG, identifies the right visualization type,
 * and structures the data into a renderable format.
 *
 * Supported vizTypes:
 *   - decision-tree: Hierarchical view of decisions, options, and rationale
 *   - (more coming: impact-graph, architecture, heatmap)
 */
export async function registerInsightRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const config: ServerConfig = (fastify as any).config;

  fastify.post(
    "/api/insight",
    {
      schema: {
        tags: ["insight"],
        description:
          "Generate a purpose-built visualization from the knowledge graph",
        body: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description:
                "Natural language question (used to filter and title the visualization)",
            },
            vizType: {
              type: "string",
              enum: [
                "decision-tree",
                "impact-graph",
                "architecture",
                "heatmap",
              ],
              default: "decision-tree",
              description:
                "Visualization type. Defaults to decision-tree for v1.",
            },
            session: {
              type: "string",
              description: "Session ID to scope the query",
            },
            maxNodes: {
              type: "integer",
              default: 30,
              description: "Maximum decision nodes to include",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              vizType: { type: "string" },
              title: { type: "string" },
              data: {
                type: "object",
                properties: {
                  nodes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        label: { type: "string" },
                        kind: { type: "string" },
                        description: { type: "string" },
                        confidence: { type: "number" },
                      },
                    },
                  },
                  edges: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        source: { type: "string" },
                        target: { type: "string" },
                        label: { type: "string" },
                      },
                    },
                  },
                  rootId: { type: "string" },
                },
              },
              meta: {
                type: "object",
                properties: {
                  session: { type: "string" },
                  entityCount: { type: "number" },
                  edgeCount: { type: "number" },
                  queryTimeMs: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        question?: string;
        vizType?: string;
        session?: string;
        maxNodes?: number;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = body.session ?? ctx.sessionId;
      const vizType = body.vizType ?? "decision-tree";
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      switch (vizType) {
        case "decision-tree": {
          const result = await buildDecisionTree({
            runner,
            sessionId,
            question: body.question,
            maxDecisions: body.maxNodes ?? 30,
          });
          return result;
        }

        default:
          return (reply as any).status(400).send({
            error: `Unsupported vizType: ${vizType}. Supported: decision-tree`,
          });
      }
    },
  );
}
