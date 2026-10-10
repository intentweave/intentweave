import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { buildFromPaths } from "../facade.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("KWX worker experiment through buildFromPaths", () => {
  it("preserves index annotation and co-occurrence rows for serial and worker execution", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "iw-kwx-workers-"));
    temporaryDirectories.push(workspaceRoot);
    mkdirSync(join(workspaceRoot, "docs"), { recursive: true });
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(workspaceRoot, "docs", "guide.md"), [
      "# CacheStore",
      "",
      "CacheStore uses Redis and QueueWorker.",
      "",
      "## QueueWorker",
      "",
      "QueueWorker sends messages to Redis.",
    ].join("\n"));
    writeFileSync(join(workspaceRoot, "src", "cache.ts"), [
      "export class CacheStore {",
      "  get(key: string): string { return key; }",
      "}",
      "export class QueueWorker {",
      "  send(value: string): string { return value; }",
      "}",
    ].join("\n"));

    const serialPath = join(workspaceRoot, "serial.db");
    const workerPath = join(workspaceRoot, "worker.db");
    const workerLogs: string[] = [];
    const serial = await buildFromPaths({
      paths: [join(workspaceRoot, "docs")],
      workspaceRoot,
      depth: "full",
      outputPath: serialPath,
      kwxWorkers: 1,
    });
    const workers = await buildFromPaths({
      paths: [join(workspaceRoot, "docs")],
      workspaceRoot,
      depth: "full",
      outputPath: workerPath,
      kwxWorkers: 2,
      log: (message) => workerLogs.push(message),
    });

    expect(workers.counts).toEqual(serial.counts);
    expect(workerLogs).toContain("KWX worker experiment: 2 workers across chunk tasks");
    const readRows = (databasePath: string, table: "annotations" | "co_occurrences"): string[] => {
      const database = new Database(databasePath, { readonly: true });
      try {
        return database.prepare(`SELECT * FROM ${table}`).all()
          .map((row) => JSON.stringify(Object.values(row)))
          .sort();
      } finally {
        database.close();
      }
    };
    expect(readRows(workerPath, "annotations")).toEqual(readRows(serialPath, "annotations"));
    expect(readRows(workerPath, "co_occurrences")).toEqual(readRows(serialPath, "co_occurrences"));
  });

  it("collects optional SQLite writer metrics without changing index rows", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "iw-sink-metrics-"));
    temporaryDirectories.push(workspaceRoot);
    mkdirSync(join(workspaceRoot, "docs"), { recursive: true });
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(workspaceRoot, "docs", "metrics.md"), "# CacheStore\n\nCacheStore uses Redis.");
    writeFileSync(join(workspaceRoot, "src", "cache.ts"), "export class CacheStore { get(key: string): string { return key; } }");

    const serialPath = join(workspaceRoot, "serial.db");
    const measuredPath = join(workspaceRoot, "measured.db");
    const serial = await buildFromPaths({
      paths: [join(workspaceRoot, "docs")],
      workspaceRoot,
      depth: "full",
      outputPath: serialPath,
    });
    const measured = await buildFromPaths({
      paths: [join(workspaceRoot, "docs")],
      workspaceRoot,
      depth: "full",
      outputPath: measuredPath,
      measureSinkMetrics: true,
    });

    expect(serial.sinkMetrics).toBeUndefined();
    expect(measured.counts).toEqual(serial.counts);
    expect(measured.sinkMetrics?.writerDurationMs).toBeGreaterThanOrEqual(0);
    expect(measured.sinkMetrics?.sqlite.statementRunCount).toBeGreaterThan(0);
    expect(measured.sinkMetrics?.sqlite.transactionCount).toBeGreaterThan(0);
    expect(measured.sinkMetrics?.sqlite.commitCount).toBeGreaterThan(0);
    expect(measured.sinkMetrics?.sqlite.closeCount).toBe(1);
    expect(measured.sinkMetrics?.tableWrites.find((table) => table.table === "annotations")?.rowCount)
      .toBe(measured.counts.annotations);
    expect(measured.sinkMetrics?.tableWrites.every((table) => table.rowsPerSecond === null || table.rowsPerSecond >= 0))
      .toBe(true);

    const readRows = (databasePath: string): string[] => {
      const database = new Database(databasePath, { readonly: true });
      try {
        return database.prepare("SELECT * FROM annotations").all()
          .map((row) => JSON.stringify(Object.values(row)))
          .sort();
      } finally {
        database.close();
      }
    };
    expect(readRows(measuredPath)).toEqual(readRows(serialPath));
  });
});