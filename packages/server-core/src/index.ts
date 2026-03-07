// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/server-core
 *
 * Fastify-based server foundation for IntentWeave.
 * Provides: Neo4j connection pool, session/workspace context,
 * health checks, SSE hub, OpenAPI generation, and a plugin
 * registration system for composing OSS + Pro features.
 */

export { createServer } from './app.js';
export type { ServerConfig, IwServer, IwServerPlugin } from './types.js';
export { neo4jPlugin } from './plugins/neo4j.js';
export { contextPlugin } from './plugins/context.js';
export { healthPlugin } from './plugins/health.js';
export { ssePlugin, type SseHub } from './plugins/sse.js';
