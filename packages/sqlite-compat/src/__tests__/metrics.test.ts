import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database, { createSqliteMetrics } from "@intentweave/sqlite-compat";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite optional measurements", () => {
  it("records synchronous statement, exec, transaction-body, and commit timings", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "sqlite-compat-metrics-"));
    temporaryDirectories.push(temporaryDirectory);
    const metrics = createSqliteMetrics();
    const database = new Database(join(temporaryDirectory, "metrics.db"), { metrics });
    try {
      database.exec("CREATE TABLE sample (value TEXT NOT NULL)");
      const insert = database.prepare("INSERT INTO sample (value) VALUES (?)");
      database.transaction(() => insert.run("kept"))();

      expect(database.prepare("SELECT value FROM sample").all()).toEqual([{ value: "kept" }]);
      expect(metrics.statementRunCount).toBe(1);
      expect(metrics.execCallCount).toBeGreaterThanOrEqual(1);
      expect(metrics.transactionCount).toBe(1);
      expect(metrics.commitCount).toBe(1);
      expect(metrics.statementRunMs).toBeGreaterThanOrEqual(0);
      expect(metrics.execCallMs).toBeGreaterThanOrEqual(0);
      expect(metrics.transactionBodyMs).toBeGreaterThanOrEqual(0);
      expect(metrics.commitMs).toBeGreaterThanOrEqual(0);
    } finally {
      database.close();
    }
  });
});