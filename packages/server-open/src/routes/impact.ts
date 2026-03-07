import type { FastifyInstance } from 'fastify';

/**
 * POST /api/impact — Semantic impact analysis.
 *
 * Given file paths, traverses CodeRef → Canon → CANON_REL to find:
 *   - Direct impact: which semantic concepts are realized by the file
 *   - Ripple impact: what depends on those concepts (N hops)
 *   - Risks: RISKS/BLOCKS predicates in the ripple zone
 *
 * Wraps the same logic as `iw impact` CLI command.
 */
export async function registerImpactRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/impact',
    {
      schema: {
        tags: ['impact'],
        description: 'Semantic impact analysis — what concepts are affected by changing a file',
        body: {
          type: 'object',
          required: ['files'],
          properties: {
            files: { type: 'array', items: { type: 'string' }, description: 'File paths to analyze' },
            session: { type: 'string', description: 'Session ID' },
            hops: { type: 'number', default: 2, description: 'Ripple analysis depth' },
            format: { type: 'string', enum: ['markdown', 'json'], default: 'json' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              directImpact: { type: 'array', items: { type: 'object' } },
              rippleImpact: { type: 'array', items: { type: 'object' } },
              risks: { type: 'array', items: { type: 'object' } },
              summary: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented — wiring to @intentweave/cli impact module' });
    },
  );
}
