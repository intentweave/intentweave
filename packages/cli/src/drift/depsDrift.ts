// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency Drift Detector (C3)
 *
 * Compares declared dependencies (package.json) against actual code imports
 * and doc mentions to detect:
 *
 *   1. **Unused dependency** — Declared in package.json but not imported.
 *   2. **Undeclared dependency** — Imported in code but not in package.json.
 *   3. **Version drift** — Doc mentions a different version than declared.
 *
 * v1 scope: npm/pnpm monorepos only. No Cargo.toml, go.mod, etc.
 * All non-LLM, $0. Pure function + filesystem reads.
 *
 * @see PHASE-C-SPEC.md §6
 * @version 0.1
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DriftSignal,
  DriftEvidence,
  DepsDriftInput,
  DepsDriftOutput,
  KwgEntityForDrift,
  KwgMentionForDrift,
} from "@intentweave/core";
import type { AxOutput } from "@intentweave/analyzer";

// =============================================================================
// Constants
// =============================================================================

/**
 * Known dev-only tools that don't need code imports.
 * These are excluded from the "unused dependency" check.
 */
const KNOWN_DEV_TOOLS = new Set([
  "typescript",
  "vitest",
  "jest",
  "@jest/globals",
  "eslint",
  "prettier",
  "tsx",
  "ts-node",
  "rimraf",
  "turbo",
  "lerna",
  "husky",
  "lint-staged",
  "concurrently",
  "cross-env",
  "nodemon",
  "ts-jest",
  "c8",
  "nyc",
  "@vitest/coverage-v8",
  "@vitest/coverage-istanbul",
  // Type declaration packages
  "@types/node",
  "@types/jest",
  "@types/mocha",
  "@types/chai",
  // Build tools
  "esbuild",
  "rollup",
  "webpack",
  "vite",
  "postcss",
  "tailwindcss",
  "autoprefixer",
  // Linting
  "@eslint/js",
  "eslint-config-prettier",
  "eslint-plugin-react",
  "eslint-plugin-react-hooks",
  "globals",
  "typescript-eslint",
]);

/**
 * Node.js builtin modules — imports of these are not external dependencies.
 */
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

// =============================================================================
// Types
// =============================================================================

interface PackageManifest {
  /** Path to the package.json */
  filePath: string;
  /** Package name */
  name: string;
  /** dependencies */
  dependencies: Record<string, string>;
  /** devDependencies */
  devDependencies: Record<string, string>;
  /** peerDependencies */
  peerDependencies: Record<string, string>;
}

// =============================================================================
// Main Detector
// =============================================================================

/**
 * Detect dependency drift from AX output + package.json + KWG mentions.
 */
export function detectDepsDrift(input: DepsDriftInput): DepsDriftOutput {
  const startTime = performance.now();
  const log = input.log ?? (() => {});
  const { workspaceRoot, kwgEntities, kwgMentions } = input;
  const axOutput = input.axOutput as AxOutput;

  const signals: DriftSignal[] = [];

  // ── 1. Load package.json manifests ─────────────────────────────────────
  log("Loading package.json manifests...");
  const manifests = findPackageManifests(workspaceRoot);
  log(`  → ${manifests.length} package.json file(s) found`);

  if (manifests.length === 0) {
    const durationMs = Math.round(performance.now() - startTime);
    log("  → No package.json found, skipping deps drift detection");
    return {
      signals: [],
      stats: {
        enabled: true,
        signalCount: 0,
        durationMs,
        metrics: { manifests: 0 },
      },
    };
  }

  // ── 2. Collect code imports from AX output ─────────────────────────────
  log("Collecting code imports from AX output...");
  const codeImports = collectCodeImports(axOutput, workspaceRoot);
  log(`  → ${codeImports.size} unique external packages imported`);

  // ── 3. Detect unused dependencies ──────────────────────────────────────
  log("Checking unused dependencies...");
  const unusedSignals = detectUnusedDeps(manifests, codeImports, log);
  signals.push(...unusedSignals);

  // ── 4. Detect undeclared dependencies ──────────────────────────────────
  log("Checking undeclared dependencies...");
  const undeclaredSignals = detectUndeclaredDeps(manifests, codeImports, log);
  signals.push(...undeclaredSignals);

  // ── 5. Detect version drift (doc vs manifest) ─────────────────────────
  if (kwgEntities && kwgMentions && kwgMentions.length > 0) {
    log("Checking version drift in docs...");
    const versionSignals = detectVersionDrift(
      manifests,
      kwgEntities,
      kwgMentions,
      log,
    );
    signals.push(...versionSignals);
  }

  const durationMs = Math.round(performance.now() - startTime);
  log(`Deps drift: ${signals.length} signals (${durationMs}ms)`);

  return {
    signals,
    stats: {
      enabled: true,
      signalCount: signals.length,
      durationMs,
      metrics: {
        manifests: manifests.length,
        totalDeclaredDeps: manifests.reduce(
          (sum, m) =>
            sum +
            Object.keys(m.dependencies).length +
            Object.keys(m.devDependencies).length,
          0,
        ),
        totalCodeImports: codeImports.size,
        unusedCount: unusedSignals.length,
        undeclaredCount: undeclaredSignals.length,
        versionDriftCount:
          signals.length - unusedSignals.length - undeclaredSignals.length,
      },
    },
  };
}

// =============================================================================
// Step 1: Find package.json manifests
// =============================================================================

function findPackageManifests(workspaceRoot: string): PackageManifest[] {
  const manifests: PackageManifest[] = [];

  // Root package.json
  const rootPkg = loadManifest(path.join(workspaceRoot, "package.json"));
  if (rootPkg) manifests.push(rootPkg);

  // packages/*/package.json (monorepo)
  const packagesDir = path.join(workspaceRoot, "packages");
  if (fs.existsSync(packagesDir)) {
    try {
      const dirs = fs.readdirSync(packagesDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const pkgPath = path.join(packagesDir, dir.name, "package.json");
        const manifest = loadManifest(pkgPath);
        if (manifest) manifests.push(manifest);
      }
    } catch {
      // Ignore read errors
    }
  }

  // apps/*/package.json (monorepo with apps/)
  const appsDir = path.join(workspaceRoot, "apps");
  if (fs.existsSync(appsDir)) {
    try {
      const dirs = fs.readdirSync(appsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const pkgPath = path.join(appsDir, dir.name, "package.json");
        const manifest = loadManifest(pkgPath);
        if (manifest) manifests.push(manifest);
      }
    } catch {
      // Ignore read errors
    }
  }

  return manifests;
}

function loadManifest(filePath: string): PackageManifest | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw);
    return {
      filePath,
      name: json.name ?? path.basename(path.dirname(filePath)),
      dependencies: json.dependencies ?? {},
      devDependencies: json.devDependencies ?? {},
      peerDependencies: json.peerDependencies ?? {},
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Step 2: Collect code imports from AX output
// =============================================================================

/**
 * Extract external package names from code files using AX output file paths
 * + simple regex import scanning.
 *
 * AX doesn't expose imports directly, so we read source files and extract
 * import specifiers with regex. This is fast and sufficient for v1.
 */
function collectCodeImports(
  axOutput: AxOutput,
  workspaceRoot: string,
): Map<string, Set<string>> {
  const packageImports = new Map<string, Set<string>>(); // packageName → set of importing file paths

  for (const file of axOutput.files) {
    const absPath = path.join(workspaceRoot, file.filePath);
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    // Match: import ... from "specifier" / require("specifier")
    const importRegex =
      /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;

      // Skip relative imports
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;

      // Resolve package name from specifier
      const pkgName = resolvePackageName(specifier);
      if (!pkgName) continue;

      // Skip Node.js builtins
      if (isNodeBuiltin(pkgName)) continue;

      if (!packageImports.has(pkgName)) packageImports.set(pkgName, new Set());
      packageImports.get(pkgName)!.add(file.filePath);
    }
  }

  return packageImports;
}

/**
 * Resolve package name from import specifier.
 * Handles scoped packages: `@scope/pkg/sub` → `@scope/pkg`
 * Handles normal: `lodash/fp` → `lodash`
 * Handles node: prefix: `node:fs` → builtin
 */
function resolvePackageName(specifier: string): string | null {
  // Strip node: prefix
  if (specifier.startsWith("node:")) return specifier.slice(5);

  // Scoped package: @scope/pkg or @scope/pkg/sub
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return null;
  }

  // Normal package: pkg or pkg/sub
  return specifier.split("/")[0];
}

function isNodeBuiltin(name: string): boolean {
  return NODE_BUILTINS.has(name);
}

// =============================================================================
// Step 3: Detect unused dependencies
// =============================================================================

function detectUnusedDeps(
  manifests: PackageManifest[],
  codeImports: Map<string, Set<string>>,
  log: (msg: string) => void,
): DriftSignal[] {
  const signals: DriftSignal[] = [];

  for (const manifest of manifests) {
    // Check production dependencies
    for (const [dep, version] of Object.entries(manifest.dependencies)) {
      if (codeImports.has(dep)) continue;
      // Skip workspace references (workspace:*)
      if (version.startsWith("workspace:")) continue;

      signals.push({
        category: "dep-unused",
        severity: "info",
        detector: "deps",
        message: `"${dep}" declared in ${path.basename(path.dirname(manifest.filePath))}/package.json but never imported`,
        name: dep,
        files: [manifest.filePath],
        evidence: {
          packageName: dep,
          declaredVersion: version,
        },
      });
    }

    // Check dev dependencies (excluding known tools)
    for (const [dep, version] of Object.entries(manifest.devDependencies)) {
      if (codeImports.has(dep)) continue;
      if (KNOWN_DEV_TOOLS.has(dep)) continue;
      if (dep.startsWith("@types/")) continue; // Type packages don't need imports
      if (version.startsWith("workspace:")) continue;

      signals.push({
        category: "dep-unused",
        severity: "info",
        detector: "deps",
        message: `Dev dep "${dep}" declared in ${path.basename(path.dirname(manifest.filePath))}/package.json but never imported`,
        name: dep,
        files: [manifest.filePath],
        evidence: {
          packageName: dep,
          declaredVersion: version,
        },
      });
    }
  }

  log(`  → ${signals.length} unused dependencies`);
  return signals;
}

// =============================================================================
// Step 4: Detect undeclared dependencies
// =============================================================================

function detectUndeclaredDeps(
  manifests: PackageManifest[],
  codeImports: Map<string, Set<string>>,
  log: (msg: string) => void,
): DriftSignal[] {
  const signals: DriftSignal[] = [];

  // Build a set of all declared packages across all manifests
  const allDeclared = new Set<string>();
  for (const manifest of manifests) {
    for (const dep of Object.keys(manifest.dependencies)) allDeclared.add(dep);
    for (const dep of Object.keys(manifest.devDependencies))
      allDeclared.add(dep);
    for (const dep of Object.keys(manifest.peerDependencies))
      allDeclared.add(dep);
  }

  for (const [pkg, importingFiles] of codeImports) {
    if (allDeclared.has(pkg)) continue;
    if (isNodeBuiltin(pkg)) continue;

    // Skip monorepo internal references (workspace packages)
    const isWorkspacePkg = manifests.some((m) => m.name === pkg);
    if (isWorkspacePkg) continue;

    signals.push({
      category: "dep-undeclared",
      severity: "warning",
      detector: "deps",
      message: `"${pkg}" imported in ${importingFiles.size} file(s) but not declared in any package.json`,
      name: pkg,
      files: [...importingFiles],
      evidence: {
        packageName: pkg,
        importPaths: [...importingFiles],
      },
    });
  }

  log(`  → ${signals.length} undeclared dependencies`);
  return signals;
}

// =============================================================================
// Step 5: Detect version drift (doc mentions vs package.json)
// =============================================================================

function detectVersionDrift(
  manifests: PackageManifest[],
  kwgEntities: KwgEntityForDrift[],
  kwgMentions: KwgMentionForDrift[],
  log: (msg: string) => void,
): DriftSignal[] {
  const signals: DriftSignal[] = [];

  // Build declared versions map
  const declaredVersions = new Map<string, { version: string; file: string }>();
  for (const manifest of manifests) {
    for (const [dep, version] of Object.entries(manifest.dependencies)) {
      declaredVersions.set(dep.toLowerCase(), {
        version,
        file: manifest.filePath,
      });
    }
    for (const [dep, version] of Object.entries(manifest.devDependencies)) {
      if (!declaredVersions.has(dep.toLowerCase())) {
        declaredVersions.set(dep.toLowerCase(), {
          version,
          file: manifest.filePath,
        });
      }
    }
  }

  // Version extraction regex: matches patterns like "v18", "version 2.0", "@18.2", "React 17"
  const versionRegex = /(?:v(?:ersion)?\s*|@)(\d+(?:\.\d+)*)/gi;

  // For each KWG mention, check if it references a dependency with a version
  for (const mention of kwgMentions) {
    const entityLower = mention.entityName.toLowerCase();
    const declared = declaredVersions.get(entityLower);
    if (!declared) continue;

    // Extract versions from mention text
    const versions: string[] = [];
    let vMatch: RegExpExecArray | null;
    versionRegex.lastIndex = 0;
    while ((vMatch = versionRegex.exec(mention.text)) !== null) {
      versions.push(vMatch[1]);
    }

    // Also try pattern: "<entity> <version>" e.g., "React 17", "Node 20"
    const entityVersionRegex = new RegExp(
      `\\b${entityLower}\\s+(\\d+(?:\\.\\d+)*)\\b`,
      "i",
    );
    const evMatch = mention.text.match(entityVersionRegex);
    if (evMatch) versions.push(evMatch[1]);

    if (versions.length === 0) continue;

    // Compare major versions
    const declaredMajor = extractMajorVersion(declared.version);
    if (declaredMajor === null) continue;

    for (const docVersion of versions) {
      const docMajor = parseInt(docVersion.split(".")[0], 10);
      if (isNaN(docMajor)) continue;

      if (docMajor !== declaredMajor) {
        const isMinorOnly =
          docVersion.includes(".") && docMajor === declaredMajor;

        signals.push({
          category: "dep-version-drift",
          severity: isMinorOnly ? "info" : "warning",
          detector: "deps",
          message: `"${mention.entityName}" — doc mentions version ${docVersion} but package.json declares ${declared.version}`,
          name: mention.entityName,
          files: [mention.filePath, declared.file],
          evidence: {
            packageName: mention.entityName,
            declaredVersion: declared.version,
            docMentionedVersion: docVersion,
            mentionContexts: [
              {
                text: mention.text,
                heading: mention.heading,
                filePath: mention.filePath,
                startLine: mention.startLine,
              },
            ],
          },
        });
        break; // One signal per entity-mention pair
      }
    }
  }

  log(`  → ${signals.length} version drift signals`);
  return signals;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Extract major version number from a semver string like "^18.2.0" or "~3.4.5".
 */
function extractMajorVersion(versionStr: string): number | null {
  const cleaned = versionStr.replace(/^[~^>=<\s]+/, "");
  const major = parseInt(cleaned.split(".")[0], 10);
  return isNaN(major) ? null : major;
}
