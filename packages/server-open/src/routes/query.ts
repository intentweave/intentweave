// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from 'fastify';
import type { Driver } from 'neo4j-driver';
import { createRunnerFromDriver } from '../helpers/index.js';

/**
 * POST /api/query — Natural language or Cypher query against the knowledge graph.
 *
 * Body:
 *   { question?: string, cypher?: string, session?: string, limit?: number, format?: 'table' | 'json' }
 *
 * Wraps the same logic as `iw query` CLI command.
 */
export async function registerQueryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/query',
    {
      schema: {
        tags: ['query'],
        description: 'Execute a natural language or Cypher query against the knowledge graph',
        body: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Natural language question (LLM translates to Cypher)' },
            cypher: { type: 'string', description: 'Raw Cypher query (bypasses LLM)' },
            session: { type: 'string', description: 'Session ID to scope the query' },
            limit: { type: 'integer', default: 25, description: 'Maximum results to return' },
            format: { type: 'string', enum: ['table', 'json'], default: 'json' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              results: { type: 'array', items: { type: 'object', additionalProperties: true } },
              cypher: { type: 'string', description: 'The Cypher query that was executed' },
              summary: { type: 'string', description: 'LLM-generated summary (NL mode only)' },
              count: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        question?: string; cypher?: string; session?: string; limit?: number; format?: string;
      };
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(driver, (fastify as any).neo4jDatabase);

      if (body.cypher) {
        // Direct Cypher mode
        const cypherQuery = body.limit
          ? ensureLimit(body.cypher, body.limit)
          : body.cypher;

        const results = await runner.run(cypherQuery);
        return {
          results,
          cypher: cypherQuery,
          count: results.length,
        };
      }

      if (body.question) {
        // NL mode — requires LLM provider (not yet integrated in server)
        return (reply as any).status(501).send({
          error: 'Natural language query requires LLM integration. Use cypher mode or the iw CLI.',
        });
      }

      return (reply as any).status(400).send({
        error: 'Provide either question (NL) or cypher (raw Cypher query)',
      });
    },
  );
}

/** Append LIMIT if not already present */
function ensureLimit(cypher: string, limit: number): string {
  if (/\bLIMIT\b/i.test(cypher)) return cypher;
  return `${cypher.trimEnd()}\nLIMIT ${limit}`;
}
