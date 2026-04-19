// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j Persistence for Open Track (KX) Output
 *
 * Writes canonical entities + triples + raw triples to Neo4j.
 * Uses the PersistenceCapability plugin (plugin-kg or plugin-kg-lite).
 *
 * Neo4j Data Model:
 *   :Canon:Entity { canonId, name, type, aliases[], confidence }
 *   :Canon:Entity -[:DECIDED_FOR|ENABLES|BLOCKS|...]-> :Canon:Entity
 *   :RawTriple { subject, predicate, object, confidence, rationale }
 *   :RawTriple -[:CANONICALIZED_FROM]-> :Canon:Entity
 *
 * Environment variables:
 *   NEO4J_URI      (default: bolt://localhost:7687)
 *   NEO4J_USER     (default: neo4j)
 *   NEO4J_PASSWORD (required)
 */

import type {
  KxStageOutput,
  CanonEntity,
  CanonTriple,
  RawTriple,
} from "@intentweave/analyzer";
import { getPersistence, createDriverAdapter } from "../persistence/graphRunner.js";

// =============================================================================
// Types
// =============================================================================

export interface PersistOptions {
  /** Neo4j connection URI */
  uri?: string;
  /** Neo4j username */
  user?: string;
  /** Neo4j password */
  password?: string;
  /** Session ID for isolation (defaults to workspace-based) */
  sessionId: string;
  /** Run ID for provenance */
  runId: string;
  /** Workspace identifier */
  workspaceId?: string;
  /** Whether to use APOC for dynamic relationship types (default: true, falls back automatically) */
  useApoc?: boolean;
  /** Persist mode: 'full' = create all (legacy), 'delta' = diff against existing (default) */
  mode?: "full" | "delta";
  /** Log callback for verbose output */
  log?: (msg: string) => void;
}

export interface PersistResult {
  canonEntitiesWritten: number;
  canonRelationshipsWritten: number;
  rawTriplesWritten: number;
  durationMs: number;
  /** Delta details (only present when mode='delta') */
  delta?: DeltaStats;
}

export interface DeltaStats {
  entities: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
  };
  relationships: {
    added: number;
    removed: number;
    unchanged: number;
  };
  rawTriples: {
    added: number;
    removed: number;
    unchanged: number;
  };
}

// =============================================================================
// Schema Setup
// =============================================================================

const SCHEMA_CYPHER = `
// Canon entity constraints and indexes
CREATE CONSTRAINT canon_entity_unique IF NOT EXISTS
FOR (n:Canon) REQUIRE (n.canonId, n.session_id) IS UNIQUE;

CREATE INDEX canon_entity_type IF NOT EXISTS
FOR (n:Canon) ON (n.type);

CREATE INDEX canon_entity_name IF NOT EXISTS
FOR (n:Canon) ON (n.name);

CREATE INDEX canon_entity_session IF NOT EXISTS
FOR (n:Canon) ON (n.session_id);

// Raw triple indexes
CREATE INDEX raw_triple_session IF NOT EXISTS
FOR (n:RawTriple) ON (n.session_id);

CREATE INDEX raw_triple_artifact IF NOT EXISTS
FOR (n:RawTriple) ON (n.artifactId);
`.trim();

// =============================================================================
// Implementation
// =============================================================================

/**
 * Persist KX output to Neo4j.
 *
 * Uses PersistenceCapability from the plugin registry.
 * Creates schema constraints on first run.
 *
 * Modes:
 *   'full'  — legacy: always creates new nodes/rels (may duplicate)
 *   'delta' — (default) diffs against existing graph and applies only changes
 */
export async function persistKxToNeo4j(
  kxOutputs: KxStageOutput[],
  options: PersistOptions,
): Promise<PersistResult> {
  const startTime = Date.now();
  const mode = options.mode ?? "delta";
  const log = options.log ?? (() => {});

  // Set env vars from options so the persistence plugin picks them up
  if (options.uri) process.env.NEO4J_URI = options.uri;
  if (options.user) process.env.NEO4J_USER = options.user;
  if (options.password) process.env.NEO4J_PASSWORD = options.password;

  // Get the persistence capability (backed by plugin-kg or plugin-kg-lite)
  const persistence = getPersistence();

  // Create a driver-like adapter so internal functions work unchanged.
  // Each session.run() call delegates to PersistenceCapability.query().
  const driver = createDriverAdapter(persistence);

  try {
    // Ensure schema (constraints/indexes)
    await ensureSchema(driver);

    if (mode === "delta") {
      return await persistDelta(
        driver,
        kxOutputs,
        options,
        startTime,
      );
    }

    // ── Legacy full mode ────────────────────────────────────────────

    // Check APOC availability
    const hasApoc = options.useApoc !== false && (await checkApoc(driver));

    let totalEntities = 0;
    let totalRelationships = 0;
    let totalRawTriples = 0;

    for (const kxOutput of kxOutputs) {
      // Phase 1: Write canonical entities
      const entities = await writeCanonEntities(
        driver,
        kxOutput.canonEntities,
        kxOutput.artifactId,
        options,
      );
      totalEntities += entities;

      // Phase 2: Write canonical relationships
      const rels = hasApoc
        ? await writeCanonRelationshipsApoc(
            driver,
            kxOutput.canonTriples,
            kxOutput.artifactId,
            options,
          )
        : await writeCanonRelationshipsGeneric(
            driver,
            kxOutput.canonTriples,
            kxOutput.artifactId,
            options,
          );
      totalRelationships += rels;

      // Phase 3: Write raw triples with links to canon entities
      const raws = await writeRawTriples(
        driver,
        kxOutput.rawTriples,
        kxOutput.canonEntities,
        kxOutput.entityResolutions,
        kxOutput.artifactId,
        options,
        kxOutput.filePath,
      );
      totalRawTriples += raws;
    }

    return {
      canonEntitiesWritten: totalEntities,
      canonRelationshipsWritten: totalRelationships,
      rawTriplesWritten: totalRawTriples,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    throw err;
  }
}

// =============================================================================
// Delta Persist — diff against existing graph and apply only changes
// =============================================================================

/**
 * Relationship fingerprint key: "subjectCanonId|predicate|objectCanonId"
 */
function relKey(
  subjectCanonId: string,
  predicate: string,
  objectCanonId: string,
): string {
  return `${subjectCanonId}|${predicate}|${objectCanonId}`;
}

/**
 * Raw triple fingerprint key: "subject|predicate|object" (lowercased)
 */
function rawKey(subject: string, predicate: string, object: string): string {
  return `${subject.toLowerCase()}|${predicate.toLowerCase()}|${object.toLowerCase()}`;
}

async function persistDelta(
  driver: any,
  kxOutputs: KxStageOutput[],
  options: PersistOptions,
  startTime: number,
): Promise<PersistResult> {
  const { sessionId, runId, log = () => {} } = options;

  // ── 1. Collect all incoming data ────────────────────────────────────
  const incomingEntities = new Map<string, CanonEntity>();
  const incomingRels = new Map<string, CanonTriple & { artifactId: string }>();
  const incomingRaws = new Map<
    string,
    RawTriple & { artifactId: string; idx: number }
  >();
  const allEntityResolutions: KxStageOutput["entityResolutions"] = [];
  const allCanonEntities: CanonEntity[] = [];
  /** Maps artifactId → original file path (for sourceFile on RawTriple) */
  const artifactFilePaths = new Map<string, string>();

  let rawIdx = 0;
  // First pass: collect all entities
  for (const kx of kxOutputs) {
    if (kx.filePath) {
      artifactFilePaths.set(kx.artifactId, kx.filePath);
    }
    for (const e of kx.canonEntities) {
      const existing = incomingEntities.get(e.canonId);
      if (!existing || e.confidence > existing.confidence) {
        incomingEntities.set(e.canonId, e);
      }
    }
    allEntityResolutions.push(...kx.entityResolutions);
    allCanonEntities.push(...kx.canonEntities);
  }
  // Second pass: collect rels and raws (filtering orphan rels)
  for (const kx of kxOutputs) {
    for (const t of kx.canonTriples) {
      // Skip orphan rels whose subject or object entity doesn't exist
      if (
        !incomingEntities.has(t.subjectCanonId) ||
        !incomingEntities.has(t.objectCanonId)
      )
        continue;
      const key = relKey(t.subjectCanonId, t.predicate, t.objectCanonId);
      const existing = incomingRels.get(key);
      if (!existing || t.confidence > existing.confidence) {
        incomingRels.set(key, { ...t, artifactId: kx.artifactId });
      }
    }
    for (const r of kx.rawTriples) {
      const key = rawKey(r.subject, r.predicate, r.object);
      if (!incomingRaws.has(key)) {
        incomingRaws.set(key, {
          ...r,
          artifactId: kx.artifactId,
          idx: rawIdx++,
        });
      }
    }
  }

  log(
    `Incoming: ${incomingEntities.size} entities, ${incomingRels.size} rels, ${incomingRaws.size} raw triples`,
  );

  // ── 2. Snapshot existing data ───────────────────────────────────────
  log("Snapshotting existing graph…");

  const existingEntities = await snapshotEntities(driver, sessionId);
  const existingRels = await snapshotRelationships(driver, sessionId);
  const existingRaws = await snapshotRawTriples(driver, sessionId);

  log(
    `Existing: ${existingEntities.size} entities, ${existingRels.size} rels, ${existingRaws.size} raw triples`,
  );

  // ── 3. Compute diffs ───────────────────────────────────────────────

  // Entities
  const entitiesToAdd: CanonEntity[] = [];
  const entitiesToUpdate: CanonEntity[] = [];
  const entityIdsToRemove: string[] = [];
  let entitiesUnchanged = 0;

  for (const [canonId, entity] of incomingEntities) {
    const existing = existingEntities.get(canonId);
    if (!existing) {
      entitiesToAdd.push(entity);
    } else if (
      entity.confidence !== existing.confidence ||
      entity.name !== existing.name ||
      entity.type !== existing.type ||
      JSON.stringify([...entity.aliases].sort()) !==
        JSON.stringify([...existing.aliases].sort())
    ) {
      entitiesToUpdate.push(entity);
    } else {
      entitiesUnchanged++;
    }
  }
  for (const canonId of existingEntities.keys()) {
    if (!incomingEntities.has(canonId)) {
      entityIdsToRemove.push(canonId);
    }
  }

  // Relationships
  const relsToAdd: Array<CanonTriple & { artifactId: string }> = [];
  const relKeysToRemove: string[] = [];
  let relsUnchanged = 0;

  for (const [key, triple] of incomingRels) {
    if (!existingRels.has(key)) {
      relsToAdd.push(triple);
    } else {
      relsUnchanged++;
    }
  }
  for (const key of existingRels.keys()) {
    if (!incomingRels.has(key)) {
      relKeysToRemove.push(key);
    }
  }

  // Raw triples
  const rawsToAdd: Array<RawTriple & { artifactId: string; idx: number }> = [];
  const rawKeysToRemove: string[] = [];
  let rawsUnchanged = 0;

  for (const [key, triple] of incomingRaws) {
    if (!existingRaws.has(key)) {
      rawsToAdd.push(triple);
    } else {
      rawsUnchanged++;
    }
  }
  for (const key of existingRaws.keys()) {
    if (!incomingRaws.has(key)) {
      rawKeysToRemove.push(key);
    }
  }

  log(
    `Delta: +${entitiesToAdd.length} ~${entitiesToUpdate.length} -${entityIdsToRemove.length} entities | +${relsToAdd.length} -${relKeysToRemove.length} rels | +${rawsToAdd.length} -${rawKeysToRemove.length} raws`,
  );

  // ── 4. Apply: Remove stale data ────────────────────────────────────
  if (entityIdsToRemove.length > 0) {
    log(`Removing ${entityIdsToRemove.length} stale entities…`);
    await removeStaleEntities(driver, sessionId, entityIdsToRemove);
  }

  if (relKeysToRemove.length > 0) {
    log(`Removing ${relKeysToRemove.length} stale relationships…`);
    await removeStaleRelationships(driver, sessionId, relKeysToRemove);
  }

  if (rawKeysToRemove.length > 0) {
    log(`Removing ${rawKeysToRemove.length} stale raw triples…`);
    await removeStaleRawTriples(driver, sessionId, rawKeysToRemove);
  }

  // ── 5. Apply: Add new entities ─────────────────────────────────────
  if (entitiesToAdd.length > 0) {
    log(`Adding ${entitiesToAdd.length} new entities…`);
    await writeCanonEntities(driver, entitiesToAdd, "__delta__", options);
  }

  // ── 6. Apply: Update changed entities ──────────────────────────────
  if (entitiesToUpdate.length > 0) {
    log(`Updating ${entitiesToUpdate.length} changed entities…`);
    await updateCanonEntities(driver, entitiesToUpdate, options);
  }

  // ── 7. Apply: Add new relationships ────────────────────────────────
  if (relsToAdd.length > 0) {
    log(`Adding ${relsToAdd.length} new relationships…`);
    // Group by artifactId for correct provenance
    const byArtifact = new Map<string, CanonTriple[]>();
    for (const r of relsToAdd) {
      const group = byArtifact.get(r.artifactId) ?? [];
      group.push(r);
      byArtifact.set(r.artifactId, group);
    }
    for (const [artifactId, triples] of byArtifact) {
      await mergeCanonRelationships(driver, triples, artifactId, options);
    }
  }

  // ── 8. Apply: Add new raw triples ──────────────────────────────────
  if (rawsToAdd.length > 0) {
    log(`Adding ${rawsToAdd.length} new raw triples…`);
    // Group by artifactId
    const byArtifact = new Map<string, Array<RawTriple & { idx: number }>>();
    for (const r of rawsToAdd) {
      const group = byArtifact.get(r.artifactId) ?? [];
      group.push(r);
      byArtifact.set(r.artifactId, group);
    }
    for (const [artifactId, triples] of byArtifact) {
      await writeRawTriples(
        driver,
        triples,
        allCanonEntities,
        allEntityResolutions,
        artifactId,
        options,
        artifactFilePaths.get(artifactId),
      );
    }
  }

  const delta: DeltaStats = {
    entities: {
      added: entitiesToAdd.length,
      updated: entitiesToUpdate.length,
      removed: entityIdsToRemove.length,
      unchanged: entitiesUnchanged,
    },
    relationships: {
      added: relsToAdd.length,
      removed: relKeysToRemove.length,
      unchanged: relsUnchanged,
    },
    rawTriples: {
      added: rawsToAdd.length,
      removed: rawKeysToRemove.length,
      unchanged: rawsUnchanged,
    },
  };

  return {
    canonEntitiesWritten: entitiesToAdd.length + entitiesToUpdate.length,
    canonRelationshipsWritten: relsToAdd.length,
    rawTriplesWritten: rawsToAdd.length,
    durationMs: Date.now() - startTime,
    delta,
  };
}

// =============================================================================
// Delta Helpers — Snapshot
// =============================================================================

interface ExistingEntity {
  canonId: string;
  name: string;
  type: string;
  confidence: number;
  aliases: string[];
}

async function snapshotEntities(
  driver: any,
  sessionId: string,
): Promise<Map<string, ExistingEntity>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (n:Canon)
       WHERE n.session_id = $sid
       RETURN n.canonId AS canonId, n.name AS name, n.type AS type,
              coalesce(n.confidence, 1.0) AS confidence,
              coalesce(n.aliases, []) AS aliases`,
      { sid: sessionId },
    );
    const map = new Map<string, ExistingEntity>();
    for (const rec of result.records) {
      const canonId = rec.get("canonId");
      map.set(canonId, {
        canonId,
        name: rec.get("name"),
        type: rec.get("type"),
        confidence: toNumber(rec.get("confidence")) ?? 1.0,
        aliases: (rec.get("aliases") ?? []) as string[],
      });
    }
    return map;
  } finally {
    await session.close();
  }
}

async function snapshotRelationships(
  driver: any,
  sessionId: string,
): Promise<Map<string, { predicate: string; confidence: number }>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (a:Canon)-[r:CANON_REL]->(b:Canon)
       WHERE a.session_id = $sid
       RETURN a.canonId AS subj, r.predicate AS pred, b.canonId AS obj,
              coalesce(r.confidence, 1.0) AS confidence`,
      { sid: sessionId },
    );
    const map = new Map<string, { predicate: string; confidence: number }>();
    for (const rec of result.records) {
      const key = relKey(rec.get("subj"), rec.get("pred"), rec.get("obj"));
      map.set(key, {
        predicate: rec.get("pred"),
        confidence: toNumber(rec.get("confidence")) ?? 1.0,
      });
    }
    return map;
  } finally {
    await session.close();
  }
}

async function snapshotRawTriples(
  driver: any,
  sessionId: string,
): Promise<Map<string, boolean>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (r:RawTriple)
       WHERE r.session_id = $sid
       RETURN r.subject AS subj, r.predicate AS pred, r.object AS obj`,
      { sid: sessionId },
    );
    const map = new Map<string, boolean>();
    for (const rec of result.records) {
      const key = rawKey(rec.get("subj"), rec.get("pred"), rec.get("obj"));
      map.set(key, true);
    }
    return map;
  } finally {
    await session.close();
  }
}

// =============================================================================
// Delta Helpers — Mutations
// =============================================================================

/**
 * MERGE-based relationship writer for delta mode.
 * Unlike writeCanonRelationshipsGeneric (CREATE), this won't duplicate rels.
 */
async function mergeCanonRelationships(
  driver: any,
  triples: CanonTriple[],
  artifactId: string,
  options: PersistOptions,
): Promise<number> {
  if (triples.length === 0) return 0;
  const session = driver.session();
  try {
    const result = await session.run(
      `UNWIND $triples AS t
       MATCH (s:Canon:Entity { canonId: t.subjectCanonId, session_id: $sessionId })
       MATCH (o:Canon:Entity { canonId: t.objectCanonId, session_id: $sessionId })
       MERGE (s)-[r:CANON_REL { predicate: t.predicate }]->(o)
       ON CREATE SET
         r.confidence = t.confidence,
         r.rawPredicate = t.rawPredicate,
         r.rawTripleIndex = t.rawTripleIndex,
         r.artifactId = $artifactId,
         r.run_id = $runId,
         r.track = 'open'
       ON MATCH SET
         r.confidence = CASE WHEN t.confidence > r.confidence THEN t.confidence ELSE r.confidence END,
         r.run_id = $runId
       RETURN count(r) AS written`,
      {
        triples: triples.map((t) => ({
          subjectCanonId: t.subjectCanonId,
          objectCanonId: t.objectCanonId,
          predicate: t.predicate,
          confidence: t.confidence,
          rawPredicate: t.rawPredicate,
          rawTripleIndex: t.rawTripleIndex,
        })),
        sessionId: options.sessionId,
        artifactId,
        runId: options.runId,
      },
    );
    return toNumber(result.records[0]?.get("written")) ?? 0;
  } finally {
    await session.close();
  }
}

async function updateCanonEntities(
  driver: any,
  entities: CanonEntity[],
  options: PersistOptions,
): Promise<void> {
  if (entities.length === 0) return;
  const session = driver.session();
  try {
    await session.run(
      `UNWIND $entities AS e
       MATCH (n:Canon:Entity { canonId: e.canonId, session_id: $sessionId })
       SET n.name = e.name,
           n.type = e.type,
           n.confidence = e.confidence,
           n.aliases = e.aliases,
           n.run_id = $runId,
           n.updated_at = datetime()`,
      {
        entities: entities.map((e) => ({
          canonId: e.canonId,
          name: e.name,
          type: e.type,
          confidence: e.confidence,
          aliases: e.aliases,
        })),
        sessionId: options.sessionId,
        runId: options.runId,
      },
    );
  } finally {
    await session.close();
  }
}

async function removeStaleEntities(
  driver: any,
  sessionId: string,
  canonIds: string[],
): Promise<void> {
  if (canonIds.length === 0) return;
  const session = driver.session();
  try {
    // Remove relationships first, then the entity node
    await session.run(
      `MATCH (n:Canon { session_id: $sid })
       WHERE n.canonId IN $ids
       DETACH DELETE n`,
      { sid: sessionId, ids: canonIds },
    );
  } finally {
    await session.close();
  }
}

async function removeStaleRelationships(
  driver: any,
  sessionId: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;

  // Parse keys back into components
  const parsed = keys.map((k) => {
    const parts = k.split("|");
    return { subj: parts[0], pred: parts[1], obj: parts[2] };
  });

  const BATCH = 200;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const batch = parsed.slice(i, i + BATCH);
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $batch AS b
         MATCH (a:Canon { canonId: b.subj, session_id: $sid })-[r:CANON_REL { predicate: b.pred }]->(o:Canon { canonId: b.obj, session_id: $sid })
         DELETE r`,
        { batch, sid: sessionId },
      );
    } finally {
      await session.close();
    }
  }
}

async function removeStaleRawTriples(
  driver: any,
  sessionId: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;

  // Parse keys back into components
  const parsed = keys.map((k) => {
    const parts = k.split("|");
    return { subj: parts[0], pred: parts[1], obj: parts[2] };
  });

  const BATCH = 200;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const batch = parsed.slice(i, i + BATCH);
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $batch AS b
         MATCH (r:RawTriple { session_id: $sid })
         WHERE toLower(r.subject) = b.subj
           AND toLower(r.predicate) = b.pred
           AND toLower(r.object) = b.obj
         DETACH DELETE r`,
        { batch, sid: sessionId },
      );
    } finally {
      await session.close();
    }
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

async function ensureSchema(driver: any): Promise<void> {
  const session = driver.session();
  try {
    // Run each statement separately (Neo4j doesn't support multi-statement in one call)
    const statements = SCHEMA_CYPHER.split("\n").filter(
      (l) => !l.startsWith("//") && l.trim().length > 0,
    );

    // Rejoin multi-line statements
    let current = "";
    for (const line of statements) {
      current += " " + line;
      if (current.includes(";")) {
        try {
          await session.run(current.replace(";", "").trim());
        } catch {
          // Constraint/index may already exist — safe to ignore
        }
        current = "";
      }
    }
  } finally {
    await session.close();
  }
}

async function checkApoc(driver: any): Promise<boolean> {
  const session = driver.session();
  try {
    await session.run("RETURN apoc.version() AS v");
    return true;
  } catch {
    return false;
  } finally {
    await session.close();
  }
}

async function writeCanonEntities(
  driver: any,
  entities: CanonEntity[],
  artifactId: string,
  options: PersistOptions,
): Promise<number> {
  if (entities.length === 0) return 0;

  const session = driver.session();
  try {
    const result = await session.run(
      `
      UNWIND $entities AS e
      MERGE (n:Canon:Entity {
        canonId: e.canonId,
        session_id: $sessionId
      })
      ON CREATE SET
        n.name = e.name,
        n.type = e.type,
        n.aliases = e.aliases,
        n.confidence = e.confidence,
        n.artifactId = $artifactId,
        n.run_id = $runId,
        n.workspace_id = $workspaceId,
        n.created_at = datetime(),
        n.track = 'open'
      ON MATCH SET
        n.confidence = CASE WHEN e.confidence > n.confidence THEN e.confidence ELSE n.confidence END,
        n.aliases = [x IN (n.aliases + e.aliases) WHERE x IS NOT NULL | x],
        n.updated_at = datetime()
      RETURN count(n) AS written
      `,
      {
        entities: entities.map((e) => ({
          canonId: e.canonId,
          name: e.name,
          type: e.type,
          aliases: e.aliases,
          confidence: e.confidence,
        })),
        sessionId: options.sessionId,
        runId: options.runId,
        artifactId,
        workspaceId: options.workspaceId ?? "default",
      },
    );

    return toNumber(result.records[0]?.get("written")) ?? entities.length;
  } finally {
    await session.close();
  }
}

async function writeCanonRelationshipsApoc(
  driver: any,
  triples: CanonTriple[],
  artifactId: string,
  options: PersistOptions,
): Promise<number> {
  if (triples.length === 0) return 0;

  const session = driver.session();
  try {
    let written = 0;

    // Group by predicate for efficient APOC calls
    const byPredicate = new Map<string, CanonTriple[]>();
    for (const t of triples) {
      const group = byPredicate.get(t.predicate) ?? [];
      group.push(t);
      byPredicate.set(t.predicate, group);
    }

    for (const [predicate, group] of byPredicate) {
      const result = await session.run(
        `
        UNWIND $triples AS t
        MATCH (s:Canon:Entity { canonId: t.subjectCanonId, session_id: $sessionId })
        MATCH (o:Canon:Entity { canonId: t.objectCanonId, session_id: $sessionId })
        CALL apoc.create.relationship(s, $predicate, {
          confidence: t.confidence,
          rawPredicate: t.rawPredicate,
          rawTripleIndex: t.rawTripleIndex,
          artifactId: $artifactId,
          run_id: $runId,
          track: 'open'
        }, o) YIELD rel
        RETURN count(rel) AS written
        `,
        {
          triples: group.map((t) => ({
            subjectCanonId: t.subjectCanonId,
            objectCanonId: t.objectCanonId,
            confidence: t.confidence,
            rawPredicate: t.rawPredicate,
            rawTripleIndex: t.rawTripleIndex,
          })),
          predicate,
          sessionId: options.sessionId,
          artifactId,
          runId: options.runId,
        },
      );

      written += toNumber(result.records[0]?.get("written")) ?? 0;
    }

    return written;
  } finally {
    await session.close();
  }
}

async function writeCanonRelationshipsGeneric(
  driver: any,
  triples: CanonTriple[],
  artifactId: string,
  options: PersistOptions,
): Promise<number> {
  if (triples.length === 0) return 0;

  const session = driver.session();
  try {
    const result = await session.run(
      `
      UNWIND $triples AS t
      MATCH (s:Canon:Entity { canonId: t.subjectCanonId, session_id: $sessionId })
      MATCH (o:Canon:Entity { canonId: t.objectCanonId, session_id: $sessionId })
      CREATE (s)-[r:CANON_REL {
        predicate: t.predicate,
        confidence: t.confidence,
        rawPredicate: t.rawPredicate,
        rawTripleIndex: t.rawTripleIndex,
        artifactId: $artifactId,
        run_id: $runId,
        track: 'open'
      }]->(o)
      RETURN count(r) AS written
      `,
      {
        triples: triples.map((t) => ({
          subjectCanonId: t.subjectCanonId,
          objectCanonId: t.objectCanonId,
          predicate: t.predicate,
          confidence: t.confidence,
          rawPredicate: t.rawPredicate,
          rawTripleIndex: t.rawTripleIndex,
        })),
        sessionId: options.sessionId,
        artifactId,
        runId: options.runId,
      },
    );

    return toNumber(result.records[0]?.get("written")) ?? 0;
  } finally {
    await session.close();
  }
}

async function writeRawTriples(
  driver: any,
  rawTriples: RawTriple[],
  canonEntities: CanonEntity[],
  entityResolutions: KxStageOutput["entityResolutions"],
  artifactId: string,
  options: PersistOptions,
  sourceFile?: string,
): Promise<number> {
  if (rawTriples.length === 0) return 0;

  // Build lookup: raw name → canonId
  const nameToCanonId = new Map<string, string>();
  for (const res of entityResolutions) {
    nameToCanonId.set(res.rawName.toLowerCase(), res.canonId);
  }
  for (const entity of canonEntities) {
    nameToCanonId.set(entity.name.toLowerCase(), entity.canonId);
    for (const alias of entity.aliases) {
      nameToCanonId.set(alias.toLowerCase(), entity.canonId);
    }
  }

  // Batch writes — 200 triples per batch to avoid transaction size issues
  const BATCH_SIZE = 200;
  let totalWritten = 0;

  for (let i = 0; i < rawTriples.length; i += BATCH_SIZE) {
    const batch = rawTriples.slice(i, i + BATCH_SIZE);
    const session = driver.session();
    try {
      const result = await session.run(
        `
        UNWIND $triples AS t
        CREATE (r:RawTriple {
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          subjectKind: t.subjectKind,
          objectKind: t.objectKind,
          confidence: t.confidence,
          rationale: t.rationale,
          tripleIndex: t.idx,
          artifactId: $artifactId,
          sourceFile: $sourceFile,
          session_id: $sessionId,
          run_id: $runId,
          track: 'open',
          created_at: datetime()
        })
        WITH r, t
        OPTIONAL MATCH (cs:Canon:Entity { canonId: t.subjectCanonId, session_id: $sessionId })
        FOREACH (_ IN CASE WHEN cs IS NOT NULL THEN [1] ELSE [] END |
          CREATE (r)-[:CANONICALIZED_FROM { role: 'subject' }]->(cs)
        )
        WITH r, t
        OPTIONAL MATCH (co:Canon:Entity { canonId: t.objectCanonId, session_id: $sessionId })
        FOREACH (_ IN CASE WHEN co IS NOT NULL THEN [1] ELSE [] END |
          CREATE (r)-[:CANONICALIZED_FROM { role: 'object' }]->(co)
        )
        RETURN count(r) AS written
        `,
        {
          triples: batch.map((t, batchIdx) => ({
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            subjectKind: t.subjectKind ?? null,
            objectKind: t.objectKind ?? null,
            confidence: t.confidence,
            rationale: t.rationale ?? null,
            idx: i + batchIdx,
            subjectCanonId: nameToCanonId.get(t.subject.toLowerCase()) ?? null,
            objectCanonId: nameToCanonId.get(t.object.toLowerCase()) ?? null,
          })),
          sessionId: options.sessionId,
          artifactId,
          sourceFile: sourceFile ?? null,
          runId: options.runId,
        },
      );

      totalWritten += toNumber(result.records[0]?.get("written")) ?? 0;
    } finally {
      await session.close();
    }
  }

  return totalWritten;
}

/**
 * Safely convert Neo4j Integer to JS number
 */
function toNumber(val: any): number | undefined {
  if (val == null) return undefined;
  if (typeof val === "number") return val;
  if (typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}
