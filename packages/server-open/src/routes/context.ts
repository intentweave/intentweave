// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import type { ServerConfig } from "@intentweave/server-core";
import {
  buildTopicContext,
  buildEntityContext,
  buildFullContext,
  enrichWithDescriptions,
  enrichWithCodeRefs,
  formatContextMarkdown,
  formatContextJson,
} from "@intentweave/cli/context";
import { createRunnerFromDriver, createLlmComplete } from "../helpers/index.js";

/**
 * POST /api/context — Build RAG context from the knowledge graph.
 *
 * Supports three retrieval modes:
 *   - topic: NL topic → LLM picks relevant entities → expand neighborhood
 *   - entity: Seed from named entity → expand N hops
 *   - all: Dump entire session
 *
 * Wraps the same logic as `iw context` CLI command.
 */
export async function registerContextRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const config: ServerConfig = (fastify as any).config;
  const llmComplete = createLlmComplete(config);

  fastify.post(
    "/api/context",
    {
      schema: {
        tags: ["context"],
        description: "Build RAG context from the knowledge graph",
        body: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "Natural language topic for semantic retrieval",
            },
            entity: {
              type: "string",
              description: "Seed entity name for neighborhood expansion",
            },
            all: {
              type: "boolean",
              default: false,
              description: "Dump all entities in session",
            },
            session: { type: "string", description: "Session ID" },
            hops: {
              type: "integer",
              default: 2,
              description: "Hops for neighborhood expansion",
            },
            limit: {
              type: "integer",
              default: 50,
              description: "Maximum entities to return",
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
              context: {
                type: "string",
                description: "Formatted context (markdown or JSON string)",
              },
              entities: {
                type: "number",
                description: "Number of entities included",
              },
              relationships: {
                type: "number",
                description: "Number of relationships included",
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        topic?: string;
        entity?: string;
        all?: boolean;
        session?: string;
        hops?: number;
        limit?: number;
        format?: string;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = body.session ?? ctx.sessionId;
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      const opts = {
        runner,
        sessionId,
        hops: body.hops ?? 2,
        limit: body.limit ?? 50,
        includeCodeRefs: true,
        log: (msg: string) => fastify.log.debug(msg),
      };

      let bundle;
      if (body.entity) {
        bundle = await buildEntityContext(body.entity, opts);
      } else if (body.all) {
        bundle = await buildFullContext(opts);
      } else if (body.topic) {
        // Topic mode requires LLM to pick relevant seed entities
        if (!llmComplete) {
          return (reply as any).status(501).send({
            error:
              "Topic-based context requires LLM configuration. " +
              "Set OPENAI_API_KEY or use entity/all mode.",
          });
        }

        // Create LLMCompleter (the function shape buildTopicContext expects)
        const llm = async (llmOpts: {
          system: string;
          userMessage: string;
        }): Promise<string> => {
          return llmComplete(llmOpts);
        };

        bundle = await buildTopicContext(body.topic, { ...opts, llm });
      } else {
        return (reply as any).status(400).send({
          error: "Provide one of: topic, entity, or all=true",
        });
      }

      // Enrich with descriptions and code refs
      await enrichWithDescriptions(runner, sessionId, bundle.entities);
      await enrichWithCodeRefs(runner, sessionId, bundle.entities);

      const formatted =
        body.format === "markdown"
          ? formatContextMarkdown(bundle, {})
          : formatContextJson(bundle);

      return {
        context: formatted,
        entities: bundle.stats.totalEntities,
        relationships: bundle.stats.totalRelationships,
      };
    },
  );
}
