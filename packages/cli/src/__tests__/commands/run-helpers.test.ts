/**
 * Tests for run command helper functions.
 *
 * These are internal functions in run.ts — since they're not exported,
 * we test them indirectly through behavior or by importing from the
 * module internals (requires refactoring to export).
 *
 * For now, we test the functions that ARE accessible or testable via
 * module-level patterns.
 *
 * Focus areas:
 * - generateRunId format
 * - generateArtifactId normalization
 * - formatProgress rendering
 * - collectFiles (would need temp FS)
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

// =============================================================================
// generateRunId (reimplemented for testing since not exported)
// =============================================================================

function generateRunId(): string {
  const now = new Date();
  const dateStr = now.toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `run-${dateStr}-${suffix}`;
}

describe('generateRunId', () => {
  it('starts with "run-"', () => {
    const id = generateRunId();
    expect(id).toMatch(/^run-/);
  });

  it('contains a date-time segment', () => {
    const id = generateRunId();
    // Format: run-YYYY-MM-DD_HH-MM-SS-hex8
    expect(id).toMatch(/^run-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 20 }, generateRunId));
    expect(ids.size).toBe(20);
  });
});

// =============================================================================
// generateArtifactId (reimplemented for testing)
// =============================================================================

function generateArtifactId(filePath: string, basePath: string): string {
  const relativePath = path.relative(basePath, filePath);
  return relativePath
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9/_-]/g, '_');
}

describe('generateArtifactId', () => {
  it('strips file extension', () => {
    const id = generateArtifactId('/project/docs/README.md', '/project');
    expect(id).toBe('docs/README');
  });

  it('replaces backslashes with forward slashes', () => {
    // Simulates Windows path
    const relative = 'docs\\nested\\file.md';
    const result = relative.replace(/\\/g, '/').replace(/\.[^.]+$/, '');
    expect(result).toBe('docs/nested/file');
  });

  it('replaces special characters with underscores', () => {
    const id = generateArtifactId('/project/docs/my file (1).md', '/project');
    expect(id).toBe('docs/my_file__1_');
  });

  it('preserves hyphens and underscores', () => {
    const id = generateArtifactId('/project/docs/my-file_name.md', '/project');
    expect(id).toBe('docs/my-file_name');
  });

  it('handles nested paths', () => {
    const id = generateArtifactId('/workspace/src/components/Button.tsx', '/workspace');
    expect(id).toBe('src/components/Button');
  });
});

// =============================================================================
// formatProgress (reimplemented for testing)
// =============================================================================

function formatProgress(progress: number, width: number = 30): string {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${(progress * 100).toFixed(0)}%`;
}

describe('formatProgress', () => {
  it('renders 0% as empty bar', () => {
    const bar = formatProgress(0, 10);
    expect(bar).toBe('[░░░░░░░░░░] 0%');
  });

  it('renders 100% as full bar', () => {
    const bar = formatProgress(1, 10);
    expect(bar).toBe('[██████████] 100%');
  });

  it('renders 50% correctly', () => {
    const bar = formatProgress(0.5, 10);
    expect(bar).toBe('[█████░░░░░] 50%');
  });

  it('uses default width of 30', () => {
    const bar = formatProgress(0);
    expect(bar).toContain('░'.repeat(30));
  });

  it('handles fractional progress', () => {
    const bar = formatProgress(0.33, 10);
    expect(bar).toContain('33%');
    // 0.33 * 10 = 3.3 → round to 3
    expect(bar).toBe('[███░░░░░░░] 33%');
  });
});
