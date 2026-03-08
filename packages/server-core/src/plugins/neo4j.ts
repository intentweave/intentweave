// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import fp from "fastify-plugin";
import neo4j, { type Driver } from "neo4j-driver";
import type { FastifyInstance } from "fastify";

export interface Neo4jPluginOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

/**
 * Fastify plugin that creates a Neo4j driver and decorates the server instance.
 *
 * Access via `fastify.neo4j` in route handlers:
 * ```ts
 * fastify.get('/example', async (req, reply) => {
 *   const session = fastify.neo4j.session();
 *   try {
 *     const result = await session.run('MATCH (n) RETURN count(n) AS count');
 *     return { count: result.records[0].get('count').toInt() };
 *   } finally {
 *     await session.close();
 *   }
 * });
 * ```
 */
async function neo4jPluginFn(
  fastify: FastifyInstance,
  opts: Neo4jPluginOptions,
): Promise<void> {
  const driver: Driver = neo4j.driver(
    opts.uri,
    neo4j.auth.basic(opts.username, opts.password),
    {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30_000,
      connectionTimeout: 10_000,
    },
  );

  // Verify connectivity at startup
  try {
    await driver.verifyConnectivity();
    fastify.log.info(`Neo4j connected: ${opts.uri}`);
  } catch (err) {
    fastify.log.error({ err }, "Failed to connect to Neo4j");
    throw err;
  }

  // Decorate for access in routes
  fastify.decorate("neo4j", driver);

  // Also store the database name for session creation
  fastify.decorate("neo4jDatabase", opts.database ?? "neo4j");

  // Clean shutdown
  fastify.addHook("onClose", async () => {
    fastify.log.info("Closing Neo4j driver...");
    await driver.close();
  });
}

export const neo4jPlugin = fp(neo4jPluginFn, {
  name: "iw-neo4j",
  fastify: "5.x",
});
