// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from 'fastify';
import { CANONICAL_PREDICATES } from '@intentweave/core/predicates';
import { ENTITY_TYPES } from '@intentweave/core/types';

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
    async () => {
      return {
        nodeLabels: ['Canon', 'Entity', 'RawTriple', 'Session', 'CodeRef'],
        relationshipTypes: ['CANON_REL', 'CANONICALIZED_FROM', 'CONTAINS', 'REALIZED_BY'],
        canonicalPredicates: Object.values(CANONICAL_PREDICATES),
        entityTypes: [...ENTITY_TYPES],
      };
    },
  );
}
