// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import Database from "@intentweave/sqlite-compat";
import { checkFromDb } from "../queries/check.js";
import { initSchema } from "../schema.js";

describe("CARI drift check", () => {
  let database: Database.Database;

  afterEach(() => database?.close());

  it("blocks only stale structured references in actual documentation files", () => {
    database = new Database(":memory:");
    initSchema(database);
    database.exec(`
      INSERT INTO files (path, last_modified, is_doc) VALUES
        ('src/claims.ts', '2026-09-14T00:00:00Z', 0),
        ('docs/api.md', '2026-01-01T00:00:00Z', 1),
        ('docs/architecture.md', '2026-01-01T00:00:00Z', 1),
        ('docs/operations.md', '2026-01-01T00:00:00Z', 1),
        ('packages/types.ts', '2026-01-01T00:00:00Z', 0);
      INSERT INTO symbols (id, name, kind, file_path, line, export)
        VALUES ('sym.claims', 'ClaimsCheckExecution', 'interface', 'src/claims.ts', 1, 'exported');
      INSERT INTO annotations (
        doc_path, line, text, symbol_id, confidence, source, idf_score
      ) VALUES
        ('docs/api.md', 12, 'ClaimsCheckExecution', 'sym.claims', 0.9, 'code_span', 0.9),
        ('docs/architecture.md', 20, 'execution', 'sym.claims', 0.97, 'bold', 0.2),
        ('docs/operations.md', 25, 'selection', 'sym.claims', 0.9, 'identifier', 0.9),
        ('packages/types.ts', 40, 'execution', 'sym.claims', 0.97, 'body', 0.2);
    `);

    const warningResult = checkFromDb(database, {
      changed: ["src/claims.ts"],
      severity: "warning",
    });
    expect(warningResult.exitCode).toBe(2);
    expect(warningResult.findings).toEqual([
      expect.objectContaining({
        severity: "critical",
        file: "docs/api.md",
        line: 12,
      }),
    ]);

    const infoResult = checkFromDb(database, {
      changed: ["src/claims.ts"],
      severity: "info",
    });
    expect(infoResult.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "docs/api.md", line: 12 }),
        expect.objectContaining({
          severity: "info",
          file: "docs/architecture.md",
          line: 20,
        }),
        expect.objectContaining({
          severity: "info",
          file: "docs/operations.md",
          line: 25,
        }),
      ]),
    );
    expect(
      infoResult.findings.some(
        (finding) => finding.file === "packages/types.ts",
      ),
    ).toBe(false);
  });
});
