// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript and JavaScript observation (Phase O1).
 *
 * Produces the generic observation kinds from source: file, module, symbol,
 * dependency (from package.json), and call-site (any call with at least one literal
 * string argument). It does not interpret any of them. Claim families decide what
 * an observation means.
 *
 * Identity keys follow Amendment A: they are built from kind and defining locator,
 * never from a CARI id. Same-name declarations in one file get an ordinal suffix in
 * source order, so keys stay unique.
 */

import * as fs from "fs";
import * as path from "path";
import {
  createExtractor,
  type ExtractedSymbol,
} from "@intentweave/ast-extractor";
import type {
  LanguageObservation,
  ObservationCapability,
  ObservationKind,
  ObservedRecord,
} from "../languageRegistry.js";

export const TYPESCRIPT_OBSERVATION_CONTRACT_VERSION = "1";

/** Thrown when a file cannot be read or parsed, so the kind is partial. */
export class ObservationParseError extends Error {
  constructor(
    readonly filePath: string,
    message: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = "ObservationParseError";
  }
}

function languageFor(
  filePath: string,
): "typescript" | "javascript" | "tsx" | "jsx" {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "typescript";
  }
}

/** Literal string argument: unquoted text, or null when not a plain literal. */
function literalArgument(text: string): string | null {
  const quote = text[0];
  if (!quote || !["'", '"', "`"].includes(quote)) return null;
  if (text.length < 2 || text.at(-1) !== quote) return null;
  const value = text.slice(1, -1);
  if (quote === "`" && value.includes("${")) return null;
  return value;
}

/** Disambiguate keys that would otherwise repeat, in source order. */
function withOrdinals(
  records: Array<{ base: string; record: ObservedRecord }>,
): ObservedRecord[] {
  const totals = new Map<string, number>();
  for (const { base } of records) totals.set(base, (totals.get(base) ?? 0) + 1);
  const seen = new Map<string, number>();
  return records.map(({ base, record }) => {
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    const duplicate = (totals.get(base) ?? 1) > 1;
    return { ...record, identityKey: duplicate ? `${base}~${ordinal}` : base };
  });
}

export function createTypeScriptObservation(
  workspaceRoot: string,
): LanguageObservation {
  let extractor: ReturnType<typeof createExtractor> | null = null;
  const getExtractor = () => {
    extractor ??= createExtractor(workspaceRoot);
    return extractor;
  };

  const capabilities: Record<ObservationKind, ObservationCapability> = {
    file: { status: "observed" },
    module: { status: "observed" },
    symbol: { status: "observed" },
    dependency: { status: "observed" },
    "call-site": { status: "observed" },
  };

  return {
    contractVersion: TYPESCRIPT_OBSERVATION_CONTRACT_VERSION,
    capabilities,

    observeFile(root, relativePath) {
      const absolute = path.join(root, relativePath);
      let content: string;
      try {
        content = fs.readFileSync(absolute, "utf-8");
      } catch (error) {
        throw new ObservationParseError(
          relativePath,
          `unreadable: ${String(error)}`,
        );
      }
      const extraction = getExtractor().extractFromString(
        content,
        relativePath,
        languageFor(relativePath),
      );
      if (extraction.errors?.length) {
        throw new ObservationParseError(relativePath, "parse errors");
      }

      const records: ObservedRecord[] = [];
      records.push({
        kind: "file",
        identityKey: `file:${relativePath}`,
        locator: { filePath: relativePath },
        payload: { extension: path.extname(relativePath) },
      });

      const topLevel = extraction.symbols.filter((symbol) => !symbol.parent);
      const exported = topLevel.filter((symbol) => symbol.isExported);
      if (exported.length > 0) {
        records.push({
          kind: "module",
          identityKey: `module:${relativePath}`,
          locator: { filePath: relativePath },
          payload: {
            exportNames: exported.map((symbol) => symbol.name).sort(),
          },
        });
      }

      const symbolRecords = extraction.symbols.map(
        (symbol: ExtractedSymbol) => {
          const container = symbol.parent ?? null;
          const qualified = container
            ? `${container}.${symbol.name}`
            : symbol.name;
          return {
            base: `symbol:${symbol.kind}:${relativePath}#${qualified}`,
            record: {
              kind: "symbol" as const,
              identityKey: "",
              locator: {
                filePath: relativePath,
                ...(container ? { container } : {}),
                line: symbol.range.startLine,
                endLine: symbol.range.endLine,
              },
              payload: {
                name: symbol.name,
                symbolKind: symbol.kind,
                container,
                signature: symbol.signature ?? null,
                exported: symbol.isExported,
                documented: Boolean(symbol.docSummary),
                deprecated: symbol.deprecated === true,
              },
            },
          };
        },
      );
      records.push(...withOrdinals(symbolRecords));

      const callRecords = extraction.calls ?? [];
      const callSites = callRecords
        .map((call) => {
          const literals = (call.argumentTexts ?? [])
            .map(literalArgument)
            .filter((value): value is string => value !== null);
          if (literals.length === 0) return null;
          const callee = call.calleeId ?? call.calleeName;
          return {
            base: `call-site:${relativePath}#${call.callerLine}:${callee}`,
            record: {
              kind: "call-site" as const,
              identityKey: "",
              locator: { filePath: relativePath, line: call.callerLine },
              payload: {
                callee,
                isMethod: call.isMethod,
                receiver: call.receiverName ?? null,
                caller: call.callerName,
                literalArguments: literals,
                argumentCount: call.argumentTexts?.length ?? 0,
              },
            },
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      records.push(...withOrdinals(callSites));
      return records;
    },

    observeManifest(root) {
      const manifestPath = path.join(root, "package.json");
      if (!fs.existsSync(manifestPath)) return [];
      let manifest: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      } catch (error) {
        throw new ObservationParseError(
          "package.json",
          `invalid JSON: ${String(error)}`,
        );
      }
      const dependencies: ObservedRecord[] = [];
      for (const [section, entries] of [
        ["dependencies", manifest.dependencies ?? {}],
        ["devDependencies", manifest.devDependencies ?? {}],
      ] as const) {
        for (const [name, range] of Object.entries(entries)) {
          dependencies.push({
            kind: "dependency",
            identityKey: `dependency:${name}@package.json`,
            locator: { filePath: "package.json" },
            payload: { name, range, section },
          });
        }
      }
      return dependencies;
    },
  };
}
