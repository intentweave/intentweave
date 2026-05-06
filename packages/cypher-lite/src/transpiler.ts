// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CypherLite SQL transpiler.
 *
 * Converts a Cypher AST into SQLite-compatible SQL queries.
 * Handles node patterns → table lookups, relationship patterns → JOINs,
 * variable-length paths → recursive CTEs, and all supported predicates.
 */

import {
  CypherStatement,
  Clause,
  MatchClause,
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
  ReturnItem,
  SetItem,
  OrderItem,
} from "./types.js";

/** Result of transpiling a Cypher statement. */
export interface TranspiledQuery {
  sql: string;
  /** Positional parameter values for the prepared statement. */
  params: unknown[];
  /** Whether this is a read or write operation. */
  kind: "read" | "write";
}

/**
 * Context accumulated during transpilation.
 * Tracks variable → table alias mappings and parameter bindings.
 */
interface TranspileContext {
  /** Variable name → table alias + id column */
  nodeBindings: Map<string, NodeBinding>;
  /** Relationship variable → join info */
  relBindings: Map<string, RelBinding>;
  /** FROM clause fragments */
  fromParts: string[];
  /** JOIN clause fragments */
  joinParts: string[];
  /** Parameters for JOIN ON clauses (emitted before WHERE params in SQL) */
  joinParams: unknown[];
  /** WHERE clause fragments */
  whereParts: string[];
  /** Parameters for WHERE / SELECT / ORDER / LIMIT (emitted after JOIN params) */
  params: unknown[];
  /** Parameters originating in SELECT expressions (must be emitted before JOIN/WHERE params). */
  selectParams: unknown[];
  /** CTE definitions (for variable-length paths) */
  ctes: string[];
  /** Parameters for CTE definitions */
  cteParams: unknown[];
  /** Auto-incrementing alias counter */
  aliasCounter: number;
}

interface NodeBinding {
  tableAlias: string;
  variable: string;
}

interface RelBinding {
  tableAlias: string;
  variable: string;
  fromNode: string;
  toNode: string;
}

export class CypherLiteTranspiler {
  private userParams: Record<string, unknown>;

  constructor(params: Record<string, unknown> = {}) {
    this.userParams = params;
  }

  transpile(stmt: CypherStatement): TranspiledQuery[] {
    const results: TranspiledQuery[] = [];
    let i = 0;

    while (i < stmt.clauses.length) {
      const clause = stmt.clauses[i];

      if (clause.type === "MatchClause") {
        // Collect consecutive MATCH + WHERE + optional MATCH + RETURN/WITH/DELETE/SET
        const { query, endIdx } = this.transpileReadBlock(stmt.clauses, i);
        results.push(query);
        i = endIdx;
      } else if (clause.type === "CreateClause") {
        results.push(this.transpileCreate(clause));
        i++;
      } else if (clause.type === "MergeClause") {
        results.push(...this.transpileMerge(clause));
        i++;
      } else if (clause.type === "DeleteClause") {
        results.push(this.transpileDeleteStandalone(clause));
        i++;
      } else if (clause.type === "UnwindClause") {
        // UNWIND + following clauses — expand inline
        const { queries, endIdx } = this.transpileUnwindBlock(stmt.clauses, i);
        results.push(...queries);
        i = endIdx;
      } else {
        i++;
      }
    }

    return results;
  }

  // ── Read block (MATCH ... [WHERE] ... RETURN) ─────────────────────

  private transpileReadBlock(
    clauses: Clause[],
    startIdx: number,
  ): { query: TranspiledQuery; endIdx: number } {
    const ctx = this.newContext();
    let i = startIdx;

    // Process all MATCH / OPTIONAL MATCH clauses
    while (
      i < clauses.length &&
      (clauses[i].type === "MatchClause" || clauses[i].type === "WhereClause")
    ) {
      const c = clauses[i];
      if (c.type === "MatchClause") {
        this.processMatch(c as MatchClause, ctx);
      }
      i++;
    }

    // Collect trailing clauses: RETURN, ORDER BY, LIMIT, SKIP, WITH, DELETE, SET
    let returnClause: ReturnClause | undefined;
    let withClause: WithClause | undefined;
    let orderBy: OrderByClause | undefined;
    let limit: LimitClause | undefined;
    let skip: SkipClause | undefined;
    let deleteClause: DeleteClause | undefined;
    let setClause: SetClause | undefined;

    while (i < clauses.length) {
      const c = clauses[i];
      if (c.type === "ReturnClause") {
        returnClause = c;
        i++;
      } else if (c.type === "WithClause") {
        withClause = c;
        i++;
      } else if (c.type === "OrderByClause") {
        orderBy = c;
        i++;
      } else if (c.type === "LimitClause") {
        limit = c;
        i++;
      } else if (c.type === "SkipClause") {
        skip = c;
        i++;
      } else if (c.type === "DeleteClause") {
        deleteClause = c;
        i++;
      } else if (c.type === "SetClause") {
        setClause = c;
        i++;
      } else {
        break;
      }
    }

    // Build SQL
    if (deleteClause) {
      const sql = this.buildDeleteSql(deleteClause, ctx);
      return {
        query: { sql, params: this.allParams(ctx), kind: "write" },
        endIdx: i,
      };
    }

    if (setClause) {
      const sql = this.buildUpdateSql(setClause, ctx);
      return {
        query: { sql, params: this.allParams(ctx), kind: "write" },
        endIdx: i,
      };
    }

    const items = returnClause?.items ?? withClause?.items ?? [];
    const distinct = returnClause?.distinct ?? withClause?.distinct ?? false;

    const selectParts = items.map((item) => {
      const before = ctx.params.length;
      const expr = this.exprToSql(item.expression, ctx);
      if (ctx.params.length > before) {
        const appended = ctx.params.splice(before);
        ctx.selectParams.push(...appended);
      }
      if (item.alias) {
        return `${expr} AS ${this.quoteId(item.alias)}`;
      }
      // Auto-alias property expressions to their Cypher name (e.g. n.name → "n.name")
      // to avoid column name collisions when multiple nodes share a property name
      const cypherAlias = this.cypherAlias(item.expression);
      return cypherAlias ? `${expr} AS "${cypherAlias}"` : expr;
    });

    const selectStr = selectParts.length > 0 ? selectParts.join(", ") : "*";
    const distinctStr = distinct ? "DISTINCT " : "";

    let sql = "";

    // CTEs
    if (ctx.ctes.length > 0) {
      sql += "WITH " + ctx.ctes.join(", ") + " ";
    }

    sql += `SELECT ${distinctStr}${selectStr}`;

    if (ctx.fromParts.length > 0) {
      sql += " FROM " + ctx.fromParts.join(", ");
    }

    if (ctx.joinParts.length > 0) {
      sql += " " + ctx.joinParts.join(" ");
    }

    if (ctx.whereParts.length > 0) {
      sql += " WHERE " + ctx.whereParts.join(" AND ");
    }

    if (orderBy) {
      const orderParts = orderBy.items.map(
        (item) => `${this.exprToSql(item.expression, ctx)} ${item.direction}`,
      );
      sql += " ORDER BY " + orderParts.join(", ");
    }

    if (limit) {
      sql += " LIMIT " + this.exprToSql(limit.count, ctx);
    }

    if (skip) {
      sql += " OFFSET " + this.exprToSql(skip.count, ctx);
    }

    return {
      query: { sql, params: this.allParams(ctx), kind: "read" },
      endIdx: i,
    };
  }

  // ── MATCH processing ──────────────────────────────────────────────

  private processMatch(match: MatchClause, ctx: TranspileContext): void {
    const pattern = match.pattern;
    const joinType = match.optional ? "LEFT JOIN" : "JOIN";

    let prevNodeVar: string | undefined;

    for (const element of pattern.elements) {
      if (element.type === "NodePattern") {
        this.processNodePattern(element, ctx, prevNodeVar === undefined);
        prevNodeVar = element.variable;
      } else if (element.type === "RelationshipPattern") {
        if (!prevNodeVar) {
          throw new Error("Relationship pattern without preceding node");
        }
        const nextElement = pattern.elements[
          pattern.elements.indexOf(element) + 1
        ] as NodePattern | undefined;
        const nextNodeVar = nextElement?.variable;

        if (element.variableLength) {
          this.processVariableLengthRel(
            element,
            prevNodeVar,
            nextNodeVar,
            ctx,
            joinType,
          );
        } else {
          this.processRelPattern(
            element,
            prevNodeVar,
            nextNodeVar,
            ctx,
            joinType,
          );
        }
      }
    }

    // WHERE clause attached to MATCH
    if (match.where) {
      ctx.whereParts.push(this.exprToSql(match.where, ctx));
    }
  }

  private processNodePattern(
    node: NodePattern,
    ctx: TranspileContext,
    isFirst: boolean,
  ): void {
    if (!node.variable) return;

    // Skip if already bound
    if (ctx.nodeBindings.has(node.variable)) return;

    const alias = this.nextAlias(ctx);
    ctx.nodeBindings.set(node.variable, {
      tableAlias: alias,
      variable: node.variable,
    });

    if (isFirst && ctx.fromParts.length === 0) {
      ctx.fromParts.push(`kg_entities ${alias}`);
    } else if (!isFirst) {
      // Additional unlinked nodes go into FROM (cross join)
      ctx.fromParts.push(`kg_entities ${alias}`);
    }

    // Label filter
    for (const label of node.labels) {
      if (label === "Entity" || label === "Canon") {
        // These are always implied
        continue;
      }
      ctx.whereParts.push(`${alias}.type = ?`);
      ctx.params.push(label.toUpperCase());
    }

    // Inline properties
    if (node.properties) {
      for (const entry of node.properties.entries) {
        const val = this.resolvePropertyValue(entry.value, ctx);
        ctx.whereParts.push(
          `${alias}.${this.mapPropertyColumn(entry.key)} = ?`,
        );
        ctx.params.push(val);
      }
    }
  }

  private processRelPattern(
    rel: RelationshipPattern,
    fromVar: string,
    toVar: string | undefined,
    ctx: TranspileContext,
    joinType: string,
  ): void {
    const relAlias = this.nextAlias(ctx);
    const fromBinding = ctx.nodeBindings.get(fromVar);
    if (!fromBinding) {
      throw new Error(`Unbound node variable: ${fromVar}`);
    }

    // Determine the target node binding
    let toAlias: string;
    if (toVar && ctx.nodeBindings.has(toVar)) {
      toAlias = ctx.nodeBindings.get(toVar)!.tableAlias;
    } else {
      toAlias = this.nextAlias(ctx);
      if (toVar) {
        ctx.nodeBindings.set(toVar, { tableAlias: toAlias, variable: toVar });
      }
    }

    // Direction handling
    let fromCol: string;
    let toCol: string;
    if (rel.direction === "outgoing") {
      fromCol = "from_id";
      toCol = "to_id";
    } else if (rel.direction === "incoming") {
      fromCol = "to_id";
      toCol = "from_id";
    } else {
      // Undirected: we'll use OR for both directions
      fromCol = "from_id";
      toCol = "to_id";
    }

    if (rel.direction === "undirected") {
      // Undirected: join where either direction matches
      let onClause =
        `(${relAlias}.from_id = ${fromBinding.tableAlias}.id AND ${relAlias}.to_id = ${toAlias}.id) ` +
        `OR (${relAlias}.to_id = ${fromBinding.tableAlias}.id AND ${relAlias}.from_id = ${toAlias}.id)`;
      if (rel.relTypes.length > 0) {
        onClause += ` AND ${this.relTypeFilter(relAlias, rel.relTypes, ctx)}`;
      }
      ctx.joinParts.push(
        `${joinType} kg_relationships ${relAlias} ON ${onClause}`,
      );
    } else {
      let onClause = `${relAlias}.${fromCol} = ${fromBinding.tableAlias}.id`;
      if (rel.relTypes.length > 0) {
        onClause += ` AND ${this.relTypeFilter(relAlias, rel.relTypes, ctx)}`;
      }
      ctx.joinParts.push(
        `${joinType} kg_relationships ${relAlias} ON ${onClause}`,
      );
    }

    // Join to the target entity table
    if (!ctx.nodeBindings.has(toVar ?? "") || toVar === undefined) {
      // Need to also join the target entity table
    }
    if (rel.direction !== "undirected") {
      ctx.joinParts.push(
        `${joinType} kg_entities ${toAlias} ON ${toAlias}.id = ${relAlias}.${toCol}`,
      );
    } else {
      // For undirected, the target is already covered by the OR
      ctx.joinParts.push(
        `${joinType} kg_entities ${toAlias} ON ` +
          `(${toAlias}.id = ${relAlias}.to_id OR ${toAlias}.id = ${relAlias}.from_id) ` +
          `AND ${toAlias}.id <> ${fromBinding.tableAlias}.id`,
      );
    }

    if (rel.variable) {
      ctx.relBindings.set(rel.variable, {
        tableAlias: relAlias,
        variable: rel.variable,
        fromNode: fromVar,
        toNode: toVar ?? "",
      });
    }
  }

  private processVariableLengthRel(
    rel: RelationshipPattern,
    fromVar: string,
    toVar: string | undefined,
    ctx: TranspileContext,
    joinType: string,
  ): void {
    const fromBinding = ctx.nodeBindings.get(fromVar);
    if (!fromBinding) {
      throw new Error(`Unbound node variable: ${fromVar}`);
    }

    const cteName = `_cte_${ctx.ctes.length}`;
    const minDepth = rel.variableLength?.min ?? 1;
    const maxDepth = rel.variableLength?.max ?? 10;

    // Direction-aware column references
    const fromCol = rel.direction === "incoming" ? "to_id" : "from_id";
    const toCol = rel.direction === "incoming" ? "from_id" : "to_id";

    // Relationship type filter
    let typeFilter = "";
    if (rel.relTypes.length > 0) {
      const placeholders = rel.relTypes.map(() => "?").join(", ");
      typeFilter = ` AND r.predicate IN (${placeholders})`;
      // We need params twice (base + recursive)
      ctx.cteParams.push(...rel.relTypes);
      ctx.cteParams.push(...rel.relTypes);
    }

    // Build recursive CTE
    const cte =
      `${cteName}(node_id, depth) AS (` +
      // Base case: from the start node
      `SELECT r.${toCol}, 1 FROM kg_relationships r ` +
      `WHERE r.${fromCol} = ${fromBinding.tableAlias}.id${typeFilter} ` +
      `UNION ALL ` +
      // Recursive case
      `SELECT r.${toCol}, ${cteName}.depth + 1 FROM ${cteName} ` +
      `JOIN kg_relationships r ON r.${fromCol} = ${cteName}.node_id${typeFilter} ` +
      `WHERE ${cteName}.depth < ${maxDepth}` +
      `)`;

    ctx.ctes.push(cte);

    // Add the target node
    const toAlias = this.nextAlias(ctx);
    if (toVar) {
      ctx.nodeBindings.set(toVar, { tableAlias: toAlias, variable: toVar });
    }

    ctx.joinParts.push(
      `${joinType} ${cteName} ON ${cteName}.depth >= ${minDepth}`,
    );
    ctx.joinParts.push(
      `${joinType} kg_entities ${toAlias} ON ${toAlias}.id = ${cteName}.node_id`,
    );
  }

  // ── CREATE ────────────────────────────────────────────────────────

  private transpileCreate(clause: CreateClause): TranspiledQuery {
    const parts: string[] = [];
    const params: unknown[] = [];

    for (const element of clause.pattern.elements) {
      if (element.type === "NodePattern" && element.properties) {
        const columns: string[] = [];
        const values: string[] = [];

        for (const entry of element.properties.entries) {
          columns.push(this.mapPropertyColumn(entry.key));
          values.push("?");
          params.push(this.resolveLiteralOrParam(entry.value));
        }

        // Add labels as type
        if (element.labels.length > 0) {
          columns.push("type");
          values.push("?");
          params.push(element.labels[element.labels.length - 1].toUpperCase());
        }

        parts.push(
          `INSERT INTO kg_entities (${columns.join(", ")}) VALUES (${values.join(", ")})`,
        );
      }
    }

    return {
      sql: parts.join("; "),
      params,
      kind: "write",
    };
  }

  // ── MERGE ─────────────────────────────────────────────────────────

  private transpileMerge(clause: MergeClause): TranspiledQuery[] {
    const results: TranspiledQuery[] = [];

    for (const element of clause.pattern.elements) {
      if (element.type !== "NodePattern") continue;

      const matchCols: string[] = [];
      const matchVals: unknown[] = [];

      // Build match criteria from labels and inline properties
      if (element.labels.length > 0) {
        matchCols.push("type");
        matchVals.push(element.labels[element.labels.length - 1].toUpperCase());
      }

      if (element.properties) {
        for (const entry of element.properties.entries) {
          matchCols.push(this.mapPropertyColumn(entry.key));
          matchVals.push(this.resolveLiteralOrParam(entry.value));
        }
      }

      // Collect ON CREATE SET and ON MATCH SET values
      const setOnCreate = clause.onCreateSet ?? [];
      const setOnMatch = clause.onMatchSet ?? [];

      // Build INSERT OR IGNORE + UPDATE
      const allCols = [...matchCols];
      const allVals = [...matchVals];

      for (const item of setOnCreate) {
        const col = this.mapPropertyColumn(item.property.property);
        if (!allCols.includes(col)) {
          allCols.push(col);
          allVals.push(this.resolveLiteralOrParam(item.value));
        }
      }

      // INSERT OR IGNORE to handle the "create if not exists" part
      const insertSql =
        `INSERT OR IGNORE INTO kg_entities (${allCols.join(", ")}) ` +
        `VALUES (${allCols.map(() => "?").join(", ")})`;
      results.push({ sql: insertSql, params: [...allVals], kind: "write" });

      // UPDATE for the "on match set" part
      if (setOnMatch.length > 0) {
        const updateParts: string[] = [];
        const updateParams: unknown[] = [];

        for (const item of setOnMatch) {
          updateParts.push(
            `${this.mapPropertyColumn(item.property.property)} = ?`,
          );
          updateParams.push(this.resolveLiteralOrParam(item.value));
        }

        const whereParts = matchCols.map((col) => `${col} = ?`);
        updateParams.push(...matchVals);

        const updateSql =
          `UPDATE kg_entities SET ${updateParts.join(", ")} ` +
          `WHERE ${whereParts.join(" AND ")}`;
        results.push({ sql: updateSql, params: updateParams, kind: "write" });
      }
    }

    return results;
  }

  // ── DELETE (standalone) ───────────────────────────────────────────

  private transpileDeleteStandalone(clause: DeleteClause): TranspiledQuery {
    // Simple variable-based delete without prior MATCH
    const vars = clause.expressions
      .filter((e): e is VariableExpr => e.type === "VariableExpr")
      .map((e) => e.name);

    const sql = clause.detach
      ? `DELETE FROM kg_entities WHERE id IN (SELECT id FROM kg_entities WHERE name IN (${vars.map(() => "?").join(", ")}))`
      : `DELETE FROM kg_entities WHERE name IN (${vars.map(() => "?").join(", ")})`;

    return { sql, params: vars, kind: "write" };
  }

  // ── DELETE (with MATCH context) ───────────────────────────────────

  private buildDeleteSql(clause: DeleteClause, ctx: TranspileContext): string {
    const vars = clause.expressions
      .filter((e): e is VariableExpr => e.type === "VariableExpr")
      .map((e) => e.name);

    const targets: string[] = [];
    for (const v of vars) {
      const binding = ctx.nodeBindings.get(v);
      if (binding) {
        targets.push(binding.tableAlias);
      }
    }

    if (targets.length === 0) {
      throw new Error("DELETE: no valid targets found");
    }

    // For DETACH DELETE, also delete relationships
    const stmts: string[] = [];
    if (clause.detach) {
      for (const alias of targets) {
        stmts.push(
          `DELETE FROM kg_relationships WHERE from_id IN ` +
            `(SELECT ${alias}.id FROM kg_entities ${alias}` +
            this.buildWhereFragment(ctx) +
            `)`,
        );
        stmts.push(
          `DELETE FROM kg_relationships WHERE to_id IN ` +
            `(SELECT ${alias}.id FROM kg_entities ${alias}` +
            this.buildWhereFragment(ctx) +
            `)`,
        );
      }
    }

    for (const alias of targets) {
      stmts.push(
        `DELETE FROM kg_entities WHERE id IN ` +
          `(SELECT ${alias}.id FROM kg_entities ${alias}` +
          this.buildWhereFragment(ctx) +
          `)`,
      );
    }

    return stmts.join("; ");
  }

  // ── UPDATE (with MATCH context) ───────────────────────────────────

  private buildUpdateSql(clause: SetClause, ctx: TranspileContext): string {
    const updates: string[] = [];
    for (const item of clause.items) {
      const binding = ctx.nodeBindings.get(item.property.object);
      if (binding) {
        const col = this.mapPropertyColumn(item.property.property);
        const val = this.exprToSql(item.value, ctx);
        updates.push(`${col} = ${val}`);
      }
    }

    return (
      `UPDATE kg_entities SET ${updates.join(", ")}` +
      this.buildWhereFragment(ctx)
    );
  }

  // ── UNWIND block ──────────────────────────────────────────────────

  private transpileUnwindBlock(
    clauses: Clause[],
    startIdx: number,
  ): { queries: TranspiledQuery[]; endIdx: number } {
    const unwind = clauses[startIdx] as UnwindClause;

    // Resolve the list parameter
    const listParam = this.resolveExprValue(unwind.expression);
    const list = Array.isArray(listParam) ? listParam : [listParam];

    // Collect remaining clauses after UNWIND
    const remainingClauses = clauses.slice(startIdx + 1);

    // For each item in the list, run the remaining clauses with the
    // unwind variable bound to the current item
    const queries: TranspiledQuery[] = [];
    for (const item of list) {
      // Create a temporary parameter binding
      const savedParams = { ...this.userParams };
      this.userParams[unwind.alias] = item;

      const tempStmt: CypherStatement = {
        type: "CypherStatement",
        clauses: remainingClauses,
      };

      queries.push(...this.transpile(tempStmt));
      this.userParams = savedParams;
    }

    return { queries, endIdx: clauses.length };
  }

  // ── Expression → SQL ──────────────────────────────────────────────

  private exprToSql(expr: WhereExpression, ctx: TranspileContext): string {
    switch (expr.type) {
      case "PropertyExpr":
        return this.propertyToSql(expr, ctx);

      case "ParameterExpr":
        return this.parameterToSql(expr, ctx);

      case "LiteralExpr":
        return this.literalToSql(expr, ctx);

      case "VariableExpr":
        return this.variableToSql(expr, ctx);

      case "ComparisonExpr":
        return `${this.exprToSql(expr.left, ctx)} ${expr.operator} ${this.exprToSql(expr.right, ctx)}`;

      case "LogicalExpr":
        return `(${this.exprToSql(expr.left, ctx)} ${expr.operator} ${this.exprToSql(expr.right, ctx)})`;

      case "NotExpr":
        return `NOT (${this.exprToSql(expr.expression, ctx)})`;

      case "InExpr":
        return `${this.exprToSql(expr.value, ctx)} IN (${this.exprToSql(expr.list, ctx)})`;

      case "ContainsExpr":
        return `${this.exprToSql(expr.value, ctx)} LIKE '%' || ${this.exprToSql(expr.substring, ctx)} || '%'`;

      case "StartsWithExpr":
        return `${this.exprToSql(expr.value, ctx)} LIKE ${this.exprToSql(expr.prefix, ctx)} || '%'`;

      case "EndsWithExpr":
        return `${this.exprToSql(expr.value, ctx)} LIKE '%' || ${this.exprToSql(expr.suffix, ctx)}`;

      case "IsNullExpr":
        return expr.negated
          ? `${this.exprToSql(expr.value, ctx)} IS NOT NULL`
          : `${this.exprToSql(expr.value, ctx)} IS NULL`;

      case "ExistsExpr":
        return this.existsToSql(expr, ctx);

      case "AnyExpr":
        return this.anyToSql(expr, ctx);

      case "FunctionCallExpr":
        return this.functionToSql(expr, ctx);

      default:
        throw new Error(
          `Unsupported expression type: ${(expr as WhereExpression).type}`,
        );
    }
  }

  private propertyToSql(expr: PropertyExpr, ctx: TranspileContext): string {
    // Check node bindings
    const nodeBinding = ctx.nodeBindings.get(expr.object);
    if (nodeBinding) {
      return `${nodeBinding.tableAlias}.${this.mapPropertyColumn(expr.property)}`;
    }

    // Check relationship bindings
    const relBinding = ctx.relBindings.get(expr.object);
    if (relBinding) {
      return `${relBinding.tableAlias}.${this.mapPropertyColumn(expr.property)}`;
    }

    // Fallback: unbound variable — use as-is
    return `${this.quoteId(expr.object)}.${this.mapPropertyColumn(expr.property)}`;
  }

  private parameterToSql(expr: ParameterExpr, ctx: TranspileContext): string {
    const val = this.userParams[expr.name];
    if (val === undefined) {
      throw new Error(`Unbound parameter: $${expr.name}`);
    }

    if (Array.isArray(val)) {
      // Expand array parameters inline
      const placeholders = val.map(() => "?");
      ctx.params.push(...val);
      return placeholders.join(", ");
    }

    ctx.params.push(val);
    return "?";
  }

  private literalToSql(expr: LiteralExpr, ctx: TranspileContext): string {
    if (expr.value === null) return "NULL";
    if (typeof expr.value === "boolean") return expr.value ? "1" : "0";
    if (typeof expr.value === "number") return String(expr.value);

    ctx.params.push(expr.value);
    return "?";
  }

  private variableToSql(expr: VariableExpr, ctx: TranspileContext): string {
    if (expr.name === "*") return "*";

    const nodeBinding = ctx.nodeBindings.get(expr.name);
    if (nodeBinding) {
      return `${nodeBinding.tableAlias}.id`;
    }

    const relBinding = ctx.relBindings.get(expr.name);
    if (relBinding) {
      return `${relBinding.tableAlias}.id`;
    }

    // Check if it's an unwind alias in params
    if (this.userParams[expr.name] !== undefined) {
      ctx.params.push(this.userParams[expr.name]);
      return "?";
    }

    return this.quoteId(expr.name);
  }

  private functionToSql(expr: FunctionCallExpr, ctx: TranspileContext): string {
    const name = expr.name.toLowerCase();

    switch (name) {
      case "count":
        if (expr.distinct && expr.args.length > 0) {
          return `COUNT(DISTINCT ${this.exprToSql(expr.args[0], ctx)})`;
        }
        if (
          expr.args.length === 0 ||
          (expr.args[0] as VariableExpr)?.name === "*"
        ) {
          return "COUNT(*)";
        }
        return `COUNT(${this.exprToSql(expr.args[0], ctx)})`;

      case "collect":
        if (expr.distinct) {
          return `json_group_array(DISTINCT ${this.exprToSql(expr.args[0], ctx)})`;
        }
        return `json_group_array(${this.exprToSql(expr.args[0], ctx)})`;

      case "tolower":
        return `LOWER(${this.exprToSql(expr.args[0], ctx)})`;

      case "coalesce":
        return `COALESCE(${expr.args.map((a) => this.exprToSql(a, ctx)).join(", ")})`;

      case "__concat":
        return `(${this.exprToSql(expr.args[0], ctx)} || ${this.exprToSql(expr.args[1], ctx)})`;

      case "__list":
        return expr.args.map((a) => this.exprToSql(a, ctx)).join(", ");

      case "__case": {
        let sql = "CASE";
        let i = 0;
        while (i + 1 < expr.args.length) {
          sql += ` WHEN ${this.exprToSql(expr.args[i], ctx)} THEN ${this.exprToSql(expr.args[i + 1], ctx)}`;
          i += 2;
        }
        if (i < expr.args.length) {
          sql += ` ELSE ${this.exprToSql(expr.args[i], ctx)}`;
        }
        sql += " END";
        return sql;
      }

      default:
        return `${name}(${expr.args.map((a) => this.exprToSql(a, ctx)).join(", ")})`;
    }
  }

  private existsToSql(expr: ExistsExpr, ctx: TranspileContext): string {
    // Build a subquery for EXISTS
    const subCtx = this.newContext();
    // Inherit node bindings from outer context for correlated subqueries
    for (const [key, val] of ctx.nodeBindings) {
      subCtx.nodeBindings.set(key, val);
    }
    // Keep alias generation monotonic across outer + subquery scopes
    // to avoid alias collisions (e.g. reusing _t0 for different tables).
    subCtx.aliasCounter = ctx.aliasCounter;

    // Process the pattern
    const pattern = expr.pattern;
    let anchoredFromOuter = false;
    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i];
      if (element.type === "NodePattern") {
        if (
          element.variable &&
          subCtx.nodeBindings.has(element.variable) &&
          subCtx.fromParts.length === 0
        ) {
          // Correlated variable: do not add it to FROM inside the subquery,
          // otherwise the alias is shadowed and correlation is lost.
          anchoredFromOuter = true;
          continue;
        }
        this.processNodePattern(element, subCtx, subCtx.fromParts.length === 0);
      } else if (element.type === "RelationshipPattern") {
        const prevNode = pattern.elements[i - 1] as NodePattern | undefined;
        const nextNode = pattern.elements[i + 1] as NodePattern | undefined;
        if (prevNode?.variable) {
          this.processRelPattern(
            element,
            prevNode.variable,
            nextNode?.variable,
            subCtx,
            "JOIN",
          );
        }
      }
    }

    // If a correlated pattern only references previously bound variables,
    // ensure the subquery still has a valid FROM anchor.
    if (!anchoredFromOuter && subCtx.fromParts.length === 0) {
      const firstNode = pattern.elements.find(
        (e): e is NodePattern => e.type === "NodePattern",
      );
      if (firstNode?.variable) {
        const binding = subCtx.nodeBindings.get(firstNode.variable);
        if (binding) {
          subCtx.fromParts.push(`kg_entities ${binding.tableAlias}`);
        }
      }
    }

    let subSql = "SELECT 1";
    if (subCtx.fromParts.length > 0) {
      subSql += " FROM " + subCtx.fromParts.join(", ");
      if (subCtx.joinParts.length > 0) {
        subSql += " " + subCtx.joinParts.join(" ");
      }
    } else if (subCtx.joinParts.length > 0) {
      const [firstJoin, ...remainingJoins] = subCtx.joinParts;
      // A correlated EXISTS may start from a relationship join and reference
      // only outer-bound node aliases. Promote the first JOIN into FROM.
      const promoted = firstJoin.match(
        /^(?:LEFT\s+)?JOIN\s+(.+?)\s+ON\s+(.+)$/i,
      );
      if (promoted) {
        subSql += " FROM " + promoted[1];
        subCtx.whereParts.unshift(promoted[2]);
      } else {
        subSql += " FROM " + firstJoin.replace(/^LEFT\s+JOIN\s+|^JOIN\s+/i, "");
      }
      if (remainingJoins.length > 0) {
        subSql += " " + remainingJoins.join(" ");
      }
    }
    if (subCtx.whereParts.length > 0) {
      subSql += " WHERE " + subCtx.whereParts.join(" AND ");
    }

    // Copy params from subcontext (all buckets go into parent params since EXISTS is inlined in WHERE)
    ctx.params.push(
      ...subCtx.cteParams,
      ...subCtx.joinParams,
      ...subCtx.params,
    );

    // Keep alias allocation monotonic after inlined EXISTS generation.
    ctx.aliasCounter = subCtx.aliasCounter;

    return `EXISTS (${subSql})`;
  }

  private anyToSql(expr: AnyExpr, ctx: TranspileContext): string {
    // ANY(x IN list WHERE pred) → translate to EXISTS with param expansion
    // For simple cases like ANY(label IN labels(n) WHERE ...), we simplify
    const listSql = this.exprToSql(expr.list, ctx);
    const predSql = this.exprToSql(expr.predicate, ctx);
    // Best-effort: use JSON functions if the list is a JSON array column
    return `EXISTS (SELECT 1 FROM json_each(${listSql}) WHERE ${predSql})`;
  }

  // ── Utility ───────────────────────────────────────────────────────

  private newContext(): TranspileContext {
    return {
      nodeBindings: new Map(),
      relBindings: new Map(),
      fromParts: [],
      joinParts: [],
      joinParams: [],
      whereParts: [],
      params: [],
      selectParams: [],
      ctes: [],
      cteParams: [],
      aliasCounter: 0,
    };
  }

  /** Combine all params in SQL emission order: CTEs → SELECT → JOINs → WHERE. */
  private allParams(ctx: TranspileContext): unknown[] {
    return [
      ...ctx.cteParams,
      ...ctx.selectParams,
      ...ctx.joinParams,
      ...ctx.params,
    ];
  }

  private nextAlias(ctx: TranspileContext): string {
    return `_t${ctx.aliasCounter++}`;
  }

  private buildWhereFragment(ctx: TranspileContext): string {
    if (ctx.whereParts.length === 0) return "";
    return " WHERE " + ctx.whereParts.join(" AND ");
  }

  /**
   * Map Cypher property names to SQLite column names.
   * Most properties map directly; some have different names in the schema.
   */
  private mapPropertyColumn(prop: string): string {
    const map: Record<string, string> = {
      canonId: "canon_id",
      sessionId: "session_id",
      artifactId: "artifact_id",
      runId: "run_id",
      workspaceId: "workspace_id",
      sourceFile: "source_file",
      rawPredicate: "raw_predicate",
      tripleIndex: "triple_index",
      subjectKind: "subject_kind",
      objectKind: "object_kind",
      subjectCanonId: "subject_canon_id",
      objectCanonId: "object_canon_id",
      createdAt: "created_at",
      updatedAt: "updated_at",
    };
    return map[prop] ?? prop;
  }

  private resolvePropertyValue(
    expr: WhereExpression,
    ctx: TranspileContext,
  ): unknown {
    if (expr.type === "LiteralExpr") return expr.value;
    if (expr.type === "ParameterExpr") return this.userParams[expr.name];
    return this.exprToSql(expr, ctx);
  }

  private resolveLiteralOrParam(expr: WhereExpression): unknown {
    if (expr.type === "LiteralExpr") return expr.value;
    if (expr.type === "ParameterExpr") {
      const val = this.userParams[expr.name];
      if (val === undefined)
        throw new Error(`Unbound parameter: $${expr.name}`);
      return val;
    }
    throw new Error(`Expected literal or parameter, got ${expr.type}`);
  }

  private resolveExprValue(expr: WhereExpression): unknown {
    if (expr.type === "LiteralExpr") return expr.value;
    if (expr.type === "ParameterExpr") {
      const val = this.userParams[expr.name];
      if (val === undefined)
        throw new Error(`Unbound parameter: $${expr.name}`);
      return val;
    }
    if (expr.type === "FunctionCallExpr" && expr.name === "__list") {
      return expr.args.map((a) => this.resolveExprValue(a));
    }
    throw new Error(`Cannot resolve expression value for ${expr.type}`);
  }

  private quoteId(name: string): string {
    // SQLite identifier quoting
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** Derive a Cypher-style alias for a RETURN expression (e.g. `n.name`). */
  private cypherAlias(expr: WhereExpression): string | undefined {
    if (expr.type === "PropertyExpr") {
      const pe = expr as PropertyExpr;
      // pe.object is a string (variable name) in our parser
      if (typeof pe.object === "string") {
        return `${pe.object}.${pe.property}`;
      }
    }
    return undefined;
  }

  private relTypeFilter(
    relAlias: string,
    relTypes: string[],
    ctx: TranspileContext,
  ): string {
    if (relTypes.length === 1) {
      ctx.joinParams.push(relTypes[0]);
      return `${relAlias}.predicate = ?`;
    }
    const placeholders = relTypes.map(() => "?").join(", ");
    ctx.joinParams.push(...relTypes);
    return `${relAlias}.predicate IN (${placeholders})`;
  }
}

/** Convenience function to transpile a Cypher AST to SQL. */
export function transpile(
  stmt: CypherStatement,
  params: Record<string, unknown> = {},
): TranspiledQuery[] {
  return new CypherLiteTranspiler(params).transpile(stmt);
}
