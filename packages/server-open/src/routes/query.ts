// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import type { ServerConfig } from "@intentweave/server-core";
import {
  createRunnerFromDriver,
  createLlmComplete,
  buildCypherSystemPrompt,
  SUMMARISE_SYSTEM,
} from "../helpers/index.js";

/**
 * POST /api/query — Natural language or Cypher query against the knowledge graph.
 *
 * Body:
 *   { question?: string, cypher?: string, session?: string, limit?: number, format?: 'table' | 'json' }
 *
 * NL mode: LLM translates question → Cypher → execute → optional LLM summary.
 * Cypher mode: executes directly.
 */
export async function registerQueryRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const config: ServerConfig = (fastify as any).config;
  const llmComplete = createLlmComplete(config);

  fastify.post(
    "/api/query",
    {
      schema: {
        tags: ["query"],
        description:
          "Execute a natural language or Cypher query against the knowledge graph",
        body: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description:
                "Natural language question (LLM translates to Cypher)",
            },
            cypher: {
              type: "string",
              description: "Raw Cypher query (bypasses LLM)",
            },
            session: {
              type: "string",
              description: "Session ID to scope the query",
            },
            limit: {
              type: "integer",
              default: 25,
              description: "Maximum results to return",
            },
            summarize: {
              type: "boolean",
              default: true,
              description:
                "Whether to include an LLM-generated summary (NL mode only)",
            },
            format: {
              type: "string",
              enum: ["table", "json"],
              default: "json",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              cypher: {
                type: "string",
                description: "The Cypher query that was executed",
              },
              summary: {
                type: "string",
                description: "LLM-generated summary (NL mode only)",
              },
              count: { type: "number" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        question?: string;
        cypher?: string;
        session?: string;
        limit?: number;
        summarize?: boolean;
        format?: string;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = body.session ?? ctx.sessionId;
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );
      const limit = body.limit ?? 25;

      if (body.cypher) {
        // ── Direct Cypher mode ──────────────────────────────────────────
        const cypherQuery = ensureLimit(body.cypher, limit);
        const results = await runner.run(cypherQuery);
        return { results, cypher: cypherQuery, count: results.length };
      }

      if (body.question) {
        // ── Natural language mode ───────────────────────────────────────
        if (!llmComplete) {
          return (reply as any).status(501).send({
            error:
              "Natural language query requires LLM configuration. " +
              "Set OPENAI_API_KEY or use cypher mode.",
          });
        }

        // Step 1: NL → Cypher via LLM
        const systemPrompt = buildCypherSystemPrompt(sessionId);
        const userMsg = body.limit
          ? `${body.question}\n\nLimit results to ${limit}.`
          : body.question;

        let cypher: string;
        try {
          cypher = await llmComplete({
            system: systemPrompt,
            userMessage: userMsg,
          });
        } catch (err: any) {
          return (reply as any).status(502).send({
            error: `LLM translation failed: ${err.message}`,
          });
        }

        // Strip markdown fences if present
        cypher = cypher
          .replace(/^```(?:cypher)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        // Bail if LLM returned a comment (can't answer)
        if (cypher.startsWith("//")) {
          return {
            results: [],
            cypher,
            summary: cypher.replace(/^\/\/\s*/, ""),
            count: 0,
          };
        }

        cypher = ensureLimit(cypher, limit);

        // Step 2: Execute the generated Cypher
        let results: Record<string, unknown>[];
        try {
          results = await runner.run(cypher);
        } catch (err: any) {
          // Retry once with error context for self-correction
          fastify.log.warn(
            { err: err.message, cypher },
            "First Cypher attempt failed, retrying with error context",
          );
          try {
            const retryMsg = `${body.question}\n\nThe previous query failed with: ${err.message}\n\nPrevious query:\n${cypher}\n\nPlease fix the Cypher query.`;
            cypher = await llmComplete({
              system: systemPrompt,
              userMessage: retryMsg,
            });
            cypher = cypher
              .replace(/^```(?:cypher)?\s*/i, "")
              .replace(/\s*```$/i, "")
              .trim();
            cypher = ensureLimit(cypher, limit);
            results = await runner.run(cypher);
          } catch (retryErr: any) {
            return (reply as any).status(422).send({
              error: `Cypher execution failed after retry: ${retryErr.message}`,
              cypher,
            });
          }
        }

        // Step 3: Optional LLM summary
        let summary: string | undefined;
        if (body.summarize !== false && results.length > 0) {
          try {
            const summaryInput = `Question: ${body.question}\n\nResults (${results.length} rows):\n${JSON.stringify(results.slice(0, 50), null, 2)}`;
            summary = await llmComplete({
              system: SUMMARISE_SYSTEM,
              userMessage: summaryInput,
            });
          } catch {
            // Non-fatal — skip summary on error
            fastify.log.warn("LLM summary generation failed, skipping");
          }
        }

        return { results, cypher, summary, count: results.length };
      }

      return (reply as any).status(400).send({
        error: "Provide either question (NL) or cypher (raw Cypher query)",
      });
    },
  );
}

/** Append LIMIT if not already present */
function ensureLimit(cypher: string, limit: number): string {
  if (/\bLIMIT\b/i.test(cypher)) return cypher;
  return `${cypher.trimEnd()}\nLIMIT ${limit}`;
}
