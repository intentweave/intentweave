// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import type { ServerConfig } from "@intentweave/server-core";
import { createRunnerFromDriver } from "../helpers/index.js";
import {
  buildDecisionTree,
  buildImpactGraph,
  buildKnowledgeGraph,
  buildKwgGraph,
  buildKwgPlusGraph,
  buildLineage,
} from "../insight/index.js";

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
                "knowledge-graph",
                "kwg",
                "kwg-plus",
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
            hops: {
              type: "integer",
              default: 2,
              minimum: 1,
              maximum: 3,
              description: "Impact graph expansion hops (1-3, default 2)",
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

        case "impact-graph": {
          const result = await buildImpactGraph({
            runner,
            sessionId,
            question: body.question,
            hops: (body as any).hops ?? 2,
            maxNodes: body.maxNodes ?? 60,
          });
          return result;
        }

        case "knowledge-graph": {
          const result = await buildKnowledgeGraph({
            runner,
            sessionId,
            question: body.question,
            maxNodes: body.maxNodes ?? 200,
          });
          return result;
        }

        case "kwg": {
          const result = await buildKwgGraph({
            runner,
            sessionId,
            question: body.question,
            maxNodes: body.maxNodes ?? 200,
          });
          return result;
        }

        case "kwg-plus": {
          const result = await buildKwgPlusGraph({
            runner,
            sessionId,
            question: body.question,
            maxNodes: body.maxNodes ?? 200,
          });
          return result;
        }

        default:
          return (reply as any).status(400).send({
            error: `Unsupported vizType: ${vizType}. Supported: decision-tree, impact-graph, knowledge-graph, kwg, kwg-plus`,
          });
      }
    },
  );

  // ── GET /api/insight/lineage/:canonId — trace an entity back to sources ──
  fastify.get(
    "/api/insight/lineage/:canonId",
    {
      schema: {
        tags: ["insight"],
        description:
          "Trace a Canon entity back through raw triples to original source documents",
        params: {
          type: "object",
          properties: {
            canonId: {
              type: "string",
              description: "The canonId of the entity to trace",
            },
          },
          required: ["canonId"],
        },
        querystring: {
          type: "object",
          properties: {
            session: {
              type: "string",
              description: "Session ID to scope the query",
            },
          },
        },
      },
    },
    async (request, _reply) => {
      const { canonId } = request.params as { canonId: string };
      const { session } = (request.query as { session?: string }) ?? {};
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = session ?? ctx.sessionId;

      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      return buildLineage({ runner, sessionId, canonId });
    },
  );
}
