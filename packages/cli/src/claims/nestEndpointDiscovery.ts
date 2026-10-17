// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import {
  createExtractor,
  type ExtractedDecorator,
  type ExtractedSymbol,
} from "@intentweave/ast-extractor";
import type Database from "@intentweave/sqlite-compat";
import {
  endpointCandidateIdentity,
  endpointIdentity,
  persistObservation,
  retireMissingEndpointCandidates,
  type EndpointDiscoveryProfile,
  type EndpointObservation,
  type EndpointCandidateResult,
} from "./endpointCandidatePersistence.js";
import { languageFor, literalString } from "./sourceHelpers.js";
import {
  endpointPayload,
  nestHandlerIdentityKey,
  recordEndpointObservationRun,
} from "./endpointObservationProducer.js";

export const NEST_ENDPOINT_DISCOVERY_ADAPTER_ID =
  "cari-nestjs-endpoint-authentication";
export const NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION = "1";

export const NEST_ENDPOINT_PROFILE: EndpointDiscoveryProfile = {
  framework: "nestjs",
  adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
  contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
  packageName: "@nestjs/common",
};

interface CariSymbolRow {
  id: string;
  name: string;
  container: string | null;
  signature: string | null;
  file_path: string;
  line: number;
  end_line: number | null;
}

const HTTP_DECORATORS = new Map<string, string>([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "*"],
]);

const PUBLIC_DECORATORS = new Set(["Public", "AllowAnonymous", "SkipAuth"]);

function importAliases(
  imports: ReturnType<
    ReturnType<typeof createExtractor>["extractFromString"]
  >["imports"],
): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const imported of imports) {
    if (imported.moduleSpecifier !== "@nestjs/common") continue;
    for (const binding of imported.imports) {
      aliases.set(binding.alias ?? binding.name, binding.name);
    }
  }
  return aliases;
}

function decoratorName(
  decorator: ExtractedDecorator,
  aliases: ReadonlyMap<string, string>,
): string {
  return aliases.get(decorator.name) ?? decorator.name;
}

function decoratorsNamed(
  symbol: ExtractedSymbol,
  aliases: ReadonlyMap<string, string>,
  name: string,
): ExtractedDecorator[] {
  return (symbol.decoratorDetails ?? []).filter(
    (decorator) => decoratorName(decorator, aliases) === name,
  );
}

function normalizedRoutePath(prefix: string, route: string): string {
  const segments = `${prefix}/${route}`
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return `/${segments.join("/")}`;
}

function guardNames(decorator: ExtractedDecorator | undefined): string[] {
  return [
    ...new Set(
      (decorator?.arguments ?? [])
        .map((argument) => argument.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ].sort();
}

function documentationRequirement(
  source: string,
  symbolStartLine: number,
): "required" | "public" | undefined {
  const prefix = source
    .split(/\r?\n/)
    .slice(0, symbolStartLine - 1)
    .join("\n");
  const comments = [...prefix.matchAll(/\/\*\*([\s\S]*?)\*\//g)];
  const latest = comments.at(-1);
  if (!latest || latest.index === undefined) return undefined;
  const afterComment = prefix.slice(latest.index + latest[0].length);
  if (!/^\s*(?:@[A-Za-z_$][\w$]*(?:\([^\n]*\))?\s*)*$/.test(afterComment)) {
    return undefined;
  }
  const auth = /@auth\s+(required|public)\b/i.exec(latest[1] ?? "");
  return auth?.[1]?.toLowerCase() as "required" | "public" | undefined;
}

function discoverObservations(
  rows: readonly CariSymbolRow[],
  readSource: (filePath: string) => string | undefined,
): EndpointObservation[] {
  const extractor = createExtractor(process.cwd());
  const rowsByFile = new Map<string, CariSymbolRow[]>();
  for (const row of rows) {
    const existing = rowsByFile.get(row.file_path) ?? [];
    existing.push(row);
    rowsByFile.set(row.file_path, existing);
  }
  const observations: EndpointObservation[] = [];
  for (const [filePath, fileRows] of rowsByFile) {
    const source = readSource(filePath);
    if (source === undefined) continue;
    const extraction = extractor.extractFromString(
      source,
      filePath,
      languageFor(filePath),
    );
    const aliases = importAliases(extraction.imports);
    if (![...aliases.values()].includes("Controller")) continue;
    const methods = extraction.symbols.filter(
      (symbol) => symbol.kind === "method" && symbol.parent,
    );
    for (const controller of extraction.symbols.filter(
      (symbol) => symbol.kind === "class",
    )) {
      const controllerDecorator = decoratorsNamed(
        controller,
        aliases,
        "Controller",
      )[0];
      if (!controllerDecorator) continue;
      const prefix = literalString(controllerDecorator.arguments[0]);
      const classGuard = decoratorsNamed(controller, aliases, "UseGuards")[0];
      const classPublic = (controller.decoratorDetails ?? []).some(
        (decorator) => PUBLIC_DECORATORS.has(decoratorName(decorator, aliases)),
      );
      for (const handler of methods.filter(
        (method) => method.parent === controller.name,
      )) {
        const routeDecorators = (handler.decoratorDetails ?? []).filter(
          (decorator) => HTTP_DECORATORS.has(decoratorName(decorator, aliases)),
        );
        if (routeDecorators.length === 0) continue;
        const routeDecorator = routeDecorators[0]!;
        const method = HTTP_DECORATORS.get(
          decoratorName(routeDecorator, aliases),
        )!;
        const route = literalString(routeDecorator.arguments[0]);
        const routeKnown = prefix !== undefined && route !== undefined;
        const routePath = routeKnown
          ? normalizedRoutePath(prefix, route)
          : `/unknown/${controller.name}.${handler.name}`;
        const handlerGuard = decoratorsNamed(handler, aliases, "UseGuards")[0];
        const guards = guardNames(handlerGuard ?? classGuard);
        const publicExemption =
          classPublic ||
          (handler.decoratorDetails ?? []).some((decorator) =>
            PUBLIC_DECORATORS.has(decoratorName(decorator, aliases)),
          );
        const indexedHandler = fileRows.find(
          (row) =>
            row.container === controller.name &&
            row.name === handler.name &&
            row.line === handler.range.startLine,
        );
        observations.push({
          method,
          routePath,
          routeKnown,
          controllerName: controller.name,
          handlerName: handler.name,
          handlerSignature:
            handler.signature ?? indexedHandler?.signature ?? null,
          handlerSymbolId: indexedHandler?.id,
          filePath,
          line: handler.range.startLine,
          endLine: handler.range.endLine,
          guards,
          guardSource: handlerGuard
            ? "handler"
            : classGuard
              ? "controller"
              : "none",
          publicExemption,
          documentationRequirement: documentationRequirement(
            source,
            handler.range.startLine,
          ),
          ambiguous: routeDecorators.length !== 1,
        });
      }
    }
  }
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const key = endpointIdentity(
      NEST_ENDPOINT_PROFILE.framework,
      observation.method,
      observation.routePath,
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return observations.map((observation) => ({
    ...observation,
    ambiguous:
      observation.ambiguous ||
      (counts.get(
        endpointIdentity(
          NEST_ENDPOINT_PROFILE.framework,
          observation.method,
          observation.routePath,
        ),
      ) ?? 0) > 1,
  }));
}

export function persistNestEndpointCandidates(
  database: Database.Database,
  repositoryRevision: string,
  readSource: (filePath: string) => string | undefined,
): EndpointCandidateResult[] {
  const rows = database
    .prepare(
      `SELECT id, name, container, signature, file_path, line, end_line
       FROM symbols
       WHERE file_path LIKE '%.ts' OR file_path LIKE '%.tsx'
          OR file_path LIKE '%.js' OR file_path LIKE '%.jsx'
          OR file_path LIKE '%.mjs' OR file_path LIKE '%.cjs'
       ORDER BY file_path, line, id`,
    )
    .all() as CariSymbolRow[];
  const observations = discoverObservations(rows, readSource);
  const uniqueObservations = new Map<string, EndpointObservation>();
  for (const observation of observations) {
    const key = endpointIdentity(
      NEST_ENDPOINT_PROFILE.framework,
      observation.method,
      observation.routePath,
    );
    if (!uniqueObservations.has(key)) uniqueObservations.set(key, observation);
  }
  recordEndpointObservationRun(database, {
    adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
    contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
    kind: "symbol",
    repositoryRevision,
    scopeFiles: [...new Set(rows.map((row) => row.file_path))],
    description: "NestJS route handlers",
    records: [...uniqueObservations.values()].map((observation) => ({
      identityKey: nestHandlerIdentityKey(observation),
      filePath: observation.filePath,
      line: observation.line,
      endLine: observation.endLine,
      payload: endpointPayload("nest", observation),
    })),
  });
  const discovered = [...uniqueObservations.values()].map((observation) =>
    persistObservation(
      database,
      repositoryRevision,
      observation,
      NEST_ENDPOINT_PROFILE,
    ),
  );
  const activeIdentityKeys = new Set(
    discovered.map((candidate) => candidate.identityKey),
  );
  const retired = retireMissingEndpointCandidates(
    database,
    repositoryRevision,
    activeIdentityKeys,
    NEST_ENDPOINT_PROFILE,
  );
  return [...discovered, ...retired];
}
