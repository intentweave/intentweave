// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { logSessionEvent } from "../sessionLog.js";

async function makeTmpWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "iw-session-log-test-"));
}

describe("logSessionEvent", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when disabled — no .iw/sessions directory is created", async () => {
    const workspaceRoot = await makeTmpWorkspace();
    tmpDirs.push(workspaceRoot);

    await logSessionEvent({
      enabled: false,
      workspaceRoot,
      surface: "cli",
      tool: "index retrieve",
      confidence: 0.9,
    });

    const sessionsDir = path.join(workspaceRoot, ".iw", "sessions");
    await expect(fs.stat(sessionsDir)).rejects.toThrow();
  });

  it("appends a JSONL entry with the expected shape when enabled", async () => {
    const workspaceRoot = await makeTmpWorkspace();
    tmpDirs.push(workspaceRoot);

    await logSessionEvent({
      enabled: true,
      workspaceRoot,
      surface: "cli",
      tool: "index retrieve",
      confidence: 0.87,
      resultCount: 5,
    });

    const sessionsDir = path.join(workspaceRoot, ".iw", "sessions");
    const files = await fs.readdir(sessionsDir);
    expect(files).toHaveLength(1);

    const today = new Date().toISOString().slice(0, 10);
    expect(files[0]).toBe(`${today}.jsonl`);

    const content = await fs.readFile(
      path.join(sessionsDir, files[0]),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.surface).toBe("cli");
    expect(entry.tool).toBe("index retrieve");
    expect(entry.confidence).toBe(0.87);
    expect(entry.resultCount).toBe(5);
    expect(entry.sessionId).toBe("default");
    expect(typeof entry.ts).toBe("string");
  });

  it("appends multiple entries to the same day's file", async () => {
    const workspaceRoot = await makeTmpWorkspace();
    tmpDirs.push(workspaceRoot);

    await logSessionEvent({
      enabled: true,
      workspaceRoot,
      surface: "cli",
      tool: "index retrieve",
    });
    await logSessionEvent({
      enabled: true,
      workspaceRoot,
      surface: "mcp",
      tool: "cari_connections",
    });

    const sessionsDir = path.join(workspaceRoot, ".iw", "sessions");
    const files = await fs.readdir(sessionsDir);
    expect(files).toHaveLength(1);

    const content = await fs.readFile(
      path.join(sessionsDir, files[0]),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("index retrieve");
    expect(JSON.parse(lines[1]).tool).toBe("cari_connections");
  });

  it("uses IW_SESSION env var as sessionId when not explicitly provided", async () => {
    const workspaceRoot = await makeTmpWorkspace();
    tmpDirs.push(workspaceRoot);
    const prev = process.env.IW_SESSION;
    process.env.IW_SESSION = "my-session";

    try {
      await logSessionEvent({
        enabled: true,
        workspaceRoot,
        surface: "mcp",
        tool: "cari_check",
      });

      const sessionsDir = path.join(workspaceRoot, ".iw", "sessions");
      const files = await fs.readdir(sessionsDir);
      const content = await fs.readFile(
        path.join(sessionsDir, files[0]),
        "utf-8",
      );
      const entry = JSON.parse(content.trim().split("\n")[0]);
      expect(entry.sessionId).toBe("my-session");
    } finally {
      if (prev === undefined) delete process.env.IW_SESSION;
      else process.env.IW_SESSION = prev;
    }
  });

  it("never throws even if the workspace root is unwritable", async () => {
    await expect(
      logSessionEvent({
        enabled: true,
        workspaceRoot: "/nonexistent/\0invalid/path",
        surface: "cli",
        tool: "index retrieve",
      }),
    ).resolves.toBeUndefined();
  });
});
