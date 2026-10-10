// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * @intentweave/sqlite-compat
 *
 * Thin compatibility wrapper around Node.js built-in `node:sqlite` that
 * exposes the same synchronous API as `better-sqlite3`.  This removes the
 * only native-compiled dependency from the query stack — `node:sqlite` ships
 * with Node.js ≥ 22.15 and requires no additional installation step.
 *
 * API surface covered:
 *   new Database(path, { readonly? })
 *   db.prepare(sql)   → StatementCompat
 *   db.exec(sql)
 *   db.pragma(source) → maps to PRAGMA statement
 *   db.transaction(fn)→ BEGIN / COMMIT / ROLLBACK wrapper
 *   db.close()
 *   stmt.all(...params)
 *   stmt.get(...params)
 *   stmt.run(...params) → { changes, lastInsertRowid }
 */

import { DatabaseSync, StatementSync } from "node:sqlite";

// Suppress the ExperimentalWarning emitted by Node 22 for node:sqlite.
// The feature is stable in Node 24; until then, suppress the noise.
process.on("warning", (warning: Error) => {
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message.includes("SQLite")
  ) {
    // swallow — handled by overriding the listener below
  }
});
// Remove the default process warning handler for this specific warning
{
  const _warn = process.emitWarning.bind(process);
  process.emitWarning = function (
    warning: string | Error,
    ...args: unknown[]
  ): void {
    const msg =
      typeof warning === "string"
        ? warning
        : ((warning as Error).message ?? "");
    if (msg.includes("SQLite") && msg.includes("experimental")) return;
    (_warn as (w: string | Error, ...a: unknown[]) => void)(warning, ...args);
  };
}

// ---------------------------------------------------------------------------
// RunResult — mirrors better-sqlite3's RunResult
// ---------------------------------------------------------------------------

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteMetrics {
  statementRunCount: number;
  statementRunMs: number;
  statementReadCount: number;
  statementReadMs: number;
  execCallCount: number;
  execCallMs: number;
  transactionCount: number;
  transactionBodyMs: number;
  beginCount: number;
  beginMs: number;
  commitCount: number;
  commitMs: number;
  rollbackCount: number;
  rollbackMs: number;
  closeCount: number;
  closeMs: number;
}

export function createSqliteMetrics(): SqliteMetrics {
  return {
    statementRunCount: 0,
    statementRunMs: 0,
    statementReadCount: 0,
    statementReadMs: 0,
    execCallCount: 0,
    execCallMs: 0,
    transactionCount: 0,
    transactionBodyMs: 0,
    beginCount: 0,
    beginMs: 0,
    commitCount: 0,
    commitMs: 0,
    rollbackCount: 0,
    rollbackMs: 0,
    closeCount: 0,
    closeMs: 0,
  };
}

// ---------------------------------------------------------------------------
// StatementCompat — wraps StatementSync with the better-sqlite3 Statement API
//
// Generic type parameters match better-sqlite3's Statement<BindParameters, Result>
// so call sites that use prepare<T, U>() continue to compile unchanged.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class StatementCompat<_BindParameters = unknown, Result = unknown> {
  constructor(
    private readonly _stmt: StatementSync,
    private readonly metrics?: SqliteMetrics,
  ) {}

  // Returns Result[] so that code using prepare<_, Result>() gets typed results.
  // When Result = unknown (the default), this is unknown[] which still allows
  // downstream `as SomeRow[]` casts (unknown is the top type).
  //
  // Handle both:
  //   .all(val1, val2, val3) — individual positional args
  //   .all([val1, val2, val3]) — array passed as single arg (better-sqlite3 style)
  // node:sqlite expects individual args, so we detect the array case and spread it.
  all(...params: unknown[]): Result[] {
    const args =
      params.length === 1 && Array.isArray(params[0])
        ? (params[0] as unknown[])
        : params;
    if (!this.metrics) {
      return this._stmt.all(
        ...(args as Parameters<StatementSync["all"]>),
      ) as unknown as Result[];
    }
    const start = performance.now();
    try {
      return this._stmt.all(
        ...(args as Parameters<StatementSync["all"]>),
      ) as unknown as Result[];
    } finally {
      this.metrics.statementReadCount += 1;
      this.metrics.statementReadMs += performance.now() - start;
    }
  }

  get(...params: unknown[]): Result | undefined {
    const args =
      params.length === 1 && Array.isArray(params[0])
        ? (params[0] as unknown[])
        : params;
    if (!this.metrics) {
      return this._stmt.get(
        ...(args as Parameters<StatementSync["get"]>),
      ) as unknown as Result | undefined;
    }
    const start = performance.now();
    try {
      return this._stmt.get(
        ...(args as Parameters<StatementSync["get"]>),
      ) as unknown as Result | undefined;
    } finally {
      this.metrics.statementReadCount += 1;
      this.metrics.statementReadMs += performance.now() - start;
    }
  }

  run(...params: unknown[]): RunResult {
    const args =
      params.length === 1 && Array.isArray(params[0])
        ? (params[0] as unknown[])
        : params;
    if (!this.metrics) {
      const result = this._stmt.run(
        ...(args as Parameters<StatementSync["run"]>),
      );
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    }
    const start = performance.now();
    try {
      const result = this._stmt.run(
        ...(args as Parameters<StatementSync["run"]>),
      );
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    } finally {
      this.metrics.statementRunCount += 1;
      this.metrics.statementRunMs += performance.now() - start;
    }
  }
}

// ---------------------------------------------------------------------------
// Database — wraps DatabaseSync with the better-sqlite3 Database API
// ---------------------------------------------------------------------------

class Database {
  private readonly _db: DatabaseSync;
  private transactionDepth = 0;
  private readonly metrics?: SqliteMetrics;

  constructor(
    path: string,
    options?: { readonly?: boolean; metrics?: SqliteMetrics },
  ) {
    this._db = new DatabaseSync(path, { readOnly: options?.readonly ?? false });
    this.metrics = options?.metrics;
  }

  prepare<BindParameters = unknown, Result = unknown>(
    sql: string,
  ): StatementCompat<BindParameters, Result> {
    return new StatementCompat<BindParameters, Result>(
      this._db.prepare(sql),
      this.metrics,
    );
  }

  exec(sql: string): this {
    if (!this.metrics) {
      this._db.exec(sql);
      return this;
    }
    const start = performance.now();
    try {
      this._db.exec(sql);
    } finally {
      this.metrics.execCallCount += 1;
      this.metrics.execCallMs += performance.now() - start;
    }
    return this;
  }

  /**
   * Maps `db.pragma("journal_mode = WAL")` to `PRAGMA journal_mode = WAL`.
   * Returns the result rows (like better-sqlite3), or an empty array for
   * setting-only pragmas.
   */
  pragma(source: string): unknown[] {
    if (!this.metrics) return this._db.prepare(`PRAGMA ${source}`).all();
    const start = performance.now();
    try {
      return this._db.prepare(`PRAGMA ${source}`).all();
    } finally {
      this.metrics.statementReadCount += 1;
      this.metrics.statementReadMs += performance.now() - start;
    }
  }

  /**
   * Returns a function that wraps `fn` in a BEGIN / COMMIT / ROLLBACK
   * transaction, matching the better-sqlite3 `db.transaction()` helper.
   */
  transaction<F extends (...args: unknown[]) => unknown>(fn: F): F {
    return ((...args: unknown[]) => {
      const savepoint = `sqlite_compat_transaction_${this.transactionDepth}`;
      const nested = this.transactionDepth > 0;
      const beginStart = this.metrics ? performance.now() : 0;
      this._db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
      if (this.metrics) {
        this.metrics.beginCount += 1;
        this.metrics.beginMs += performance.now() - beginStart;
        this.metrics.transactionCount += 1;
      }
      this.transactionDepth += 1;
      const bodyStart = this.metrics ? performance.now() : 0;
      try {
        const result = fn(...args);
        if (this.metrics) {
          this.metrics.transactionBodyMs += performance.now() - bodyStart;
        }
        this.transactionDepth -= 1;
        const commitStart = this.metrics ? performance.now() : 0;
        try {
          this._db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        } finally {
          if (this.metrics) {
            this.metrics.commitCount += 1;
            this.metrics.commitMs += performance.now() - commitStart;
          }
        }
        return result;
      } catch (err) {
        if (this.metrics) {
          this.metrics.transactionBodyMs += performance.now() - bodyStart;
        }
        this.transactionDepth -= 1;
        const rollbackStart = this.metrics ? performance.now() : 0;
        if (nested) {
          try {
            this._db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this._db.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } finally {
            if (this.metrics) {
              this.metrics.rollbackCount += 1;
              this.metrics.rollbackMs += performance.now() - rollbackStart;
            }
          }
        } else {
          try {
            this._db.exec("ROLLBACK");
          } finally {
            if (this.metrics) {
              this.metrics.rollbackCount += 1;
              this.metrics.rollbackMs += performance.now() - rollbackStart;
            }
          }
        }
        throw err;
      }
    }) as F;
  }

  close(): void {
    if (!this.metrics) {
      this._db.close();
      return;
    }
    const start = performance.now();
    try {
      this._db.close();
    } finally {
      this.metrics.closeCount += 1;
      this.metrics.closeMs += performance.now() - start;
    }
  }
}

// TypeScript namespace merging — makes `Database.Database` a valid type alias
// for the instance type, matching the @types/better-sqlite3 convention.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Database {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface Database extends InstanceType<typeof Database> {}
}

export { Database };
export default Database;
