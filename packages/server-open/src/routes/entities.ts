import type { FastifyInstance } from 'fastify';

/**
 * GET /api/entities — List or search canon entities in the knowledge graph.
 *
 * Wraps the same logic as `kg_entities` MCP tool.
 */
export async function registerEntitiesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/entities',
    {
      schema: {
        tags: ['entities'],
        description: 'List or search canonical entities',
        querystring: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Filter by entity type (e.g., component, decision, technology)' },
            search: { type: 'string', description: 'Search by name (case-insensitive contains)' },
            session: { type: 'string', description: 'Session ID' },
            limit: { type: 'number', default: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              entities: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string' },
                    aliases: { type: 'array', items: { type: 'string' } },
                    confidence: { type: 'number' },
                    relationshipCount: { type: 'number' },
                  },
                },
              },
              total: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented — wiring to entity query logic' });
    },
  );
}
