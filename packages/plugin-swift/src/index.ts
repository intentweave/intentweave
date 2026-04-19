// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/plugin-swift
 *
 * Swift language plugin for IntentWeave. Provides AST extraction for
 * .swift files via tree-sitter-swift behind the IWPlugin interface so
 * the platform can discover and use Swift parsing without hard-coding
 * the dependency.
 *
 * Discovery: the default export is an IWPlugin instance that the
 * PluginRegistry picks up via `import("@intentweave/plugin-swift")`.
 */

import type {
  IWPlugin,
  LanguageCapability,
  Capability,
  PluginContext,
} from "@intentweave/core";
import { createSwiftAdapter } from "./adapter.js";

// Re-export for consumers that want direct access
export { createSwiftAdapter } from "./adapter.js";

// =============================================================================
// Plugin definition
// =============================================================================

const swiftPlugin: IWPlugin = {
  name: "swift",
  version: "0.8.0",
  description: "Swift language support via tree-sitter (AST extraction for .swift files)",
  capabilities: ["language"],

  getCapabilities(_context: PluginContext): Capability[] {
    const capability: LanguageCapability = {
      name: "language",
      extensions: [".swift"],
      languageName: "Swift",

      createAdapter(options) {
        return createSwiftAdapter(options);
      },
    };

    return [capability];
  },
};

export default swiftPlugin;
