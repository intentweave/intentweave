// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace Tests - Phase 1.6.3
 *
 * Unit tests for workspace key handling and WorkspaceRef
 */

import { describe, it, expect } from "vitest";
import {
  // WorkspaceRef
  createWorkspaceRef,

  // Workspace key validation
  isValidWorkspaceKey,
  sanitizeWorkspaceKey,

  // Key → Path mapping
  getWorkspacePath,
  getManifestPath,
  getWorkspaceRunsPath,
  getRunPath,
  getCuratedPath,

  // WorkspaceManifest
  createWorkspaceManifest,
  validateWorkspaceManifest,
  getWorkspaceRefFromManifest,

  // WorkspaceRegistry
  createWorkspaceRegistry,
  findWorkspaceInRegistry,
  upsertWorkspaceInRegistry,

  // RunMeta helpers
  generateRunId,
  createRunMeta,
  completeRunMeta,
  failRunMeta,

  // Types
  type WorkspaceRef,
  type WorkspaceManifest,
  type WorkspaceRegistry,
} from "../workspace/index.js";
import { isStableWorkspaceId } from "../cgId/index.js";

describe("Workspace utilities", () => {
  describe("WorkspaceRef", () => {
    describe("createWorkspaceRef", () => {
      it("creates WorkspaceRef with generated ID", () => {
        const ref = createWorkspaceRef("my-project");
        expect(ref.key).toBe("my-project");
        expect(isStableWorkspaceId(ref.id)).toBe(true);
      });

      it("creates WorkspaceRef with explicit ID", () => {
        const ref = createWorkspaceRef("my-project", "ws_1234");
        expect(ref.key).toBe("my-project");
        expect(ref.id).toBe("ws_1234");
      });

      it("throws for invalid workspace key", () => {
        expect(() => createWorkspaceRef("Invalid Key!")).toThrow();
        expect(() => createWorkspaceRef("X")).toThrow(); // Too short
        expect(() => createWorkspaceRef("123-start")).toThrow(); // Starts with number
      });
    });
  });

  describe("Workspace key validation", () => {
    describe("isValidWorkspaceKey", () => {
      it("returns true for valid keys", () => {
        expect(isValidWorkspaceKey("my-project")).toBe(true);
        expect(isValidWorkspaceKey("project123")).toBe(true);
        expect(isValidWorkspaceKey("ab")).toBe(true); // Min length
        expect(isValidWorkspaceKey("a-b-c-d")).toBe(true);
      });

      it("returns false for invalid keys", () => {
        expect(isValidWorkspaceKey("X")).toBe(false); // Too short
        expect(isValidWorkspaceKey("123project")).toBe(false); // Starts with number
        expect(isValidWorkspaceKey("my--project")).toBe(false); // Double hyphen
        expect(isValidWorkspaceKey("project-")).toBe(false); // Ends with hyphen
        expect(isValidWorkspaceKey("My Project")).toBe(false); // Uppercase and space
        expect(isValidWorkspaceKey("")).toBe(false);
      });
    });

    describe("sanitizeWorkspaceKey", () => {
      it("converts to lowercase", () => {
        expect(sanitizeWorkspaceKey("MyProject")).toBe("myproject");
      });

      it("replaces spaces with hyphens", () => {
        expect(sanitizeWorkspaceKey("my project")).toBe("my-project");
      });

      it("removes invalid characters", () => {
        expect(sanitizeWorkspaceKey("my@project!")).toBe("my-project");
      });

      it("handles consecutive hyphens", () => {
        expect(sanitizeWorkspaceKey("my---project")).toBe("my-project");
      });

      it("throws for empty result", () => {
        expect(() => sanitizeWorkspaceKey("")).toThrow();
        expect(() => sanitizeWorkspaceKey("!@#")).toThrow();
      });

      it("adds prefix if starts with number", () => {
        const result = sanitizeWorkspaceKey("123project");
        expect(result).toBe("ws-123project");
        expect(isValidWorkspaceKey(result)).toBe(true);
      });
    });
  });

  describe("Key → Path mapping", () => {
    describe("getWorkspacePath", () => {
      it("returns workspace directory path", () => {
        expect(getWorkspacePath("my-project")).toBe(
          ".iw/workspaces/my-project",
        );
      });

      it("uses custom base directory", () => {
        expect(
          getWorkspacePath("my-project", { baseDir: "/home/user/.iw" }),
        ).toBe("/home/user/.iw/workspaces/my-project");
      });

      it("throws for invalid workspace key", () => {
        expect(() => getWorkspacePath("Invalid!")).toThrow();
      });
    });

    describe("getManifestPath", () => {
      it("returns manifest file path", () => {
        expect(getManifestPath("my-project")).toBe(
          ".iw/workspaces/my-project/workspace.json",
        );
      });
    });

    describe("getWorkspaceRunsPath", () => {
      it("returns runs directory path", () => {
        expect(getWorkspaceRunsPath("my-project")).toBe(
          ".iw/workspaces/my-project/runs",
        );
      });
    });

    describe("getRunPath", () => {
      it("returns specific run directory path", () => {
        expect(getRunPath("my-project", "run-2026-01-10")).toBe(
          ".iw/workspaces/my-project/runs/run-2026-01-10",
        );
      });
    });

    describe("getCuratedPath", () => {
      it("returns curated directory path", () => {
        expect(getCuratedPath("my-project")).toBe(
          ".iw/workspaces/my-project/curated",
        );
      });
    });
  });

  describe("WorkspaceManifest", () => {
    describe("createWorkspaceManifest", () => {
      it("creates valid manifest with defaults", () => {
        const manifest = createWorkspaceManifest(
          "my-project",
          "My Project",
          "/path/to/project",
        );

        expect(manifest.schemaVersion).toBe("0.1");
        expect(manifest.workspace.key).toBe("my-project");
        expect(isStableWorkspaceId(manifest.workspace.id)).toBe(true);
        expect(manifest.displayName).toBe("My Project");
        expect(manifest.rootPath).toBe("/path/to/project");
        expect(manifest.createdAt).toBeDefined();
        expect(manifest.updatedAt).toBeDefined();
      });

      it("creates manifest with options", () => {
        const manifest = createWorkspaceManifest(
          "my-project",
          "My Project",
          "/path",
          {
            description: "A test project",
            defaultProfile: "starter",
            config: { runRetention: 5 },
          },
        );

        expect(manifest.description).toBe("A test project");
        expect(manifest.defaultProfile).toBe("starter");
        expect(manifest.config?.runRetention).toBe(5);
      });
    });

    describe("validateWorkspaceManifest", () => {
      it("returns true for valid manifest", () => {
        const manifest = createWorkspaceManifest(
          "my-project",
          "My Project",
          "/path",
        );
        expect(validateWorkspaceManifest(manifest)).toBe(true);
      });

      it("returns false for invalid manifest", () => {
        expect(validateWorkspaceManifest(null)).toBe(false);
        expect(validateWorkspaceManifest({})).toBe(false);
        expect(validateWorkspaceManifest({ schemaVersion: "0.2" })).toBe(false);
        expect(
          validateWorkspaceManifest({
            schemaVersion: "0.1",
            workspace: { key: "valid", id: "invalid" }, // Invalid ID
            displayName: "Test",
            rootPath: "/",
            createdAt: "2026-01-10",
            updatedAt: "2026-01-10",
          }),
        ).toBe(false);
      });
    });

    describe("getWorkspaceRefFromManifest", () => {
      it("extracts WorkspaceRef from manifest", () => {
        const manifest = createWorkspaceManifest(
          "my-project",
          "My Project",
          "/path",
        );
        const ref = getWorkspaceRefFromManifest(manifest);

        expect(ref.key).toBe("my-project");
        expect(ref.id).toBe(manifest.workspace.id);
      });
    });
  });

  describe("WorkspaceRegistry", () => {
    describe("createWorkspaceRegistry", () => {
      it("creates empty registry", () => {
        const registry = createWorkspaceRegistry();
        expect(registry.schemaVersion).toBe("0.1");
        expect(registry.workspaces).toEqual([]);
        expect(registry.defaultWorkspace).toBeUndefined();
      });
    });

    describe("findWorkspaceInRegistry", () => {
      it("finds workspace by key", () => {
        const registry: WorkspaceRegistry = {
          schemaVersion: "0.1",
          workspaces: [
            { key: "project-a", id: "ws_aaaa", path: "/a" },
            { key: "project-b", id: "ws_bbbb", path: "/b" },
          ],
        };

        const found = findWorkspaceInRegistry(registry, "project-a");
        expect(found?.key).toBe("project-a");
        expect(found?.id).toBe("ws_aaaa");
      });

      it("finds workspace by alias", () => {
        const registry: WorkspaceRegistry = {
          schemaVersion: "0.1",
          workspaces: [
            { key: "project-a", id: "ws_aaaa", path: "/a", alias: "pa" },
          ],
        };

        const found = findWorkspaceInRegistry(registry, "pa");
        expect(found?.key).toBe("project-a");
      });

      it("returns undefined for unknown workspace", () => {
        const registry = createWorkspaceRegistry();
        expect(findWorkspaceInRegistry(registry, "unknown")).toBeUndefined();
      });
    });

    describe("upsertWorkspaceInRegistry", () => {
      it("adds new workspace", () => {
        let registry = createWorkspaceRegistry();
        registry = upsertWorkspaceInRegistry(registry, {
          key: "new-project",
          id: "ws_new1",
          path: "/new",
        });

        expect(registry.workspaces.length).toBe(1);
        expect(registry.workspaces[0].key).toBe("new-project");
        expect(registry.workspaces[0].lastAccessed).toBeDefined();
      });

      it("updates existing workspace", () => {
        let registry: WorkspaceRegistry = {
          schemaVersion: "0.1",
          workspaces: [{ key: "existing", id: "ws_old1", path: "/old" }],
        };

        registry = upsertWorkspaceInRegistry(registry, {
          key: "existing",
          id: "ws_old1",
          path: "/updated",
        });

        expect(registry.workspaces.length).toBe(1);
        expect(registry.workspaces[0].path).toBe("/updated");
      });
    });
  });

  describe("RunMeta helpers", () => {
    describe("generateRunId", () => {
      it("generates valid run ID format", () => {
        const runId = generateRunId();
        expect(runId).toMatch(/^run-\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{4}$/);
      });

      it("generates unique IDs", () => {
        const ids = new Set(Array.from({ length: 10 }, generateRunId));
        expect(ids.size).toBe(10);
      });
    });

    describe("createRunMeta", () => {
      it("creates RunMeta with defaults", () => {
        const ref = createWorkspaceRef("my-project", "ws_1234");
        const meta = createRunMeta(ref);

        expect(meta.schemaVersion).toBe("0.1");
        expect(meta.workspaceId).toBe("ws_1234");
        expect(meta.workspaceKey).toBe("my-project");
        expect(meta.runId).toMatch(/^run-/);
        expect(meta.status).toBe("running");
        expect(meta.startedAt).toBeDefined();
        expect(meta.completedAt).toBeUndefined();
      });

      it("creates RunMeta with custom runId and profile", () => {
        const ref = createWorkspaceRef("my-project", "ws_1234");
        const meta = createRunMeta(ref, {
          runId: "custom-run-id",
          profile: "starter",
        });

        expect(meta.runId).toBe("custom-run-id");
        expect(meta.profile).toBe("starter");
      });
    });

    describe("completeRunMeta", () => {
      it("marks run as completed with stats", () => {
        const ref = createWorkspaceRef("my-project", "ws_1234");
        const meta = createRunMeta(ref);
        const completed = completeRunMeta(meta, {
          entityCount: 10,
          statementCount: 25,
          artifactCount: 3,
        });

        expect(completed.status).toBe("completed");
        expect(completed.completedAt).toBeDefined();
        expect(completed.entityCount).toBe(10);
        expect(completed.statementCount).toBe(25);
        expect(completed.artifactCount).toBe(3);
      });
    });

    describe("failRunMeta", () => {
      it("marks run as failed with error", () => {
        const ref = createWorkspaceRef("my-project", "ws_1234");
        const meta = createRunMeta(ref);
        const failed = failRunMeta(meta, "Extraction failed: API error");

        expect(failed.status).toBe("failed");
        expect(failed.completedAt).toBeDefined();
        expect(failed.error).toBe("Extraction failed: API error");
      });
    });
  });
});
