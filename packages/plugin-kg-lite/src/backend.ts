// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * KG-Lite Backend — SQLite persistence via CypherLite.
 *
 * Provides entity/relationship persistence and Cypher query execution
 * against a local SQLite database using the CypherLite engine.
 */

import Database from "better-sqlite3";
import { CypherLiteEngine, KG_SCHEMA_SQL } from "@intentweave/cypher-lite";
import type { CypherLiteDatabase } from "@intentweave/cypher-lite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface PersistData {
  entities: EntityRecord[];
  relationships: RelationshipRecord[];
  session: string;
}

export interface EntityRecord {
  canonId: string;
  name: string;
  type: string;
  aliases?: string[];
  confidence?: number;
  artifactId?: string;
  runId?: string;
}

export interface RelationshipRecord {
  subjectCanonId: string;
  predicate: string;
  objectCanonId: string;
  confidence?: number;
  rawPredicate?: string;
  rawTripleIndex?: number;
  artifactId?: string;
  runId?: string;
}

export interface PersistResult {
  entityCount: number;
  relationshipCount: number;
}

// =============================================================================
// Backend
// =============================================================================

export class KgLiteBackend {
  private db: ReturnType<typeof Database>;
  private engine: CypherLiteEngine;
  private closed = false;

  constructor(dbPath: string) {
    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    this.engine = new CypherLiteEngine(
      this.db as unknown as CypherLiteDatabase,
    );
    this.engine.initSchema();
  }

  /**
   * Persist entities and relationships to SQLite.
   *
   * Uses INSERT OR REPLACE for entities (upsert on canon_id + session_id)
   * and INSERT for relationships.
   */
  persist(data: PersistData): PersistResult {
    const { entities, relationships, session } = data;
    let entityCount = 0;
    let relationshipCount = 0;

    const insertEntity = this.db.prepare(`
      INSERT OR REPLACE INTO kg_entities
        (canon_id, name, type, aliases, confidence, session_id, run_id, track)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
    `);

    const findEntity = this.db.prepare(`
      SELECT id FROM kg_entities WHERE canon_id = ? AND session_id = ?
    `);

    const insertRel = this.db.prepare(`
      INSERT INTO kg_relationships
        (from_id, to_id, predicate, confidence, raw_predicate, run_id, track)
      VALUES (?, ?, ?, ?, ?, ?, 'open')
    `);

    // Wrap in a transaction for atomicity and performance
    const tx = this.db.transaction(() => {
      // Write entities
      for (const e of entities) {
        insertEntity.run(
          e.canonId,
          e.name,
          e.type.toUpperCase(),
          e.aliases ? JSON.stringify(e.aliases) : null,
          e.confidence ?? 1.0,
          session,
          e.runId ?? null,
        );
        entityCount++;
      }

      // Write relationships
      for (const r of relationships) {
        const fromRow = findEntity.get(
          r.subjectCanonId,
          session,
        ) as { id: number } | undefined;
        const toRow = findEntity.get(
          r.objectCanonId,
          session,
        ) as { id: number } | undefined;

        if (!fromRow || !toRow) {
          // Skip relationships with unresolved entities
          continue;
        }

        insertRel.run(
          fromRow.id,
          toRow.id,
          r.predicate,
          r.confidence ?? 1.0,
          r.rawPredicate ?? null,
          r.runId ?? null,
        );
        relationshipCount++;
      }
    });

    tx();

    return { entityCount, relationshipCount };
  }

  /**
   * Execute a Cypher query via CypherLite and return results.
   */
  query(
    cypher: string,
    params?: Record<string, unknown>,
  ): Record<string, unknown>[] {
    return this.engine.run(cypher, params ?? {});
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
