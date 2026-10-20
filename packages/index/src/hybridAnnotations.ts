// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Annotations for an index built by the native engine. Symbols, imports, calls and the
 * rest come from the native build. The keyword stages (IN, KWX) and the annotator run here,
 * on the TypeScript implementation, so annotation rows match the TypeScript index exactly.
 * Their cost is small next to symbol extraction (see the stage timings in a build log).
 */

import path from "node:path";
import fs from "node:fs";
import Database from "@intentweave/sqlite-compat";
import type { AxOutput } from "@intentweave/analyzer";
import { annotate } from "./annotator.js";
import { computeIdf } from "./idf.js";
import { writeAnnotations } from "./writer.js";
import { extractSourceCommentContent } from "./facade.js";

/** Source files whose comments are annotated (the TypeScript build's SOURCE_COMMENT_EXTS). */
const SOURCE_COMMENT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".swift",
  ".go",
  ".java",
  ".cs",
]);

/**
 * Files the Analysis stage visits (its discovery excludes declaration, test and spec files,
 * `node_modules`, `dist`, and dot-directories). Comments of these files are annotated.
 */
function analysisVisits(relPath: string): boolean {
  const parts = relPath.split("/");
  if (
    parts.some((p) => p === "node_modules" || p === "dist" || p.startsWith("."))
  )
    return false;
  const name = parts[parts.length - 1] ?? "";
  if (
    name.endsWith(".d.ts") ||
    name.endsWith(".test.ts") ||
    name.endsWith(".spec.ts")
  )
    return false;
  return /\.(ts|tsx|js|jsx)$/.test(name);
}

export interface HybridAnnotationOptions {
  /** Index database written by the native build (replaced atomically by the caller). */
  dbPath: string;
  workspaceRoot: string;
  /** Document files, absolute paths, as the TypeScript build would discover them. */
  docFiles: string[];
  depth: "structured" | "full";
}

function toArtifactId(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel.replace(/[/\\]/g, ".").replace(/\.[^.]+$/, "");
}

/** Symbols read back from the native index, in the shape the annotator expects. */
function symbolsFromIndex(db: Database.Database): AxOutput {
  const rows = db
    .prepare(
      `SELECT id, name, file_path, export FROM symbols ORDER BY file_path, line, rowid`,
    )
    .all() as Array<{
    id: string;
    name: string;
    file_path: string;
    export: string;
  }>;
  const files = new Map<string, { filePath: string; symbols: unknown[] }>();
  for (const row of rows) {
    let file = files.get(row.file_path);
    if (!file) {
      file = { filePath: row.file_path, symbols: [] };
      files.set(row.file_path, file);
    }
    file.symbols.push({
      id: row.id,
      name: row.name,
      export: row.export === "exported" ? "exported" : "internal",
    });
  }
  return { files: [...files.values()] } as unknown as AxOutput;
}

/** Replace the annotation rows of a native-built index. Returns the number written. */
export async function annotateBuiltIndex(
  options: HybridAnnotationOptions,
): Promise<number> {
  const db = new Database(options.dbPath);
  try {
    const ax = symbolsFromIndex(db);
    const analyzer = await import("@intentweave/analyzer");
    const logger = new analyzer.NoopLogger();
    const ctx = {
      logger,
      workspace: { root: options.workspaceRoot, key: "index", id: "index" },
      runId: `index-${Date.now()}`,
      store: null as unknown,
      profile: null as unknown,
      providers: null as unknown,
      now: () => new Date(),
      timestamp: () => new Date().toISOString(),
    } as unknown;
    const symbolDictionary =
      options.depth === "full"
        ? new Set(
            (
              ax as unknown as {
                files: Array<{ symbols: Array<{ name: string }> }>;
              }
            ).files.flatMap((file) =>
              file.symbols.map((symbol) => symbol.name.toLowerCase()),
            ),
          )
        : undefined;

    const kwxOutputs = [];
    for (const filePath of options.docFiles) {
      const relPath = path.relative(options.workspaceRoot, filePath);
      const content = await fs.promises.readFile(filePath, "utf-8");
      const inOutput = await analyzer.runInStage(
        {
          artifactId: toArtifactId(filePath, options.workspaceRoot),
          filePath: relPath,
          content,
        },
        ctx as Parameters<typeof analyzer.runInStage>[1],
      );
      kwxOutputs.push(
        await analyzer.runKwxStage(
          { inOutput },
          { depth: options.depth, dictionary: symbolDictionary },
        ),
      );
    }

    // Comments of source files, as the TypeScript build annotates them (full depth).
    const sourceFiles = (
      db.prepare("SELECT path FROM files WHERE is_doc = 0").all() as Array<{
        path: string;
      }>
    )
      .map((row) => row.path)
      .filter(
        (rel) =>
          SOURCE_COMMENT_EXTS.has(path.extname(rel).toLowerCase()) &&
          analysisVisits(rel),
      )
      .sort();
    for (const relPath of sourceFiles) {
      const absPath = path.join(options.workspaceRoot, relPath);
      let raw: string;
      try {
        raw = await fs.promises.readFile(absPath, "utf-8");
      } catch {
        continue;
      }
      const commentContent = extractSourceCommentContent(raw);
      if (!commentContent.trim()) continue;
      const inOutput = await analyzer.runInStage(
        {
          artifactId: toArtifactId(absPath, options.workspaceRoot),
          filePath: relPath,
          artifactFormat: "text",
          content: commentContent,
        } as Parameters<typeof analyzer.runInStage>[0],
        ctx as Parameters<typeof analyzer.runInStage>[1],
        { minChunkSize: 1 },
      );
      kwxOutputs.push(
        await analyzer.runKwxStage(
          { inOutput },
          { depth: "full", dictionary: symbolDictionary },
        ),
      );
    }

    const idfScores =
      options.depth === "full" ? computeIdf(kwxOutputs) : undefined;
    const annotations = annotate(ax, kwxOutputs, {
      idfScores,
      applyIdfPenalty: options.depth === "full",
    });
    db.transaction(() => {
      db.prepare("DELETE FROM annotations").run();
      writeAnnotations(db, annotations);
    })();
    return annotations.length;
  } finally {
    db.close();
  }
}
