// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Decorator-Derived Layer Assignment (14.4)
 *
 * Reads decorator metadata stored on symbols and maps decorator names to
 * architectural layers using built-in presets (nestjs, angular, spring) or
 * user-supplied overrides.
 *
 * Optionally writes the inferred layer configuration to `.iw/layers.yaml`.
 */

import Database from "@intentweave/sqlite-compat";
import * as fs from "fs";
import * as path from "path";
import type {
  LayersFromDecoratorsResult,
  DecoratorLayerAssignment,
} from "../types.js";

export interface LayersFromDecoratorsOptions {
  /** Built-in preset name */
  preset?: "nestjs" | "angular" | "spring";
  /** Custom decorator → { layer, layerName } overrides (merged with preset) */
  overrides?: Record<string, { layer: number; layerName: string }>;
  /** If true, write the resulting layer map to .iw/layers.yaml */
  writeYaml?: boolean;
  /** Workspace root (needed when writeYaml=true) */
  workspaceRoot?: string;
}

// ── Built-in presets ─────────────────────────────────────────────────────────

type LayerDef = { layer: number; layerName: string };

const PRESETS: Record<string, Record<string, LayerDef>> = {
  nestjs: {
    Controller: { layer: 1, layerName: "presentation" },
    Resolver: { layer: 1, layerName: "presentation" },
    Gateway: { layer: 1, layerName: "presentation" },
    Get: { layer: 1, layerName: "presentation" },
    Post: { layer: 1, layerName: "presentation" },
    Put: { layer: 1, layerName: "presentation" },
    Delete: { layer: 1, layerName: "presentation" },
    Patch: { layer: 1, layerName: "presentation" },
    Injectable: { layer: 2, layerName: "service" },
    Service: { layer: 2, layerName: "service" },
    UseGuards: { layer: 2, layerName: "service" },
    UsePipes: { layer: 2, layerName: "service" },
    UseInterceptors: { layer: 2, layerName: "service" },
    Repository: { layer: 3, layerName: "data" },
    InjectRepository: { layer: 3, layerName: "data" },
    Entity: { layer: 3, layerName: "data" },
    Column: { layer: 3, layerName: "data" },
    PrimaryGeneratedColumn: { layer: 3, layerName: "data" },
    Module: { layer: 0, layerName: "module" },
  },
  angular: {
    Component: { layer: 1, layerName: "presentation" },
    Directive: { layer: 1, layerName: "presentation" },
    Pipe: { layer: 1, layerName: "presentation" },
    Injectable: { layer: 2, layerName: "service" },
    NgModule: { layer: 0, layerName: "module" },
    Input: { layer: 1, layerName: "presentation" },
    Output: { layer: 1, layerName: "presentation" },
    HostListener: { layer: 1, layerName: "presentation" },
  },
  spring: {
    RestController: { layer: 1, layerName: "presentation" },
    Controller: { layer: 1, layerName: "presentation" },
    RequestMapping: { layer: 1, layerName: "presentation" },
    GetMapping: { layer: 1, layerName: "presentation" },
    PostMapping: { layer: 1, layerName: "presentation" },
    Service: { layer: 2, layerName: "service" },
    Component: { layer: 2, layerName: "service" },
    Repository: { layer: 3, layerName: "data" },
    Entity: { layer: 3, layerName: "data" },
    Configuration: { layer: 0, layerName: "config" },
    Bean: { layer: 0, layerName: "config" },
    Autowired: { layer: 2, layerName: "service" },
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

export function layersFromDecorators(
  dbPath: string,
  opts: LayersFromDecoratorsOptions = {},
): LayersFromDecoratorsResult {
  const db = new Database(dbPath, { readonly: true });
  try {
    return layersFromDecoratorsFromDb(db, opts);
  } finally {
    db.close();
  }
}

export function layersFromDecoratorsFromDb(
  db: Database.Database,
  opts: LayersFromDecoratorsOptions = {},
): LayersFromDecoratorsResult {
  const {
    preset = "nestjs",
    overrides = {},
    writeYaml = false,
    workspaceRoot,
  } = opts;

  const baseMap: Record<string, LayerDef> = {
    ...(PRESETS[preset] ?? {}),
    ...overrides,
  };

  // Query symbols that have decorators stored
  const rows = db
    .prepare(
      `SELECT id, name, file_path, decorators
       FROM symbols
       WHERE decorators IS NOT NULL AND decorators != '[]'`,
    )
    .all() as Array<{
    id: string;
    name: string;
    file_path: string;
    decorators: string;
  }>;

  const assignments: DecoratorLayerAssignment[] = [];
  let totalSymbols = 0;

  for (const row of rows) {
    let decoratorNames: string[];
    try {
      decoratorNames = JSON.parse(row.decorators) as string[];
    } catch {
      continue;
    }
    if (!Array.isArray(decoratorNames) || decoratorNames.length === 0) continue;

    totalSymbols++;

    // Find the first decorator that matches the map
    let matched: LayerDef | undefined;
    for (const dec of decoratorNames) {
      if (baseMap[dec]) {
        matched = baseMap[dec];
        break;
      }
    }
    if (!matched) continue;

    assignments.push({
      filePath: row.file_path,
      layer: matched.layer,
      layerName: matched.layerName,
      decorators: decoratorNames,
      symbolName: row.name,
    });
  }

  // Group into layers map
  const layersMap: LayersFromDecoratorsResult["layers"] = {};
  for (const a of assignments) {
    if (!layersMap[a.layer]) {
      layersMap[a.layer] = { name: a.layerName, files: [], decorators: [] };
    }
    const entry = layersMap[a.layer];
    if (!entry.files.includes(a.filePath)) entry.files.push(a.filePath);
    for (const d of a.decorators) {
      if (!entry.decorators.includes(d)) entry.decorators.push(d);
    }
  }

  if (writeYaml && workspaceRoot) {
    writeLayersYaml(workspaceRoot, layersMap, preset);
  }

  return {
    assignments,
    layers: layersMap,
    totalSymbols,
    preset,
  };
}

function writeLayersYaml(
  workspaceRoot: string,
  layers: LayersFromDecoratorsResult["layers"],
  preset: string,
): void {
  const iwDir = path.join(workspaceRoot, ".iw");
  fs.mkdirSync(iwDir, { recursive: true });

  // Hand-rolled YAML — avoids js-yaml dependency in @intentweave/index
  const lines: string[] = [
    `# Generated by iw index layers-infer --from-decorators`,
    `preset: ${preset}`,
    `layers:`,
  ];

  for (const [num, def] of Object.entries(layers)) {
    lines.push(`  - layer: ${num}`);
    lines.push(`    name: ${def.name}`);
    if (def.files.length > 0) {
      lines.push(`    files:`);
      for (const f of def.files) {
        lines.push(`      - ${f.replace(/'/g, "\\'")}`);
      }
    }
  }

  fs.writeFileSync(
    path.join(iwDir, "layers.yaml"),
    lines.join("\n") + "\n",
    "utf-8",
  );
}
