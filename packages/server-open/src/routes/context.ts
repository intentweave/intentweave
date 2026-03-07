import type { FastifyInstance } from 'fastify';
import type { Driver } from 'neo4j-driver';
import {
  buildTopicContext,
  buildEntityContext,
  buildFullContext,
  enrichWithDescriptions,
  enrichWithCodeRefs,
  formatContextMarkdown,
  formatContextJson,
} from '@intentweave/cli/context';
import { createRunnerFromDriver } from '../helpers/index.js';

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
            hops: { type: 'integer', default: 2, description: 'Hops for neighborhood expansion' },
            limit: { type: 'integer', default: 50, description: 'Maximum entities to return' },
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
    async (request, reply) => {
      const body = request.body as {
        topic?: string; entity?: string; all?: boolean;
        session?: string; hops?: number; limit?: number; format?: string;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = body.session ?? ctx.sessionId;
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(driver, (fastify as any).neo4jDatabase);

      const opts = {
        runner,
        sessionId,
        hops: body.hops ?? 2,
        limit: body.limit ?? 50,
        includeCodeRefs: true,
        log: (msg: string) => fastify.log.debug(msg),
      };

      let bundle;
      if (body.entity) {
        bundle = await buildEntityContext(body.entity, opts);
      } else if (body.all) {
        bundle = await buildFullContext(opts);
      } else if (body.topic) {
        // Topic mode requires an LLM — return 400 if not available
        // For now, return an error. Server-side LLM integration will be added later.
        return (reply as any).status(400).send({
          error: 'Topic-based context requires an LLM provider. Use entity or all mode, or add LLM config.',
        });
      } else {
        return (reply as any).status(400).send({
          error: 'Provide one of: topic, entity, or all=true',
        });
      }

      // Enrich with descriptions and code refs
      await enrichWithDescriptions(runner, sessionId, bundle.entities);
      await enrichWithCodeRefs(runner, sessionId, bundle.entities);

      const formatted = body.format === 'markdown'
        ? formatContextMarkdown(bundle, {})
        : formatContextJson(bundle);

      return {
        context: formatted,
        entities: bundle.stats.totalEntities,
        relationships: bundle.stats.totalRelationships,
      };
    },
  );
}
