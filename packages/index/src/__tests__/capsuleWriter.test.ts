// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the Semantic Capsule Writer (14.0).
 *
 * Covers:
 *   - collectSymbolEvidence: symbol lookup, annotations, callers/callees
 *   - generateSymbolSummary: LLM call, DB persist, cache hit, cache miss on hash change
 *   - generateCallSemantics: edge capsule generation and cache
 *   - generatePathSummary: multi-symbol path capsule
 *   - markStaleForChangedSymbols: detects body_hash change, marks possibly_stale
 *   - listCapsules / getCapsule: read APIs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../schema.js";
import {
  collectSymbolEvidence,
  generateSymbolSummary,
  generateCallSemantics,
  generatePathSummary,
  markStaleForChangedSymbols,
  listCapsules,
  getCapsule,
  type CapsuleLLM,
  type CapsuleWriteOptions,
} from "../queries/capsuleWriter.js";

// ── Minimal schema helpers ────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

/** Insert a minimal symbol row. Returns the inserted ID. */
function insertSymbol(
  db: Database.Database,
  opts: {
    id?: string;
    name: string;
    kind?: string;
    signature?: string;
    docSummary?: string;
    bodyHash?: string;
    filePath?: string;
    line?: number;
    endLine?: number;
  },
): string {
  const id = opts.id ?? `sym-${opts.name}`;
  db.prepare(
    `
    INSERT OR REPLACE INTO symbols
      (id, name, kind, container, signature, file_path, line, end_line, export,
       doc_summary, body_hash, body_lines, structure_hash, implements,
       deprecated, deprecated_note, is_internal, decorators)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, 0, NULL, 0, NULL)
  `,
  ).run(
    id,
    opts.name,
    opts.kind ?? "function",
    opts.signature ?? null,
    opts.filePath ?? "src/test.ts",
    opts.line ?? 1,
    opts.endLine ?? 10,
    opts.docSummary ?? null,
    opts.bodyHash ?? "abc123",
  );
  return id;
}

// ── Mock LLM ──────────────────────────────────────────────────────────────────

function makeMockLLM(returnJson: Record<string, unknown>): CapsuleLLM {
  return {
    async complete(_req) {
      return {
        content: JSON.stringify(returnJson),
        parsed: returnJson,
        tokensUsed: { prompt: 50, completion: 20 },
        model: "mock-gpt",
      };
    },
  };
}

const DEFAULT_OPTS: CapsuleWriteOptions = {
  model: "mock-gpt",
  promptVersion: "test-v1",
};

// =============================================================================
// collectSymbolEvidence
// =============================================================================

describe("collectSymbolEvidence", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it("returns null for unknown symbol id", () => {
    const ev = collectSymbolEvidence(db, "nonexistent");
    expect(ev).toBeNull();
  });

  it("returns basic symbol fields", () => {
    const id = insertSymbol(db, {
      name: "authenticate",
      kind: "function",
      signature: "(req: Request): boolean",
      docSummary: "Verifies user credentials.",
      bodyHash: "hash1",
      filePath: "src/auth.ts",
    });

    const ev = collectSymbolEvidence(db, id);
    expect(ev).not.toBeNull();
    expect(ev!.name).toBe("authenticate");
    expect(ev!.kind).toBe("function");
    expect(ev!.signature).toBe("(req: Request): boolean");
    expect(ev!.docSummary).toBe("Verifies user credentials.");
    expect(ev!.bodyHash).toBe("hash1");
    expect(ev!.filePath).toBe("src/auth.ts");
    expect(ev!.symbolId).toBe(id);
  });

  it("collects doc annotations for the symbol", () => {
    const id = insertSymbol(db, { name: "validateToken" });

    db.prepare(
      `
      INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run("docs/auth.md", 5, "validates the JWT token", id, 0.9, "keyword");
    db.prepare(
      `
      INSERT INTO annotations (doc_path, line, text, symbol_id, confidence, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run("docs/auth.md", 10, "called during login flow", id, 0.7, "keyword");

    const ev = collectSymbolEvidence(db, id);
    expect(ev!.docAnnotations).toHaveLength(2);
    expect(ev!.docAnnotations).toContain("validates the JWT token");
    expect(ev!.docAnnotations).toContain("called during login flow");
  });

  it("collects callers and callees from symbol_calls", () => {
    const id = insertSymbol(db, { name: "processPayment" });

    // callers
    db.prepare(
      `
      INSERT INTO symbol_calls (caller_file, caller_name, callee_name)
      VALUES (?, ?, ?)
    `,
    ).run("src/checkout.ts", "handleCheckout", "processPayment");
    db.prepare(
      `
      INSERT INTO symbol_calls (caller_file, caller_name, callee_name)
      VALUES (?, ?, ?)
    `,
    ).run("src/retry.ts", "retryPayment", "processPayment");

    // callees
    db.prepare(
      `
      INSERT INTO symbol_calls (caller_file, caller_name, callee_name)
      VALUES (?, ?, ?)
    `,
    ).run("src/payment.ts", "processPayment", "chargeCard");
    db.prepare(
      `
      INSERT INTO symbol_calls (caller_file, caller_name, callee_name)
      VALUES (?, ?, ?)
    `,
    ).run("src/payment.ts", "processPayment", "writeReceipt");

    const ev = collectSymbolEvidence(db, id);
    expect(ev!.callers).toContain("handleCheckout");
    expect(ev!.callers).toContain("retryPayment");
    expect(ev!.callees).toContain("chargeCard");
    expect(ev!.callees).toContain("writeReceipt");
  });

  it("returns empty arrays when no callers/callees/annotations exist", () => {
    const id = insertSymbol(db, { name: "standalone" });
    const ev = collectSymbolEvidence(db, id);
    expect(ev!.callers).toEqual([]);
    expect(ev!.callees).toEqual([]);
    expect(ev!.docAnnotations).toEqual([]);
  });
});

// =============================================================================
// generateSymbolSummary
// =============================================================================

describe("generateSymbolSummary", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it("calls LLM and persists capsule to DB", async () => {
    const id = insertSymbol(db, {
      name: "buildIndex",
      docSummary: "Builds the CARI index",
      bodyHash: "bh-001",
    });
    const llm = makeMockLLM({
      summary: "Builds the code-aware retrieval index from AST output.",
      purpose: "Index construction",
      inputs: ["AxOutput"],
      outputs: ["IndexResult"],
    });

    const result = await generateSymbolSummary(db, id, llm, DEFAULT_OPTS);
    expect(result.fromCache).toBe(false);
    expect(result.capsule.capsuleKind).toBe("symbol_summary");
    expect(result.capsule.targetId).toBe(`symbol:${id}`);
    expect(result.capsule.status).toBe("fresh");
    expect(result.capsule.model).toBe("mock-gpt");
    expect(result.capsule.sourceRevision).toBe("bh-001");
    expect(result.capsule.content.summary).toBe(
      "Builds the code-aware retrieval index from AST output.",
    );
    expect(result.tokensUsed).toEqual({ prompt: 50, completion: 20 });
  });

  it("returns from cache on second call with same body_hash", async () => {
    const id = insertSymbol(db, { name: "cachedFn", bodyHash: "stable-hash" });
    const llm = makeMockLLM({ summary: "First generation" });
    let callCount = 0;
    const countingLlm: CapsuleLLM = {
      async complete(req) {
        callCount++;
        return llm.complete(req);
      },
    };

    await generateSymbolSummary(db, id, countingLlm, DEFAULT_OPTS);
    const second = await generateSymbolSummary(
      db,
      id,
      countingLlm,
      DEFAULT_OPTS,
    );

    expect(callCount).toBe(1); // LLM called only once
    expect(second.fromCache).toBe(true);
    expect(second.capsule.content.summary).toBe("First generation");
  });

  it("regenerates when body_hash changes (cache miss)", async () => {
    const id = insertSymbol(db, { name: "changingFn", bodyHash: "hash-v1" });
    await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "v1 summary" }),
      DEFAULT_OPTS,
    );

    // Simulate symbol body change
    db.prepare(`UPDATE symbols SET body_hash = 'hash-v2' WHERE id = ?`).run(id);

    let callCount = 0;
    const llm2: CapsuleLLM = {
      async complete(req) {
        callCount++;
        return makeMockLLM({ summary: "v2 summary" }).complete(req);
      },
    };

    const result = await generateSymbolSummary(db, id, llm2, DEFAULT_OPTS);
    expect(callCount).toBe(1);
    expect(result.fromCache).toBe(false);
    expect(result.capsule.content.summary).toBe("v2 summary");
    expect(result.capsule.sourceRevision).toBe("hash-v2");
  });

  it("force=true bypasses cache", async () => {
    const id = insertSymbol(db, { name: "forcedFn", bodyHash: "h1" });
    await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "original" }),
      DEFAULT_OPTS,
    );

    let callCount = 0;
    const llm: CapsuleLLM = {
      async complete(req) {
        callCount++;
        return makeMockLLM({ summary: "refreshed" }).complete(req);
      },
    };
    const result = await generateSymbolSummary(db, id, llm, {
      ...DEFAULT_OPTS,
      force: true,
    });

    expect(callCount).toBe(1);
    expect(result.fromCache).toBe(false);
    expect(result.capsule.content.summary).toBe("refreshed");
  });

  it("throws for unknown symbol id", async () => {
    await expect(
      generateSymbolSummary(db, "no-such-id", makeMockLLM({}), DEFAULT_OPTS),
    ).rejects.toThrow("no-such-id");
  });

  it("stores promptVersion on the capsule", async () => {
    const id = insertSymbol(db, { name: "versionedFn", bodyHash: "h1" });
    const result = await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "x" }),
      {
        model: "mock-gpt",
        promptVersion: "capsule-v99",
      },
    );
    expect(result.capsule.promptVersion).toBe("capsule-v99");
  });
});

// =============================================================================
// generateCallSemantics
// =============================================================================

describe("generateCallSemantics", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it("generates a call_semantics capsule for a caller→callee pair", async () => {
    const callerId = insertSymbol(db, { name: "handleLogin", bodyHash: "c1" });
    const calleeId = insertSymbol(db, {
      name: "validateCredentials",
      bodyHash: "c2",
    });

    const llm = makeMockLLM({
      summary:
        "handleLogin delegates credential validation to validateCredentials before issuing a token.",
      role: "pre-condition check",
    });

    const result = await generateCallSemantics(
      db,
      callerId,
      calleeId,
      llm,
      DEFAULT_OPTS,
    );
    expect(result.capsule.capsuleKind).toBe("call_semantics");
    expect(result.capsule.targetId).toBe(`call:${callerId}→${calleeId}`);
    expect(result.capsule.content.role).toBe("pre-condition check");
    expect(result.fromCache).toBe(false);
  });

  it("returns from cache on second call with same combined revision", async () => {
    const cId = insertSymbol(db, { name: "callerA", bodyHash: "hA" });
    const eId = insertSymbol(db, { name: "calleeB", bodyHash: "hB" });
    let calls = 0;
    const llm: CapsuleLLM = {
      async complete(req) {
        calls++;
        return makeMockLLM({
          summary: "semantics",
          role: "delegation",
        }).complete(req);
      },
    };

    await generateCallSemantics(db, cId, eId, llm, DEFAULT_OPTS);
    await generateCallSemantics(db, cId, eId, llm, DEFAULT_OPTS);

    expect(calls).toBe(1);
  });

  it("throws when caller or callee not found", async () => {
    const realId = insertSymbol(db, { name: "realFn" });
    await expect(
      generateCallSemantics(
        db,
        realId,
        "ghost-id",
        makeMockLLM({}),
        DEFAULT_OPTS,
      ),
    ).rejects.toThrow();
  });
});

// =============================================================================
// generatePathSummary
// =============================================================================

describe("generatePathSummary", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it("generates a path_summary capsule for an ordered symbol list", async () => {
    const ids = [
      insertSymbol(db, { name: "receiveRequest", bodyHash: "p1" }),
      insertSymbol(db, { name: "parseBody", bodyHash: "p2" }),
      insertSymbol(db, { name: "persistRecord", bodyHash: "p3" }),
    ];

    const llm = makeMockLLM({
      summary:
        "Receives an HTTP request, parses the body, then writes it to the DB.",
      domains: ["HTTP", "Persistence"],
    });

    const result = await generatePathSummary(db, ids, llm, DEFAULT_OPTS);
    expect(result.capsule.capsuleKind).toBe("path_summary");
    expect(result.capsule.evidenceIds).toEqual(ids.map((id) => `symbol:${id}`));
    expect(result.capsule.content.summary).toContain("Receives");
    expect(result.fromCache).toBe(false);
  });

  it("throws when fewer than 2 symbols provided", async () => {
    const id = insertSymbol(db, { name: "solo" });
    await expect(
      generatePathSummary(db, [id], makeMockLLM({}), DEFAULT_OPTS),
    ).rejects.toThrow("at least 2");
  });

  it("throws when any symbol id is missing", async () => {
    const id = insertSymbol(db, { name: "known" });
    await expect(
      generatePathSummary(
        db,
        [id, "missing-id"],
        makeMockLLM({}),
        DEFAULT_OPTS,
      ),
    ).rejects.toThrow();
  });

  it("returns from cache on second call", async () => {
    const ids = [
      insertSymbol(db, { name: "step1", bodyHash: "s1" }),
      insertSymbol(db, { name: "step2", bodyHash: "s2" }),
    ];
    let calls = 0;
    const llm: CapsuleLLM = {
      async complete(req) {
        calls++;
        return makeMockLLM({ summary: "path narrative" }).complete(req);
      },
    };
    await generatePathSummary(db, ids, llm, DEFAULT_OPTS);
    await generatePathSummary(db, ids, llm, DEFAULT_OPTS);
    expect(calls).toBe(1);
  });
});

// =============================================================================
// markStaleForChangedSymbols
// =============================================================================

describe("markStaleForChangedSymbols", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it("marks capsule possibly_stale when body_hash has changed", async () => {
    const id = insertSymbol(db, { name: "staleFn", bodyHash: "original-hash" });
    await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "ok" }),
      DEFAULT_OPTS,
    );

    // Confirm it's fresh
    const before = getCapsule(db, `symbol:${id}`, "symbol_summary");
    expect(before!.status).toBe("fresh");

    // Simulate code change
    db.prepare(`UPDATE symbols SET body_hash = 'new-hash' WHERE id = ?`).run(
      id,
    );

    const count = markStaleForChangedSymbols(db);
    expect(count).toBe(1);

    const after = getCapsule(db, `symbol:${id}`, "symbol_summary");
    expect(after!.status).toBe("possibly_stale");
  });

  it("does not touch capsules whose source_revision still matches body_hash", async () => {
    const id = insertSymbol(db, {
      name: "stableSymbol",
      bodyHash: "unchanged",
    });
    await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "fine" }),
      DEFAULT_OPTS,
    );

    const count = markStaleForChangedSymbols(db);
    expect(count).toBe(0);

    const cap = getCapsule(db, `symbol:${id}`, "symbol_summary");
    expect(cap!.status).toBe("fresh");
  });

  it("does not mark already-stale capsules again", async () => {
    const id = insertSymbol(db, { name: "alreadyStale", bodyHash: "h1" });
    await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "x" }),
      DEFAULT_OPTS,
    );
    db.prepare(`UPDATE symbols SET body_hash = 'h2' WHERE id = ?`).run(id);
    markStaleForChangedSymbols(db);

    // Run again — nothing left to mark (already possibly_stale)
    const count2 = markStaleForChangedSymbols(db);
    expect(count2).toBe(0);
  });

  it("marks multiple capsules when multiple symbols changed", async () => {
    const ids = ["fnA", "fnB", "fnC"].map((name) =>
      insertSymbol(db, { name, bodyHash: `hash-${name}` }),
    );
    for (const id of ids) {
      await generateSymbolSummary(
        db,
        id,
        makeMockLLM({ summary: "x" }),
        DEFAULT_OPTS,
      );
    }

    // Change 2 of 3
    db.prepare(`UPDATE symbols SET body_hash = 'new' WHERE id = ?`).run(ids[0]);
    db.prepare(`UPDATE symbols SET body_hash = 'new' WHERE id = ?`).run(ids[2]);

    const count = markStaleForChangedSymbols(db);
    expect(count).toBe(2);
  });
});

// =============================================================================
// listCapsules / getCapsule
// =============================================================================

describe("listCapsules and getCapsule", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  it("listCapsules returns empty array when none exist", () => {
    expect(listCapsules(db)).toEqual([]);
  });

  it("listCapsules returns all capsules in descending updated_at order", async () => {
    const id1 = insertSymbol(db, { name: "alpha", bodyHash: "h1" });
    const id2 = insertSymbol(db, { name: "beta", bodyHash: "h2" });
    await generateSymbolSummary(
      db,
      id1,
      makeMockLLM({ summary: "a" }),
      DEFAULT_OPTS,
    );
    await generateSymbolSummary(
      db,
      id2,
      makeMockLLM({ summary: "b" }),
      DEFAULT_OPTS,
    );

    const list = listCapsules(db);
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.capsuleKind === "symbol_summary")).toBe(true);
  });

  it("listCapsules filters by status", async () => {
    const id = insertSymbol(db, { name: "filterFn", bodyHash: "h1" });
    await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "x" }),
      DEFAULT_OPTS,
    );
    db.prepare(`UPDATE symbols SET body_hash = 'h2' WHERE id = ?`).run(id);
    markStaleForChangedSymbols(db);

    const fresh = listCapsules(db, { status: "fresh" });
    const stale = listCapsules(db, { status: "possibly_stale" });
    expect(fresh).toHaveLength(0);
    expect(stale).toHaveLength(1);
  });

  it("listCapsules filters by kind", async () => {
    const callerId = insertSymbol(db, { name: "cA", bodyHash: "hA" });
    const calleeId = insertSymbol(db, { name: "cB", bodyHash: "hB" });
    const symId = insertSymbol(db, { name: "symC", bodyHash: "hC" });
    await generateCallSemantics(
      db,
      callerId,
      calleeId,
      makeMockLLM({ summary: "x", role: "y" }),
      DEFAULT_OPTS,
    );
    await generateSymbolSummary(
      db,
      symId,
      makeMockLLM({ summary: "z" }),
      DEFAULT_OPTS,
    );

    const symbolCaps = listCapsules(db, { kind: "symbol_summary" });
    const callCaps = listCapsules(db, { kind: "call_semantics" });
    expect(symbolCaps).toHaveLength(1);
    expect(callCaps).toHaveLength(1);
  });

  it("getCapsule returns null when not found", () => {
    const cap = getCapsule(db, "symbol:unknown", "symbol_summary");
    expect(cap).toBeNull();
  });

  it("getCapsule returns the correct capsule", async () => {
    const id = insertSymbol(db, { name: "getMe", bodyHash: "gm1" });
    await generateSymbolSummary(
      db,
      id,
      makeMockLLM({ summary: "found!" }),
      DEFAULT_OPTS,
    );

    const cap = getCapsule(db, `symbol:${id}`, "symbol_summary");
    expect(cap).not.toBeNull();
    expect(cap!.content.summary).toBe("found!");
    expect(cap!.targetId).toBe(`symbol:${id}`);
  });

  it("getCapsule respects kind discriminant", async () => {
    const callerId = insertSymbol(db, { name: "dis-caller", bodyHash: "d1" });
    const calleeId = insertSymbol(db, { name: "dis-callee", bodyHash: "d2" });
    await generateCallSemantics(
      db,
      callerId,
      calleeId,
      makeMockLLM({ summary: "call cap", role: "test" }),
      DEFAULT_OPTS,
    );

    const symCap = getCapsule(
      db,
      `call:${callerId}→${calleeId}`,
      "symbol_summary",
    );
    const callCap = getCapsule(
      db,
      `call:${callerId}→${calleeId}`,
      "call_semantics",
    );
    expect(symCap).toBeNull();
    expect(callCap).not.toBeNull();
  });
});
