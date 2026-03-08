// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import type { Driver } from "neo4j-driver";

/** Configuration for creating an IntentWeave server. */
export interface ServerConfig {
  /** Neo4j connection settings. */
  neo4j: {
    uri: string;
    username: string;
    password: string;
    database?: string;
  };

  /** Default session for queries (can be overridden per-request). */
  defaultSession?: string;

  /**
   * Workspace root directory (absolute path).
   * Used by pipeline and persist endpoints to access files and .iw/ data.
   * If not set, pipeline and persist endpoints return 400.
   */
  workspaceRoot?: string;

  /** Server host. Default: '0.0.0.0' */
  host?: string;

  /** Server port. Default: 3000 */
  port?: number;

  /** Enable OpenAPI/Swagger UI at /docs. Default: true */
  swagger?: boolean;

  /** Enable CORS. Default: true */
  cors?: boolean;

  /** CORS origin(s). Default: '*' */
  corsOrigin?: string | string[];

  /** Log level. Default: 'info' */
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

/** Request context extracted from headers or defaults. */
export interface RequestContext {
  sessionId: string;
  workspaceId?: string;
  traceId?: string;
}

/**
 * Extended Fastify instance with IntentWeave decorators.
 * Plugins can access neo4j driver, config, SSE hub via these.
 */
export interface IwServer extends FastifyInstance {
  neo4j: Driver;
  config: ServerConfig;
}

/**
 * Plugin interface for extending the server.
 * Both server-open (OSS) and server-pro (proprietary) implement this.
 */
export interface IwServerPlugin {
  /** Unique plugin name. */
  name: string;

  /** Plugin version. */
  version: string;

  /**
   * Register routes and hooks on the Fastify instance.
   * Called during server setup — the neo4j decorator is already available.
   */
  register: (server: IwServer) => Promise<void>;
}
