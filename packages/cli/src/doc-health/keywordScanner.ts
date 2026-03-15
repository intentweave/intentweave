/**
 * keywordScanner.ts — Fast multi-pattern codebase keyword scanner
 *
 * Scans source files for entity name occurrences. Used by doc-health,
 * preflight, and xlink features.
 *
 * Two public APIs:
 *   - scanKeywords()      → Map<name, filePaths[]>  (for grounding links)
 *   - scanKeywordNames()  → Set<name>               (for existence checks)
 *
 * Performance strategies (applied in order of preference):
 *
 *   1. **ripgrep fast path** — when `rg` is on PATH, spawns it with patterns
 *      piped via stdin (`-f -`). ripgrep uses memory-mapped I/O, SIMD-
 *      accelerated search, and native parallelism. Result: a pre-filtered
 *      list of files that contain at least one match. Only those files are
 *      then read by Node.js for per-name attribution.
 *      → Install ripgrep for best performance: `brew install ripgrep`
 *
 *   2. **Node.js fallback** — parallel directory walk + parallel file reads
 *      (128 concurrent) + combined regex pre-filter + single-pass
 *      case-insensitive indexOf.
 *
 * Both paths share:
 *   - Case-insensitive matching
 *   - File size limit (512 KB — skip generated/bundled files)
 *   - Extensive ignore list (node_modules, dist, .git, etc.)
 *   - Early termination when all names found
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

// =============================================================================
// Configuration
// =============================================================================

/** Source code file extensions to scan for keyword matches. */
export const SCAN_CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml',
]);

/** Directories to skip during scanning. */
export const SCAN_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.iw', 'coverage',
  '.turbo', '.cache', '.output', '.nuxt', '.svelte-kit', '.specstory',
  '.pnpm', '__pycache__', '.venv', 'vendor',
]);

/** Individual files to always skip (huge lock files, build artifacts). */
export const SCAN_IGNORE_FILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb',
  'tsconfig.tsbuildinfo',
]);

/** Max file size to scan (512 KB — skip generated/bundled files). */
const MAX_FILE_SIZE = 512 * 1024;

/** Concurrent file reads for the Node.js fallback path. */
const READ_CONCURRENCY = 128;

/** Timeout for ripgrep subprocess (ms). */
const RG_TIMEOUT_MS = 30_000;

// =============================================================================
// ripgrep fast path
// =============================================================================

/**
 * Use ripgrep to quickly find files containing any of the given names.
 * Returns absolute file paths, or null if rg is not available.
 *
 * Patterns are written to rg's stdin (one per line, via `-f -`) to avoid
 * ARG_MAX issues with hundreds of entity names.
 */
function tryRipgrepFileList(
  cwd: string,
  names: string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    try {
      const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

      const globIncludes = [...SCAN_CODE_EXTENSIONS].map(ext => `--glob=*${ext}`);
      const globExcludes = [...SCAN_IGNORE_DIRS].map(dir => `--glob=!${dir}/`);
      const fileExcludes = [...SCAN_IGNORE_FILES].map(f => `--glob=!${f}`);

      const args = [
        '-l',                              // list matching files only
        '-i',                              // case-insensitive
        '--no-messages',                   // suppress file-access errors
        `--max-filesize=${MAX_FILE_SIZE}`,  // skip large files
        '-f', '-',                         // read patterns from stdin
        ...globIncludes,
        ...globExcludes,
        ...fileExcludes,
        cwd,
      ];

      const rg = nodeSpawn('rg', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let killed = false;

      rg.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

      rg.on('error', () => resolve(null));  // rg not found on PATH

      rg.on('close', (code) => {
        if (killed) { resolve(null); return; }
        // rg exit codes: 0 = matches found, 1 = no matches, 2 = error
        if (code === 0 || code === 1) {
          resolve(stdout.trim().split('\n').filter(Boolean));
        } else {
          resolve(null);
        }
      });

      // Write patterns (one per line) to rg's stdin
      rg.stdin.write(escaped.join('\n'));
      rg.stdin.end();

      // Safety timeout
      const timer = setTimeout(() => { killed = true; rg.kill(); }, RG_TIMEOUT_MS);
      rg.on('close', () => clearTimeout(timer));
    } catch {
      resolve(null);
    }
  });
}

// =============================================================================
// Node.js directory walker
// =============================================================================

/**
 * Recursively collect file paths matching extension filters.
 * Directory reads are parallelized via Promise.all at each level.
 */
async function collectFilePaths(cwd: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: Promise<void>[] = [];
    for (const entry of entries) {
      if (SCAN_IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(walk(fullPath));
      } else if (entry.isFile()) {
        if (SCAN_IGNORE_FILES.has(entry.name)) continue;
        const ext = path.extname(entry.name);
        if (SCAN_CODE_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
    if (subdirs.length > 0) await Promise.all(subdirs);
  }

  await walk(cwd);
  return results;
}

// =============================================================================
// Main scanner
// =============================================================================

/**
 * Scan codebase source files for entity name occurrences.
 *
 * Returns a Map of entity name → workspace-relative file paths where
 * that name was found. Case-insensitive matching. Names shorter than
 * 3 characters are skipped.
 *
 * Compatible with both Map and Set usage patterns:
 *   - `map.has(name)` — existence check (same as Set)
 *   - `map.get(name)` — file paths for grounding links
 *
 * @param cwd       Working directory (root of file scan)
 * @param entityNames  Entity names to search for
 * @param log       Optional progress callback
 */
export async function scanKeywords(
  cwd: string,
  entityNames: string[],
  log?: (msg: string) => void,
): Promise<Map<string, string[]>> {
  const names = entityNames.filter(n => n.length >= 3);
  if (names.length === 0) return new Map();

  const t0 = Date.now();
  const found = new Map<string, string[]>();
  const nameLower = names.map(n => n.toLowerCase());
  let filesScanned = 0;
  let usedRipgrep = false;

  // ── Try ripgrep fast path ───────────────────────────────────────────
  let filesToRead: string[];
  const rgResult = await tryRipgrepFileList(cwd, names);

  if (rgResult !== null) {
    filesToRead = rgResult;
    usedRipgrep = true;
    log?.(`  ripgrep: ${rgResult.length} candidate files in ${Date.now() - t0}ms`);
  } else {
    // ── Fallback: collect all paths via parallel readdir walk ────────
    filesToRead = await collectFilePaths(cwd);
    log?.(`  Collected ${filesToRead.length} source files in ${Date.now() - t0}ms`);
  }

  if (filesToRead.length === 0) {
    log?.(`  Keyword scan: 0 files, 0/${names.length} names matched (${Date.now() - t0}ms)`);
    return found;
  }

  // ── Build pre-filter regexes (Node.js fallback only) ──────────────
  // When ripgrep already filtered, every file is expected to match,
  // so the pre-filter is skipped entirely.
  const needPreFilter = !usedRipgrep;
  const preFilterRegexes: RegExp[] = [];

  if (needPreFilter) {
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const CHUNK = 200;
    for (let i = 0; i < escaped.length; i += CHUNK) {
      preFilterRegexes.push(new RegExp(escaped.slice(i, i + CHUNK).join('|'), 'i'));
    }
  }

  // ── Read & match in parallel batches ──────────────────────────────
  let allFound = false;
  let lastLogTime = Date.now();

  async function processFile(fullPath: string): Promise<void> {
    if (allFound) return;
    try {
      // When ripgrep pre-filtered, it already enforced --max-filesize,
      // so we skip the fs.stat() syscall (saves ~1ms per file).
      if (needPreFilter) {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) return;
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      filesScanned++;

      const relPath = path.relative(cwd, fullPath);

      // Progress feedback every 500ms
      const now = Date.now();
      if (now - lastLogTime > 500) {
        log?.(`  Scanning… ${filesScanned}/${filesToRead.length} files, ${found.size} matches`);
        lastLogTime = now;
      }

      // Pre-filter (Node.js fallback only)
      if (needPreFilter) {
        let pass = false;
        for (const re of preFilterRegexes) {
          if (re.test(content)) { pass = true; break; }
        }
        if (!pass) return;
      }

      // Per-name matching via lowercase indexOf (single-pass)
      const contentLower = content.toLowerCase();
      for (let i = 0; i < names.length; i++) {
        if (contentLower.includes(nameLower[i])) {
          const existing = found.get(names[i]);
          if (existing) {
            existing.push(relPath);
          } else {
            found.set(names[i], [relPath]);
          }
        }
      }

      // Early termination: all names found somewhere
      if (found.size >= names.length) {
        allFound = true;
      }
    } catch {
      // skip unreadable files
    }
  }

  // Process files in bounded-concurrency batches
  for (let i = 0; i < filesToRead.length; i += READ_CONCURRENCY) {
    if (allFound) break;
    const batch = filesToRead.slice(i, i + READ_CONCURRENCY);
    await Promise.all(batch.map(fp => processFile(fp)));
  }

  const elapsed = Date.now() - t0;
  const method = usedRipgrep ? ', rg' : '';
  log?.(`  Keyword scan: ${filesScanned} files, ${found.size}/${names.length} names matched (${elapsed}ms${method})`);

  return found;
}

/**
 * Convenience wrapper returning just the set of matched entity names.
 * Use this when file locations are not needed.
 */
export async function scanKeywordNames(
  cwd: string,
  entityNames: string[],
  log?: (msg: string) => void,
): Promise<Set<string>> {
  const map = await scanKeywords(cwd, entityNames, log);
  return new Set(map.keys());
}
