// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

import { registerQueryRoutes } from "./routes/query.js";
import { registerContextRoutes } from "./routes/context.js";
import { registerEntitiesRoutes } from "./routes/entities.js";
import { registerSchemaRoutes } from "./routes/schema.js";
import { registerImpactRoutes } from "./routes/impact.js";
import { registerDocHealthRoutes } from "./routes/doc-health.js";
import { registerRunRoutes } from "./routes/run.js";
import { registerPersistRoutes } from "./routes/persist.js";
import { registerXlinkRoutes } from "./routes/xlink.js";
import { registerInsightRoutes } from "./routes/insight.js";
import { registerSessionRoutes } from "./routes/sessions.js";

/**
 * Open track plugin — registers all OSS API routes on the Fastify instance.
 *
 * Usage:
 * ```ts
 * import { createServer } from '@intentweave/server-core';
 * import { openPlugin } from '@intentweave/server-open';
 *
 * const server = await createServer(config);
 * await server.register(openPlugin);
 * await server.listen({ port: 3000 });
 * ```
 */
async function openPluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.log.info("Registering IntentWeave open track routes");

  // Each route module registers its own endpoints under /api/
  await registerQueryRoutes(fastify);
  await registerContextRoutes(fastify);
  await registerEntitiesRoutes(fastify);
  await registerSchemaRoutes(fastify);
  await registerImpactRoutes(fastify);
  await registerDocHealthRoutes(fastify);
  await registerRunRoutes(fastify);
  await registerPersistRoutes(fastify);
  await registerXlinkRoutes(fastify);
  await registerInsightRoutes(fastify);
  await registerSessionRoutes(fastify);

  fastify.log.info("Open track routes registered (11 endpoint groups)");
}

export const openPlugin = fp(openPluginFn, {
  name: "iw-open-track",
  fastify: "5.x",
  dependencies: ["iw-neo4j", "iw-context"],
});
