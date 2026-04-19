// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/plugin-kg-lite
 *
 * Lightweight KG persistence plugin for IntentWeave. Uses CypherLite + SQLite
 * to provide a zero-config `PersistenceCapability` backend. Ships with the CLI
 * by default — no external database required.
 *
 * Discovery: the default export is an IWPlugin instance that the PluginRegistry
 * picks up via `import("@intentweave/plugin-kg-lite")`.
 */

import type {
  IWPlugin,
  PersistenceCapability,
  Capability,
  PluginContext,
} from "@intentweave/core";
import { KgLiteBackend, type PersistData } from "./backend.js";

export { KgLiteBackend } from "./backend.js";

// =============================================================================
// Plugin definition
// =============================================================================

const kgLitePlugin: IWPlugin = {
  name: "kg-lite",
  version: "0.8.0",
  description:
    "Lightweight KG persistence — SQLite backend via CypherLite (zero config)",
  capabilities: ["persistence"],

  getCapabilities(context: PluginContext): Capability[] {
    const dbPath = process.env.IW_KG_DB ?? `${context.workspaceRoot}/.iw/kg.db`;

    const backend = new KgLiteBackend(dbPath);

    const capability: PersistenceCapability = {
      name: "persistence",

      async persist(data) {
        return backend.persist(data as PersistData);
      },

      async query(cypher, params) {
        return backend.query(cypher, params);
      },

      async close() {
        backend.close();
      },
    };

    return [capability];
  },
};

export default kgLitePlugin;
