// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for file filtering, .iwignore support, and exclude/include patterns
 * in the `iw index` commands.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { minimatch } from "minimatch";

import {
  DEFAULT_EXCLUDES,
  loadIwIgnore,
  buildExcludeList,
  discoverFiles,
  isExcluded,
} from "../commands/indexBuild.js";

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

function setupTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iw-filter-"));
}

function writeFile(relPath: string, content = "# Hello"): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

// =============================================================================
// DEFAULT_EXCLUDES
// =============================================================================

describe("DEFAULT_EXCLUDES", () => {
  it("contains expected patterns", () => {
    expect(DEFAULT_EXCLUDES).toContain("**/node_modules/**");
    expect(DEFAULT_EXCLUDES).toContain("**/dist/**");
    expect(DEFAULT_EXCLUDES).toContain("**/.git/**");
    expect(DEFAULT_EXCLUDES).toContain("**/.iw/**");
    expect(DEFAULT_EXCLUDES).toContain("**/build/**");
    expect(DEFAULT_EXCLUDES).toContain("**/__pycache__/**");
  });

  it("matches paths inside node_modules", () => {
    expect(
      minimatch("node_modules/foo/README.md", "**/node_modules/**", {
        dot: true,
      }),
    ).toBe(true);
    expect(
      minimatch("packages/cli/node_modules/bar/docs.md", "**/node_modules/**", {
        dot: true,
      }),
    ).toBe(true);
  });

  it("matches paths inside dist", () => {
    expect(minimatch("dist/docs/README.md", "**/dist/**", { dot: true })).toBe(
      true,
    );
  });

  it("matches .git subdirectories", () => {
    expect(
      minimatch(".git/hooks/pre-commit", "**/.git/**", { dot: true }),
    ).toBe(true);
  });
});

// =============================================================================
// loadIwIgnore
// =============================================================================

describe("loadIwIgnore", () => {
  beforeEach(() => {
    tmpDir = setupTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no .iwignore exists", async () => {
    const patterns = await loadIwIgnore(tmpDir);
    expect(patterns).toEqual([]);
  });

  it("loads patterns from .iwignore", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".iwignore"),
      "**/vendor/**\n**/tmp/**\n",
      "utf-8",
    );
    const patterns = await loadIwIgnore(tmpDir);
    expect(patterns).toEqual(["**/vendor/**", "**/tmp/**"]);
  });

  it("skips comments and empty lines", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".iwignore"),
      "# This is a comment\n\n**/vendor/**\n  # Another comment\n\n**/tmp/**\n",
      "utf-8",
    );
    const patterns = await loadIwIgnore(tmpDir);
    expect(patterns).toEqual(["**/vendor/**", "**/tmp/**"]);
  });

  it("trims whitespace from patterns", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".iwignore"),
      "  **/vendor/**  \n  **/tmp/**\n",
      "utf-8",
    );
    const patterns = await loadIwIgnore(tmpDir);
    expect(patterns).toEqual(["**/vendor/**", "**/tmp/**"]);
  });
});

// =============================================================================
// buildExcludeList
// =============================================================================

describe("buildExcludeList", () => {
  it("includes defaults when useDefaults is true", () => {
    const result = buildExcludeList([], [], true);
    expect(result).toEqual(DEFAULT_EXCLUDES);
  });

  it("omits defaults when useDefaults is false", () => {
    const result = buildExcludeList([], [], false);
    expect(result).toEqual([]);
  });

  it("merges .iwignore patterns after defaults", () => {
    const result = buildExcludeList([], ["**/vendor/**"], true);
    expect(result).toContain("**/node_modules/**");
    expect(result).toContain("**/vendor/**");
    expect(result.indexOf("**/vendor/**")).toBeGreaterThan(
      result.indexOf("**/node_modules/**"),
    );
  });

  it("merges CLI excludes after iwignore", () => {
    const result = buildExcludeList(
      ["**/generated/**"],
      ["**/vendor/**"],
      true,
    );
    expect(result).toContain("**/generated/**");
    expect(result.indexOf("**/generated/**")).toBeGreaterThan(
      result.indexOf("**/vendor/**"),
    );
  });

  it("combines all three sources", () => {
    const result = buildExcludeList(
      ["**/cli-exclude/**"],
      ["**/iwignore-exclude/**"],
      true,
    );
    expect(result.length).toBe(DEFAULT_EXCLUDES.length + 2);
  });
});

// =============================================================================
// isExcluded
// =============================================================================

describe("isExcluded", () => {
  it("returns false when no patterns or no minimatch fn", () => {
    expect(isExcluded("docs/README.md", [], null)).toBe(false);
    expect(isExcluded("docs/README.md", ["**/dist/**"], null)).toBe(false);
  });

  it("returns true for matching pattern", () => {
    expect(isExcluded("dist/docs/README.md", ["**/dist/**"], minimatch)).toBe(
      true,
    );
  });

  it("returns false for non-matching pattern", () => {
    expect(isExcluded("docs/README.md", ["**/dist/**"], minimatch)).toBe(false);
  });

  it("matches dot-files with { dot: true }", () => {
    expect(isExcluded(".iw/cache/data.txt", ["**/.iw/**"], minimatch)).toBe(
      true,
    );
  });

  it("matches any of multiple patterns", () => {
    expect(
      isExcluded(
        "vendor/lib/file.md",
        ["**/dist/**", "**/vendor/**"],
        minimatch,
      ),
    ).toBe(true);
  });
});

// =============================================================================
// discoverFiles
// =============================================================================

describe("discoverFiles", () => {
  beforeEach(() => {
    tmpDir = setupTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .md files recursively", async () => {
    writeFile("docs/README.md");
    writeFile("docs/guide/INSTALL.md");
    writeFile("src/code.ts", "export const x = 1;");

    const files = await discoverFiles([tmpDir], tmpDir);
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    expect(relPaths).toContain("docs/README.md");
    expect(relPaths).toContain("docs/guide/INSTALL.md");
    // .ts files are not supported by doc discovery
    expect(relPaths).not.toContain("src/code.ts");
  });

  it("excludes node_modules by fast-path", async () => {
    writeFile("docs/README.md");
    writeFile("node_modules/pkg/README.md");

    const files = await discoverFiles([tmpDir], tmpDir);
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    expect(relPaths).toContain("docs/README.md");
    expect(relPaths).not.toContain("node_modules/pkg/README.md");
  });

  it("excludes .git by fast-path", async () => {
    writeFile("docs/README.md");
    writeFile(".git/hooks/readme.md");

    const files = await discoverFiles([tmpDir], tmpDir);
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    expect(relPaths).not.toContain(".git/hooks/readme.md");
  });

  it("excludes .iw by fast-path", async () => {
    writeFile("docs/README.md");
    writeFile(".iw/cache/data.md");

    const files = await discoverFiles([tmpDir], tmpDir);
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    expect(relPaths).not.toContain(".iw/cache/data.md");
  });

  it("applies custom exclude patterns", async () => {
    writeFile("docs/README.md");
    writeFile("vendor/lib/notes.md");

    const files = await discoverFiles([tmpDir], tmpDir, {
      exclude: ["**/vendor/**"],
    });
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    expect(relPaths).toContain("docs/README.md");
    expect(relPaths).not.toContain("vendor/lib/notes.md");
  });

  it("applies include patterns to limit results", async () => {
    writeFile("docs/README.md");
    writeFile("docs/guide/INSTALL.md");
    writeFile("notes/TODO.md");

    const files = await discoverFiles([tmpDir], tmpDir, {
      include: ["docs/**"],
    });
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    expect(relPaths).toContain("docs/README.md");
    expect(relPaths).toContain("docs/guide/INSTALL.md");
    expect(relPaths).not.toContain("notes/TODO.md");
  });

  it("handles non-existent paths gracefully", async () => {
    const files = await discoverFiles(
      [path.join(tmpDir, "nonexistent")],
      tmpDir,
    );
    expect(files).toEqual([]);
  });

  it("deduplicates files", async () => {
    writeFile("docs/README.md");
    const docsPath = path.join(tmpDir, "docs");

    const files = await discoverFiles([docsPath, docsPath], tmpDir);
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    const readmeCount = relPaths.filter((p) => p === "docs/README.md").length;
    expect(readmeCount).toBe(1);
  });

  it("returns sorted results", async () => {
    writeFile("zzz/last.md");
    writeFile("aaa/first.md");
    writeFile("mmm/middle.md");

    const files = await discoverFiles([tmpDir], tmpDir);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  it("supports .mdx, .txt, .rst extensions", async () => {
    writeFile("docs/readme.mdx");
    writeFile("docs/notes.txt");
    writeFile("docs/guide.rst");
    writeFile("docs/code.js", "// not a doc");

    const files = await discoverFiles([tmpDir], tmpDir);
    const relPaths = files.map((f) => path.relative(tmpDir, f));

    expect(relPaths).toContain("docs/readme.mdx");
    expect(relPaths).toContain("docs/notes.txt");
    expect(relPaths).toContain("docs/guide.rst");
    expect(relPaths).not.toContain("docs/code.js");
  });
});
