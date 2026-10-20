// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const labelsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../evaluation/fastify-semantic-endpoint.labels.json",
);

describe("Fastify semantic Endpoint labels", () => {
  const dataset = JSON.parse(readFileSync(labelsPath, "utf-8")) as {
    schemaVersion: string;
    contract: string;
    cases: Array<{
      id: string;
      label: string;
      rationale: string;
      files: Record<string, string>;
    }>;
  };

  it("declares its contract and a unique set of cases", () => {
    expect(dataset.schemaVersion).toBe("1");
    expect(dataset.contract).toBe("fastify-semantic-endpoint-labels@1");
    const ids = dataset.cases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("labels every case probable or ambiguous with a rationale and a complete repository", () => {
    for (const item of dataset.cases) {
      expect(["probable", "ambiguous"]).toContain(item.label);
      expect(item.rationale.length).toBeGreaterThan(20);
      expect(Object.keys(item.files)).toEqual(
        expect.arrayContaining(["package.json", "src/app.ts"]),
      );
    }
  });
});
