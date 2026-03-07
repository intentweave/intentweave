import type { FastifyInstance } from 'fastify';

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
            limit: { type: 'number', default: 25, description: 'Maximum results to return' },
            format: { type: 'string', enum: ['table', 'json'], default: 'json' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              results: { type: 'array', items: { type: 'object' } },
              cypher: { type: 'string', description: 'The Cypher query that was executed' },
              summary: { type: 'string', description: 'LLM-generated summary (NL mode only)' },
              count: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      // TODO: Wire to @intentweave/cli query module
      // const { question, cypher, session, limit, format } = request.body as any;
      // const ctx = (request as any).ctx;
      return (reply as any).status(501).send({ error: 'Not yet implemented — wiring to @intentweave/cli query module' });
    },
  );
}
