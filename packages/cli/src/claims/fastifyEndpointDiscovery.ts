// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic Fastify endpoint discovery.
 *
 * Recognizes literal route registrations (`fastify.get("/path", options, handler)`),
 * the hooks that protect them, and the plugin graph that gives each route its
 * full path:
 *
 * - `fastify.register(routesModule[, { prefix }])` edges between files, resolved
 *   through relative imports;
 * - `fastify.register(AutoLoad, { dir: join(__dirname, "x"), options: { prefix } })`
 *   roots, including autoload's directory-name route prefix.
 *
 * A guard counts as positive authentication Evidence only when its
 * `fastify.decorate` definition calls a token verifier in its body. Anything else
 * is recorded as an unverified guard and never as `passed` Evidence. A route whose
 * prefix cannot be proven from literals is recorded with `routeKnown: false`, and
 * the endpoint-authentication contract keeps it inconclusive.
 */

import path from "node:path";
import {
  createExtractor,
  type ExtractedCall,
  type ExtractedImport,
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
}

/** A `fastify.register(identifier, options)` call inside a file. */
interface RegisterCall {
  from: string;
  identifier: string;
  prefix: string | null;
}

/** A `fastify.register(AutoLoad, { dir, options })` root. */
interface AutoloadRoot {
  directory: string;
  prefix: string | null;
  directoryPrefix: boolean;
}

interface ParsedFile {
  file: string;
  calls: ExtractedCall[];
  imports: ExtractedImport[];
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
    const optionsText =
      args.length >= 3 && args[1]!.trim().startsWith("{")
        ? args[1]!
        : undefined;
    const routeGuards: GuardRef[] = [];
    const unparsedGuards: string[] = [];
    for (const expression of optionsText
      ? routeHookExpressions(optionsText)
      : []) {
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
    });
  }
  return registrations;
}

/** The literal `prefix` in a register options object, or null when unprovable. */
function registerPrefix(optionsText: string | undefined): string | null {
  if (optionsText === undefined) return "";
  const literal = /\bprefix\s*:\s*(['"`])([^'"`]*)\1/.exec(optionsText);
  if (literal) return literal[2]!;
  return /\bprefix\s*:/.test(optionsText) ? null : "";
}

function autoloadRoot(
  file: string,
  optionsText: string | undefined,
): AutoloadRoot | undefined {
  if (optionsText === undefined) return undefined;
  const directory =
    /\bdir\s*:\s*(?:path\.)?join\(\s*__dirname\s*,\s*(['"`])([^'"`]+)\1\s*\)/.exec(
      optionsText,
    );
  if (!directory) return undefined;
  const prefix = /\bprefix\s*:\s*(['"`])([^'"`]*)\1/.exec(optionsText);
  const hasPrefixKey = /\bprefix\s*:/.test(optionsText);
  return {
    directory: path.posix.join(path.posix.dirname(file), directory[2]!),
    prefix: prefix ? prefix[2]! : hasPrefixKey ? null : "",
    directoryPrefix: !/dirNameRoutePrefix\s*:\s*false/.test(optionsText),
  };
}

function resolveModule(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ].find((candidate) => files.has(candidate));
}

function joinRoute(...segments: string[]): string {
  const joined = segments
    .join("/")
    .split("/")
    .filter((segment) => segment.length > 0);
  return `/${joined.join("/")}`;
}

/**
 * Build endpoint observations from Fastify sources. `sources` maps relative file
 * paths to source text. Exported for direct fixture testing.
 */
export function discoverFastifyObservations(
  sources: ReadonlyMap<string, string>,
): EndpointObservation[] {
  const extractor = createExtractor(process.cwd());
  const files = new Set(sources.keys());
  const decorations = new Map<string, Decoration[]>();
  const routes: RouteRegistration[] = [];
  const scopeGuardsByFile = new Map<string, GuardRef[]>();
  const scopeUnparsedByFile = new Map<string, string[]>();
  const parsed: ParsedFile[] = [];
  const registerCalls: RegisterCall[] = [];
  const autoloads: AutoloadRoot[] = [];

  for (const [file, source] of sources) {
    if (TEST_FILE_PATTERN.test(file)) continue;
    const extraction = extractor.extractFromString(
      source,
      file,
      languageFor(file),
    );
    const calls = extraction.calls ?? [];
    parsed.push({ file, calls, imports: extraction.imports });

    for (const call of calls) {
      if (!call.isMethod) continue;
      if (call.calleeName === "decorate") {
        const name = literalString(call.argumentTexts?.[0]);
        if (!name) continue;
        const handlerText = call.argumentTexts?.[1] ?? "";
        const list = decorations.get(name) ?? [];
        list.push({ verified: VERIFIER_PATTERN.test(handlerText) });
        decorations.set(name, list);
      }
      if (call.calleeName === "register") {
        const args = call.argumentTexts ?? [];
        const target = args[0]?.trim() ?? "";
        const optionsText = args[1];
        if (target === "AutoLoad") {
          const root = autoloadRoot(file, optionsText);
          if (root) autoloads.push(root);
        } else if (/^[A-Za-z_$][\w$]*$/.test(target)) {
          registerCalls.push({
            from: file,
            identifier: target,
            prefix: registerPrefix(optionsText),
          });
        }
      }
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

  // Resolve each `register(identifier)` through the importing file's imports.
  const edges: Array<{ from: string; to: string; prefix: string | null }> = [];
  for (const call of registerCalls) {
    const importer = parsed.find((item) => item.file === call.from);
    const binding = importer?.imports.find((imported) =>
      imported.imports.some(
        (item) => (item.alias ?? item.name) === call.identifier,
      ),
    );
    if (!binding) continue;
    const target = resolveModule(call.from, binding.moduleSpecifier, files);
    if (target)
      edges.push({ from: call.from, to: target, prefix: call.prefix });
  }

  const memo = new Map<string, string | null>();
  const prefixFor = (
    file: string,
    visiting = new Set<string>(),
  ): string | null => {
    if (memo.has(file)) return memo.get(file)!;
    if (visiting.has(file)) return null;
    visiting.add(file);

    // Autoload loads plugin files, not routes modules. A file under an autoload
    // directory counts as loaded only when it registers plugins itself.
    const registersPlugins = parsed.some(
      (item) =>
        item.file === file &&
        item.calls.some((call) => call.calleeName === "register"),
    );
    const owning = registersPlugins
      ? autoloads
          .filter((root) => file.startsWith(`${root.directory}/`))
          .sort((a, b) => b.directory.length - a.directory.length)[0]
      : undefined;
    let result: string | null;
    if (owning) {
      // Autoload loads plugin files; a plugin's directory under the autoload
      // root becomes its route prefix when dirNameRoutePrefix is enabled.
      const relativeDirectory = path.posix.dirname(
        file.slice(owning.directory.length + 1),
      );
      const directoryPrefix =
        owning.directoryPrefix && relativeDirectory !== "."
          ? `/${relativeDirectory}`
          : "";
      result =
        owning.prefix === null
          ? null
          : joinRoute(owning.prefix, directoryPrefix);
    } else {
      const parents = edges.filter((edge) => edge.to === file);
      if (parents.length === 0) {
        // A root registers plugins itself and is served without a prefix.
        result = registersPlugins ? "/" : null;
      } else {
        const prefixes = new Set<string>();
        let unknown = false;
        for (const parent of parents) {
          const parentPrefix = prefixFor(parent.from, visiting);
          if (parentPrefix === null || parent.prefix === null) {
            unknown = true;
          } else {
            prefixes.add(joinRoute(parentPrefix, parent.prefix));
          }
        }
        result = !unknown && prefixes.size === 1 ? [...prefixes][0]! : null;
      }
    }
    visiting.delete(file);
    memo.set(file, result);
    return result;
  };

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

  const observations = routes.map((route): EndpointObservation => {
    const guards: string[] = [];
    const unverified: string[] = [...route.unparsedGuards];
    let ambiguous = false;
    let guardAmbiguous = false;

    for (const guard of route.routeGuards) {
      const result = resolve(guard);
      ambiguous ||= result.ambiguous;
      guardAmbiguous ||= result.ambiguous;
      if (result.verified) guards.push(guard.display);
      else unverified.push(guard.display);
    }
    const scopeGuards = scopeGuardsByFile.get(route.file) ?? [];
    for (const guard of scopeGuards) {
      const result = resolve(guard);
      ambiguous ||= result.ambiguous;
      guardAmbiguous ||= result.ambiguous;
      if (result.verified) guards.push(guard.display);
      else unverified.push(guard.display);
    }
    const scopeUnparsed = scopeUnparsedByFile.get(route.file) ?? [];
    unverified.push(...scopeUnparsed);
    // Scope hooks apply to every route in their encapsulation context. Routes in
    // the same file are treated as in scope, which is an approximation.
    if (scopeGuards.length > 0 || scopeUnparsed.length > 0) ambiguous = true;

    const guardSource: EndpointObservation["guardSource"] =
      route.routeGuards.length > 0
        ? "handler"
        : scopeGuards.length > 0
          ? "scope-hook"
          : "none";

    const prefix = prefixFor(route.file);
    const routeKnown = prefix !== null;
    const routePath = routeKnown
      ? joinRoute(prefix, route.route)
      : `${route.route}@${route.file}`;

    return {
      method: route.method,
      routePath,
      routeKnown,
      controllerName: path.posix.basename(
        route.file,
        path.posix.extname(route.file),
      ),
      handlerName: route.handlerName,
      handlerSignature: null,
      filePath: route.file,
      line: route.line,
      endLine: route.line,
      guards: [...new Set(guards)].sort(),
      guardAmbiguous,
      unverifiedGuards: [...new Set(unverified)].sort(),
      guardSource,
      publicExemption: false,
      ambiguous,
    };
  });

  // The same method and path from different registrations cannot be told apart.
  const keyCounts = new Map<string, number>();
  for (const observation of observations) {
    const key = `${observation.method} ${observation.routePath}`;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  return observations.map((observation) => ({
    ...observation,
    ambiguous:
      observation.ambiguous ||
      (keyCounts.get(`${observation.method} ${observation.routePath}`) ?? 0) >
        1,
  }));
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
 * Registrations that share a method and path cannot be told apart by the
 * server, so the merged observation is ambiguous and keeps only the guards
 * every registration shares. Dropping a registration silently would hide it.
 */
export function mergeDuplicateObservations(
  observations: readonly EndpointObservation[],
): Map<string, EndpointObservation> {
  const groups = new Map<string, EndpointObservation[]>();
  for (const observation of observations) {
    const key = `${observation.method} ${observation.routePath}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const merged = new Map<string, EndpointObservation>();
  for (const [key, group] of groups) {
    const [first, ...rest] = group;
    if (!first) continue;
    if (rest.length === 0) {
      merged.set(key, first);
      continue;
    }
    const shared = first.guards.filter((guard) =>
      group.every((item) => item.guards.includes(guard)),
    );
    merged.set(key, {
      ...first,
      guards: shared,
      unverifiedGuards: [
        ...new Set(group.flatMap((item) => item.unverifiedGuards ?? [])),
      ].sort(),
      guardAmbiguous: group.some((item) => item.guardAmbiguous === true),
      ambiguous: true,
    });
  }
  return merged;
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
  const discovered = [...mergeDuplicateObservations(observations).values()].map(
    (observation) =>
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
