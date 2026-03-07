import type { FastifyInstance } from 'fastify';

/**
 * POST /api/doc-health — Documentation freshness analysis.
 *
 * Checks for:
 *   - Stale: entity DECIDED_AGAINST or SUPERSEDED since extraction
 *   - Drift: entity gained new relationships not in doc's triples
 *   - Temporal: file modified after extraction timestamp
 *   - Missing: canon entities with no doc provenance
 *
 * Wraps the same logic as `iw doc-health` CLI command.
 */
export async function registerDocHealthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/doc-health',
    {
      schema: {
        tags: ['doc-health'],
        description: 'Analyze documentation freshness — detect stale, drifted, and contradicted docs',
        body: {
          type: 'object',
          properties: {
            files: { type: 'array', items: { type: 'string' }, description: 'Specific files to check (or omit for all)' },
            session: { type: 'string', description: 'Session ID' },
            format: { type: 'string', enum: ['markdown', 'json'], default: 'json' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              reports: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    file: { type: 'string' },
                    status: { type: 'string', enum: ['fresh', 'warning', 'rotten'] },
                    score: { type: 'number' },
                    issues: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
              summary: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return (reply as any).status(501).send({ error: 'Not yet implemented — wiring to @intentweave/cli doc-health module' });
    },
  );
}
