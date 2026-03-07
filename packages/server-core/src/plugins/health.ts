// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/**
 * Health and readiness endpoints.
 *
 * GET /health   — always 200 (liveness)
 * GET /ready    — checks Neo4j connectivity (readiness)
 */
async function healthPluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        description: 'Liveness probe — always returns 200',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              uptime: { type: 'number' },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  );

  fastify.get(
    '/ready',
    {
      schema: {
        tags: ['health'],
        description: 'Readiness probe — checks Neo4j connectivity',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              neo4j: { type: 'string' },
            },
          },
          503: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              neo4j: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      try {
        const driver = (fastify as any).neo4j;
        if (!driver) {
          return reply.status(503).send({
            status: 'error',
            neo4j: 'not configured',
          });
        }
        await driver.verifyConnectivity();
        return { status: 'ok', neo4j: 'connected' };
      } catch (err: any) {
        return reply.status(503).send({
          status: 'error',
          neo4j: 'disconnected',
          error: err.message,
        });
      }
    },
  );
}

export const healthPlugin = fp(healthPluginFn, {
  name: 'iw-health',
  fastify: '5.x',
});
