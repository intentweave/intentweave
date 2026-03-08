// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RequestContext } from "../types.js";

export interface ContextPluginOptions {
  defaultSession?: string;
}

/**
 * Extracts session/workspace context from request headers.
 *
 * Headers:
 *   x-session-id   → ctx.sessionId  (falls back to defaultSession)
 *   x-workspace-id → ctx.workspaceId
 *   x-trace-id     → ctx.traceId    (auto-generated if missing)
 *
 * Access via `request.ctx` in route handlers.
 */
async function contextPluginFn(
  fastify: FastifyInstance,
  opts: ContextPluginOptions,
): Promise<void> {
  // Decorate request with ctx
  fastify.decorateRequest("ctx", null);

  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    const headers = request.headers;

    const ctx: RequestContext = {
      sessionId:
        (headers["x-session-id"] as string) ?? opts.defaultSession ?? "default",
      workspaceId: (headers["x-workspace-id"] as string) ?? undefined,
      traceId: (headers["x-trace-id"] as string) ?? crypto.randomUUID(),
    };

    (request as FastifyRequest & { ctx: RequestContext }).ctx = ctx;
  });
}

export const contextPlugin = fp(contextPluginFn, {
  name: "iw-context",
  fastify: "5.x",
});
