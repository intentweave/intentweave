// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";
import { createRunnerFromDriver } from "../helpers/index.js";

/**
 * GET /api/entities — List or search canon entities in the knowledge graph.
 *
 * Wraps the same logic as `kg_entities` MCP tool.
 */
export async function registerEntitiesRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/api/entities",
    {
      schema: {
        tags: ["entities"],
        description: "List or search canonical entities",
        querystring: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description:
                "Filter by entity type (e.g., component, decision, technology)",
            },
            search: {
              type: "string",
              description: "Search by name (case-insensitive contains)",
            },
            session: { type: "string", description: "Session ID" },
            limit: { type: "integer", default: 50 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              entities: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    aliases: { type: "array", items: { type: "string" } },
                    confidence: { type: "number" },
                    relationshipCount: { type: "number" },
                  },
                },
              },
              total: { type: "number" },
            },
          },
        },
      },
    },
    async (request) => {
      const {
        type,
        search,
        session,
        limit = 50,
      } = request.query as {
        type?: string;
        search?: string;
        session?: string;
        limit?: number;
      };
      const ctx = (request as any).ctx as { sessionId: string };
      const sessionId = session ?? ctx.sessionId;
      const driver: Driver = (fastify as any).neo4j;
      const runner = createRunnerFromDriver(
        driver,
        (fastify as any).neo4jDatabase,
      );

      // Build Cypher dynamically
      const conditions: string[] = [];
      const params: Record<string, unknown> = { limit: Math.round(limit) };
      if (sessionId) {
        conditions.push("n.session_id = $sid");
        params.sid = sessionId;
      }
      if (type) {
        conditions.push("toLower(n.type) = toLower($type)");
        params.type = type;
      }
      if (search) {
        conditions.push("toLower(n.name) CONTAINS toLower($search)");
        params.search = search;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const cypher = `
        MATCH (n:Canon)
        ${where}
        OPTIONAL MATCH (n)-[r:CANON_REL]-()
        WITH n, count(r) AS relCount
        RETURN n.name AS name, n.type AS type, n.aliases AS aliases,
               n.confidence AS confidence, relCount AS relationshipCount
        ORDER BY relCount DESC
        LIMIT $limit
      `;

      const rows = await runner.run(cypher, params);
      return {
        entities: rows.map((r: any) => ({
          name: r.name,
          type: r.type,
          aliases: r.aliases ?? [],
          confidence: r.confidence ?? 1.0,
          relationshipCount: r.relationshipCount ?? 0,
        })),
        total: rows.length,
      };
    },
  );
}
