// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CypherLite executor.
 *
 * Executes transpiled SQL against a SQLite-compatible database interface.
 * Does NOT import better-sqlite3 directly — accepts a duck-typed interface
 * so consumers can inject their own database.
 */

import { parse } from './parser.js';
import { transpile, TranspiledQuery } from './transpiler.js';

/**
 * Minimal database interface compatible with better-sqlite3.
 * Consumers inject their own Database instance.
 */
export interface CypherLiteDatabase {
  prepare(sql: string): CypherLiteStatement;
  exec(sql: string): void;
}

export interface CypherLiteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

/** Schema creation SQL for the KG tables. */
export const KG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kg_entities (
  id          INTEGER PRIMARY KEY,
  canon_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  aliases     TEXT,
  confidence  REAL DEFAULT 1.0,
  artifact_id TEXT,
  run_id      TEXT,
  workspace_id TEXT,
  track       TEXT DEFAULT 'open',
  props       TEXT,
  created_at  TEXT,
  updated_at  TEXT,
  UNIQUE(canon_id, session_id)
);

CREATE TABLE IF NOT EXISTS kg_relationships (
  id          INTEGER PRIMARY KEY,
  from_id     INTEGER NOT NULL REFERENCES kg_entities(id),
  to_id       INTEGER NOT NULL REFERENCES kg_entities(id),
  predicate   TEXT NOT NULL,
  confidence  REAL DEFAULT 1.0,
  raw_predicate TEXT,
  artifact_id TEXT,
  run_id      TEXT,
  track       TEXT DEFAULT 'open',
  props       TEXT
);

CREATE TABLE IF NOT EXISTS kg_raw_triples (
  id               INTEGER PRIMARY KEY,
  subject          TEXT,
  predicate        TEXT,
  object           TEXT,
  subject_kind     TEXT,
  object_kind      TEXT,
  confidence       REAL,
  rationale        TEXT,
  triple_index     INTEGER,
  artifact_id      TEXT,
  source_file      TEXT,
  session_id       TEXT NOT NULL,
  run_id           TEXT,
  track            TEXT DEFAULT 'open',
  created_at       TEXT,
  subject_canon_id TEXT,
  object_canon_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_kg_entities_session ON kg_entities(session_id);
CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);
CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_canon_id ON kg_entities(canon_id);
CREATE INDEX IF NOT EXISTS idx_kg_rels_from ON kg_relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_kg_rels_to ON kg_relationships(to_id);
CREATE INDEX IF NOT EXISTS idx_kg_rels_predicate ON kg_relationships(predicate);
CREATE INDEX IF NOT EXISTS idx_kg_raw_session ON kg_raw_triples(session_id);
`;

/**
 * CypherLite engine — the main entry point.
 *
 * Parses Cypher, transpiles to SQL, and executes against SQLite.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { CypherLiteEngine } from '@intentweave/cypher-lite';
 *
 * const db = new Database(':memory:');
 * const engine = new CypherLiteEngine(db);
 * engine.initSchema();
 *
 * const results = engine.run(
 *   'MATCH (n:Entity) WHERE n.name = $name RETURN n.name, n.type',
 *   { name: 'AuthService' }
 * );
 * ```
 */
export class CypherLiteEngine {
  private db: CypherLiteDatabase;

  constructor(db: CypherLiteDatabase) {
    this.db = db;
  }

  /** Create the KG tables and indexes if they don't exist. */
  initSchema(): void {
    this.db.exec(KG_SCHEMA_SQL);
  }

  /**
   * Execute a Cypher query and return results.
   *
   * For read queries, returns an array of row objects.
   * For write queries, returns summary info.
   */
  run(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Record<string, unknown>[] {
    const ast = parse(cypher);
    const queries = transpile(ast, params);

    let lastResults: Record<string, unknown>[] = [];

    for (const q of queries) {
      if (q.kind === 'read') {
        lastResults = this.executeRead(q);
      } else {
        this.executeWrite(q);
      }
    }

    return lastResults;
  }

  /**
   * Execute a Cypher query that is known to be a read.
   * Alias for `run()` with explicit intent for type clarity.
   */
  query(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Record<string, unknown>[] {
    return this.run(cypher, params);
  }

  /**
   * Execute a Cypher write query
   * (CREATE, MERGE, DELETE, SET).
   */
  execute(
    cypher: string,
    params: Record<string, unknown> = {}
  ): void {
    const ast = parse(cypher);
    const queries = transpile(ast, params);

    for (const q of queries) {
      if (q.kind === 'write') {
        this.executeWrite(q);
      } else {
        this.executeRead(q);
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private executeRead(q: TranspiledQuery): Record<string, unknown>[] {
    // Handle multiple SQL statements (unlikely for reads but possible)
    const statements = q.sql.split(';').map((s) => s.trim()).filter(Boolean);
    let results: Record<string, unknown>[] = [];

    for (const sql of statements) {
      const stmt = this.db.prepare(sql);
      results = stmt.all(...q.params);
    }

    return results;
  }

  private executeWrite(q: TranspiledQuery): void {
    const statements = q.sql.split(';').map((s) => s.trim()).filter(Boolean);

    for (const sql of statements) {
      const stmt = this.db.prepare(sql);
      stmt.run(...q.params);
    }
  }
}
