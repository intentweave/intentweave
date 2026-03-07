/**
 * Tests for `iw watch` supporting utilities (run-shared + watch internals).
 *
 * We cannot easily unit-test the full chokidar watcher, but we _can_ verify:
 *  - run-shared helpers (generateRunId, generateArtifactId, collectFiles, etc.)
 *  - debouncer logic (batching, flush)
 *  - watch command object (options, description)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

// ── run-shared helpers ─────────────────────────────────────

import {
  generateRunId,
  generateArtifactId,
  collectFiles,
  formatProgress,
  buildArtifacts,
  loadWorkspaceInfo,
  resolveProfile,
} from '../commands/run-shared.js';

// ── watch command export ───────────────────────────────────

import { watchCommand } from '../commands/watch.js';

// ═══════════════════════════════════════════════════════════
// generateRunId
// ═══════════════════════════════════════════════════════════

describe('generateRunId', () => {
  it('returns a string starting with "run-"', () => {
    const id = generateRunId();
    expect(id).toMatch(/^run-/);
  });

  it('contains a hex suffix', () => {
    const id = generateRunId();
    // format: run-YYYY-MM-DD_HH-MM-SS-<8hex>
    expect(id).toMatch(/[0-9a-f]{8}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRunId()));
    expect(ids.size).toBe(20);
  });
});

// ═══════════════════════════════════════════════════════════
// generateArtifactId
// ═══════════════════════════════════════════════════════════

describe('generateArtifactId', () => {
  it('strips extension and returns relative path', () => {
    const id = generateArtifactId('/project/src/foo.ts', '/project');
    expect(id).toBe('src/foo');
  });

  it('normalises special characters', () => {
    const id = generateArtifactId('/p/docs/my file (2).md', '/p');
    expect(id).toBe('docs/my_file__2_');
  });

  it('handles deeply nested paths', () => {
    const id = generateArtifactId('/p/a/b/c/d.ts', '/p');
    expect(id).toBe('a/b/c/d');
  });
});

// ═══════════════════════════════════════════════════════════
// collectFiles
// ═══════════════════════════════════════════════════════════

describe('collectFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-watch-test-'));
    // Create test structure
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), 'export const a = 1;');
    await fs.writeFile(path.join(tmpDir, 'src', 'b.ts'), 'export const b = 2;');
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Readme');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds files in a directory', async () => {
    const files = await collectFiles([path.join(tmpDir, 'src')], tmpDir);
    expect(files).toHaveLength(2);
    expect(files.every(f => f.endsWith('.ts'))).toBe(true);
  });

  it('finds a single file by absolute path', async () => {
    const files = await collectFiles([path.join(tmpDir, 'README.md')], tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('README.md');
  });

  it('deduplicates files', async () => {
    const files = await collectFiles(
      [path.join(tmpDir, 'src'), path.join(tmpDir, 'src', 'a.ts')],
      tmpDir,
    );
    // a.ts appears in both the directory glob AND as a direct path — should deduplicate
    const aCount = files.filter(f => f.endsWith('a.ts')).length;
    expect(aCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// buildArtifacts
// ═══════════════════════════════════════════════════════════

describe('buildArtifacts', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-artifacts-'));
    await fs.writeFile(path.join(tmpDir, 'hello.md'), '# Hello');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads file content and generates artifact ID', async () => {
    const artifacts = await buildArtifacts([path.join(tmpDir, 'hello.md')], tmpDir);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactId).toBe('hello');
    expect(artifacts[0].content).toBe('# Hello');
    expect(artifacts[0].filePath).toContain('hello.md');
  });

  it('respects role override', async () => {
    const artifacts = await buildArtifacts(
      [path.join(tmpDir, 'hello.md')],
      tmpDir,
      'spec',
    );
    expect((artifacts[0] as any).artifactRole).toBe('spec');
  });
});

// ═══════════════════════════════════════════════════════════
// formatProgress
// ═══════════════════════════════════════════════════════════

describe('formatProgress', () => {
  it('shows 0% at start', () => {
    const bar = formatProgress(0);
    expect(bar).toContain('0%');
    expect(bar).toContain('░');
  });

  it('shows 100% at end', () => {
    const bar = formatProgress(1);
    expect(bar).toContain('100%');
    expect(bar).toContain('█');
  });

  it('respects custom width', () => {
    const bar = formatProgress(0.5, 10);
    // 5 filled + 5 empty
    expect(bar).toContain('█████░░░░░');
  });
});

// ═══════════════════════════════════════════════════════════
// loadWorkspaceInfo
// ═══════════════════════════════════════════════════════════

describe('loadWorkspaceInfo', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iw-ws-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config exists', async () => {
    const info = await loadWorkspaceInfo(tmpDir);
    expect(info.workspaceKey).toBe('default');
    expect(info.workspaceId).toBe('ws_default');
    expect(info.iwDir).toContain('.iw');
  });

  it('reads workspace name from config.json', async () => {
    const iwDir = path.join(tmpDir, '.iw');
    await fs.mkdir(iwDir, { recursive: true });
    await fs.writeFile(
      path.join(iwDir, 'config.json'),
      JSON.stringify({ name: 'My Project', id: 'ws_123' }),
    );
    const info = await loadWorkspaceInfo(tmpDir);
    expect(info.workspaceKey).toBe('my-project');
    expect(info.workspaceId).toBe('ws_123');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveProfile
// ═══════════════════════════════════════════════════════════

describe('resolveProfile', () => {
  it('resolves "standard" profile', () => {
    const profile = resolveProfile('standard');
    expect(profile).toBeDefined();
    expect(profile.name).toBeDefined();
  });

  // Unknown profile calls process.exit — we can at least check the function exists
  it('is a function', () => {
    expect(typeof resolveProfile).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════
// watchCommand (Commander object)
// ═══════════════════════════════════════════════════════════

describe('watchCommand', () => {
  it('has the correct name', () => {
    expect(watchCommand.name()).toBe('watch');
  });

  it('has a description', () => {
    expect(watchCommand.description()).toContain('Watch');
  });

  it('accepts expected options', () => {
    const optionNames = watchCommand.options.map(o => o.long);
    expect(optionNames).toContain('--provider');
    expect(optionNames).toContain('--debounce');
    expect(optionNames).toContain('--persist');
    expect(optionNames).toContain('--verbose');
    expect(optionNames).toContain('--clear');
    expect(optionNames).toContain('--model');
    expect(optionNames).toContain('--concurrency');
  });
});

// ═══════════════════════════════════════════════════════════
// Debouncer (inline implementation — we test via a simplified version)
// ═══════════════════════════════════════════════════════════

describe('debouncer logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Minimal re-implementation matching watch.ts createDebouncer logic. */
  function createDebouncer(fn: (paths: string[]) => void, delayMs: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();

    return {
      push(p: string) {
        pending.add(p);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          const batch = [...pending];
          pending.clear();
          fn(batch);
        }, delayMs);
      },
      flush() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (pending.size > 0) {
          const batch = [...pending];
          pending.clear();
          fn(batch);
        }
      },
    };
  }

  it('batches events within the debounce window', () => {
    const batches: string[][] = [];
    const d = createDebouncer((paths) => batches.push(paths), 300);

    d.push('/a.ts');
    d.push('/b.ts');
    d.push('/c.ts');

    vi.advanceTimersByTime(300);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('deduplicates repeated paths', () => {
    const batches: string[][] = [];
    const d = createDebouncer((paths) => batches.push(paths), 200);

    d.push('/a.ts');
    d.push('/a.ts');
    d.push('/a.ts');

    vi.advanceTimersByTime(200);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(['/a.ts']);
  });

  it('fires separate batches for events outside the window', () => {
    const batches: string[][] = [];
    const d = createDebouncer((paths) => batches.push(paths), 100);

    d.push('/a.ts');
    vi.advanceTimersByTime(100);

    d.push('/b.ts');
    vi.advanceTimersByTime(100);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(['/a.ts']);
    expect(batches[1]).toEqual(['/b.ts']);
  });

  it('flush drains pending events immediately', () => {
    const batches: string[][] = [];
    const d = createDebouncer((paths) => batches.push(paths), 500);

    d.push('/x.ts');
    d.push('/y.ts');

    // No time has passed — flush forces delivery
    d.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(['/x.ts', '/y.ts']);
  });

  it('flush is idempotent when nothing is pending', () => {
    const batches: string[][] = [];
    const d = createDebouncer((paths) => batches.push(paths), 100);

    d.flush();
    d.flush();

    expect(batches).toHaveLength(0);
  });
});
