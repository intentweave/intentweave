// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import pythonPlugin from "../index.js";

describe("plugin-python", () => {
  it("has correct plugin metadata", () => {
    expect(pythonPlugin.name).toBe("python");
    expect(pythonPlugin.version).toBe("0.8.0");
    expect(pythonPlugin.capabilities).toEqual(["language"]);
  });

  it("provides a language capability", () => {
    const caps = pythonPlugin.getCapabilities({});
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe("language");
  });

  it("language capability has correct extensions and name", () => {
    const caps = pythonPlugin.getCapabilities({});
    const lang = caps[0] as { extensions: string[]; languageName: string };
    expect(lang.extensions).toEqual([".py"]);
    expect(lang.languageName).toBe("Python");
  });

  it("language capability has createAdapter factory", () => {
    const caps = pythonPlugin.getCapabilities({});
    const lang = caps[0] as { createAdapter: Function };
    expect(typeof lang.createAdapter).toBe("function");
  });

  it("createAdapter returns an adapter with extensions and processFile", () => {
    const caps = pythonPlugin.getCapabilities({});
    const lang = caps[0] as {
      createAdapter: (opts: Record<string, unknown>) => unknown;
    };
    const adapter = lang.createAdapter({
      workspaceRoot: "/tmp/test",
      includePrivate: true,
      includeMembers: true,
      maxDepth: 2,
    }) as { extensions: string[]; processFile: Function };

    expect(adapter.extensions).toEqual([".py"]);
    expect(typeof adapter.processFile).toBe("function");
  });

  it("is the default export", async () => {
    const mod = await import("../index.js");
    expect(mod.default).toBe(pythonPlugin);
  });
});
