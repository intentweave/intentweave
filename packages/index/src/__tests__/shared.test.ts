// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { openIndex } from "../queries/shared.js";
import { initSchema, schemaMigrationBackupPath } from "../schema.js";

describe("openIndex", () => {
  const dbPath = join(tmpdir(), `intentweave-schema-14-${process.pid}.db`);

  afterEach(() => {
    for (const path of [
      dbPath,
      `${dbPath}-shm`,
      `${dbPath}-wal`,
      schemaMigrationBackupPath(dbPath, "16"),
      schemaMigrationBackupPath(dbPath, "17"),
    ]) {
      if (existsSync(path)) rmSync(path);
    }
  });

  it("upgrades a schema-14 database before validating its version", () => {
    const legacy = new Database(dbPath);
    initSchema(legacy);
    legacy
      .prepare(`UPDATE _meta SET value = '14' WHERE key = 'schema_version'`)
      .run();
    legacy.close();

    const index = openIndex(dbPath);
    const version = index
      .prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    const table = index
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claim_assessment_references'`,
      )
      .get() as { name: string } | undefined;
    index.close();

    expect(version.value).toBe("19");
    expect(table?.name).toBe("claim_assessment_references");
  });

  it("continues for a database that predates schema metadata", () => {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE annotations (text TEXT NOT NULL);
      CREATE TABLE co_occurrences (entity_a TEXT NOT NULL, entity_b TEXT NOT NULL);
    `);
    legacy.close();

    const index = openIndex(dbPath);
    index.close();
  });
});
