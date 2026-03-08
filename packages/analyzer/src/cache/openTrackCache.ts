// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Open Track Incremental Cache
 *
 * Content-addressed cache for the open track (FX/KX) pipeline stages.
 * Reuses content-hashing utilities from the main-track cache but maintains
 * its own directory structure and simpler cascade logic:
 *
 *   contentHash changes → invalidate FX + KX
 *   FX output changes   → invalidate KX only
 *   nothing changed      → full cache hit (skip both)
 *
 * Directory layout:
 *   .iw/cache/open-track/
 *     <sanitized-artifactKey>/
 *       FX.json          – cached FxStageOutput
 *       KX.json          – cached KxStageOutput
 *       meta.json         – hashes & timestamps
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { computeContentHash, hashContent } from "./registry.js";

// =============================================================================
// Types
// =============================================================================

export type OpenTrackStageId = "FX" | "KX";

/**
 * Per-artifact metadata stored alongside cached stage outputs.
 */
export interface OpenTrackArtifactMeta {
  /** SHA-256 of canonicalized source content */
  contentHash: string;
  /** SHA-256 of serialized FX output (used to detect KX invalidation) */
  fxOutputHash?: string;
  /** Hash of the FX system prompt at cache time (detects prompt changes) */
  fxPromptVersion?: string;
  /** Hash of the KX system prompt + vocabulary at cache time */
  kxPromptVersion?: string;
  /** LLM provider used (e.g. 'openai', 'smart-mock') */
  provider?: string;
  /** Model used (e.g. 'gpt-5-mini', 'gpt-4o') */
  model?: string;
  /** Timestamps & misc */
  stages: Partial<
    Record<
      OpenTrackStageId,
      {
        cachedAt: string;
        latencyMs: number;
        outputHash: string;
      }
    >
  >;
}

/**
 * Result of checking the cache for one artifact.
 */
export interface OpenTrackCacheCheck {
  /** FX cache hit — output can be reused */
  fxHit: boolean;
  /** KX cache hit — output can be reused */
  kxHit: boolean;
  /** Reason for FX miss */
  fxMissReason?:
    | "not-cached"
    | "content-changed"
    | "fx-prompt-changed"
    | "provider-changed"
    | "forced";
  /** Reason for KX miss */
  kxMissReason?:
    | "not-cached"
    | "content-changed"
    | "fx-changed"
    | "fx-prompt-changed"
    | "kx-prompt-changed"
    | "provider-changed"
    | "forced";
}

// =============================================================================
// Helpers
// =============================================================================

function sanitizeKey(key: string): string {
  return key
    .replace(/:/g, "__")
    .replace(/\//g, "_")
    .replace(/[<>"|?*]/g, "_");
}

// =============================================================================
// OpenTrackCache
// =============================================================================

export class OpenTrackCache {
  private readonly baseDir: string;

  constructor(projectRoot: string) {
    this.baseDir = path.join(projectRoot, ".iw", "cache", "open-track");
  }

  /** Ensure cache directory exists */
  async init(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  // ─── Path helpers ──────────────────────────────────────────────────────────

  private artifactDir(artifactKey: string): string {
    return path.join(this.baseDir, sanitizeKey(artifactKey));
  }

  private stagePath(artifactKey: string, stage: OpenTrackStageId): string {
    return path.join(this.artifactDir(artifactKey), `${stage}.json`);
  }

  private metaPath(artifactKey: string): string {
    return path.join(this.artifactDir(artifactKey), "meta.json");
  }

  // ─── Low-level I/O ────────────────────────────────────────────────────────

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeJson<T>(filePath: string, data: T): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // ─── Cache check ──────────────────────────────────────────────────────────

  /**
   * Determine which stages (FX, KX) can be skipped for an artifact.
   *
   * @param artifactKey       Stable artifact identifier (e.g. "file:docs/spec.md")
   * @param contentHash       SHA-256 of the artifact's current content
   * @param force             If true, treat everything as a miss
   * @param fxPromptVersion   Hash of the current FX system prompt (detects prompt changes)
   * @param kxPromptVersion   Hash of the current KX prompt + vocabulary
   */
  async check(
    artifactKey: string,
    contentHash: string,
    force = false,
    fxPromptVersion?: string,
    kxPromptVersion?: string,
    provider?: string,
    model?: string,
  ): Promise<OpenTrackCacheCheck> {
    if (force) {
      return {
        fxHit: false,
        kxHit: false,
        fxMissReason: "forced",
        kxMissReason: "forced",
      };
    }

    const meta = await this.readJson<OpenTrackArtifactMeta>(
      this.metaPath(artifactKey),
    );
    if (!meta) {
      return {
        fxHit: false,
        kxHit: false,
        fxMissReason: "not-cached",
        kxMissReason: "not-cached",
      };
    }

    // Content changed → both stages invalid
    if (meta.contentHash !== contentHash) {
      return {
        fxHit: false,
        kxHit: false,
        fxMissReason: "content-changed",
        kxMissReason: "content-changed",
      };
    }

    // FX prompt changed (or old cache without version tracking) → invalidate FX + KX
    if (fxPromptVersion && meta.fxPromptVersion !== fxPromptVersion) {
      return {
        fxHit: false,
        kxHit: false,
        fxMissReason: "fx-prompt-changed",
        kxMissReason: "fx-prompt-changed",
      };
    }

    // Provider/model changed → invalidate FX + KX (prevents cross-contamination)
    // Also invalidates old cache entries that lack provider metadata
    if (provider && meta.provider !== provider) {
      return {
        fxHit: false,
        kxHit: false,
        fxMissReason: "provider-changed",
        kxMissReason: "provider-changed",
      };
    }
    if (model && meta.model && meta.model !== model) {
      return {
        fxHit: false,
        kxHit: false,
        fxMissReason: "provider-changed",
        kxMissReason: "provider-changed",
      };
    }

    // Content same — check FX data exists
    const fxExists = meta.stages.FX != null;
    if (!fxExists) {
      return {
        fxHit: false,
        kxHit: false,
        fxMissReason: "not-cached",
        kxMissReason: "not-cached",
      };
    }

    // FX exists and content matches — FX hit
    const kxExists = meta.stages.KX != null;

    // KX prompt changed (or old cache without version tracking) → invalidate only KX
    if (kxPromptVersion && meta.kxPromptVersion !== kxPromptVersion) {
      return {
        fxHit: true,
        kxHit: false,
        kxMissReason: "kx-prompt-changed",
      };
    }

    return {
      fxHit: true,
      kxHit: kxExists,
      kxMissReason: kxExists ? undefined : "not-cached",
    };
  }

  // ─── Get / Put ─────────────────────────────────────────────────────────────

  /** Retrieve cached FX output */
  async getFx<T = unknown>(artifactKey: string): Promise<T | null> {
    return this.readJson<T>(this.stagePath(artifactKey, "FX"));
  }

  /** Retrieve cached KX output */
  async getKx<T = unknown>(artifactKey: string): Promise<T | null> {
    return this.readJson<T>(this.stagePath(artifactKey, "KX"));
  }

  /** Store FX output and update metadata */
  async putFx<T>(
    artifactKey: string,
    contentHash: string,
    data: T,
    latencyMs: number,
    fxPromptVersion?: string,
    provider?: string,
    model?: string,
  ): Promise<void> {
    await this.writeJson(this.stagePath(artifactKey, "FX"), data);

    const fxOutputHash = hashContent(JSON.stringify(data));
    const meta = (await this.readJson<OpenTrackArtifactMeta>(
      this.metaPath(artifactKey),
    )) ?? {
      contentHash,
      stages: {},
    };

    meta.contentHash = contentHash;
    meta.fxOutputHash = fxOutputHash;
    if (fxPromptVersion) meta.fxPromptVersion = fxPromptVersion;
    if (provider) meta.provider = provider;
    if (model) meta.model = model;
    meta.stages.FX = {
      cachedAt: new Date().toISOString(),
      latencyMs,
      outputHash: fxOutputHash,
    };
    // FX changed → KX is no longer valid
    delete meta.stages.KX;

    await this.writeJson(this.metaPath(artifactKey), meta);
  }

  /** Store KX output and update metadata */
  async putKx<T>(
    artifactKey: string,
    data: T,
    latencyMs: number,
    kxPromptVersion?: string,
  ): Promise<void> {
    await this.writeJson(this.stagePath(artifactKey, "KX"), data);

    const meta = await this.readJson<OpenTrackArtifactMeta>(
      this.metaPath(artifactKey),
    );
    if (!meta) return; // Should not happen — FX must be cached first

    const kxOutputHash = hashContent(JSON.stringify(data));
    if (kxPromptVersion) meta.kxPromptVersion = kxPromptVersion;
    meta.stages.KX = {
      cachedAt: new Date().toISOString(),
      latencyMs,
      outputHash: kxOutputHash,
    };

    await this.writeJson(this.metaPath(artifactKey), meta);
  }

  // ─── Invalidation ─────────────────────────────────────────────────────────

  /** Invalidate all cached data for an artifact */
  async invalidate(artifactKey: string): Promise<void> {
    const dir = this.artifactDir(artifactKey);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  /** Clear the entire open-track cache */
  async clearAll(): Promise<void> {
    try {
      await fs.rm(this.baseDir, { recursive: true, force: true });
      await this.init();
    } catch {
      // ignore
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  /** List all cached artifact keys */
  async listArtifacts(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name.replace(/__/g, ":").replace(/_/g, "/"));
    } catch {
      return [];
    }
  }
}
