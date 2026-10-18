// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTypeScriptAdapter } from "../stages/ax.js";
import {
  LanguageRegistry,
  type LanguageAdapterOptions,
} from "../stages/languageRegistry.js";
import { runObservationInventory } from "../stages/observation/inventoryRun.js";

const workspaces: string[] = [];

afterAll(() => {
  for (const workspace of workspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function workspaceWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "intentweave-observation-"));
  workspaces.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function registryFor(root: string): LanguageRegistry {
  const options: LanguageAdapterOptions = {
    workspaceRoot: root,
    includePrivate: true,
    includeMembers: true,
    maxDepth: 2,
  };
  return new LanguageRegistry().register(createTypeScriptAdapter(options));
}

const ROUTES = `import { FastifyInstance } from "fastify";
/** Lists users. */
export function listUsers(): string[] {
  return [];
}

export class UserService {
  find(id: string): string {
    return id;
  }
}

export function routes(fastify: FastifyInstance) {
  fastify.get("/users", async () => listUsers());
  fastify.post("/users", async () => ({}));
  fastify.get(dynamicPath, async () => ({}));
  console.log("ready");
}
`;

describe("TypeScript observation inventory (Phase O1)", () => {
  it("produces symbols with locators, containers, and creation keys", () => {
    const root = workspaceWith({ "src/routes.ts": ROUTES });
    const run = runObservationInventory(registryFor(root), root, [
      "src/routes.ts",
    ]);
    const symbols = run.records.filter((record) => record.kind === "symbol");
    expect(symbols.map((record) => record.identityKey)).toContain(
      "symbol:function:src/routes.ts#listUsers",
    );
    const find = symbols.find((record) => record.payload.name === "find");
    expect(find).toMatchObject({
      identityKey: "symbol:method:src/routes.ts#UserService.find",
      locator: { filePath: "src/routes.ts", container: "UserService" },
      // The extractor marks members of an exported class as exported.
      payload: { exported: true, container: "UserService" },
    });
    expect(
      symbols.find((record) => record.payload.name === "listUsers")?.payload,
    ).toMatchObject({ exported: true, documented: true });
  });

  it("records every call with a literal string argument and skips the rest", () => {
    const root = workspaceWith({ "src/routes.ts": ROUTES });
    const run = runObservationInventory(registryFor(root), root, [
      "src/routes.ts",
    ]);
    const callSites = run.records.filter(
      (record) => record.kind === "call-site",
    );
    const literals = callSites.map((record) => ({
      callee: record.payload.callee,
      args: record.payload.literalArguments,
    }));
    expect(literals).toEqual(
      expect.arrayContaining([
        { callee: "fastify.get", args: ["/users"] },
        { callee: "fastify.post", args: ["/users"] },
        { callee: "console.log", args: ["ready"] },
      ]),
    );
    expect(
      literals.some(
        (item) => item.callee === "fastify.get" && item.args.length === 0,
      ),
    ).toBe(false);
    expect(new Set(callSites.map((record) => record.identityKey)).size).toBe(
      callSites.length,
    );
  });

  it("observes modules only for files with exports, and dependencies from package.json", () => {
    const root = workspaceWith({
      "src/routes.ts": ROUTES,
      "src/private.ts": "const hidden = 1;\nconsole.log(hidden);\n",
      "package.json": JSON.stringify({
        dependencies: { fastify: "^5.0.0" },
        devDependencies: { vitest: "^2.0.0" },
      }),
    });
    const run = runObservationInventory(registryFor(root), root, [
      "src/routes.ts",
      "src/private.ts",
    ]);
    const modules = run.records.filter((record) => record.kind === "module");
    expect(modules.map((record) => record.locator.filePath)).toEqual([
      "src/routes.ts",
    ]);
    const dependencies = run.records.filter(
      (record) => record.kind === "dependency",
    );
    expect(dependencies.map((record) => record.identityKey).sort()).toEqual([
      "dependency:fastify@package.json",
      "dependency:vitest@package.json",
    ]);
  });

  it("reports complete coverage when every in-scope file is observed", () => {
    const root = workspaceWith({ "src/routes.ts": ROUTES });
    const run = runObservationInventory(registryFor(root), root, [
      "src/routes.ts",
    ]);
    for (const kind of ["file", "module", "symbol", "call-site"] as const) {
      expect(run.coverage[kind].status).toBe("complete");
    }
  });

  it("keeps a kind complete and lists a file with no observation adapter as unobserved", () => {
    const root = workspaceWith({
      "src/routes.ts": ROUTES,
      "src/app.py": "print('x')\n",
    });
    const run = runObservationInventory(registryFor(root), root, [
      "src/routes.ts",
      "src/app.py",
    ]);
    expect(run.coverage.symbol.status).toBe("complete");
    expect(run.unobservedFiles).toEqual([
      expect.objectContaining({ filePath: "src/app.py" }),
    ]);
  });

  it("keeps a kind complete over the readable files and lists an unreadable file as unobserved", () => {
    const root = workspaceWith({ "src/routes.ts": ROUTES });
    const run = runObservationInventory(registryFor(root), root, [
      "src/routes.ts",
      "src/missing.ts",
    ]);
    expect(run.coverage.symbol.status).toBe("complete");
    expect(run.unobservedFiles).toEqual([
      expect.objectContaining({ filePath: "src/missing.ts" }),
    ]);
    // The readable file is still observed.
    expect(
      run.records.some((record) => record.locator.filePath === "src/routes.ts"),
    ).toBe(true);
  });

  it("reports dependency coverage not_observed when no manifest adapter is registered", () => {
    const root = workspaceWith({
      "src/routes.ts": ROUTES,
      "package.json": "{}",
    });
    const registry = new LanguageRegistry();
    const bare = createTypeScriptAdapter({
      workspaceRoot: root,
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    });
    // Strip the manifest capability to model an adapter without manifest support.
    registry.register({
      ...bare,
      observation: bare.observation && {
        ...bare.observation,
        observeManifest: undefined,
      },
    });
    const run = runObservationInventory(registry, root, ["src/routes.ts"]);
    expect(run.coverage.dependency.status).toBe("not_observed");
  });

  it("does not treat an adapter without observation as observing", () => {
    const registry = new LanguageRegistry().register({
      extensions: [".ts"],
      processFile: async () => {
        throw new Error("unused");
      },
    });
    expect(registry.observationAdapterFor("src/a.ts")).toBeNull();
  });

  it("admits a second language through the adapter contract without core changes", () => {
    const root = workspaceWith({
      "src/routes.ts": ROUTES,
      "tools/check.py": "def check(value):\n    return value\n",
    });
    // Test double: a Python observer that declares the kinds it produces.
    const python = {
      extensions: [".py"],
      processFile: async () => {
        throw new Error("unused");
      },
      observation: {
        contractVersion: "test-1",
        capabilities: {
          file: { status: "observed" as const },
          module: {
            status: "not_observed" as const,
            reason: "test double declares no modules",
          },
          symbol: { status: "observed" as const },
          dependency: { status: "unsupported" as const },
          "call-site": { status: "observed" as const },
        },
        observeFile(_root: string, relativePath: string) {
          return [
            {
              kind: "file" as const,
              identityKey: `file:${relativePath}`,
              locator: { filePath: relativePath },
              payload: { extension: ".py" },
            },
            {
              kind: "symbol" as const,
              identityKey: `symbol:function:${relativePath}#check`,
              locator: { filePath: relativePath, line: 1 },
              payload: { name: "check" },
            },
          ];
        },
      },
    };
    const registry = registryFor(root);
    registry.register(python);
    const run = runObservationInventory(registry, root, [
      "src/routes.ts",
      "tools/check.py",
    ]);
    expect(run.records.map((record) => record.locator.filePath)).toEqual(
      expect.arrayContaining(["src/routes.ts", "tools/check.py"]),
    );
    expect(run.coverage.symbol.status).toBe("complete");
    expect(run.coverage.module).toEqual({
      status: "not_observed",
      reason: "test double declares no modules",
    });
  });
});
