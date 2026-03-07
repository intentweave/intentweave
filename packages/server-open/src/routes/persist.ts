// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

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
      // Persist requires reading KX results from disk (.iw/runs/<runId>/).
      // Server-side integration needs a workspace root path and run locator.
      // This will be wired once the iw run server-side workflow is implemented.
      return (reply as any).status(501).send({
        error: 'Persist endpoint requires server-side run storage. Use `iw persist` CLI for now.',
      });
    },
  );
}
