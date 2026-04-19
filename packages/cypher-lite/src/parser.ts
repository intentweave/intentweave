// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CypherLite parser.
 *
 * Recursive descent parser that converts a token stream into an AST.
 * Supports the Cypher subset used in IntentWeave KG queries.
 */

import { tokenize } from "./tokenizer.js";
import {
  Token,
  TokenType,
  CypherStatement,
  Clause,
  MatchClause,
  ReturnClause,
  ReturnItem,
  CreateClause,
  MergeClause,
  DeleteClause,
  SetClause,
  SetItem,
  UnwindClause,
  WithClause,
  OrderByClause,
  OrderItem,
  LimitClause,
  SkipClause,
  Pattern,
  PatternElement,
  NodePattern,
  RelationshipPattern,
  VariableLength,
  WhereExpression,
  PropertyExpr,
  ParameterExpr,
  LiteralExpr,
  FunctionCallExpr,
  VariableExpr,
  ComparisonExpr,
  LogicalExpr,
  NotExpr,
  InExpr,
  ContainsExpr,
  StartsWithExpr,
  EndsWithExpr,
  IsNullExpr,
  ExistsExpr,
  AnyExpr,
  MapLiteral,
  MapEntry,
} from "./types.js";

export class CypherLiteParser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): CypherStatement {
    const clauses: Clause[] = [];

    while (!this.isAtEnd()) {
      const clause = this.parseClause();
      if (clause) clauses.push(clause);
    }

    if (clauses.length === 0) {
      throw this.error("Empty query");
    }

    return { type: "CypherStatement", clauses };
  }

  // ── Clause dispatch ───────────────────────────────────────────────

  private parseClause(): Clause | null {
    const token = this.peek();

    switch (token.type) {
      case TokenType.MATCH:
        return this.parseMatch(false);

      case TokenType.OPTIONAL: {
        this.advance(); // consume OPTIONAL
        if (!this.check(TokenType.MATCH)) {
          throw this.error("Expected MATCH after OPTIONAL");
        }
        return this.parseMatch(true);
      }

      case TokenType.WHERE:
        // WHERE can be standalone or attached to MATCH — we parse it here
        // and the transpiler will handle it.
        return this.parseWhereClause();

      case TokenType.RETURN:
        return this.parseReturn();

      case TokenType.CREATE:
        return this.parseCreate();

      case TokenType.MERGE:
        return this.parseMerge();

      case TokenType.DELETE:
        return this.parseDelete(false);

      case TokenType.DETACH: {
        this.advance(); // consume DETACH
        if (!this.check(TokenType.DELETE)) {
          throw this.error("Expected DELETE after DETACH");
        }
        return this.parseDelete(true);
      }

      case TokenType.SET:
        return this.parseSet();

      case TokenType.UNWIND:
        return this.parseUnwind();

      case TokenType.WITH:
        return this.parseWith();

      case TokenType.ORDER:
        return this.parseOrderBy();

      case TokenType.LIMIT:
        return this.parseLimit();

      case TokenType.SKIP:
        return this.parseSkip();

      case TokenType.EOF:
        return null;

      default:
        throw this.error(`Unexpected token ${token.type} ('${token.value}')`);
    }
  }

  // ── MATCH ─────────────────────────────────────────────────────────

  private parseMatch(optional: boolean): MatchClause {
    this.advance(); // consume MATCH
    const pattern = this.parsePattern();
    let where: WhereExpression | undefined;
    if (this.check(TokenType.WHERE)) {
      this.advance(); // consume WHERE
      where = this.parseExpression();
    }
    return { type: "MatchClause", optional, pattern, where };
  }

  // ── WHERE (standalone clause) ─────────────────────────────────────

  private parseWhereClause() {
    this.advance(); // consume WHERE
    const expression = this.parseExpression();
    return { type: "WhereClause" as const, expression };
  }

  // ── RETURN ────────────────────────────────────────────────────────

  private parseReturn(): ReturnClause {
    this.advance(); // consume RETURN
    let distinct = false;
    if (this.check(TokenType.DISTINCT)) {
      this.advance();
      distinct = true;
    }
    const items = this.parseReturnItems();
    return { type: "ReturnClause", distinct, items };
  }

  private parseReturnItems(): ReturnItem[] {
    const items: ReturnItem[] = [];
    items.push(this.parseReturnItem());
    while (this.check(TokenType.COMMA)) {
      this.advance();
      items.push(this.parseReturnItem());
    }
    return items;
  }

  private parseReturnItem(): ReturnItem {
    const expression = this.parseExpression();
    let alias: string | undefined;
    if (this.check(TokenType.AS)) {
      this.advance();
      alias = this.expectIdentifier("alias");
    }
    return { expression, alias };
  }

  // ── CREATE ────────────────────────────────────────────────────────

  private parseCreate(): CreateClause {
    this.advance(); // consume CREATE
    const pattern = this.parsePattern();
    return { type: "CreateClause", pattern };
  }

  // ── MERGE ─────────────────────────────────────────────────────────

  private parseMerge(): MergeClause {
    this.advance(); // consume MERGE
    const pattern = this.parsePattern();
    let onCreateSet: SetItem[] | undefined;
    let onMatchSet: SetItem[] | undefined;

    while (this.check(TokenType.ON)) {
      this.advance(); // consume ON
      const token = this.peek();
      if (token.type === TokenType.CREATE) {
        this.advance(); // consume CREATE
        this.expect(TokenType.SET, "Expected SET after ON CREATE");
        onCreateSet = this.parseSetItems();
      } else if (token.type === TokenType.MATCH) {
        this.advance(); // consume MATCH
        this.expect(TokenType.SET, "Expected SET after ON MATCH");
        onMatchSet = this.parseSetItems();
      } else {
        throw this.error(
          `Expected CREATE or MATCH after ON, got ${token.type}`,
        );
      }
    }

    return { type: "MergeClause", pattern, onCreateSet, onMatchSet };
  }

  // ── DELETE ────────────────────────────────────────────────────────

  private parseDelete(detach: boolean): DeleteClause {
    this.advance(); // consume DELETE
    const expressions: WhereExpression[] = [];
    expressions.push(this.parsePrimary());
    while (this.check(TokenType.COMMA)) {
      this.advance();
      expressions.push(this.parsePrimary());
    }
    return { type: "DeleteClause", detach, expressions };
  }

  // ── SET ───────────────────────────────────────────────────────────

  private parseSet(): SetClause {
    this.advance(); // consume SET
    const items = this.parseSetItems();
    return { type: "SetClause", items };
  }

  private parseSetItems(): SetItem[] {
    const items: SetItem[] = [];
    items.push(this.parseSetItem());
    while (this.check(TokenType.COMMA)) {
      this.advance();
      items.push(this.parseSetItem());
    }
    return items;
  }

  private parseSetItem(): SetItem {
    const obj = this.expectIdentifier("SET property object");
    this.expect(TokenType.DOT, "Expected . in SET");
    const prop = this.expectIdentifier("SET property name");
    this.expect(TokenType.EQ, "Expected = in SET");
    const value = this.parseExpression();
    const property: PropertyExpr = {
      type: "PropertyExpr",
      object: obj,
      property: prop,
    };
    return { property, value };
  }

  // ── UNWIND ────────────────────────────────────────────────────────

  private parseUnwind(): UnwindClause {
    this.advance(); // consume UNWIND
    const expression = this.parseExpression();
    this.expect(TokenType.AS, "Expected AS in UNWIND");
    const alias = this.expectIdentifier("UNWIND alias");
    return { type: "UnwindClause", expression, alias };
  }

  // ── WITH ──────────────────────────────────────────────────────────

  private parseWith(): WithClause {
    this.advance(); // consume WITH
    let distinct = false;
    if (this.check(TokenType.DISTINCT)) {
      this.advance();
      distinct = true;
    }
    const items = this.parseReturnItems();
    let where: WhereExpression | undefined;
    if (this.check(TokenType.WHERE)) {
      this.advance();
      where = this.parseExpression();
    }
    return { type: "WithClause", distinct, items, where };
  }

  // ── ORDER BY ──────────────────────────────────────────────────────

  private parseOrderBy(): OrderByClause {
    this.advance(); // consume ORDER
    this.expect(TokenType.BY, "Expected BY after ORDER");
    const items: OrderItem[] = [];
    items.push(this.parseOrderItem());
    while (this.check(TokenType.COMMA)) {
      this.advance();
      items.push(this.parseOrderItem());
    }
    return { type: "OrderByClause", items };
  }

  private parseOrderItem(): OrderItem {
    const expression = this.parseExpression();
    let direction: "ASC" | "DESC" = "ASC";
    if (this.check(TokenType.ASC)) {
      this.advance();
    } else if (this.check(TokenType.DESC)) {
      this.advance();
      direction = "DESC";
    }
    return { expression, direction };
  }

  // ── LIMIT / SKIP ──────────────────────────────────────────────────

  private parseLimit(): LimitClause {
    this.advance(); // consume LIMIT
    const count = this.parsePrimary();
    return { type: "LimitClause", count };
  }

  private parseSkip(): SkipClause {
    this.advance(); // consume SKIP
    const count = this.parsePrimary();
    return { type: "SkipClause", count };
  }

  // ── Pattern ───────────────────────────────────────────────────────

  private parsePattern(): Pattern {
    const elements: PatternElement[] = [];
    elements.push(this.parseNodePattern());

    while (this.isRelStart()) {
      elements.push(this.parseRelationshipPattern());
      elements.push(this.parseNodePattern());
    }

    return { type: "Pattern", elements };
  }

  private parseNodePattern(): NodePattern {
    this.expect(TokenType.LPAREN, "Expected ( for node pattern");

    let variable: string | undefined;
    const labels: string[] = [];
    let properties: MapLiteral | undefined;

    // Variable name (optional)
    if (this.check(TokenType.IDENTIFIER)) {
      variable = this.advance().value;
    }

    // Labels (:Label1:Label2)
    while (this.check(TokenType.COLON)) {
      this.advance(); // consume :
      labels.push(this.expectIdentifier("label"));
    }

    // Inline properties { key: value }
    if (this.check(TokenType.LBRACE)) {
      properties = this.parseMapLiteral();
    }

    this.expect(TokenType.RPAREN, "Expected ) to close node pattern");

    return { type: "NodePattern", variable, labels, properties };
  }

  private isRelStart(): boolean {
    return (
      this.check(TokenType.MINUS) ||
      this.check(TokenType.ARROW_LEFT) ||
      this.check(TokenType.DASH)
    );
  }

  private parseRelationshipPattern(): RelationshipPattern {
    let direction: "outgoing" | "incoming" | "undirected" = "undirected";
    let variable: string | undefined;
    let relTypes: string[] = [];
    let variableLength: VariableLength | undefined;
    let properties: MapLiteral | undefined;

    // Left side: <- or - or --
    if (this.check(TokenType.ARROW_LEFT)) {
      direction = "incoming";
      this.advance();
    } else if (this.check(TokenType.DASH)) {
      // --[...]--  undirected
      this.advance();
    } else if (this.check(TokenType.MINUS)) {
      this.advance();
    }

    // [r:TYPE*1..3]
    if (this.check(TokenType.LBRACKET)) {
      this.advance();

      // Variable
      if (this.check(TokenType.IDENTIFIER)) {
        variable = this.advance().value;
      }

      // :TYPE1|TYPE2
      if (this.check(TokenType.COLON)) {
        this.advance();
        relTypes.push(this.expectIdentifier("relationship type"));
        while (this.check(TokenType.PIPE)) {
          this.advance();
          relTypes.push(this.expectIdentifier("relationship type"));
        }
      }

      // *1..3 or * or *..3 or *1..
      if (this.check(TokenType.STAR)) {
        this.advance();
        variableLength = this.parseVariableLength();
      }

      // Inline properties
      if (this.check(TokenType.LBRACE)) {
        properties = this.parseMapLiteral();
      }

      this.expect(TokenType.RBRACKET, "Expected ] to close relationship");
    }

    // Right side: -> or - or --
    if (this.check(TokenType.ARROW_RIGHT)) {
      if (direction === "incoming") {
        throw this.error("Invalid relationship direction: both <- and ->");
      }
      direction = "outgoing";
      this.advance();
    } else if (this.check(TokenType.DASH)) {
      this.advance();
    } else if (this.check(TokenType.MINUS)) {
      this.advance();
    }

    return {
      type: "RelationshipPattern",
      variable,
      relTypes,
      direction,
      variableLength,
      properties,
    };
  }

  private parseVariableLength(): VariableLength {
    let min: number | undefined;
    let max: number | undefined;

    if (this.check(TokenType.NUMBER)) {
      min = parseInt(this.advance().value, 10);
    }

    if (this.check(TokenType.DOT)) {
      this.advance();
      this.expect(TokenType.DOT, "Expected .. in variable length");
      if (this.check(TokenType.NUMBER)) {
        max = parseInt(this.advance().value, 10);
      }
    } else if (min !== undefined) {
      // *3 means exactly 3
      max = min;
    }

    return { min, max };
  }

  // ── Map literal ───────────────────────────────────────────────────

  private parseMapLiteral(): MapLiteral {
    this.expect(TokenType.LBRACE, "Expected {");
    const entries: MapEntry[] = [];

    if (!this.check(TokenType.RBRACE)) {
      entries.push(this.parseMapEntry());
      while (this.check(TokenType.COMMA)) {
        this.advance();
        entries.push(this.parseMapEntry());
      }
    }

    this.expect(TokenType.RBRACE, "Expected }");
    return { type: "MapLiteral", entries };
  }

  private parseMapEntry(): MapEntry {
    const key = this.expectIdentifier("map key");
    this.expect(TokenType.COLON, "Expected : in map entry");
    const value = this.parseExpression();
    return { key, value };
  }

  // ── Expression parsing (precedence climbing) ──────────────────────

  private parseExpression(): WhereExpression {
    return this.parseOr();
  }

  private parseOr(): WhereExpression {
    let left = this.parseAnd();
    while (this.check(TokenType.OR)) {
      this.advance();
      const right = this.parseAnd();
      left = {
        type: "LogicalExpr",
        operator: "OR",
        left,
        right,
      } as LogicalExpr;
    }
    return left;
  }

  private parseAnd(): WhereExpression {
    let left = this.parseNot();
    while (this.check(TokenType.AND)) {
      this.advance();
      const right = this.parseNot();
      left = {
        type: "LogicalExpr",
        operator: "AND",
        left,
        right,
      } as LogicalExpr;
    }
    return left;
  }

  private parseNot(): WhereExpression {
    if (this.check(TokenType.NOT)) {
      this.advance();
      const expr = this.parseNot();
      return { type: "NotExpr", expression: expr } as NotExpr;
    }
    return this.parseComparison();
  }

  private parseComparison(): WhereExpression {
    let left = this.parseAddSub();

    // String predicates: CONTAINS, STARTS WITH, ENDS WITH
    if (this.check(TokenType.CONTAINS)) {
      this.advance();
      const right = this.parseAddSub();
      return {
        type: "ContainsExpr",
        value: left,
        substring: right,
      } as ContainsExpr;
    }
    if (this.check(TokenType.STARTS)) {
      this.advance();
      // "STARTS WITH" is two tokens
      if (this.check(TokenType.WITH)) {
        this.advance();
      }
      const right = this.parseAddSub();
      return {
        type: "StartsWithExpr",
        value: left,
        prefix: right,
      } as StartsWithExpr;
    }
    if (this.check(TokenType.ENDS)) {
      this.advance();
      // "ENDS WITH" is two tokens
      if (this.check(TokenType.WITH)) {
        this.advance();
      }
      const right = this.parseAddSub();
      return {
        type: "EndsWithExpr",
        value: left,
        suffix: right,
      } as EndsWithExpr;
    }

    // IN
    if (this.check(TokenType.IN)) {
      this.advance();
      const list = this.parseAddSub();
      return { type: "InExpr", value: left, list } as InExpr;
    }

    // IS NULL / IS NOT NULL
    if (this.check(TokenType.IS)) {
      this.advance();
      let negated = false;
      if (this.check(TokenType.NOT)) {
        this.advance();
        negated = true;
      }
      this.expect(TokenType.NULL, "Expected NULL after IS [NOT]");
      return { type: "IsNullExpr", value: left, negated } as IsNullExpr;
    }

    // Comparison operators
    const opMap: Partial<Record<TokenType, ComparisonExpr["operator"]>> = {
      [TokenType.EQ]: "=",
      [TokenType.NEQ]: "<>",
      [TokenType.LT]: "<",
      [TokenType.GT]: ">",
      [TokenType.LTE]: "<=",
      [TokenType.GTE]: ">=",
    };

    const op = opMap[this.peek().type];
    if (op) {
      this.advance();
      const right = this.parseAddSub();
      return {
        type: "ComparisonExpr",
        operator: op,
        left,
        right,
      } as ComparisonExpr;
    }

    return left;
  }

  private parseAddSub(): WhereExpression {
    let left = this.parsePrimary();

    while (this.check(TokenType.PLUS)) {
      this.advance();
      const right = this.parsePrimary();
      left = {
        type: "FunctionCallExpr",
        name: "__concat",
        args: [left, right],
      } as FunctionCallExpr;
    }

    return left;
  }

  // ── Primary expressions ───────────────────────────────────────────

  private parsePrimary(): WhereExpression {
    const token = this.peek();

    // Parenthesized expression
    if (token.type === TokenType.LPAREN) {
      this.advance();
      const expr = this.parseExpression();
      this.expect(TokenType.RPAREN, "Expected )");
      return expr;
    }

    // Parameter ($name)
    if (token.type === TokenType.PARAMETER) {
      this.advance();
      return { type: "ParameterExpr", name: token.value } as ParameterExpr;
    }

    // String literal
    if (token.type === TokenType.STRING) {
      this.advance();
      return { type: "LiteralExpr", value: token.value } as LiteralExpr;
    }

    // Number literal
    if (token.type === TokenType.NUMBER) {
      this.advance();
      const numVal = token.value.includes(".")
        ? parseFloat(token.value)
        : parseInt(token.value, 10);
      return { type: "LiteralExpr", value: numVal } as LiteralExpr;
    }

    // Boolean literals
    if (token.type === TokenType.TRUE) {
      this.advance();
      return { type: "LiteralExpr", value: true } as LiteralExpr;
    }
    if (token.type === TokenType.FALSE) {
      this.advance();
      return { type: "LiteralExpr", value: false } as LiteralExpr;
    }

    // NULL literal
    if (token.type === TokenType.NULL) {
      this.advance();
      return { type: "LiteralExpr", value: null } as LiteralExpr;
    }

    // List literal [a, b, c]
    if (token.type === TokenType.LBRACKET) {
      return this.parseListLiteral();
    }

    // NOT EXISTS { ... }
    if (token.type === TokenType.NOT) {
      this.advance();
      if (this.check(TokenType.EXISTS)) {
        const existsExpr = this.parseExistsExpr();
        return { type: "NotExpr", expression: existsExpr } as NotExpr;
      }
      const expr = this.parsePrimary();
      return { type: "NotExpr", expression: expr } as NotExpr;
    }

    // EXISTS { MATCH pattern }
    if (token.type === TokenType.EXISTS) {
      return this.parseExistsExpr();
    }

    // ANY(x IN list WHERE pred)
    if (token.type === TokenType.ANY) {
      return this.parseAnyExpr();
    }

    // CASE WHEN ... THEN ... ELSE ... END
    if (token.type === TokenType.CASE) {
      return this.parseCaseExpr();
    }

    // STAR (for COUNT(*))
    if (token.type === TokenType.STAR) {
      this.advance();
      return { type: "VariableExpr", name: "*" } as VariableExpr;
    }

    // Function call or identifier with property access
    // Functions: count, collect, coalesce, toLower, DISTINCT
    if (this.isFunctionName(token.type)) {
      return this.parseFunctionCall();
    }

    if (token.type === TokenType.IDENTIFIER) {
      return this.parseIdentifierExpr();
    }

    // COALESCE as a function
    if (token.type === TokenType.COALESCE) {
      return this.parseFunctionCall();
    }

    throw this.error(
      `Unexpected token in expression: ${token.type} ('${token.value}')`,
    );
  }

  private parseIdentifierExpr(): WhereExpression {
    const name = this.advance().value;

    // Function call: name(...)
    if (this.check(TokenType.LPAREN)) {
      this.pos--; // back up so parseFunctionCall reads the name
      return this.parseFunctionCall();
    }

    // Property access: name.prop
    if (this.check(TokenType.DOT)) {
      this.advance();
      const prop = this.expectIdentifier("property name");
      return {
        type: "PropertyExpr",
        object: name,
        property: prop,
      } as PropertyExpr;
    }

    return { type: "VariableExpr", name } as VariableExpr;
  }

  private isFunctionName(type: TokenType): boolean {
    return (
      type === TokenType.COUNT ||
      type === TokenType.COLLECT ||
      type === TokenType.COALESCE ||
      type === TokenType.TOLOWER
    );
  }

  private parseFunctionCall(): FunctionCallExpr {
    const nameToken = this.advance();
    const name = nameToken.value.toLowerCase();
    this.expect(TokenType.LPAREN, `Expected ( after function name ${name}`);

    let distinct = false;
    if (this.check(TokenType.DISTINCT)) {
      this.advance();
      distinct = true;
    }

    const args: WhereExpression[] = [];
    if (!this.check(TokenType.RPAREN)) {
      args.push(this.parseExpression());
      while (this.check(TokenType.COMMA)) {
        this.advance();
        args.push(this.parseExpression());
      }
    }

    this.expect(TokenType.RPAREN, `Expected ) after function args`);
    return { type: "FunctionCallExpr", name, args, distinct };
  }

  private parseExistsExpr(): ExistsExpr {
    this.advance(); // consume EXISTS
    this.expect(TokenType.LBRACE, "Expected { after EXISTS");

    // EXISTS { MATCH (a)-[r]->(b) } or just EXISTS { (a)-[r]->(b) }
    if (this.check(TokenType.MATCH)) {
      this.advance(); // consume MATCH
    }

    const pattern = this.parsePattern();
    this.expect(TokenType.RBRACE, "Expected } to close EXISTS");
    return { type: "ExistsExpr", pattern };
  }

  private parseAnyExpr(): AnyExpr {
    this.advance(); // consume ANY
    this.expect(TokenType.LPAREN, "Expected ( after ANY");
    const variable = this.expectIdentifier("ANY variable");
    this.expect(TokenType.IN, "Expected IN in ANY");
    const list = this.parseExpression();
    this.expect(TokenType.WHERE, "Expected WHERE in ANY");
    const predicate = this.parseExpression();
    this.expect(TokenType.RPAREN, "Expected ) to close ANY");
    return { type: "AnyExpr", variable, list, predicate };
  }

  private parseCaseExpr(): FunctionCallExpr {
    this.advance(); // consume CASE
    // Simple CASE WHEN ... THEN ... [ELSE ...] END → encode as __case function
    const args: WhereExpression[] = [];
    while (this.check(TokenType.WHEN)) {
      this.advance();
      args.push(this.parseExpression()); // condition
      this.expect(TokenType.THEN, "Expected THEN in CASE");
      args.push(this.parseExpression()); // result
    }
    if (this.check(TokenType.ELSE)) {
      this.advance();
      args.push(this.parseExpression()); // else value
    }
    this.expect(TokenType.END, "Expected END for CASE");
    return { type: "FunctionCallExpr", name: "__case", args };
  }

  private parseListLiteral(): FunctionCallExpr {
    this.advance(); // consume [
    const args: WhereExpression[] = [];
    if (!this.check(TokenType.RBRACKET)) {
      args.push(this.parseExpression());
      while (this.check(TokenType.COMMA)) {
        this.advance();
        args.push(this.parseExpression());
      }
    }
    this.expect(TokenType.RBRACKET, "Expected ]");
    // Encode as a __list pseudo-function
    return { type: "FunctionCallExpr", name: "__list", args };
  }

  // ── Token utilities ───────────────────────────────────────────────

  private peek(): Token {
    return (
      this.tokens[this.pos] ?? { type: TokenType.EOF, value: "", position: -1 }
    );
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private expect(type: TokenType, message: string): Token {
    if (!this.check(type)) {
      const got = this.peek();
      throw this.error(`${message}: got ${got.type} ('${got.value}')`);
    }
    return this.advance();
  }

  private expectIdentifier(context: string): string {
    const token = this.peek();
    // Many keywords can also be used as identifiers in Cypher
    if (
      token.type === TokenType.IDENTIFIER ||
      this.isContextualIdentifier(token.type)
    ) {
      this.advance();
      return token.value;
    }
    throw this.error(`Expected identifier for ${context}, got ${token.type}`);
  }

  private isContextualIdentifier(type: TokenType): boolean {
    // Keywords that can appear as identifiers in certain contexts
    return (
      type === TokenType.COUNT ||
      type === TokenType.COLLECT ||
      type === TokenType.COALESCE ||
      type === TokenType.TOLOWER ||
      type === TokenType.EXISTS ||
      type === TokenType.ANY
    );
  }

  private isAtEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }

  private error(message: string): Error {
    const token = this.peek();
    return new Error(
      `CypherLite parse error at position ${token.position}: ${message}`,
    );
  }
}

/** Parse a Cypher string into an AST. */
export function parse(cypher: string): CypherStatement {
  const tokens = tokenize(cypher);
  const parser = new CypherLiteParser(tokens);
  return parser.parse();
}
