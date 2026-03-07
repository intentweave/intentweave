import type { FastifyInstance } from 'fastify';

/**
 * POST /api/xlink — Cross-layer code linking.
 *
 * Connects semantic KG entities to source code using 4 strategies:
 *   - dep: package.json dependency matching
 *   - import: TypeScript/JavaScript import matching
 *   - name: Exported symbol name matching
 *   - path: File/directory path matching
 *
 * Creates CodeRef nodes and REALIZED_BY relationships.
 * Wraps the same logic as `iw xlink` CLI command.
 */
export async function registerXlinkRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/xlink',
    {
      schema: {
        tags: ['xlink'],
        description: 'Cross-layer code linking — connect semantic KG to source code',
        body: {
          type: 'object',
          required: ['directory'],
          properties: {
            directory: { type: 'string', description: 'Root directory of the codebase to link' },
            session: { type: 'string', description: 'Session ID' },
            strategies: {
              type: 'array',
              items: { type: 'string', enum: ['dep', 'import', 'name', 'path'] },
              default: ['dep', 'import', 'name', 'path'],
              description: 'Matching strategies to use',
            },
            persist: { type: 'boolean', default: false, description: 'Write CodeRef nodes to Neo4j' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              matched: { type: 'number' },
              total: { type: 'number' },
              codeRefs: { type: 'number' },
              realizedBy: { type: 'number' },
              byStrategy: { type: 'object' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return (reply as any).status(501).send({ error: 'Not yet implemented — wiring to @intentweave/cli xlink module' });
    },
  );
}
