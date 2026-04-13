// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { createExtractor } from "../src/index.js";

describe("implements extraction", () => {
  const extractor = createExtractor(process.cwd());

  it("should extract implements clause from class", () => {
    const code = `
      export class Foo implements Bar {
        doStuff(x: string): void {}
      }
    `;

    const result = extractor.extractFromString(code, "test.ts", "typescript", {
      includeMembers: true,
      includeParameters: true,
    });

    const classSymbol = result.symbols.find((s) => s.kind === "class");
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.name).toBe("Foo");
    expect(classSymbol!.signature).toContain("implements");
    expect(classSymbol!.implements).toEqual(["Bar"]);
  });

  it("should extract multiple implements", () => {
    const code = `
      class Multi implements Alpha, Beta {
        run(): void {}
      }
    `;

    const result = extractor.extractFromString(code, "test.ts", "typescript", {
      includeMembers: true,
    });

    const classSymbol = result.symbols.find((s) => s.kind === "class");
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.implements).toEqual(["Alpha", "Beta"]);
  });

  it("should not set implements when class has no implements clause", () => {
    const code = `
      class Plain {
        run(): void {}
      }
    `;

    const result = extractor.extractFromString(code, "test.ts", "typescript", {
      includeMembers: true,
    });

    const classSymbol = result.symbols.find((s) => s.kind === "class");
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.implements).toBeUndefined();
  });

  it("should extract method signatures on class members", () => {
    const code = `
      class Svc {
        handleRequest(req: Request): Response {}
      }
    `;

    const result = extractor.extractFromString(code, "test.ts", "typescript", {
      includeMembers: true,
    });

    const method = result.symbols.find((s) => s.kind === "method");
    expect(method).toBeDefined();
    expect(method!.signature).toBeDefined();
    expect(method!.signature).toContain("handleRequest");
  });

  it("should extract method signatures on interface members", () => {
    const code = `
      interface Svc {
        handleRequest(req: Request): Response;
      }
    `;

    const result = extractor.extractFromString(code, "test.ts", "typescript", {
      includeMembers: true,
    });

    const method = result.symbols.find((s) => s.kind === "method");
    expect(method).toBeDefined();
    expect(method!.signature).toBeDefined();
    expect(method!.signature).toContain("handleRequest");
  });
});
