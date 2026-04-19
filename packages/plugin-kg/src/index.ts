// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/plugin-kg
 *
 * Neo4j KG persistence plugin for IntentWeave. Provides a production-grade
 * `PersistenceCapability` backed by Neo4j. Install via `iw plugin add kg`
 * for full graph database support.
 *
 * Discovery: the default export is an IWPlugin instance that the PluginRegistry
 * picks up via `import("@intentweave/plugin-kg")`.
 */

import type {
  IWPlugin,
  PersistenceCapability,
  Capability,
  PluginContext,
} from "@intentweave/core";
import { KgBackend, type Neo4jConfig, type PersistData } from "./backend.js";

export { KgBackend, type Neo4jConfig } from "./backend.js";

// =============================================================================
// Plugin definition
// =============================================================================

const kgPlugin: IWPlugin = {
  name: "kg",
  version: "0.8.0",
  description: "Neo4j KG persistence — production graph database backend",
  capabilities: ["persistence"],

  getCapabilities(_context: PluginContext): Capability[] {
    // Defer creation — the backend validates config and connects lazily.
    // Env vars are read at first use, not at resolve time, so CLI commands
    // can set process.env.NEO4J_URI from --neo4j-uri before the first query.
    let backend: KgBackend | undefined;

    function getBackend(): KgBackend {
      if (!backend) {
        const config: Neo4jConfig = {
          uri: process.env.NEO4J_URI,
          user: process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME,
          password: process.env.NEO4J_PASSWORD,
        };
        backend = new KgBackend(config);
      }
      return backend;
    }

    const capability: PersistenceCapability = {
      name: "persistence",

      async persist(data) {
        return getBackend().persist(data as PersistData);
      },

      async query(cypher, params) {
        return getBackend().query(cypher, params);
      },

      async close() {
        if (backend) {
          await backend.close();
        }
      },
    };

    return [capability];
  },
};

export default kgPlugin;
