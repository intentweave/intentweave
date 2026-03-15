// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import { createRunnerFromDriver } from "../helpers/index.js";

/**
 * GET /api/sessions — List available sessions across all graph layers.
 *
 * Returns sessions from Canon:Entity (open track), KWEntity (doc-health KWG),
 * and SCG nodes, with per-layer node counts.
 */
export async function registerSessionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/api/sessions",
    {
      schema: {
        tags: ["sessions"],
        description:
          "List available sessions across Canon (open track) and KWG (doc-health) layers",
        response: {
          200: {
            type: "object",
            properties: {
              sessions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    canonCount: { type: "number" },
                    kwgCount: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      // Query Canon:Entity sessions
      const canonRows = await runner.run(`
        MATCH (n:Canon:Entity)
        WHERE n.session_id IS NOT NULL
        RETURN n.session_id AS sid, count(n) AS cnt
      `);

      // Query KWEntity sessions
      const kwRows = await runner.run(`
        MATCH (n:KWEntity)
        WHERE n.session_id IS NOT NULL
        RETURN n.session_id AS sid, count(n) AS cnt
      `);

      // Merge into a unified map
      const map = new Map<
        string,
        { id: string; canonCount: number; kwgCount: number }
      >();

      for (const r of canonRows) {
        const sid = r.sid as string;
        const existing = map.get(sid) ?? {
          id: sid,
          canonCount: 0,
          kwgCount: 0,
        };
        existing.canonCount = r.cnt as number;
        map.set(sid, existing);
      }

      for (const r of kwRows) {
        const sid = r.sid as string;
        const existing = map.get(sid) ?? {
          id: sid,
          canonCount: 0,
          kwgCount: 0,
        };
        existing.kwgCount = r.cnt as number;
        map.set(sid, existing);
      }

      const sessions = [...map.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      );

      return { sessions };
    },
  );
}
