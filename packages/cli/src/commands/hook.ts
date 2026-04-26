// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * iw hook — Git hooks integration for CARI index maintenance.
 *
 * Subcommands:
 *   iw hook install    Install post-commit and post-checkout hooks
 *   iw hook uninstall  Remove the hooks installed by iw
 *   iw hook status     Show whether the hooks are installed
 *
 * The hooks run `iw index update` automatically so the CARI index
 * stays current after every commit and branch switch — without requiring
 * manual `iw index build` calls.
 */

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import chalk from "chalk";

// ── Constants ────────────────────────────────────────────────────────────────

const IW_MARKER = "# managed-by-intentweave";

const HOOK_BODY = `${IW_MARKER}
# Run 'iw hook uninstall' to remove this hook.
if command -v iw >/dev/null 2>&1; then
  iw index update
elif [ -f "$(git rev-parse --show-toplevel)/iw.sh" ]; then
  "$(git rev-parse --show-toplevel)/iw.sh" index update
fi
`;

const HOOK_NAMES = ["post-commit", "post-checkout"] as const;
type HookName = (typeof HOOK_NAMES)[number];

// ── Utilities ────────────────────────────────────────────────────────────────

/** Resolve the .git/hooks directory for the current repo. */
async function resolveHooksDir(cwd: string): Promise<string> {
  // Support worktrees and custom core.hooksPath
  try {
    const { execSync } = await import("node:child_process");
    const result = execSync("git rev-parse --git-path hooks", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return path.resolve(cwd, result);
  } catch {
    // Fallback: standard .git/hooks
    return path.join(cwd, ".git", "hooks");
  }
}

/** Check whether a hook file contains the IW marker. */
function isIwHook(content: string): boolean {
  return content.includes(IW_MARKER);
}

interface HookStatus {
  name: HookName;
  path: string;
  exists: boolean;
  hasIwSection: boolean;
  otherContent: boolean;
}

async function getHookStatus(
  hooksDir: string,
  name: HookName,
): Promise<HookStatus> {
  const hookPath = path.join(hooksDir, name);
  if (!fsSync.existsSync(hookPath)) {
    return {
      name,
      path: hookPath,
      exists: false,
      hasIwSection: false,
      otherContent: false,
    };
  }
  const content = await fs.readFile(hookPath, "utf-8");
  const hasIw = isIwHook(content);
  // "other content" = file has non-shebang, non-iw lines
  const lines = content
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#!") && !l.includes(IW_MARKER));
  const otherContent = lines.some((l) => !HOOK_BODY.includes(l));
  return {
    name,
    path: hookPath,
    exists: true,
    hasIwSection: hasIw,
    otherContent,
  };
}

// ── install ──────────────────────────────────────────────────────────────────

const installCmd = new Command("install")
  .description(
    "Install post-commit and post-checkout git hooks that run iw index update",
  )
  .option(
    "--hooks-dir <path>",
    "Override the hooks directory (default: auto-detect from git config)",
  )
  .option("-v, --verbose", "Verbose output")
  .action(async (opts: { hooksDir?: string; verbose?: boolean }) => {
    const cwd = process.cwd();
    const hooksDir = opts.hooksDir ?? (await resolveHooksDir(cwd));
    const verbose = opts.verbose ?? false;

    if (!fsSync.existsSync(hooksDir)) {
      await fs.mkdir(hooksDir, { recursive: true });
      if (verbose) console.log(chalk.dim(`  Created ${hooksDir}`));
    }

    let installed = 0;
    let skipped = 0;

    for (const name of HOOK_NAMES) {
      const hookPath = path.join(hooksDir, name);
      const status = await getHookStatus(hooksDir, name);

      if (status.exists && status.hasIwSection) {
        console.log(chalk.yellow(`  ${name}: already installed — skipped`));
        skipped++;
        continue;
      }

      if (status.exists && status.otherContent) {
        // Append iw block to existing hook
        const existing = await fs.readFile(hookPath, "utf-8");
        const updated = existing.trimEnd() + "\n\n" + HOOK_BODY;
        await fs.writeFile(hookPath, updated, "utf-8");
        // Ensure executable
        await fs.chmod(hookPath, 0o755);
        console.log(chalk.cyan(`  ${name}: appended to existing hook`));
      } else {
        // Write fresh hook with shebang
        await fs.writeFile(hookPath, "#!/bin/sh\n" + HOOK_BODY, "utf-8");
        await fs.chmod(hookPath, 0o755);
        console.log(chalk.green(`  ${name}: installed`));
      }
      installed++;
    }

    if (verbose) {
      console.log(chalk.dim(`  Hooks dir: ${hooksDir}`));
    }

    console.log(
      `\n${chalk.bold("Done.")} ${installed} hook(s) installed, ${skipped} skipped.`,
    );
    console.log(
      chalk.dim(
        "  Run 'iw hook uninstall' to remove, 'iw hook status' to check.",
      ),
    );
  });

// ── uninstall ────────────────────────────────────────────────────────────────

const uninstallCmd = new Command("uninstall")
  .description("Remove the git hooks installed by iw hook install")
  .option("--hooks-dir <path>", "Override the hooks directory")
  .option("-v, --verbose", "Verbose output")
  .action(async (opts: { hooksDir?: string; verbose?: boolean }) => {
    const cwd = process.cwd();
    const hooksDir = opts.hooksDir ?? (await resolveHooksDir(cwd));
    const verbose = opts.verbose ?? false;

    let removed = 0;

    for (const name of HOOK_NAMES) {
      const hookPath = path.join(hooksDir, name);
      const status = await getHookStatus(hooksDir, name);

      if (!status.exists || !status.hasIwSection) {
        if (verbose)
          console.log(chalk.dim(`  ${name}: no iw section — skipped`));
        continue;
      }

      const content = await fs.readFile(hookPath, "utf-8");

      // Strip the iw block — everything from the marker line to end of block
      const stripped = stripIwBlock(content);

      if (!stripped.trim() || stripped.trim() === "#!/bin/sh") {
        // Hook is now empty — delete it
        await fs.rm(hookPath);
        console.log(chalk.green(`  ${name}: removed`));
      } else {
        // Keep the rest
        await fs.writeFile(hookPath, stripped, "utf-8");
        await fs.chmod(hookPath, 0o755);
        console.log(chalk.cyan(`  ${name}: iw section removed, rest kept`));
      }
      removed++;
    }

    console.log(`\n${chalk.bold("Done.")} ${removed} hook(s) updated.`);
  });

/** Remove the IW marker block from hook content. */
function stripIwBlock(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.includes(IW_MARKER)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      // End of block: hit a blank line after consuming all iw lines
      if (!HOOK_BODY.includes(line) && line.trim() !== "") {
        inBlock = false;
        out.push(line);
      }
      // else: part of the iw block — skip
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// ── status ───────────────────────────────────────────────────────────────────

const statusCmd = new Command("status")
  .description("Show whether the iw git hooks are installed")
  .option("--hooks-dir <path>", "Override the hooks directory")
  .action(async (opts: { hooksDir?: string }) => {
    const cwd = process.cwd();
    const hooksDir = opts.hooksDir ?? (await resolveHooksDir(cwd));

    console.log(chalk.bold("  iw hook status"));
    console.log(chalk.dim(`  Hooks dir: ${hooksDir}\n`));

    for (const name of HOOK_NAMES) {
      const status = await getHookStatus(hooksDir, name);

      if (!status.exists) {
        console.log(`  ${chalk.dim(name)}: ${chalk.dim("not installed")}`);
      } else if (status.hasIwSection) {
        const extra = status.otherContent ? chalk.dim(" (+ other hooks)") : "";
        console.log(
          `  ${chalk.green(name)}: ${chalk.green("installed")}${extra}`,
        );
      } else {
        console.log(
          `  ${chalk.yellow(name)}: ${chalk.yellow("hook exists but iw section not found")}`,
        );
      }
    }
    console.log();
  });

// ── root command ─────────────────────────────────────────────────────────────

export const hookCommand = new Command("hook")
  .description(
    "Manage git hooks that auto-update the CARI index on commit/checkout",
  )
  .addHelpText(
    "after",
    `
Examples:
  iw hook install               Install post-commit + post-checkout hooks
  iw hook install --verbose     Same with verbose output
  iw hook uninstall             Remove iw-managed hook sections
  iw hook status                Check installation status
`,
  )
  .addCommand(installCmd)
  .addCommand(uninstallCmd)
  .addCommand(statusCmd);
