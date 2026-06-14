// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: testCoverage
 *
 * Maps test files to source files via naming convention and import analysis,
 * then identifies exported symbols that lack test coverage.
 *
 * Strategies:
 *   1. **Naming**: `foo.test.ts` / `foo.spec.ts` → `foo.ts`
 *   2. **Import**: test file imports from source → mapping
 *   3. **Both**: naming + import agree
 */

import type Database from "@intentweave/sqlite-compat";
import type {
  TestCoverageParams,
  TestCoverageResult,
  TestMapping,
} from "../types.js";
import { openIndex } from "./shared.js";

// Test file patterns (checked against the basename)
const TEST_PATTERNS = [/\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/, /__tests__\//];

/**
 * Check if a file path is a test file.
 */
function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Derive the likely source file path from a test file path.
 * Returns null if no match.
 *
 * Examples:
 *   src/auth.test.ts       → src/auth.ts
 *   src/__tests__/auth.ts  → src/auth.ts
 *   src/auth.spec.tsx      → src/auth.tsx
 */
function deriveSourcePath(testPath: string): string | null {
  // Pattern 1: foo.test.ts → foo.ts
  const testMatch = testPath.match(/^(.+)\.(test|spec)(\.[tj]sx?)$/);
  if (testMatch) {
    return testMatch[1] + testMatch[3];
  }

  // Pattern 2: __tests__/foo.ts → ../foo.ts (relative to __tests__ dir)
  const dirMatch = testPath.match(/^(.+)\/__tests__\/(.+)$/);
  if (dirMatch) {
    // Try the parent directory
    return dirMatch[1] + "/" + dirMatch[2];
  }

  return null;
}

// =============================================================================
// Path-based API
// =============================================================================

export function testCoverage(
  dbPath: string,
  params: TestCoverageParams = {},
): TestCoverageResult {
  const db = openIndex(dbPath);
  try {
    return testCoverageFromDb(db, params);
  } finally {
    db.close();
  }
}

// =============================================================================
// DB-based API
// =============================================================================

export function testCoverageFromDb(
  db: Database.Database,
  params: TestCoverageParams = {},
): TestCoverageResult {
  // ── Step 1: Get all files ──────────────────────────────────────────
  const allFiles = db
    .prepare(`SELECT DISTINCT file_path FROM symbols ORDER BY file_path`)
    .all() as Array<{ file_path: string }>;

  const allFilePaths = new Set(allFiles.map((f) => f.file_path));

  // Partition into test and source files
  const testFiles = new Set<string>();
  const sourceFiles = new Set<string>();
  for (const fp of allFilePaths) {
    if (isTestFile(fp)) {
      testFiles.add(fp);
    } else {
      sourceFiles.add(fp);
    }
  }

  // ── Step 2: Build test→source mappings ─────────────────────────────
  const mappings: TestMapping[] = [];
  // Track which source files have at least one test mapping
  const testedSourceFiles = new Set<string>();
  // Track which exported symbol names are tested (per source file)
  const testedSymbolNames = new Map<string, Set<string>>();

  // Strategy 1: Naming convention
  const namingMappings = new Map<string, string>(); // testFile → sourceFile
  for (const tf of testFiles) {
    const candidate = deriveSourcePath(tf);
    if (candidate && sourceFiles.has(candidate)) {
      namingMappings.set(tf, candidate);
    }
  }

  // Strategy 2: Import analysis
  const importRows = db
    .prepare(
      `
      SELECT source_file, target_file, imported_names
      FROM imports
      WHERE target_file IS NOT NULL
        AND is_relative = 1
    `,
    )
    .all() as Array<{
    source_file: string;
    target_file: string;
    imported_names: string;
  }>;

  // Build: for each test file → set of (source file, imported names)
  const importMappings = new Map<string, Map<string, string[]>>(); // testFile → Map<sourceFile, names[]>

  for (const row of importRows) {
    if (!testFiles.has(row.source_file)) continue;
    if (!sourceFiles.has(row.target_file)) continue;

    if (!importMappings.has(row.source_file)) {
      importMappings.set(row.source_file, new Map());
    }
    const names: string[] = row.imported_names
      ? JSON.parse(row.imported_names)
      : [];
    const existing =
      importMappings.get(row.source_file)!.get(row.target_file) ?? [];
    importMappings
      .get(row.source_file)!
      .set(row.target_file, [...existing, ...names]);
  }

  // Merge both strategies
  const allTestFiles = new Set([
    ...namingMappings.keys(),
    ...importMappings.keys(),
  ]);

  for (const tf of allTestFiles) {
    const namingSource = namingMappings.get(tf);
    const importSources = importMappings.get(tf);

    if (namingSource && importSources?.has(namingSource)) {
      // Both naming and import agree
      const names = importSources.get(namingSource) ?? [];
      mappings.push({
        testFile: tf,
        sourceFile: namingSource,
        strategy: "both",
        importedNames: names,
      });
      testedSourceFiles.add(namingSource);
      trackTestedNames(testedSymbolNames, namingSource, names);

      // Also record any other imports from this test file
      for (const [sf, names2] of importSources) {
        if (sf !== namingSource) {
          mappings.push({
            testFile: tf,
            sourceFile: sf,
            strategy: "import",
            importedNames: names2,
          });
          testedSourceFiles.add(sf);
          trackTestedNames(testedSymbolNames, sf, names2);
        }
      }
    } else {
      // Naming only
      if (namingSource) {
        mappings.push({
          testFile: tf,
          sourceFile: namingSource,
          strategy: "naming",
          importedNames: [],
        });
        testedSourceFiles.add(namingSource);
      }

      // Import only
      if (importSources) {
        for (const [sf, names] of importSources) {
          if (sf === namingSource) continue; // already handled
          mappings.push({
            testFile: tf,
            sourceFile: sf,
            strategy: "import",
            importedNames: names,
          });
          testedSourceFiles.add(sf);
          trackTestedNames(testedSymbolNames, sf, names);
        }
      }
    }
  }

  // ── Step 3: Find untested exported symbols ─────────────────────────
  const exported = db
    .prepare(
      `
      SELECT id, name, file_path, kind, line
      FROM symbols
      WHERE export = 'exported'
      ORDER BY file_path, line
    `,
    )
    .all() as Array<{
    id: string;
    name: string;
    file_path: string;
    kind: string;
    line: number;
  }>;

  // Filter to non-test files only
  const sourceExported = exported.filter((s) => !isTestFile(s.file_path));

  // An exported symbol is "tested" if:
  // (a) its file has a test mapping with strategy "naming" (covers all), OR
  // (b) its name appears in importedNames from a test file
  const untested = sourceExported.filter((sym) => {
    // If file has no test at all → untested
    if (!testedSourceFiles.has(sym.file_path)) return true;

    // If there's a naming-based mapping → consider file tested
    const hasNamingMapping = mappings.some(
      (m) =>
        m.sourceFile === sym.file_path &&
        (m.strategy === "naming" || m.strategy === "both"),
    );
    if (hasNamingMapping) return false;

    // Import-only: check if this specific symbol name is imported by a test
    const tested = testedSymbolNames.get(sym.file_path);
    if (tested && (tested.has(sym.name) || tested.has("*"))) return false;

    return true;
  });

  const covered = sourceExported.length - untested.length;
  const coveragePercent =
    sourceExported.length > 0 ? (covered / sourceExported.length) * 100 : 100;

  // ── Step 4: Per-directory summary ──────────────────────────────────
  const dirMap = new Map<string, { total: number; covered: number }>();

  for (const sym of sourceExported) {
    const dir = sym.file_path.includes("/")
      ? sym.file_path.substring(0, sym.file_path.lastIndexOf("/"))
      : ".";
    if (!dirMap.has(dir)) {
      dirMap.set(dir, { total: 0, covered: 0 });
    }
    dirMap.get(dir)!.total++;
  }

  for (const sym of sourceExported) {
    const isUntested = untested.some(
      (u) => u.file_path === sym.file_path && u.name === sym.name,
    );
    if (!isUntested) {
      const dir = sym.file_path.includes("/")
        ? sym.file_path.substring(0, sym.file_path.lastIndexOf("/"))
        : ".";
      dirMap.get(dir)!.covered++;
    }
  }

  const byDirectory = Array.from(dirMap.entries())
    .map(([directory, stats]) => ({
      directory,
      totalExported: stats.total,
      covered: stats.covered,
      coveragePercent:
        stats.total > 0 ? (stats.covered / stats.total) * 100 : 100,
    }))
    .sort((a, b) => a.coveragePercent - b.coveragePercent);

  // ── Step 5: Build result ───────────────────────────────────────────
  const limit = params.limit;
  const untestedSlice =
    limit != null
      ? untested.slice(0, limit).map((s) => ({
          name: s.name,
          filePath: s.file_path,
          kind: s.kind,
          line: s.line,
        }))
      : untested.map((s) => ({
          name: s.name,
          filePath: s.file_path,
          kind: s.kind,
          line: s.line,
        }));

  return {
    totalExported: sourceExported.length,
    covered,
    coveragePercent: Math.round(coveragePercent * 10) / 10,
    untested: untestedSlice,
    mappings,
    byDirectory,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function trackTestedNames(
  map: Map<string, Set<string>>,
  sourceFile: string,
  names: string[],
): void {
  if (!map.has(sourceFile)) {
    map.set(sourceFile, new Set());
  }
  const set = map.get(sourceFile)!;
  for (const n of names) {
    set.add(n);
  }
}
