// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from 'fastify';

/**
 * POST /api/run — Execute the extraction pipeline.
 *
 * Supports:
 *   - open track: IN → FX → KX → GX (schema-free knowledge extraction)
 *   - Incremental caching (skip unchanged files)
 *   - Progress streaming via SSE
 *
 * This is a long-running operation. The response includes a run ID;
 * progress can be followed via GET /stream with SSE.
 *
 * Wraps the same logic as `iw run` CLI command.
 */
export async function registerRunRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/run',
    {
      schema: {
        tags: ['pipeline'],
        description: 'Execute the extraction pipeline on files',
        body: {
          type: 'object',
          required: ['files'],
          properties: {
            files: { type: 'array', items: { type: 'string' }, description: 'File paths or glob patterns' },
            track: { type: 'string', enum: ['open', 'main', 'both'], default: 'open' },
            provider: { type: 'string', enum: ['smart-mock', 'openai'], default: 'smart-mock' },
            model: { type: 'string', description: 'LLM model name (e.g., gpt-4o-mini)' },
            incremental: { type: 'boolean', default: true, description: 'Enable incremental caching' },
            concurrency: { type: 'number', default: 5 },
            persist: { type: 'boolean', default: false, description: 'Persist results to Neo4j after run' },
            session: { type: 'string', description: 'Session ID' },
            profile: { type: 'string', description: 'Extraction profile name' },
            force: { type: 'boolean', default: false, description: 'Force recomputation (ignore cache)' },
          },
        },
        response: {
          202: {
            type: 'object',
            properties: {
              runId: { type: 'string' },
              status: { type: 'string' },
              artifactCount: { type: 'number' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      // Pipeline execution requires LLM provider config, file system access,
      // and async run management (SSE progress, run storage).
      // This will be wired once server-side LLM and workspace integration is ready.
      return (reply as any).status(501).send({
        error: 'Pipeline execution endpoint requires LLM + workspace configuration. Use `iw run` CLI for now.',
      });
    },
  );

  // GET /api/runs/:runId — Check status of a pipeline run
  fastify.get(
    '/api/runs/:runId',
    {
      schema: {
        tags: ['pipeline'],
        description: 'Get the status and results of a pipeline run',
        params: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
          },
        },
      },
    },
    async (_request, reply) => {
      return (reply as any).status(501).send({ error: 'Not yet implemented' });
    },
  );
}
