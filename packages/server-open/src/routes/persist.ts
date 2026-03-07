import type { FastifyInstance } from 'fastify';

/**
 * POST /api/persist — Write KX results to Neo4j.
 *
 * Supports delta mode (diff-only) and full mode.
 * Wraps the same logic as `iw persist` CLI command.
 */
export async function registerPersistRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/persist',
    {
      schema: {
        tags: ['pipeline'],
        description: 'Persist extraction results to Neo4j',
        body: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: 'Run ID to persist (or use latest)' },
            latest: { type: 'boolean', default: false, description: 'Persist the latest run' },
            session: { type: 'string', description: 'Session ID' },
            mode: { type: 'string', enum: ['delta', 'full'], default: 'delta' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              entitiesPersisted: { type: 'number' },
              relationshipsPersisted: { type: 'number' },
              mode: { type: 'string' },
              duration: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented — wiring to @intentweave/cli persist module' });
    },
  );
}
