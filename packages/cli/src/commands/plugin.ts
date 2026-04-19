// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw plugin — Plugin lifecycle management.
 *
 * Subcommands:
 *   iw plugin list              Show installed plugins + capabilities
 *   iw plugin add <name>        Install a plugin
 *   iw plugin remove <name>     Uninstall a plugin
 *   iw plugin info <name>       Show plugin details
 */

import { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { getPluginRegistry } from "@intentweave/core";

export const pluginCommand = new Command("plugin")
  .description("Manage IntentWeave plugins");

// ─── iw plugin list ──────────────────────────────────────────────────────────

pluginCommand
  .command("list")
  .alias("ls")
  .description("List installed plugins and their capabilities")
  .action(async () => {
    const registry = getPluginRegistry();

    // Discover plugins (in case not already discovered)
    await registry.discover((pkg) => import(pkg));

    const plugins = registry.summary();

    if (plugins.length === 0) {
      console.log(chalk.dim("No plugins installed."));
      console.log(
        chalk.dim("\nAvailable plugins:"),
      );
      console.log(chalk.dim("  iw plugin add kg      — Knowledge graph extraction + Neo4j"));
      console.log(chalk.dim("  iw plugin add llm     — LLM provider for --explain / --provider"));
      console.log(chalk.dim("  iw plugin add python  — Python AST extraction"));
      console.log(chalk.dim("  iw plugin add swift   — Swift AST extraction"));
      return;
    }

    // Header
    console.log(
      chalk.bold(
        padRight("Plugin", 16) +
          padRight("Version", 10) +
          padRight("Capabilities", 22) +
          "Description",
      ),
    );
    console.log(
      chalk.dim(
        "─".repeat(16) +
          "─".repeat(10) +
          "─".repeat(22) +
          "─".repeat(30),
      ),
    );

    for (const p of plugins) {
      const caps =
        p.capabilities.length > 0
          ? p.capabilities.join(", ")
          : chalk.dim("—");
      console.log(
        padRight(p.name, 16) +
          padRight(p.version, 10) +
          padRight(caps, 22) +
          p.description,
      );
    }

    console.log(
      chalk.dim(`\n${plugins.length} plugin(s) installed.`),
    );
  });

// ─── iw plugin add <name> ────────────────────────────────────────────────────

pluginCommand
  .command("add <name>")
  .description("Install a plugin (e.g., iw plugin add kg)")
  .option("-g, --global", "Install globally (default)", true)
  .action(async (name: string) => {
    const pkg = resolvePackageName(name);

    console.log(chalk.blue(`Installing ${pkg}…`));
    try {
      execSync(`npm install -g ${pkg}`, { stdio: "inherit" });
      console.log(chalk.green(`✓ ${pkg} installed.`));

      // Verify it works
      const registry = getPluginRegistry();
      await registry.discover((pkg) => import(pkg));
      const plugin = registry.get(name);
      if (plugin) {
        console.log(
          chalk.green(
            `✓ Plugin "${plugin.name}" v${plugin.version} registered.`,
          ),
        );
        if (plugin.capabilities?.length) {
          console.log(
            chalk.dim(`  Capabilities: ${plugin.capabilities.join(", ")}`),
          );
        }
      }
    } catch {
      console.error(chalk.red(`Failed to install ${pkg}.`));
      console.error(
        chalk.dim("Check that the package exists: npm info " + pkg),
      );
      process.exit(1);
    }
  });

// ─── iw plugin remove <name> ────────────────────────────────────────────────

pluginCommand
  .command("remove <name>")
  .alias("rm")
  .description("Uninstall a plugin")
  .action(async (name: string) => {
    const pkg = resolvePackageName(name);

    console.log(chalk.blue(`Removing ${pkg}…`));
    try {
      execSync(`npm uninstall -g ${pkg}`, { stdio: "inherit" });
      console.log(chalk.green(`✓ ${pkg} removed.`));
    } catch {
      console.error(chalk.red(`Failed to remove ${pkg}.`));
      process.exit(1);
    }
  });

// ─── iw plugin info <name> ──────────────────────────────────────────────────

pluginCommand
  .command("info <name>")
  .description("Show details about an installed plugin")
  .action(async (name: string) => {
    const registry = getPluginRegistry();
    await registry.discover((pkg) => import(pkg));

    const plugin = registry.get(name);
    if (!plugin) {
      console.error(
        chalk.red(
          `Plugin "${name}" is not installed. Install it: iw plugin add ${name}`,
        ),
      );
      process.exit(1);
    }

    console.log(chalk.bold("Plugin:      ") + plugin.name);
    console.log(chalk.bold("Version:     ") + plugin.version);
    console.log(chalk.bold("Description: ") + plugin.description);
    console.log(
      chalk.bold("Capabilities: ") +
        (plugin.capabilities?.length
          ? plugin.capabilities.join(", ")
          : chalk.dim("none")),
    );
    console.log(
      chalk.bold("Dependencies: ") +
        (plugin.dependencies?.length
          ? plugin.dependencies.join(", ")
          : chalk.dim("none")),
    );

    // Show what commands/tools it provides
    const provides: string[] = [];
    if (plugin.registerCommands) provides.push("CLI commands");
    if (plugin.registerMcpTools) provides.push("MCP tools");
    if (plugin.getApi) provides.push("Library API");
    if (plugin.getCapabilities) provides.push("Capabilities");
    console.log(
      chalk.bold("Provides:    ") +
        (provides.length ? provides.join(", ") : chalk.dim("none")),
    );
  });

// =============================================================================
// Helpers
// =============================================================================

function resolvePackageName(name: string): string {
  // Allow both "kg" and "@intentweave/plugin-kg"
  if (name.startsWith("@intentweave/")) return name;
  return `@intentweave/plugin-${name}`;
}

function padRight(str: string, len: number): string {
  // Strip ANSI codes for length calculation
  const plainLen = str.replace(/\x1b\[[0-9;]*m/g, "").length;
  if (plainLen >= len) return str + " ";
  return str + " ".repeat(len - plainLen);
}
