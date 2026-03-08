// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export interface AuthPluginOptions {
  /** Valid API keys. Empty or undefined = auth disabled. */
  apiKeys?: string[];
}

/**
 * Bearer-token auth plugin for /api/* routes.
 *
 * When configured, every request to /api/* must include:
 *   Authorization: Bearer <api-key>
 *
 * Non-API routes (/health, /docs, /stream) are always public.
 * When no keys are configured, all routes are public.
 */
async function authPluginFn(
  fastify: FastifyInstance,
  opts: AuthPluginOptions,
): Promise<void> {
  const keys = opts.apiKeys?.filter(Boolean);
  if (!keys || keys.length === 0) {
    fastify.log.debug("API key auth disabled (IW_API_KEYS unset)");
    return;
  }

  const keySet = new Set(keys);

  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url ?? "";

      // Only protect /api/* routes
      if (!url.startsWith("/api/")) return;

      const authHeader = request.headers.authorization;
      if (!authHeader) {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message:
            "Missing Authorization header. Use: Authorization: Bearer <api-key>",
        });
      }

      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer") {
        return reply.status(401).send({
          statusCode: 401,
          error: "Unauthorized",
          message: "Invalid Authorization header format. Use: Bearer <api-key>",
        });
      }

      if (!keySet.has(parts[1])) {
        return reply.status(403).send({
          statusCode: 403,
          error: "Forbidden",
          message: "Invalid API key",
        });
      }
    },
  );

  fastify.log.info(
    `API key auth enabled for /api/* routes (${keys.length} key${keys.length > 1 ? "s" : ""} configured)`,
  );
}

export const authPlugin = fp(authPluginFn, {
  name: "iw-auth",
  fastify: "5.x",
});
