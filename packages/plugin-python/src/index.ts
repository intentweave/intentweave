// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/plugin-python
 *
 * Python language plugin for IntentWeave. Provides AST extraction for
 * .py files via tree-sitter-python behind the IWPlugin interface so
 * the platform can discover and use Python parsing without hard-coding
 * the dependency.
 *
 * Discovery: the default export is an IWPlugin instance that the
 * PluginRegistry picks up via `import("@intentweave/plugin-python")`.
 */

import type {
  IWPlugin,
  LanguageCapability,
  Capability,
  PluginContext,
} from "@intentweave/core";
import { createPythonAdapter } from "./adapter.js";

// Re-export for consumers that want direct access
export { createPythonAdapter } from "./adapter.js";

// =============================================================================
// Plugin definition
// =============================================================================

const pythonPlugin: IWPlugin = {
  name: "python",
  version: "0.8.0",
  description:
    "Python language support via tree-sitter (AST extraction for .py files)",
  capabilities: ["language"],

  getCapabilities(_context: PluginContext): Capability[] {
    const capability: LanguageCapability = {
      name: "language",
      extensions: [".py"],
      languageName: "Python",

      createAdapter(options) {
        return createPythonAdapter(options);
      },
    };

    return [capability];
  },
};

export default pythonPlugin;
