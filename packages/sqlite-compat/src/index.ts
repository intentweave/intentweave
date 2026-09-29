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

// ---------------------------------------------------------------------------
// StatementCompat — wraps StatementSync with the better-sqlite3 Statement API
//
// Generic type parameters match better-sqlite3's Statement<BindParameters, Result>
// so call sites that use prepare<T, U>() continue to compile unchanged.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class StatementCompat<_BindParameters = unknown, Result = unknown> {
  constructor(private readonly _stmt: StatementSync) {}

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
    return this._stmt.all(
      ...(args as Parameters<StatementSync["all"]>),
    ) as unknown as Result[];
  }

  get(...params: unknown[]): Result | undefined {
    const args =
      params.length === 1 && Array.isArray(params[0])
        ? (params[0] as unknown[])
        : params;
    return this._stmt.get(
      ...(args as Parameters<StatementSync["get"]>),
    ) as unknown as Result | undefined;
  }

  run(...params: unknown[]): RunResult {
    const args =
      params.length === 1 && Array.isArray(params[0])
        ? (params[0] as unknown[])
        : params;
    const r = this._stmt.run(...(args as Parameters<StatementSync["run"]>));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
}

// ---------------------------------------------------------------------------
// Database — wraps DatabaseSync with the better-sqlite3 Database API
// ---------------------------------------------------------------------------

class Database {
  private readonly _db: DatabaseSync;

  constructor(path: string, options?: { readonly?: boolean }) {
    this._db = new DatabaseSync(path, { readOnly: options?.readonly ?? false });
  }

  prepare<BindParameters = unknown, Result = unknown>(
    sql: string,
  ): StatementCompat<BindParameters, Result> {
    return new StatementCompat<BindParameters, Result>(this._db.prepare(sql));
  }

  exec(sql: string): this {
    this._db.exec(sql);
    return this;
  }

  /**
   * Maps `db.pragma("journal_mode = WAL")` to `PRAGMA journal_mode = WAL`.
   * Returns the result rows (like better-sqlite3), or an empty array for
   * setting-only pragmas.
   */
  pragma(source: string): unknown[] {
    return this._db.prepare(`PRAGMA ${source}`).all();
  }

  /**
   * Returns a function that wraps `fn` in a BEGIN / COMMIT / ROLLBACK
   * transaction, matching the better-sqlite3 `db.transaction()` helper.
   */
  transaction<F extends (...args: unknown[]) => unknown>(fn: F): F {
    return ((...args: unknown[]) => {
      this._db.exec("BEGIN");
      try {
        const result = fn(...args);
        this._db.exec("COMMIT");
        return result;
      } catch (err) {
        this._db.exec("ROLLBACK");
        throw err;
      }
    }) as F;
  }

  close(): void {
    this._db.close();
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
