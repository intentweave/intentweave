// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/cypher-lite — Lightweight Cypher subset parser and SQLite transpiler.
 *
 * Provides a Cypher-compatible query interface backed by SQLite, eliminating
 * the need for Neo4j in lightweight deployments. The engine supports the exact
 * Cypher subset used by IntentWeave's KG operations.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { CypherLiteEngine } from '@intentweave/cypher-lite';
 *
 * const db = new Database('.iw/kg.db');
 * const engine = new CypherLiteEngine(db);
 * engine.initSchema();
 *
 * // Read
 * const results = engine.query(
 *   'MATCH (n:Entity) WHERE n.name CONTAINS $term RETURN n.name, n.type LIMIT 10',
 *   { term: 'auth' }
 * );
 *
 * // Write
 * engine.execute(
 *   'MERGE (n:Entity {canonId: $id, sessionId: $session}) ON CREATE SET n.name = $name',
 *   { id: 'auth-service', session: 'my-project', name: 'AuthService' }
 * );
 * ```
 *
 * @packageDocumentation
 */

export { CypherLiteEngine, KG_SCHEMA_SQL } from './executor.js';
export type { CypherLiteDatabase, CypherLiteStatement } from './executor.js';

export { parse } from './parser.js';
export { CypherLiteParser } from './parser.js';

export { tokenize } from './tokenizer.js';
export { CypherLiteTokenizer } from './tokenizer.js';

export { transpile } from './transpiler.js';
export { CypherLiteTranspiler } from './transpiler.js';
export type { TranspiledQuery } from './transpiler.js';

export { TokenType } from './types.js';

export type {
  // AST types
  CypherStatement,
  Token,
  Clause,
  MatchClause,
  WhereClause,
  ReturnClause,
  CreateClause,
  MergeClause,
  DeleteClause,
  SetClause,
  UnwindClause,
  WithClause,
  OrderByClause,
  LimitClause,
  SkipClause,
  Pattern,
  NodePattern,
  RelationshipPattern,
  WhereExpression,
  PropertyExpr,
  ParameterExpr,
  LiteralExpr,
  FunctionCallExpr,
  VariableExpr,
} from './types.js';
