// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin Registry — Discovery, Registration & Capability Resolution
 *
 * Auto-discovers installed @intentweave/plugin-* packages via dynamic
 * import(). Manages plugin lifecycle and capability resolution so that
 * core features can request capabilities without knowing which plugin
 * provides them.
 *
 * @module pluginRegistry
 */

import type {
  IWPlugin,
  Capability,
  CapabilityName,
  PluginCommandHost,
  PluginMcpHost,
  PluginContext,
  LlmCapability,
  PersistenceCapability,
  LanguageCapability,
} from "./plugin.js";

// =============================================================================
// Known plugin package names for auto-discovery
// =============================================================================

/**
 * Plugin packages to attempt importing during discover().
 * Each entry maps to `@intentweave/plugin-<name>`.
 * Order matters: dependencies should come before dependents.
 */
const DISCOVERABLE_PLUGINS = [
  "llm",
  "kg",
  "kg-lite",
  "swift",
  "python",
  "go",
  "rust",
  "java",
  "github",
  "intent",
] as const;

// =============================================================================
// PluginRegistry
// =============================================================================

export class PluginRegistry {
  private readonly plugins = new Map<string, IWPlugin>();
  private readonly capabilities = new Map<string, Capability[]>();
  private _context: PluginContext | undefined;

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a plugin manually.
   *
   * Validates that all declared dependencies are already registered.
   * Throws if a dependency is missing or if a plugin with the same name
   * is already registered.
   */
  register(plugin: IWPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    // Check dependencies
    for (const dep of plugin.dependencies ?? []) {
      if (!this.plugins.has(dep)) {
        throw new Error(
          `Plugin "${plugin.name}" requires plugin "${dep}" which is not registered. ` +
            `Install it: iw plugin add ${dep}`,
        );
      }
    }

    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Auto-discover installed @intentweave/plugin-* packages.
   *
   * Attempts dynamic import() for each known plugin name. Silently
   * skips packages that are not installed. Plugins with unsatisfied
   * dependencies are skipped with a warning to stderr.
   *
   * @param importFn  Optional custom importer. Pass `(p) => import(p)` from
   *                  the calling module so that resolution uses the caller's
   *                  node_modules (important in pnpm workspaces where plugins
   *                  are optional deps of the CLI, not of core).
   */
  async discover(
    importFn?: (pkg: string) => Promise<any>,
  ): Promise<DiscoverResult> {
    const doImport = importFn ?? ((pkg: string) => import(pkg));
    const found: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const name of DISCOVERABLE_PLUGINS) {
      const pkg = `@intentweave/plugin-${name}`;
      try {
        const mod = await doImport(pkg);
        const plugin: IWPlugin | undefined = mod.default;

        if (!plugin?.name) {
          skipped.push({
            name,
            reason: `${pkg} has no default export with .name`,
          });
          continue;
        }

        try {
          this.register(plugin);
          found.push(name);
        } catch (err) {
          skipped.push({
            name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (importErr) {
        // Not installed — expected, skip silently
        if (process.env.IW_DEBUG_PLUGINS) {
          console.error(`  [plugin import error] ${pkg}:`, importErr);
        }
      }
    }

    return { found, skipped };
  }

  // ---------------------------------------------------------------------------
  // Capability Resolution (11.2)
  // ---------------------------------------------------------------------------

  /**
   * Resolve capabilities from all registered plugins.
   *
   * Call this after discover() / register() and before requesting
   * capabilities. Requires a PluginContext.
   */
  resolveCapabilities(context: PluginContext): void {
    this._context = context;
    this.capabilities.clear();

    for (const plugin of this.plugins.values()) {
      const caps = plugin.getCapabilities?.(context) ?? [];
      for (const cap of caps) {
        const existing = this.capabilities.get(cap.name) ?? [];
        existing.push(cap);
        this.capabilities.set(cap.name, existing);
      }
    }
  }

  /**
   * Get the first capability matching a name.
   *
   * Returns undefined if no plugin provides the requested capability.
   * Use the type parameter to narrow to a specific capability interface.
   *
   * @example
   * ```typescript
   * const llm = registry.getCapability<LlmCapability>("llm");
   * if (!llm) {
   *   console.error("No LLM provider. Run: iw plugin add llm");
   *   return;
   * }
   * const result = await llm.provider.complete({ ... });
   * ```
   */
  getCapability<T extends Capability>(name: CapabilityName): T | undefined {
    const caps = this.capabilities.get(name);
    return caps?.[0] as T | undefined;
  }

  /**
   * Get all capabilities matching a name.
   *
   * Useful for language capabilities where multiple plugins may each
   * provide extractors for different file extensions.
   */
  getAllCapabilities<T extends Capability>(name: CapabilityName): T[] {
    return (this.capabilities.get(name) ?? []) as T[];
  }

  /**
   * Check whether a capability is available.
   */
  hasCapability(name: CapabilityName): boolean {
    const caps = this.capabilities.get(name);
    return caps !== undefined && caps.length > 0;
  }

  /**
   * Require a capability or throw with a user-friendly message.
   */
  requireCapability<T extends Capability>(
    name: CapabilityName,
    hint?: string,
  ): T {
    const cap = this.getCapability<T>(name);
    if (!cap) {
      const install = hint ?? `iw plugin add ${name}`;
      throw new Error(
        `No "${name}" capability available. Install a provider: ${install}`,
      );
    }
    return cap;
  }

  // ---------------------------------------------------------------------------
  // Command & MCP Registration
  // ---------------------------------------------------------------------------

  /**
   * Register CLI commands from all discovered plugins.
   */
  registerAllCommands(host: PluginCommandHost, context: PluginContext): void {
    for (const plugin of this.plugins.values()) {
      plugin.registerCommands?.(host, context);
    }
  }

  /**
   * Register MCP tools from all discovered plugins.
   */
  registerAllMcpTools(host: PluginMcpHost, context: PluginContext): void {
    for (const plugin of this.plugins.values()) {
      plugin.registerMcpTools?.(host, context);
    }
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /** Get a plugin by name. */
  get(name: string): IWPlugin | undefined {
    return this.plugins.get(name);
  }

  /** List all registered plugins. */
  list(): IWPlugin[] {
    return [...this.plugins.values()];
  }

  /** Number of registered plugins. */
  get size(): number {
    return this.plugins.size;
  }

  /** List all available capability names. */
  listCapabilities(): CapabilityName[] {
    return [...this.capabilities.keys()] as CapabilityName[];
  }

  /** Get a summary suitable for `iw plugin list` output. */
  summary(): PluginSummary[] {
    return this.list().map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      capabilities: p.capabilities ?? [],
      dependencies: p.dependencies ?? [],
    }));
  }
}

// =============================================================================
// Result Types
// =============================================================================

export interface DiscoverResult {
  /** Plugin names that were found and successfully registered. */
  found: string[];
  /** Plugin names that were found but could not be registered. */
  skipped: Array<{ name: string; reason: string }>;
}

export interface PluginSummary {
  name: string;
  version: string;
  description: string;
  capabilities: CapabilityName[];
  dependencies: string[];
}

// =============================================================================
// Singleton convenience
// =============================================================================

let _globalRegistry: PluginRegistry | undefined;

/**
 * Get or create the global plugin registry singleton.
 *
 * CLI and MCP server entry points use this to share a single registry.
 */
export function getPluginRegistry(): PluginRegistry {
  if (!_globalRegistry) {
    _globalRegistry = new PluginRegistry();
  }
  return _globalRegistry;
}

/**
 * Replace the global plugin registry (useful for testing).
 */
export function setPluginRegistry(registry: PluginRegistry): void {
  _globalRegistry = registry;
}
