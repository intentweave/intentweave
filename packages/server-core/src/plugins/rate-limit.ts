// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

export interface RateLimitPluginOptions {
  /** Max requests per minute per IP. 0 = disabled. */
  max?: number;
}

/**
 * Rate limiting plugin — limits /api/* requests per IP.
 * Uses in-memory store (suitable for single-instance deployments).
 */
async function rateLimitPluginFn(
  fastify: FastifyInstance,
  opts: RateLimitPluginOptions,
): Promise<void> {
  const max = opts.max ?? 0;
  if (!max || max <= 0) {
    fastify.log.debug("Rate limiting disabled (IW_RATE_LIMIT=0 or unset)");
    return;
  }

  await fastify.register(rateLimit, {
    max,
    timeWindow: "1 minute",
    // Only rate-limit /api/* routes (not /health, /docs, /stream)
    allowList: (req) => {
      const url = req.url ?? "";
      return !url.startsWith("/api/");
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded — ${context.max} requests per minute. Retry after ${Math.ceil((context.ttl ?? 60000) / 1000)}s.`,
    }),
  });

  fastify.log.info(`Rate limiting enabled: ${max} req/min per IP on /api/*`);
}

export const rateLimitPlugin = fp(rateLimitPluginFn, {
  name: "iw-rate-limit",
  fastify: "5.x",
});
