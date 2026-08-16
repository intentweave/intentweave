// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initSchema } from "../schema.js";

describe("WAL safety", () => {
  let tempDir: string;
  let sourceDb: Database.Database;
  let sourcePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "intentweave-wal-test-"));
    sourcePath = path.join(tempDir, "source.db");
    sourceDb = new Database(sourcePath);
    initSchema(sourceDb);
  });

  afterEach(() => {
    sourceDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("safely copies database with WAL active using VACUUM INTO", () => {
    // Insert test data
    sourceDb
      .prepare(
        `INSERT INTO symbols (id, name, kind, file_path, line, export)
         VALUES ('test:1', 'authService', 'function', 'src/auth.ts', 10, 'exported')`,
      )
      .run();

    // Verify WAL mode is active
    const journalMode = sourceDb.pragma("journal_mode") as Array<{
      journal_mode: string;
    }>;
    expect(journalMode[0]?.journal_mode).toBe("wal");

    // Create backup using VACUUM INTO (safe with WAL)
    const backupPath = path.join(tempDir, "backup.db");
    sourceDb.exec(`VACUUM INTO '${backupPath}'`);

    // Verify backup exists and contains data
    expect(existsSync(backupPath)).toBe(true);

    const backupDb = new Database(backupPath);
    const symbol = backupDb
      .prepare(`SELECT name, kind FROM symbols WHERE id = 'test:1'`)
      .get() as { name: string; kind: string };
    expect(symbol).toEqual({ name: "authService", kind: "function" });
    backupDb.close();
  });

  it("handles checkpoint before copy", () => {
    // Insert test data
    sourceDb
      .prepare(
        `INSERT INTO symbols (id, name, kind, file_path, line, export)
         VALUES ('test:2', 'sessionService', 'function', 'src/session.ts', 20, 'exported')`,
      )
      .run();

    // Force checkpoint
    sourceDb.pragma("wal_checkpoint(TRUNCATE)");

    // Verify checkpoint completed (WAL files may still exist but are empty)
    const walPath = `${sourcePath}-wal`;
    const shmPath = `${sourcePath}-shm`;
    // After TRUNCATE checkpoint, WAL file should be empty or minimal
    if (existsSync(walPath)) {
      const stats = require("node:fs").statSync(walPath);
      expect(stats.size).toBeLessThan(4096); // Empty or near-empty
    }

    // Safe to copy using VACUUM INTO
    const copyPath = path.join(tempDir, "copy.db");
    sourceDb.exec(`VACUUM INTO '${copyPath}'`);

    const copyDb = new Database(copyPath);
    const symbol = copyDb
      .prepare(`SELECT name FROM symbols WHERE id = 'test:2'`)
      .get() as { name: string };
    expect(symbol.name).toBe("sessionService");
    copyDb.close();
  });

  it("preserves claims companion tables in backup", () => {
    // Insert into claims tables
    sourceDb
      .prepare(
        `INSERT INTO parameter_identities (id, canonical_key, created_at)
         VALUES ('param:1', 'session.timeout', 1000)`,
      )
      .run();

    sourceDb
      .prepare(
        `INSERT INTO evidence_identities (id, parameter_identity_id, source_kind, identity_key, created_at)
         VALUES ('ev:1', 'param:1', 'code-default', 'src/session.ts:SESSION_TIMEOUT', 1000)`,
      )
      .run();

    // Backup
    const backupPath = path.join(tempDir, "claims-backup.db");
    sourceDb.exec(`VACUUM INTO '${backupPath}'`);

    // Verify claims data in backup
    const backupDb = new Database(backupPath);
    const param = backupDb
      .prepare(`SELECT canonical_key FROM parameter_identities WHERE id = 'param:1'`)
      .get() as { canonical_key: string };
    expect(param.canonical_key).toBe("session.timeout");

    const evidence = backupDb
      .prepare(`SELECT source_kind FROM evidence_identities WHERE id = 'ev:1'`)
      .get() as { source_kind: string };
    expect(evidence.source_kind).toBe("code-default");
    backupDb.close();
  });
});
