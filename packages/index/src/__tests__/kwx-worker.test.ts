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
    });

    expect(workers.counts).toEqual(serial.counts);
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
});