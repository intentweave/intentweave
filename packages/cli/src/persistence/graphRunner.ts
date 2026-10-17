// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Graph Runner — query access to the installed persistence plugin.
 *
 * Resolves the PersistenceCapability from the PluginRegistry and exposes it as a
 * GraphRunner: `run(cypher, params)` returns rows. The runner is backend-neutral;
 * plugin-kg-lite (SQLite, zero config) provides the capability.
 *
 * @module persistence/graphRunner
 */

import {
  getPluginRegistry,
  type PersistenceCapability,
} from "@intentweave/core";
import type { GraphRunner } from "../context/contextBuilder.js";

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
// GraphRunner adapter
// =============================================================================

/**
 * Create a GraphRunner from the persistence capability.
 *
 * Lets the context builder and the MCP graph tools run queries without knowing
 * which backend stores the graph.
 */
export function createGraphRunner(): GraphRunner {
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
 * Create a GraphRunner from an explicit PersistenceCapability.
 *
 * Use this when you already have the capability (e.g. in MCP server
 * where you want to cache the reference).
 */
export function runnerFromCapability(cap: PersistenceCapability): GraphRunner {
  return {
    async run(cypher: string, params?: Record<string, unknown>) {
      return cap.query(cypher, params) as Promise<Record<string, unknown>[]>;
    },
  };
}
