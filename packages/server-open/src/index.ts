// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/server-open
 *
 * Fastify plugin that registers all open-track API routes:
 *   POST /api/run         — Run extraction pipeline (IN→FX→KX→GX)
 *   POST /api/query       — Natural language or Cypher query
 *   POST /api/context     — RAG context retrieval
 *   GET  /api/entities    — List/search canon entities
 *   POST /api/persist     — Write KX results to Neo4j
 *   POST /api/impact      — Semantic impact analysis
 *   POST /api/doc-health  — Documentation freshness check
 *   POST /api/xlink       — Cross-layer code linking
 *   GET  /api/schema      — Graph schema description
 */

export { openPlugin } from "./plugin.js";
