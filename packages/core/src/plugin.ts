// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin System — Types & Interfaces
 *
 * Defines the IWPlugin interface and capability contracts that plugins
 * implement. Core features consume capabilities without depending on
 * specific plugins.
 *
 * @module plugin
 */

// Re-export the existing LLMProvider so plugins can reference it
// without importing from interfaces.ts directly.
import type { LLMProvider } from "./interfaces.js";

// =============================================================================
// Capability Interfaces (11.2)
// =============================================================================

/**
 * Capability name constants.
 * Plugins declare which capabilities they provide; core features
 * request capabilities by name from the registry.
 */
export type CapabilityName = "llm" | "persistence" | "language";

/**
 * LLM Capability — generate text from a prompt.
 *
 * Thin wrapper that plugins supply. Core features (--explain, --provider,
 * layer naming) consume this without depending on openai or any LLM SDK.
 */
export interface LlmCapability {
  readonly name: "llm";

  /** The underlying LLMProvider instance. */
  readonly provider: LLMProvider;
}

/**
 * Persistence Capability — store and query entities in a graph database.
 *
 * Provided by the KG plugin. Core never imports neo4j-driver directly.
 */
export interface PersistenceCapability {
  readonly name: "persistence";

  /** Persist entities and relationships. */
  persist(data: {
    entities: unknown[];
    relationships: unknown[];
    session: string;
  }): Promise<{ entityCount: number; relationshipCount: number }>;

  /** Execute a Cypher query and return raw results. */
  query(cypher: string, params?: Record<string, unknown>): Promise<unknown[]>;

  /** Close the database connection. */
  close(): Promise<void>;
}

/**
 * Language Capability — provide AST extraction for additional languages.
 *
 * Provided by language parser plugins (swift, python, go, etc.).
 *
 * The `createAdapter` factory returns a `LanguageAdapter`-compatible object.
 * It uses loose typing here (returns `unknown`) so that core does not depend
 * on analyzer types — the consumer (`ax.ts`) casts to `LanguageAdapter`.
 */
export interface LanguageCapability {
  readonly name: "language";

  /** File extensions this extractor handles (e.g. [".py", ".pyi"]). */
  readonly extensions: string[];

  /** Human-readable language name (e.g. "Python"). */
  readonly languageName: string;

  /**
   * Factory that creates a language adapter for the AX stage.
   *
   * The returned object must satisfy the `LanguageAdapter` interface from
   * `@intentweave/analyzer` (i.e., have `extensions` and `processFile()`).
   * Typed as `unknown` to avoid core → analyzer dependency.
   */
  createAdapter(options: {
    workspaceRoot: string;
    includePrivate: boolean;
    includeMembers: boolean;
    maxDepth: number;
  }): unknown;
}

/** Union of all capability types. */
export type Capability =
  | LlmCapability
  | PersistenceCapability
  | LanguageCapability;

// =============================================================================
// Plugin Interface (11.1)
// =============================================================================

/**
 * Plugin registration context — passed to registerCommands().
 *
 * We use a minimal interface instead of importing Commander directly
 * so that @intentweave/core has zero dependency on commander.
 */
export interface PluginCommandHost {
  /**
   * Add a subcommand to the CLI program.
   * The command object must be a Commander Command instance.
   */
  addCommand(command: unknown): void;
}

/**
 * Plugin MCP context — passed to registerMcpTools().
 *
 * We use a minimal interface so @intentweave/core has zero dependency
 * on @modelcontextprotocol/sdk.
 */
export interface PluginMcpHost {
  /**
   * Register an MCP tool on the server.
   * Signature matches McpServer.tool().
   */
  tool(name: string, schema: unknown, handler: unknown): void;
}

/**
 * Context available to plugins during registration.
 */
export interface PluginContext {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;

  /** Path to the CARI index database (may not exist yet). */
  indexDbPath: string;

  /** Session identifier (for KG scoping). */
  session: string;

  /** Whether verbose/debug logging is enabled. */
  verbose: boolean;
}

/**
 * IWPlugin — the contract every IntentWeave plugin implements.
 *
 * A plugin is an npm package (@intentweave/plugin-<name>) whose default
 * export satisfies this interface. The PluginRegistry discovers installed
 * plugins via dynamic import() and calls lifecycle hooks.
 *
 * @example
 * ```typescript
 * // @intentweave/plugin-kg/src/index.ts
 * import type { IWPlugin } from "@intentweave/core";
 *
 * const plugin: IWPlugin = {
 *   name: "kg",
 *   version: "0.8.0",
 *   description: "Knowledge graph extraction and Neo4j persistence",
 *   capabilities: ["llm", "persistence"],
 *   registerCommands(host, ctx) { ... },
 *   registerMcpTools(host, ctx) { ... },
 * };
 * export default plugin;
 * ```
 */
export interface IWPlugin {
  /** Unique plugin name, e.g. "kg", "swift", "llm". */
  readonly name: string;

  /** Semver version string. */
  readonly version: string;

  /** One-line human-readable description. */
  readonly description: string;

  /** Other plugin names this plugin requires (checked at registration time). */
  readonly dependencies?: string[];

  /** Capability names this plugin provides. */
  readonly capabilities?: CapabilityName[];

  /** Register CLI subcommands onto the program. */
  registerCommands?(host: PluginCommandHost, context: PluginContext): void;

  /** Register MCP tools onto the MCP server. */
  registerMcpTools?(host: PluginMcpHost, context: PluginContext): void;

  /** Provide capability instances (called after registration). */
  getCapabilities?(context: PluginContext): Capability[];

  /** Expose library API extensions. */
  getApi?(): Record<string, unknown>;
}
