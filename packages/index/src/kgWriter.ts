// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KG Writer — writes KX output (canon entities + relationships) into
 * the CARI index.db's kg_* tables.
 *
 * Also bridges canonical entities into the CARI annotation engine
 * via registerExternalEntities() so that `retrieve`, `connections`,
 * and `mentions_of` surface them naturally.
 */

import Database from "better-sqlite3";
import type { ExternalEntity } from "./types.js";
import { registerExternalEntities } from "./writer.js";

// Re-export types used by the KX stage
interface CanonEntity {
  canonId: string;
  name: string;
  type: string;
  aliases: string[];
  confidence: number;
}

interface CanonTriple {
  subjectCanonId: string;
  predicate: string;
  objectCanonId: string;
  confidence: number;
  rawPredicate: string;
  rawTripleIndex: number;
}

interface RawTriple {
  subject: string;
  predicate: string;
  object: string;
  subjectKind?: string;
  objectKind?: string;
  confidence?: number;
}

export interface KgWriteInput {
  /** Source file that was enriched. */
  sourceFile: string;
  /** Artifact ID (typically file path based). */
  artifactId: string;
  /** Canonical entities from KX. */
  canonEntities: CanonEntity[];
  /** Canonical triples from KX. */
  canonTriples: CanonTriple[];
  /** Raw triples from FX (for provenance). */
  rawTriples: RawTriple[];
}

export interface KgWriteResult {
  entityCount: number;
  relationshipCount: number;
  rawTripleCount: number;
}

/**
 * Write KX results into kg_* tables in the CARI index.db.
 *
 * This is a write operation — opens the DB in read-write mode.
 * Wraps everything in a transaction for atomicity.
 */
export function writeKgResults(
  dbPath: string,
  inputs: KgWriteInput[],
): KgWriteResult {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Ensure kg_* tables exist (safe with IF NOT EXISTS)
  ensureKgTables(db);

  let entityCount = 0;
  let relationshipCount = 0;
  let rawTripleCount = 0;

  const insertEntity = db.prepare(`
    INSERT OR REPLACE INTO kg_entities
      (canon_id, name, type, aliases, confidence, artifact_id, source_file, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const findEntity = db.prepare(`
    SELECT id FROM kg_entities WHERE canon_id = ?
  `);

  const insertRel = db.prepare(`
    INSERT INTO kg_relationships
      (from_id, to_id, predicate, confidence, raw_predicate, artifact_id, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRaw = db.prepare(`
    INSERT INTO kg_raw_triples
      (subject, predicate, object, subject_kind, object_kind, confidence,
       source_file, artifact_id, subject_canon_id, object_canon_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertMeta = db.prepare(`
    INSERT OR REPLACE INTO enrichment_meta
      (file_path, content_hash, enriched_at, entity_count, triple_count, impact_score)
    VALUES (?, ?, datetime('now'), ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const input of inputs) {
      // Clear previous data for this source file
      db.prepare(`DELETE FROM kg_raw_triples WHERE source_file = ?`).run(
        input.sourceFile,
      );
      // We need entity IDs before we can delete relationships
      const oldEntityIds = db
        .prepare(`SELECT id FROM kg_entities WHERE source_file = ?`)
        .all(input.sourceFile) as Array<{ id: number }>;
      if (oldEntityIds.length > 0) {
        const ids = oldEntityIds.map((e) => e.id);
        db.prepare(
          `DELETE FROM kg_relationships WHERE from_id IN (${ids.join(",")}) OR to_id IN (${ids.join(",")})`,
        ).run();
        db.prepare(`DELETE FROM kg_entities WHERE source_file = ?`).run(
          input.sourceFile,
        );
      }

      // Write entities
      for (const e of input.canonEntities) {
        insertEntity.run(
          e.canonId,
          e.name,
          e.type,
          e.aliases.length > 0 ? JSON.stringify(e.aliases) : null,
          e.confidence,
          input.artifactId,
          input.sourceFile,
        );
        entityCount++;
      }

      // Write relationships
      for (const t of input.canonTriples) {
        const fromRow = findEntity.get(t.subjectCanonId) as
          | { id: number }
          | undefined;
        const toRow = findEntity.get(t.objectCanonId) as
          | { id: number }
          | undefined;
        if (!fromRow || !toRow) continue;

        insertRel.run(
          fromRow.id,
          toRow.id,
          t.predicate,
          t.confidence,
          t.rawPredicate,
          input.artifactId,
          input.sourceFile,
        );
        relationshipCount++;
      }

      // Write raw triples (for provenance)
      for (const r of input.rawTriples) {
        insertRaw.run(
          r.subject,
          r.predicate,
          r.object,
          r.subjectKind ?? null,
          r.objectKind ?? null,
          r.confidence ?? 1.0,
          input.sourceFile,
          input.artifactId,
          null, // subject_canon_id — could be resolved if needed
          null, // object_canon_id
        );
        rawTripleCount++;
      }

      // Update enrichment metadata
      // Content hash comes from the files table
      const fileRow = db
        .prepare(`SELECT content_hash FROM files WHERE path = ?`)
        .get(input.sourceFile) as { content_hash: string } | undefined;

      upsertMeta.run(
        input.sourceFile,
        fileRow?.content_hash ?? "",
        input.canonEntities.length,
        input.canonTriples.length,
        null, // impact_score set by caller if needed
      );
    }
  });

  tx();
  db.close();

  return { entityCount, relationshipCount, rawTripleCount };
}

/**
 * Bridge canonical entities into the CARI annotation engine
 * so that retrieve/connections/mentionsOf surface KG entities.
 */
export function bridgeKgEntities(dbPath: string): {
  entitiesWritten: number;
  annotationsCreated: number;
} {
  // Read all kg_entities and convert to ExternalEntity format
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");

  const rows = db
    .prepare(`SELECT canon_id, name, type, aliases FROM kg_entities`)
    .all() as Array<{
    canon_id: string;
    name: string;
    type: string;
    aliases: string | null;
  }>;
  db.close();

  if (rows.length === 0) {
    return { entitiesWritten: 0, annotationsCreated: 0 };
  }

  // Deduplicate by canon_id (multiple source files may produce same entity)
  const seen = new Set<string>();
  const entities: ExternalEntity[] = [];
  for (const r of rows) {
    if (seen.has(r.canon_id)) continue;
    seen.add(r.canon_id);

    entities.push({
      id: `kg:${r.canon_id}`,
      name: r.name,
      type: r.type,
      aliases: r.aliases ? JSON.parse(r.aliases) : undefined,
    });
  }

  return registerExternalEntities(dbPath, entities);
}

/**
 * Ensure kg_* tables exist (for existing databases upgrading to schema v5).
 */
function ensureKgTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_entities (
      id          INTEGER PRIMARY KEY,
      canon_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      aliases     TEXT,
      confidence  REAL DEFAULT 1.0,
      artifact_id TEXT,
      source_file TEXT,
      created_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS kg_relationships (
      id          INTEGER PRIMARY KEY,
      from_id     INTEGER NOT NULL REFERENCES kg_entities(id),
      to_id       INTEGER NOT NULL REFERENCES kg_entities(id),
      predicate   TEXT NOT NULL,
      confidence  REAL DEFAULT 1.0,
      raw_predicate TEXT,
      artifact_id TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS kg_raw_triples (
      id               INTEGER PRIMARY KEY,
      subject          TEXT,
      predicate        TEXT,
      object           TEXT,
      subject_kind     TEXT,
      object_kind      TEXT,
      confidence       REAL,
      source_file      TEXT,
      artifact_id      TEXT,
      subject_canon_id TEXT,
      object_canon_id  TEXT
    );

    CREATE TABLE IF NOT EXISTS enrichment_meta (
      file_path    TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      enriched_at  TEXT NOT NULL,
      entity_count INTEGER NOT NULL DEFAULT 0,
      triple_count INTEGER NOT NULL DEFAULT 0,
      impact_score REAL
    );

    CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);
    CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);
    CREATE INDEX IF NOT EXISTS idx_kg_entities_canon_id ON kg_entities(canon_id);
    CREATE INDEX IF NOT EXISTS idx_kg_entities_source ON kg_entities(source_file);
    CREATE INDEX IF NOT EXISTS idx_kg_rels_from ON kg_relationships(from_id);
    CREATE INDEX IF NOT EXISTS idx_kg_rels_to ON kg_relationships(to_id);
    CREATE INDEX IF NOT EXISTS idx_kg_rels_predicate ON kg_relationships(predicate);
    CREATE INDEX IF NOT EXISTS idx_kg_raw_source ON kg_raw_triples(source_file);
  `);
}
