// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * IntentWeave Server — OSS Edition
 *
 * Composes @intentweave/server-core (Fastify + Neo4j + middleware)
 * with @intentweave/server-open (open track routes).
 *
 * Configuration via environment variables:
 *   NEO4J_URI       — Neo4j bolt URI          (default: bolt://localhost:7687)
 *   NEO4J_USERNAME  — Neo4j username           (default: neo4j)
 *   NEO4J_PASSWORD  — Neo4j password           (required)
 *   NEO4J_DATABASE  — Neo4j database           (default: neo4j)
 *   IW_SESSION      — Default session ID       (default: default)
 *   IW_WORKSPACE_ROOT — Workspace root directory (enables run/persist endpoints)
 *   OPENAI_API_KEY  — OpenAI API key          (enables NL query + topic context)
 *   IW_LLM_MODEL    — LLM model name          (default: gpt-4o-mini)
 *   PORT            — Server port              (default: 3000)
 *   HOST            — Server host              (default: 0.0.0.0)
 *   LOG_LEVEL       — Log level                (default: info)
 *   CORS_ORIGIN     — CORS origin(s), comma-separated (default: *)
 */

import "dotenv/config";
import { createServer } from "@intentweave/server-core";
import { openPlugin } from "@intentweave/server-open";

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  const server = await createServer({
    neo4j: {
      uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
      username: process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "",
      database: process.env.NEO4J_DATABASE ?? "neo4j",
    },
    defaultSession: process.env.IW_SESSION ?? "default",
    workspaceRoot: process.env.IW_WORKSPACE_ROOT,
    llm: process.env.OPENAI_API_KEY
      ? {
          provider: "openai" as const,
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.IW_LLM_MODEL ?? "gpt-4o-mini",
        }
      : undefined,
    host,
    port,
    logLevel: (process.env.LOG_LEVEL as any) ?? "info",
    corsOrigin: process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? "*",
  });

  // Register open track routes (OSS)
  await server.register(openPlugin);

  // Start listening
  try {
    await server.listen({ port, host });
    console.log(
      `\n  🧠 IntentWeave server listening on http://${host}:${port}`,
    );
    console.log(`  📖 API docs:   http://localhost:${port}/docs`);
    console.log(`  ❤️  Health:     http://localhost:${port}/health`);
    console.log(`  📡 SSE stream: http://localhost:${port}/stream\n`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
