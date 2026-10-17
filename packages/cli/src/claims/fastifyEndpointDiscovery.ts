// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic Fastify endpoint discovery.
 *
 * Recognizes literal route registrations (`fastify.get("/path", options, handler)`)
 * and the route-level and scope-level hooks that protect them. A guard counts as
 * positive authentication Evidence only when its `fastify.decorate` definition
 * calls a token verifier in its body. Anything else is recorded as an unverified
 * guard and never as `passed` Evidence.
 *
 * Route prefixes are not resolved: Fastify plugins may add prefixes through
 * autoload, `register`, or `prefix` options. Routes are therefore recorded with
 * `pathKnown: false`, and the endpoint-authentication contract keeps them
 * inconclusive.
 */

import path from "node:path";
import {
  createExtractor,
  type ExtractedCall,
} from "@intentweave/ast-extractor";
import type Database from "@intentweave/sqlite-compat";
import {
  persistObservation,
  retireMissingEndpointCandidates,
  type EndpointCandidateResult,
  type EndpointDiscoveryProfile,
  type EndpointObservation,
} from "./endpointCandidatePersistence.js";
import { languageFor, literalString } from "./sourceHelpers.js";

export const FASTIFY_ENDPOINT_DISCOVERY_ADAPTER_ID =
  "cari-fastify-endpoint-authentication";
export const FASTIFY_ENDPOINT_DISCOVERY_CONTRACT_VERSION = "1";

export const FASTIFY_ENDPOINT_PROFILE: EndpointDiscoveryProfile = {
  framework: "fastify",
  adapterId: FASTIFY_ENDPOINT_DISCOVERY_ADAPTER_ID,
  contractVersion: FASTIFY_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
  packageName: "fastify",
};

const ROUTE_METHODS = new Map<string, string>([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
  ["options", "OPTIONS"],
  ["head", "HEAD"],
  ["all", "*"],
]);

const GUARD_HOOKS = new Set(["onRequest", "preHandler", "preValidation"]);

// A decorator body that calls a token verifier counts as authentication.
const VERIFIER_PATTERN =
  /\.(?:jwtVerify|verify|authenticate)\s*\(|\bverify\w*\s*\(/;

// Test fixtures register routes that are not production endpoints.
const TEST_FILE_PATTERN =
  /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const GUARD_EXPRESSION =
  /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*(?:\(([\s\S]*)\))?$/;

interface Decoration {
  verified: boolean;
  file: string;
}

interface GuardRef {
  name: string;
  display: string;
}

interface RouteRegistration {
  file: string;
  method: string;
  route: string;
  line: number;
  handlerName: string;
  routeGuards: GuardRef[];
  unparsedGuards: string[];
  hasOptions: boolean;
}

/** Split on commas that are not nested inside brackets or parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("([{".includes(char)) depth += 1;
    if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseGuard(expression: string): GuardRef | undefined {
  const match = GUARD_EXPRESSION.exec(expression.trim());
  if (!match) return undefined;
  const name = match[1]!;
  const args = match[2]?.replace(/\s+/g, " ").trim();
  return {
    name,
    display: args !== undefined ? `${name}(${args})` : name,
  };
}

/** Route-level hook arrays and single hooks from the options object text. */
function routeHookExpressions(optionsText: string): string[] {
  const expressions: string[] = [];
  const pattern =
    /\b(preHandler|onRequest|preValidation)\s*:\s*(\[[^\]]*\]|[^,}\n]+)/g;
  for (const match of optionsText.matchAll(pattern)) {
    const value = match[2]!.trim();
    if (value.startsWith("[")) {
      expressions.push(...splitTopLevel(value.slice(1, -1)));
    } else {
      expressions.push(value);
    }
  }
  return expressions;
}

function scopeHookExpressions(calls: readonly ExtractedCall[]): string[] {
  return calls
    .filter(
      (call) =>
        call.isMethod &&
        call.calleeName === "addHook" &&
        GUARD_HOOKS.has(literalString(call.argumentTexts?.[0]) ?? ""),
    )
    .map((call) => call.argumentTexts?.[1] ?? "")
    .filter(Boolean);
}

function routeRegistrations(
  file: string,
  calls: readonly ExtractedCall[],
): RouteRegistration[] {
  const registrations: RouteRegistration[] = [];
  for (const call of calls) {
    if (!call.isMethod || !call.receiverName) continue;
    const method = ROUTE_METHODS.get(call.calleeName);
    if (!method) continue;
    const args = call.argumentTexts ?? [];
    if (args.length < 2) continue;
    const route = literalString(args[0]);
    if (!route || !route.startsWith("/")) continue;

    const handlerText = args[args.length - 1]!;
    const optionsText = args.length >= 3 ? args[1]! : undefined;
    const hasOptions = optionsText?.trim().startsWith("{") ?? false;
    const hookExpressions = hasOptions
      ? routeHookExpressions(optionsText!)
      : [];
    const routeGuards: GuardRef[] = [];
    const unparsedGuards: string[] = [];
    for (const expression of hookExpressions) {
      const guard = parseGuard(expression);
      if (guard) routeGuards.push(guard);
      else unparsedGuards.push(expression);
    }
    const handlerIdentifier = /^[A-Za-z_$][\w$]*$/.test(handlerText)
      ? handlerText
      : undefined;
    registrations.push({
      file,
      method,
      route,
      line: call.callerLine,
      handlerName: handlerIdentifier ?? `anonymous@${call.callerLine}`,
      routeGuards,
      unparsedGuards,
      hasOptions,
    });
  }
  return registrations;
}

/**
 * Build endpoint observations from Fastify sources. `sources` maps relative file
 * paths to source text. Exported for direct fixture testing.
 */
export function discoverFastifyObservations(
  sources: ReadonlyMap<string, string>,
): EndpointObservation[] {
  const extractor = createExtractor(process.cwd());
  const decorations = new Map<string, Decoration[]>();
  const routes: RouteRegistration[] = [];
  const scopeGuardsByFile = new Map<string, GuardRef[]>();
  const scopeUnparsedByFile = new Map<string, string[]>();

  for (const [file, source] of sources) {
    if (TEST_FILE_PATTERN.test(file)) continue;
    const extraction = extractor.extractFromString(
      source,
      file,
      languageFor(file),
    );
    const calls = extraction.calls ?? [];

    for (const call of calls) {
      if (!call.isMethod || call.calleeName !== "decorate") continue;
      const name = literalString(call.argumentTexts?.[0]);
      if (!name) continue;
      const handlerText = call.argumentTexts?.[1] ?? "";
      const list = decorations.get(name) ?? [];
      list.push({ file, verified: VERIFIER_PATTERN.test(handlerText) });
      decorations.set(name, list);
    }

    routes.push(...routeRegistrations(file, calls));

    const scopeGuards: GuardRef[] = [];
    const scopeUnparsed: string[] = [];
    for (const expression of scopeHookExpressions(calls)) {
      const guard = parseGuard(expression);
      if (guard) scopeGuards.push(guard);
      else scopeUnparsed.push(expression);
    }
    scopeGuardsByFile.set(file, scopeGuards);
    scopeUnparsedByFile.set(file, scopeUnparsed);
  }

  const resolve = (
    guard: GuardRef,
  ): { verified: boolean; ambiguous: boolean } => {
    const found = decorations.get(guard.name) ?? [];
    if (found.length === 0) return { verified: false, ambiguous: false };
    if (found.length > 1) {
      return {
        verified: found.every((decoration) => decoration.verified),
        ambiguous: true,
      };
    }
    return { verified: found[0]!.verified, ambiguous: false };
  };

  const keyCounts = new Map<string, number>();
  for (const route of routes) {
    const key = `${route.method} ${route.route} ${route.file}`;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  return routes.map((route): EndpointObservation => {
    const guards: string[] = [];
    const unverified: string[] = [...route.unparsedGuards];
    let ambiguous =
      (keyCounts.get(`${route.method} ${route.route} ${route.file}`) ?? 0) > 1;

    for (const guard of route.routeGuards) {
      const result = resolve(guard);
      ambiguous ||= result.ambiguous;
      if (result.verified) guards.push(guard.display);
      else unverified.push(guard.display);
    }
    const scopeGuards = scopeGuardsByFile.get(route.file) ?? [];
    for (const guard of scopeGuards) {
      const result = resolve(guard);
      ambiguous ||= result.ambiguous;
      if (result.verified) guards.push(guard.display);
      else unverified.push(guard.display);
    }
    const scopeUnparsed = scopeUnparsedByFile.get(route.file) ?? [];
    unverified.push(...scopeUnparsed);
    // Scope hooks apply to every route in their encapsulation context. Same-file
    // routes are treated as in scope, which is an approximation.
    if (scopeGuards.length > 0 || scopeUnparsed.length > 0) ambiguous = true;

    const guardSource: EndpointObservation["guardSource"] =
      route.routeGuards.length > 0
        ? "handler"
        : scopeGuards.length > 0
          ? "scope-hook"
          : "none";

    return {
      method: route.method,
      routePath: `${route.route}@${route.file}`,
      routeKnown: false,
      controllerName: path.basename(route.file, path.extname(route.file)),
      handlerName: route.handlerName,
      handlerSignature: null,
      filePath: route.file,
      line: route.line,
      endLine: route.line,
      guards: [...new Set(guards)].sort(),
      unverifiedGuards: [...new Set(unverified)].sort(),
      guardSource,
      publicExemption: false,
      ambiguous,
    };
  });
}

function dependencyDeclared(packageJson: string | undefined): boolean {
  if (packageJson === undefined) return false;
  try {
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      parsed.dependencies?.fastify ?? parsed.devDependencies?.fastify,
    );
  } catch {
    return false;
  }
}

/**
 * Persist Fastify endpoint-authentication Candidates for a workspace. The
 * framework gate requires `fastify` to be declared in `package.json`.
 */
export function persistFastifyEndpointCandidates(
  database: Database.Database,
  repositoryRevision: string,
  readSource: (filePath: string) => string | undefined,
): EndpointCandidateResult[] {
  if (!dependencyDeclared(readSource("package.json"))) return [];

  const files = database
    .prepare(
      `SELECT path FROM files
       WHERE is_doc = 0
         AND (path LIKE '%.ts' OR path LIKE '%.tsx'
              OR path LIKE '%.js' OR path LIKE '%.jsx'
              OR path LIKE '%.mjs' OR path LIKE '%.cjs')
       ORDER BY path`,
    )
    .all() as Array<{ path: string }>;
  const sources = new Map<string, string>();
  for (const { path: filePath } of files) {
    const source = readSource(filePath);
    if (source !== undefined) sources.set(filePath, source);
  }

  const observations = discoverFastifyObservations(sources);
  const unique = new Map<string, EndpointObservation>();
  for (const observation of observations) {
    const key = `${observation.method} ${observation.routePath}`;
    if (!unique.has(key)) unique.set(key, observation);
  }
  const discovered = [...unique.values()].map((observation) =>
    persistObservation(
      database,
      repositoryRevision,
      observation,
      FASTIFY_ENDPOINT_PROFILE,
    ),
  );
  const activeIdentityKeys = new Set(
    discovered.map((candidate) => candidate.identityKey),
  );
  const retired = retireMissingEndpointCandidates(
    database,
    repositoryRevision,
    activeIdentityKeys,
    FASTIFY_ENDPOINT_PROFILE,
  );
  return [...discovered, ...retired];
}
