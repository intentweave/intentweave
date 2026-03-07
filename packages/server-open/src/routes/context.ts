import type { FastifyInstance } from 'fastify';

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
export async function registerContextRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/context',
    {
      schema: {
        tags: ['context'],
        description: 'Build RAG context from the knowledge graph',
        body: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Natural language topic for semantic retrieval' },
            entity: { type: 'string', description: 'Seed entity name for neighborhood expansion' },
            all: { type: 'boolean', default: false, description: 'Dump all entities in session' },
            session: { type: 'string', description: 'Session ID' },
            hops: { type: 'number', default: 2, description: 'Hops for neighborhood expansion' },
            limit: { type: 'number', default: 50, description: 'Maximum entities to return' },
            format: { type: 'string', enum: ['markdown', 'json'], default: 'json' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              context: { type: 'string', description: 'Formatted context (markdown or JSON string)' },
              entities: { type: 'number', description: 'Number of entities included' },
              relationships: { type: 'number', description: 'Number of relationships included' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented — wiring to @intentweave/cli context module' });
    },
  );
}
