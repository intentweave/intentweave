import type { FastifyInstance } from 'fastify';

/**
 * GET /api/schema — Describe the knowledge graph schema.
 *
 * Returns node labels, relationship types, canonical predicates, and entity types.
 */
export async function registerSchemaRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/schema',
    {
      schema: {
        tags: ['query'],
        description: 'Describe the knowledge graph schema — node labels, relationship types, predicates',
        response: {
          200: {
            type: 'object',
            properties: {
              nodeLabels: { type: 'array', items: { type: 'string' } },
              relationshipTypes: { type: 'array', items: { type: 'string' } },
              canonicalPredicates: { type: 'array', items: { type: 'string' } },
              entityTypes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented — wiring to kg_schema logic' });
    },
  );
}
