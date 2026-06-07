// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal pipeline context types retained for CARI stage compatibility.
 * The full KG pipeline has been removed; only AX/KWG/TCG stages remain.
 */

// ── Logger ────────────────────────────────────────────────────────────────────

export interface PipelineLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

// ── Profile ───────────────────────────────────────────────────────────────────

export interface ShapeRule {
  participatesIn: string[];
  position: "subject" | "object" | "any";
  inferredKind: string;
}

export interface ArtifactMapping {
  role: string;
  kinds: string[];
  patterns?: string[];
}

export interface Profile {
  name: string;
  version: string;
  kinds: string[];
  predicates: string[];
  shapes: ShapeRule[];
  artifactMappings: ArtifactMapping[];
  confidenceThreshold: number;
}

export const DEFAULT_PROFILE: Profile = {
  name: "default",
  version: "1.0.0",
  kinds: ["component", "function", "class", "module", "interface", "type", "concept"],
  predicates: ["implements", "uses", "calls", "imports", "extends", "defines", "documents"],
  shapes: [],
  artifactMappings: [
    { role: "spec", kinds: ["component", "concept", "interface"] },
    { role: "impl", kinds: ["function", "class", "module"] },
  ],
  confidenceThreshold: 0.5,
};

// ── Pipeline Context ──────────────────────────────────────────────────────────

export interface PipelineContext {
  workspaceRoot: string;
  profile: Profile;
  logger: PipelineLogger;
  session?: string;
  verbose?: boolean;
}
