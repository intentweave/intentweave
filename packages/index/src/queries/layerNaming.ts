// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: layerNaming (5.1c)
 *
 * Optional LLM pass to name inferred layers based on their file contents
 * and directory structure. E.g., a layer containing `server/`, `routes/`,
 * `middleware/` gets named "HTTP Layer".
 *
 * Depends on 5.1a (layersInfer) output. Pure ergonomics — not needed for
 * validation. Falls back to heuristic labels if no LLM provider is available.
 */

import type { LLMProvider } from "@intentweave/core";
import type {
  LayersInferResult,
  LayerNamingResult,
  NamedLayer,
  NamedDirectory,
} from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compute parent directory of a file path. */
function parentDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

/** Collect unique directories with their child file names, sorted by file count desc. */
function collectDirectories(
  layers: LayersInferResult,
): Array<{ path: string; fileNames: string[]; layerIndex: number }> {
  const dirMap = new Map<string, { files: string[]; layerIndex: number }>();

  for (const layer of layers.layers) {
    for (const file of layer.files) {
      const dir = parentDir(file);
      const existing = dirMap.get(dir);
      const fileName = file.split("/").pop() ?? file;
      if (existing) {
        existing.files.push(fileName);
      } else {
        dirMap.set(dir, { files: [fileName], layerIndex: layer.index });
      }
    }
  }

  // Sort by file count desc, limit to top 40 directories to keep prompt manageable
  return [...dirMap.entries()]
    .map(([path, { files, layerIndex }]) => ({
      path,
      fileNames: files,
      layerIndex,
    }))
    .sort((a, b) => b.fileNames.length - a.fileNames.length)
    .slice(0, 40);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate descriptive names for inferred architectural layers AND their
 * directories using an LLM.
 *
 * @param layers - Output from layersInfer (5.1a)
 * @param llm    - An LLM provider (OpenAI, SmartMock, etc.)
 * @returns Named layers and directories with LLM-generated labels
 */
export async function nameLayers(
  layers: LayersInferResult,
  llm: LLMProvider,
): Promise<LayerNamingResult> {
  if (layers.layers.length === 0) {
    return {
      layers: [],
      directories: [],
      tokensUsed: { prompt: 0, completion: 0 },
      latencyMs: 0,
    };
  }

  const directories = collectDirectories(layers);

  // Build a concise summary of each layer for the prompt
  const layerDescriptions = layers.layers.map((layer) => {
    const sample = layer.files.slice(0, 30);
    const more = layer.files.length - sample.length;
    const fileList = sample.join("\n  ");
    return [
      `Layer ${layer.index} (depth ${layer.depthRange[0]}–${layer.depthRange[1]}, ${layer.files.length} files):`,
      `  Heuristic label: "${layer.label}"`,
      `  Files:`,
      `  ${fileList}`,
      ...(more > 0 ? [`  ... and ${more} more files`] : []),
    ].join("\n");
  });

  // Build directory listing
  const dirDescriptions = directories.map((d) => {
    const sample = d.fileNames.slice(0, 10);
    const more = d.fileNames.length - sample.length;
    return `  "${d.path}" (${d.fileNames.length} files, layer ${d.layerIndex}): ${sample.join(", ")}${more > 0 ? `, …+${more}` : ""}`;
  });

  const system = `You are a software architecture expert. You will be given:
1. A list of automatically inferred architectural layers with their files
2. A list of directories (file groupings) in the codebase

Your task: generate descriptive names and one-sentence descriptions for BOTH layers and directories.

Guidelines for layer names:
- Names should be 1–3 words (e.g., "HTTP Layer", "Data Access", "Core Types")
- Layer 0 = foundation (imported by everything); higher = closer to entry points
- Avoid generic names like "Layer 1" or "Miscellaneous"

Guidelines for directory names:
- Names should be 1–3 words describing the directory's architectural role
- Focus on WHAT the directory contains, not WHERE it is
- E.g., "src/commands" → "CLI Subcommands", "src/stages" → "Pipeline Stages"`;

  const userMessage = `## Layers

${layerDescriptions.join("\n\n")}

## Directories

${dirDescriptions.join("\n")}

Generate a descriptive name and one-sentence description for each layer AND each directory.`;

  const response = await llm.complete({
    system,
    messages: [{ role: "user", content: userMessage }],
    responseSchema: {
      type: "object",
      properties: {
        layers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: {
                type: "number",
                description: "Layer index (must match input)",
              },
              name: {
                type: "string",
                description: "Short descriptive name (1–3 words)",
              },
              description: {
                type: "string",
                description: "One-sentence architectural role",
              },
            },
            required: ["index", "name", "description"],
            additionalProperties: false,
          },
        },
        directories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Directory path (must match input exactly)",
              },
              name: {
                type: "string",
                description: "Short descriptive name (1–3 words)",
              },
              description: {
                type: "string",
                description: "One-sentence description of directory contents",
              },
            },
            required: ["path", "name", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["layers", "directories"],
      additionalProperties: false,
    },
    temperature: 0.3,
    maxTokens: 4096,
  });

  // Parse the LLM response
  type ParsedResponse = {
    layers: Array<{ index: number; name: string; description: string }>;
    directories: Array<{
      path: string;
      name: string;
      description: string;
    }>;
  };
  const parsed = response.parsed as ParsedResponse | undefined;

  const namedLayers: NamedLayer[] = layers.layers.map((layer) => {
    const llmLayer = parsed?.layers?.find((l) => l.index === layer.index);
    return {
      index: layer.index,
      heuristicLabel: layer.label,
      name: llmLayer?.name ?? layer.label,
      description: llmLayer?.description ?? "",
    };
  });

  const namedDirs: NamedDirectory[] = (parsed?.directories ?? []).map((d) => ({
    path: d.path,
    name: d.name,
    description: d.description,
  }));

  return {
    layers: namedLayers,
    directories: namedDirs,
    tokensUsed: response.tokensUsed,
    latencyMs: response.latencyMs,
  };
}
