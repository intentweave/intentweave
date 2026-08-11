// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaimsGit } from "./git.js";

describe("ClaimsGit", () => {
  const repositories: string[] = [];

  afterEach(() => {
    for (const repository of repositories.splice(0)) {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("uses immutable commit anchors for merge-base, diff, and historical content", () => {
    const repository = mkdtempSync(path.join(tmpdir(), "intentweave-claims-git-"));
    repositories.push(repository);
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf-8" }).trim();
    run("init");
    run("config", "user.email", "claims@example.test");
    run("config", "user.name", "Claims Test");
    writeFileSync(path.join(repository, "session.yaml"), "timeout: 1800\n");
    run("add", "session.yaml");
    run("commit", "-m", "base");
    const base = run("rev-parse", "HEAD");
    writeFileSync(path.join(repository, "session.yaml"), "timeout: 3600\n");
    writeFileSync(path.join(repository, "docs.md"), "override\n");
    run("add", "session.yaml", "docs.md");
    run("commit", "-m", "override");
    const head = run("rev-parse", "HEAD");
    const claimsGit = new ClaimsGit(repository);

    expect(claimsGit.head()).toBe(head);
    expect(claimsGit.resolveCommit("HEAD~1")).toBe(base);
    expect(claimsGit.mergeBase("HEAD~1")).toBe(base);
    expect(claimsGit.changedPaths(base, head)).toEqual(["docs.md", "session.yaml"]);
    expect(claimsGit.listFiles(head)).toEqual(["docs.md", "session.yaml"]);
    expect(claimsGit.show(base, "session.yaml")).toBe("timeout: 1800");
    expect(claimsGit.show(head, "session.yaml")).toBe("timeout: 3600");
    expect(claimsGit.show(base, "docs.md")).toBeUndefined();
  });
});
