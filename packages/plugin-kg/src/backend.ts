// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j KG Backend — production-grade persistence via neo4j-driver.
 *
 * Provides entity/relationship persistence and Cypher query execution
 * against a Neo4j graph database. Implements the same PersistenceCapability
 * interface as plugin-kg-lite, so consuming code works identically with
 * either backend.
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";

// =============================================================================
// Types
// =============================================================================

export interface Neo4jConfig {
  uri?: string;
  user?: string;
  password?: string;
}

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

export class KgBackend {
  private driver: Driver;
  private closed = false;

  constructor(config: Neo4jConfig = {}) {
    const uri = config.uri ?? process.env.NEO4J_URI ?? "bolt://localhost:7687";
    const user =
      config.user ??
      process.env.NEO4J_USER ??
      process.env.NEO4J_USERNAME ??
      "neo4j";
    const password = config.password ?? process.env.NEO4J_PASSWORD;

    if (!password) {
      throw new Error(
        "Neo4j password required. Set NEO4J_PASSWORD environment variable.\n" +
          '  Example: export NEO4J_PASSWORD="your-password"\n' +
          "  Or start Neo4j with: docker run -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5\n" +
          "  Alternatively, use the kg-lite plugin for zero-config SQLite storage.",
      );
    }

    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  /**
   * Verify that the Neo4j connection works.
   */
  async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity();
  }

  /**
   * Persist entities and relationships to Neo4j.
   *
   * Uses MERGE for entities (upsert on canonId + session_id) and
   * CREATE for relationships.
   */
  async persist(data: PersistData): Promise<PersistResult> {
    const session = this.driver.session();
    try {
      return await this.persistInSession(session, data);
    } finally {
      await session.close();
    }
  }

  private async persistInSession(
    session: Session,
    data: PersistData,
  ): Promise<PersistResult> {
    const { entities, relationships, session: sessionId } = data;

    // Write entities via UNWIND + MERGE
    if (entities.length > 0) {
      await session.run(
        `
        UNWIND $entities AS e
        MERGE (n:Canon:Entity { canonId: e.canonId, session_id: $sessionId })
        ON CREATE SET
          n.name = e.name, n.type = e.type,
          n.aliases = e.aliases, n.confidence = e.confidence,
          n.track = 'open', n.created_at = datetime()
        ON MATCH SET
          n.confidence = CASE WHEN e.confidence > n.confidence
            THEN e.confidence ELSE n.confidence END,
          n.updated_at = datetime()
        `,
        {
          entities: entities.map((e) => ({
            canonId: e.canonId,
            name: e.name,
            type: e.type.toUpperCase(),
            aliases: e.aliases ?? [],
            confidence: e.confidence ?? 1.0,
          })),
          sessionId,
        },
      );
    }

    // Write relationships via UNWIND + MATCH + CREATE
    if (relationships.length > 0) {
      await session.run(
        `
        UNWIND $rels AS r
        MATCH (s:Canon:Entity { canonId: r.subjectCanonId, session_id: $sessionId })
        MATCH (o:Canon:Entity { canonId: r.objectCanonId, session_id: $sessionId })
        CREATE (s)-[:CANON_REL {
          predicate: r.predicate,
          confidence: r.confidence,
          rawPredicate: r.rawPredicate,
          track: 'open'
        }]->(o)
        `,
        {
          rels: relationships.map((r) => ({
            subjectCanonId: r.subjectCanonId,
            objectCanonId: r.objectCanonId,
            predicate: r.predicate,
            confidence: r.confidence ?? 1.0,
            rawPredicate: r.rawPredicate ?? r.predicate,
          })),
          sessionId,
        },
      );
    }

    return {
      entityCount: entities.length,
      relationshipCount: relationships.length,
    };
  }

  /**
   * Execute a Cypher query and return results as plain objects.
   */
  async query(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(cypher, params ?? {});
      return result.records.map((record) => {
        const obj: Record<string, unknown> = {};
        for (const key of record.keys) {
          const val = record.get(key);
          obj[key as string] = this.toPlain(val);
        }
        return obj;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get the underlying Neo4j driver (for advanced use cases).
   */
  getDriver(): Driver {
    return this.driver;
  }

  /**
   * Close the Neo4j driver connection.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      await this.driver.close();
      this.closed = true;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Convert Neo4j record values to plain JavaScript types.
   */
  private toPlain(val: unknown): unknown {
    if (val === null || val === undefined) return val;

    // Neo4j Integer → number
    if (typeof val === "object" && val !== null && "toNumber" in val) {
      return (val as { toNumber(): number }).toNumber();
    }

    // Neo4j Node → properties
    if (typeof val === "object" && val !== null && "properties" in val) {
      const node = val as { properties: Record<string, unknown> };
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.properties)) {
        props[k] = this.toPlain(v);
      }
      return props;
    }

    // Arrays
    if (Array.isArray(val)) {
      return val.map((v) => this.toPlain(v));
    }

    return val;
  }
}
