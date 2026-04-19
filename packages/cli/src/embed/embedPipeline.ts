// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedding Pipeline — Embed entities and persist vectors to Neo4j.
 *
 * Loads entities from Neo4j (KWEntity, Canon:Entity, KWCluster),
 * runs them through the local ONNX embedding model, and stores
 * the resulting 384-dim vectors back on the nodes. Also creates
 * Neo4j vector indexes for nearest-neighbor search.
 *
 * @see PHASE-D-SPEC.md §7
 * @version 0.1
 */

import type { GraphDriver as Driver } from "../persistence/graphRunner.js";

// =============================================================================
// Types
// =============================================================================

export interface EmbedPipelineOptions {
  sessionId: string;
  /** Which entity types to embed */
  layers?: ("kwg" | "skg" | "code" | "cluster")[];
  /** Embedding batch size */
  batchSize?: number;
  /** Model ID */
  model?: string;
  /** Skip entities that already have embeddings */
  skipExisting?: boolean;
  /** Logger */
  log?: (msg: string) => void;
}

export interface EmbedPipelineResult {
  /** Entities embedded by type */
  embedded: Record<string, number>;
  /** Entities skipped (already had embedding) */
  skipped: Record<string, number>;
  /** Vector indexes created */
  indexesCreated: string[];
  /** Duration in ms */
  durationMs: number;
}

// =============================================================================
// Entity text builders (what text to embed for each type)
// =============================================================================

function kwEntityText(name: string, mentionCount: number): string {
  return name;
}

function canonEntityText(name: string, entityType: string): string {
  return entityType ? `${name} (${entityType})` : name;
}

function clusterText(label: string, members: string[]): string {
  const top = members.slice(0, 10).join(", ");
  return label ? `${label}: ${top}` : top;
}

// =============================================================================
// Pipeline
// =============================================================================

/**
 * Embed entities from Neo4j and persist vectors back.
 *
 * Steps:
 *   1. Ensure vector indexes exist
 *   2. Load entities (optionally skipping those with existing embeddings)
 *   3. Embed using ONNX model
 *   4. Persist embeddings back to Neo4j
 */
export async function runEmbedPipeline(
  driver: Driver,
  opts: EmbedPipelineOptions,
): Promise<EmbedPipelineResult> {
  const start = performance.now();
  const log = opts.log ?? (() => {});
  const layers = opts.layers ?? ["kwg", "skg", "cluster"];
  const batchSize = opts.batchSize ?? 100;
  const skipExisting = opts.skipExisting ?? true;

  // Dynamic import of embedding functions
  let embedBatch: (
    texts: string[],
    options?: any,
  ) => Promise<Array<{ text: string; embedding: number[] }>>;
  try {
    const mod = await import("@intentweave/analyzer");
    if (typeof mod.embedBatch === "function") {
      embedBatch = mod.embedBatch;
    } else {
      // Analyzer not rebuilt — import source directly via relative path
      const srcMod =
        await import("../../../analyzer/src/providers/embedding/onnxEmbedding.js");
      embedBatch = srcMod.embedBatch;
    }
  } catch {
    const srcMod =
      await import("../../../analyzer/src/providers/embedding/onnxEmbedding.js");
    embedBatch = srcMod.embedBatch;
  }

  const session = driver.session();
  const embedded: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  try {
    // ── Step 1: Ensure vector indexes ──────────────────────────────
    const indexesCreated = await ensureVectorIndexes(session, log);

    // ── Step 2: Embed each layer ───────────────────────────────────
    if (layers.includes("kwg")) {
      const res = await embedLayer(session, driver, embedBatch, {
        label: "KWEntity",
        sessionId: opts.sessionId,
        textFn: (rec: any) => kwEntityText(rec.name, rec.mentionCount),
        query: skipExisting
          ? `MATCH (e:KWEntity {session_id: $sid}) WHERE e.embedding IS NULL RETURN e.name AS name, e.mentionCount AS mentionCount, elementId(e) AS eid`
          : `MATCH (e:KWEntity {session_id: $sid}) RETURN e.name AS name, e.mentionCount AS mentionCount, elementId(e) AS eid`,
        updateQuery: `
            MATCH (e:KWEntity)
            WHERE elementId(e) = $eid
            SET e.embedding = $embedding
          `,
        batchSize,
        log,
      });
      embedded["KWEntity"] = res.embedded;
      skipped["KWEntity"] = res.skipped;
    }

    if (layers.includes("skg")) {
      const res = await embedLayer(session, driver, embedBatch, {
        label: "Canon:Entity",
        sessionId: opts.sessionId,
        textFn: (rec: any) => canonEntityText(rec.name, rec.type),
        query: skipExisting
          ? `MATCH (c:Canon:Entity {session_id: $sid}) WHERE c.embedding IS NULL RETURN c.name AS name, c.type AS type, elementId(c) AS eid`
          : `MATCH (c:Canon:Entity {session_id: $sid}) RETURN c.name AS name, c.type AS type, elementId(c) AS eid`,
        updateQuery: `
            MATCH (c:Canon:Entity)
            WHERE elementId(c) = $eid
            SET c.embedding = $embedding
          `,
        batchSize,
        log,
      });
      embedded["Canon:Entity"] = res.embedded;
      skipped["Canon:Entity"] = res.skipped;
    }

    if (layers.includes("cluster")) {
      const res = await embedLayer(session, driver, embedBatch, {
        label: "KWCluster",
        sessionId: opts.sessionId,
        textFn: (rec: any) => clusterText(rec.label, rec.members ?? []),
        query: skipExisting
          ? `MATCH (cl:KWCluster {session_id: $sid}) WHERE cl.embedding IS NULL RETURN cl.label AS label, cl.members AS members, elementId(cl) AS eid`
          : `MATCH (cl:KWCluster {session_id: $sid}) RETURN cl.label AS label, cl.members AS members, elementId(cl) AS eid`,
        updateQuery: `
            MATCH (cl:KWCluster)
            WHERE elementId(cl) = $eid
            SET cl.embedding = $embedding
          `,
        batchSize,
        log,
      });
      embedded["KWCluster"] = res.embedded;
      skipped["KWCluster"] = res.skipped;
    }

    return {
      embedded,
      skipped,
      indexesCreated,
      durationMs: performance.now() - start,
    };
  } finally {
    await session.close();
  }
}

// =============================================================================
// Layer embedding helper
// =============================================================================

interface EmbedLayerOpts {
  label: string;
  sessionId: string;
  textFn: (record: any) => string;
  query: string;
  updateQuery: string;
  batchSize: number;
  log: (msg: string) => void;
}

async function embedLayer(
  session: any,
  driver: Driver,
  embedBatch: (
    texts: string[],
    options?: any,
  ) => Promise<Array<{ text: string; embedding: number[] }>>,
  opts: EmbedLayerOpts,
): Promise<{ embedded: number; skipped: number }> {
  const { label, sessionId, textFn, query, updateQuery, batchSize, log } = opts;

  // Load entities
  const result = await session.run(query, { sid: sessionId });
  const records = result.records.map((r: any) => ({
    eid: r.get("eid"),
    ...Object.fromEntries(
      r.keys
        .filter((k: string) => k !== "eid")
        .map((k: string) => [k, toPlain(r.get(k))]),
    ),
  }));

  if (records.length === 0) {
    log(`${label}: 0 entities to embed (all have embeddings or none exist)`);
    return { embedded: 0, skipped: 0 };
  }

  log(`${label}: ${records.length} entities to embed`);

  // Embed in batches
  let embeddedCount = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const texts = batch.map((r: any) => textFn(r));

    const embeddings = await embedBatch(texts, { batchSize });

    // Persist embeddings back to Neo4j
    const writeSession = driver.session();
    try {
      for (let j = 0; j < batch.length; j++) {
        await writeSession.run(updateQuery, {
          eid: batch[j].eid,
          embedding: embeddings[j].embedding,
        });
      }
    } finally {
      await writeSession.close();
    }

    embeddedCount += batch.length;
    log(`${label}: embedded ${embeddedCount}/${records.length}`);
  }

  return { embedded: embeddedCount, skipped: 0 };
}

// =============================================================================
// Vector index management
// =============================================================================

async function ensureVectorIndexes(
  session: any,
  log: (msg: string) => void,
): Promise<string[]> {
  const created: string[] = [];

  const indexes = [
    {
      name: "kwEntityEmbedding",
      cypher: `
        CREATE VECTOR INDEX kwEntityEmbedding IF NOT EXISTS
        FOR (e:KWEntity)
        ON (e.embedding)
        OPTIONS {indexConfig: {
          \`vector.dimensions\`: 384,
          \`vector.similarity_function\`: 'cosine'
        }}
      `,
    },
    {
      name: "canonEntityEmbedding",
      cypher: `
        CREATE VECTOR INDEX canonEntityEmbedding IF NOT EXISTS
        FOR (c:Canon)
        ON (c.embedding)
        OPTIONS {indexConfig: {
          \`vector.dimensions\`: 384,
          \`vector.similarity_function\`: 'cosine'
        }}
      `,
    },
    {
      name: "kwClusterEmbedding",
      cypher: `
        CREATE VECTOR INDEX kwClusterEmbedding IF NOT EXISTS
        FOR (cl:KWCluster)
        ON (cl.embedding)
        OPTIONS {indexConfig: {
          \`vector.dimensions\`: 384,
          \`vector.similarity_function\`: 'cosine'
        }}
      `,
    },
  ];

  for (const idx of indexes) {
    try {
      await session.run(idx.cypher);
      created.push(idx.name);
      log(`Vector index ensured: ${idx.name}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Index might already exist or Neo4j version doesn't support vectors
      if (msg.includes("already exists")) {
        log(`Vector index exists: ${idx.name}`);
      } else {
        log(`Vector index ${idx.name}: ${msg}`);
      }
    }
  }

  return created;
}

// =============================================================================
// Helpers
// =============================================================================

function toPlain(val: unknown): unknown {
  if (val == null) return val;
  if (typeof val === "object" && "toNumber" in (val as any)) {
    return (val as any).toNumber();
  }
  if (Array.isArray(val)) return val.map(toPlain);
  return val;
}
