// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { neo4jPlugin } from "./plugins/neo4j.js";
import { contextPlugin } from "./plugins/context.js";
import { healthPlugin } from "./plugins/health.js";
import { ssePlugin } from "./plugins/sse.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { authPlugin } from "./plugins/auth.js";
import type { ServerConfig, IwServer } from "./types.js";

const VERSION = "1.0.0";

/**
 * Create a configured Fastify server with IntentWeave core plugins.
 *
 * Usage:
 * ```ts
 * import { createServer } from '@intentweave/server-core';
 * import { openPlugin } from '@intentweave/server-open';
 *
 * const server = await createServer({
 *   neo4j: { uri: 'bolt://localhost:7687', username: 'neo4j', password: 'pw' },
 *   defaultSession: 'my-project',
 * });
 *
 * await server.register(openPlugin);
 * await server.listen({ port: 3000 });
 * ```
 */
export async function createServer(config: ServerConfig): Promise<IwServer> {
  const server = Fastify({
    logger: {
      level: config.logLevel ?? "info",
    },
  }) as unknown as IwServer;

  // Store config on the instance
  server.decorate("config", config);

  // -- CORS --
  if (config.cors !== false) {
    await server.register(fastifyCors, {
      origin: config.corsOrigin ?? "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-session-id",
        "x-workspace-id",
        "x-trace-id",
      ],
      credentials: true,
    });
  }

  // -- OpenAPI / Swagger --
  if (config.swagger !== false) {
    await server.register(fastifySwagger, {
      openapi: {
        info: {
          title: "IntentWeave API",
          description:
            "Semantic knowledge extraction platform — build queryable knowledge graphs from documents and code",
          version: VERSION,
        },
        tags: [
          { name: "health", description: "Health and readiness endpoints" },
          {
            name: "pipeline",
            description: "Pipeline execution (run, persist)",
          },
          { name: "query", description: "Knowledge graph queries" },
          { name: "context", description: "RAG context retrieval" },
          { name: "entities", description: "Entity listing and search" },
          { name: "impact", description: "Semantic impact analysis" },
          { name: "doc-health", description: "Documentation health analysis" },
          { name: "xlink", description: "Cross-layer code linking" },
          { name: "sessions", description: "Session management" },
          { name: "schema", description: "Knowledge graph schema" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description: "API key — set via apiKeys in ServerConfig",
            },
          },
        },
      },
    });

    await server.register(fastifySwaggerUi, {
      routePrefix: "/docs",
    });
  }

  // -- Core plugins --
  await server.register(neo4jPlugin, {
    uri: config.neo4j.uri,
    username: config.neo4j.username,
    password: config.neo4j.password,
    database: config.neo4j.database,
  });

  await server.register(contextPlugin, {
    defaultSession: config.defaultSession,
  });

  await server.register(healthPlugin);
  await server.register(ssePlugin);

  // -- x-api-version header on all responses --
  server.addHook("onSend", async (_req, reply) => {
    reply.header("x-api-version", VERSION);
  });

  // -- Rate limiting --
  await server.register(rateLimitPlugin, {
    max: config.rateLimit,
  });

  // -- API key auth --
  await server.register(authPlugin, {
    apiKeys: config.apiKeys,
  });

  return server;
}
