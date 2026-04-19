// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Graph Runner — Shared persistence abstraction for CLI commands.
 *
 * Resolves a PersistenceCapability from the PluginRegistry and wraps it
 * as a Neo4jRunner. CLI commands that previously used direct neo4j-driver
 * imports now call getPersistence() or createGraphRunner() instead.
 *
 * Supports both plugin-kg (Neo4j) and plugin-kg-lite (SQLite/CypherLite).
 *
 * @module persistence/graphRunner
 */

import {
  getPluginRegistry,
  type PersistenceCapability,
} from "@intentweave/core";
import type { Neo4jRunner } from "../context/contextBuilder.js";

// =============================================================================
// Types
// =============================================================================

/** Driver-like interface returned by createGraphDriver / createDriverAdapter. */
export type GraphDriver = ReturnType<typeof createDriverAdapter>;

// =============================================================================
// Persistence resolution
// =============================================================================

/**
 * Get the PersistenceCapability from the plugin registry.
 *
 * Throws a user-friendly error if no persistence plugin is installed.
 */
export function getPersistence(): PersistenceCapability {
  const registry = getPluginRegistry();
  const cap = registry.getCapability<PersistenceCapability>("persistence");
  if (!cap) {
    throw new Error(
      "No persistence plugin available.\n" +
        "Install one:\n" +
        "  npm install -D @intentweave/plugin-kg       # Neo4j backend\n" +
        "  npm install -D @intentweave/plugin-kg-lite   # SQLite backend (zero-config)\n",
    );
  }
  return cap;
}

/**
 * Check whether a persistence capability is available without throwing.
 */
export function hasPersistence(): boolean {
  try {
    const registry = getPluginRegistry();
    return registry.hasCapability("persistence");
  } catch {
    return false;
  }
}

// =============================================================================
// Neo4jRunner adapter
// =============================================================================

/**
 * Create a Neo4jRunner from the persistence capability.
 *
 * This adapter lets existing code (contextBuilder, impactAnalyzer,
 * docHealthAnalyzer, crossLayerLinker) work unchanged — they accept
 * a Neo4jRunner and don't care whether queries go to Neo4j or SQLite.
 */
export function createGraphRunner(): Neo4jRunner {
  const persistence = getPersistence();
  return {
    async run(cypher: string, params?: Record<string, unknown>) {
      return persistence.query(cypher, params) as Promise<
        Record<string, unknown>[]
      >;
    },
  };
}

/**
 * Create a Neo4jRunner from an explicit PersistenceCapability.
 *
 * Use this when you already have the capability (e.g. in MCP server
 * where you want to cache the reference).
 */
export function runnerFromCapability(cap: PersistenceCapability): Neo4jRunner {
  return {
    async run(cypher: string, params?: Record<string, unknown>) {
      return cap.query(cypher, params) as Promise<
        Record<string, unknown>[]
      >;
    },
  };
}

// =============================================================================
// Driver adapter (for persist modules that use driver.session().run())
// =============================================================================

/**
 * Create a driver-like adapter from PersistenceCapability.
 *
 * Persistence modules (persistKwg, persistTcg, persistDrift, etc.) accept
 * a Neo4j `Driver` and call `driver.session().run(cypher, params)`.
 * This adapter delegates those calls to `PersistenceCapability.query()`,
 * eliminating direct neo4j-driver imports.
 *
 * The returned object exposes `.session()` → `.run()` / `.close()` and
 * `.verifyConnectivity()` / `.close()` as no-ops (the plugin manages lifecycle).
 */
export function createGraphDriver() {
  const persistence = getPersistence();
  return createDriverAdapter(persistence);
}

/** @internal — wrap primitive values so .toNumber()/.toString() work like Neo4j records */
function wrapValue(val: unknown): unknown {
  if (typeof val === "number" || typeof val === "bigint") {
    return { toNumber: () => Number(val), toInt: () => Number(val), valueOf: () => Number(val), toString: () => String(val) };
  }
  return val;
}

/** @internal */
export function createDriverAdapter(persistence: {
  query(cypher: string, params?: Record<string, unknown>): Promise<unknown[]>;
}) {
  return {
    session() {
      return {
        async run(cypher: string, params?: Record<string, unknown>) {
          const rows = (await persistence.query(
            cypher,
            params,
          )) as Record<string, unknown>[];
          return {
            records: rows.map((row) => ({
              keys: Object.keys(row),
              get(key: string): any {
                return wrapValue(row[key]);
              },
            })),
            summary: {
              counters: {
                updates() {
                  return {
                    nodesCreated: 0,
                    nodesDeleted: 0,
                    relationshipsCreated: 0,
                    relationshipsDeleted: 0,
                    propertiesSet: 0,
                  };
                },
              },
            },
          };
        },
        async close() {
          /* no-op — plugin manages session lifecycle */
        },
      };
    },
    async verifyConnectivity() {
      /* no-op — plugin handles connectivity */
    },
    async close() {
      /* no-op — plugin manages driver lifecycle */
    },
  };
}
