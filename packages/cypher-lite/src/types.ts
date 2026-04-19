// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CypherLite AST types.
 *
 * Represents the subset of Cypher supported by IntentWeave's KG queries.
 */

// ── Tokens ──────────────────────────────────────────────────────────

export enum TokenType {
  // Keywords
  MATCH = 'MATCH',
  OPTIONAL = 'OPTIONAL',
  WHERE = 'WHERE',
  RETURN = 'RETURN',
  ORDER = 'ORDER',
  BY = 'BY',
  LIMIT = 'LIMIT',
  SKIP = 'SKIP',
  CREATE = 'CREATE',
  MERGE = 'MERGE',
  DELETE = 'DELETE',
  DETACH = 'DETACH',
  SET = 'SET',
  ON = 'ON',
  UNWIND = 'UNWIND',
  WITH = 'WITH',
  AS = 'AS',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  IN = 'IN',
  IS = 'IS',
  NULL = 'NULL',
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  CONTAINS = 'CONTAINS',
  STARTS = 'STARTS',
  ENDS = 'ENDS',
  ANY = 'ANY',
  DISTINCT = 'DISTINCT',
  CASE = 'CASE',
  WHEN = 'WHEN',
  THEN = 'THEN',
  ELSE = 'ELSE',
  END = 'END',
  ASC = 'ASC',
  DESC = 'DESC',
  EXISTS = 'EXISTS',
  COUNT = 'COUNT',
  COLLECT = 'COLLECT',
  COALESCE = 'COALESCE',
  TOLOWER = 'TOLOWER',

  // Literals & identifiers
  IDENTIFIER = 'IDENTIFIER',
  STRING = 'STRING',
  NUMBER = 'NUMBER',
  PARAMETER = 'PARAMETER',

  // Operators
  EQ = '=',
  NEQ = '<>',
  LT = '<',
  GT = '>',
  LTE = '<=',
  GTE = '>=',
  PLUS = '+',
  MINUS = '-',

  // Punctuation
  LPAREN = '(',
  RPAREN = ')',
  LBRACKET = '[',
  RBRACKET = ']',
  LBRACE = '{',
  RBRACE = '}',
  COLON = ':',
  DOT = '.',
  COMMA = ',',
  STAR = '*',
  PIPE = '|',
  ARROW_RIGHT = '->',
  ARROW_LEFT = '<-',
  DASH = '--',

  // Special
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

// ── AST Nodes ───────────────────────────────────────────────────────

export type CypherStatement = {
  type: 'CypherStatement';
  clauses: Clause[];
};

export type Clause =
  | MatchClause
  | WhereClause
  | ReturnClause
  | CreateClause
  | MergeClause
  | DeleteClause
  | SetClause
  | UnwindClause
  | WithClause
  | OrderByClause
  | LimitClause
  | SkipClause;

// ── Match ───────────────────────────────────────────────────────────

export interface MatchClause {
  type: 'MatchClause';
  optional: boolean;
  pattern: Pattern;
  where?: WhereExpression;
}

export interface Pattern {
  type: 'Pattern';
  elements: PatternElement[];
}

export type PatternElement = NodePattern | RelationshipPattern;

export interface NodePattern {
  type: 'NodePattern';
  variable?: string;
  labels: string[];
  properties?: MapLiteral;
}

export interface RelationshipPattern {
  type: 'RelationshipPattern';
  variable?: string;
  relTypes: string[];
  direction: 'outgoing' | 'incoming' | 'undirected';
  variableLength?: VariableLength;
  properties?: MapLiteral;
}

export interface VariableLength {
  min?: number;
  max?: number;
}

// ── Where ───────────────────────────────────────────────────────────

export interface WhereClause {
  type: 'WhereClause';
  expression: WhereExpression;
}

export type WhereExpression =
  | ComparisonExpr
  | LogicalExpr
  | NotExpr
  | InExpr
  | ContainsExpr
  | StartsWithExpr
  | EndsWithExpr
  | IsNullExpr
  | ExistsExpr
  | AnyExpr
  | PropertyExpr
  | ParameterExpr
  | LiteralExpr
  | FunctionCallExpr
  | VariableExpr;

export interface ComparisonExpr {
  type: 'ComparisonExpr';
  operator: '=' | '<>' | '<' | '>' | '<=' | '>=';
  left: WhereExpression;
  right: WhereExpression;
}

export interface LogicalExpr {
  type: 'LogicalExpr';
  operator: 'AND' | 'OR';
  left: WhereExpression;
  right: WhereExpression;
}

export interface NotExpr {
  type: 'NotExpr';
  expression: WhereExpression;
}

export interface InExpr {
  type: 'InExpr';
  value: WhereExpression;
  list: WhereExpression;
}

export interface ContainsExpr {
  type: 'ContainsExpr';
  value: WhereExpression;
  substring: WhereExpression;
}

export interface StartsWithExpr {
  type: 'StartsWithExpr';
  value: WhereExpression;
  prefix: WhereExpression;
}

export interface EndsWithExpr {
  type: 'EndsWithExpr';
  value: WhereExpression;
  suffix: WhereExpression;
}

export interface IsNullExpr {
  type: 'IsNullExpr';
  value: WhereExpression;
  negated: boolean; // IS NOT NULL
}

export interface ExistsExpr {
  type: 'ExistsExpr';
  pattern: Pattern;
}

export interface AnyExpr {
  type: 'AnyExpr';
  variable: string;
  list: WhereExpression;
  predicate: WhereExpression;
}

export interface PropertyExpr {
  type: 'PropertyExpr';
  object: string;
  property: string;
}

export interface ParameterExpr {
  type: 'ParameterExpr';
  name: string;
}

export interface LiteralExpr {
  type: 'LiteralExpr';
  value: string | number | boolean | null;
}

export interface FunctionCallExpr {
  type: 'FunctionCallExpr';
  name: string;
  args: WhereExpression[];
  distinct?: boolean;
}

export interface VariableExpr {
  type: 'VariableExpr';
  name: string;
}

// ── Return ──────────────────────────────────────────────────────────

export interface ReturnClause {
  type: 'ReturnClause';
  distinct: boolean;
  items: ReturnItem[];
}

export interface ReturnItem {
  expression: WhereExpression;
  alias?: string;
}

// ── Create / Merge / Delete / Set ───────────────────────────────────

export interface CreateClause {
  type: 'CreateClause';
  pattern: Pattern;
}

export interface MergeClause {
  type: 'MergeClause';
  pattern: Pattern;
  onCreateSet?: SetItem[];
  onMatchSet?: SetItem[];
}

export interface DeleteClause {
  type: 'DeleteClause';
  detach: boolean;
  expressions: WhereExpression[];
}

export interface SetClause {
  type: 'SetClause';
  items: SetItem[];
}

export interface SetItem {
  property: PropertyExpr;
  value: WhereExpression;
}

// ── Unwind / With ───────────────────────────────────────────────────

export interface UnwindClause {
  type: 'UnwindClause';
  expression: WhereExpression;
  alias: string;
}

export interface WithClause {
  type: 'WithClause';
  distinct: boolean;
  items: ReturnItem[];
  where?: WhereExpression;
}

// ── Order / Limit / Skip ────────────────────────────────────────────

export interface OrderByClause {
  type: 'OrderByClause';
  items: OrderItem[];
}

export interface OrderItem {
  expression: WhereExpression;
  direction: 'ASC' | 'DESC';
}

export interface LimitClause {
  type: 'LimitClause';
  count: WhereExpression;
}

export interface SkipClause {
  type: 'SkipClause';
  count: WhereExpression;
}

// ── Map Literal ─────────────────────────────────────────────────────

export interface MapLiteral {
  type: 'MapLiteral';
  entries: MapEntry[];
}

export interface MapEntry {
  key: string;
  value: WhereExpression;
}
