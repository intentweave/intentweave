// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import {
  createExtractor,
  type ExtractedDecorator,
  type ExtractedSymbol,
} from "@intentweave/ast-extractor";
import type Database from "@intentweave/sqlite-compat";
import {
  CandidateStore,
  ClaimsStore,
  fingerprint,
  subjectIdentity,
  type CandidateConfidence,
  type PersistedCandidate,
} from "@intentweave/index";

export const NEST_ENDPOINT_DISCOVERY_ADAPTER_ID =
  "cari-nestjs-endpoint-authentication";
export const NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION = "1";

export interface NestEndpointCandidateResult extends PersistedCandidate {
  proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED";
  confidence: CandidateConfidence;
  sourceKinds: string[];
  surfaced: boolean;
}

interface CariSymbolRow {
  id: string;
  name: string;
  container: string | null;
  signature: string | null;
  file_path: string;
  line: number;
  end_line: number | null;
}

interface EndpointObservation {
  method: string;
  routePath: string;
  routeKnown: boolean;
  controllerName: string;
  handlerName: string;
  handlerSignature: string | null;
  handlerSymbolId?: string;
  filePath: string;
  line: number;
  endLine: number;
  guards: string[];
  guardSource: "handler" | "controller" | "none";
  publicExemption: boolean;
  documentationRequirement?: "required" | "public";
  ambiguous: boolean;
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

function literalString(expression: string | undefined): string | undefined {
  if (!expression) return "";
  const quote = expression[0];
  if (!quote || !["'", '"', "`"].includes(quote)) return undefined;
  if (expression.at(-1) !== quote) return undefined;
  const value = expression.slice(1, -1);
  if (quote === "`" && value.includes("${")) return undefined;
  return value.replace(/\\([\\'"`])/g, "$1");
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

function endpointIdentity(method: string, routePath: string): string {
  return `endpoint:nestjs:${method}:${routePath}`;
}

function endpointCandidateIdentity(method: string, routePath: string): string {
  return `endpoint-auth:nestjs:${method}:${routePath}`;
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
    const key = endpointIdentity(observation.method, observation.routePath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return observations.map((observation) => ({
    ...observation,
    ambiguous:
      observation.ambiguous ||
      (counts.get(
        endpointIdentity(observation.method, observation.routePath),
      ) ?? 0) > 1,
  }));
}

function persistObservation(
  database: Database.Database,
  repositoryRevision: string,
  observation: EndpointObservation,
): NestEndpointCandidateResult {
  const claims = new ClaimsStore(database);
  const candidates = new CandidateStore(database);
  const subjectKey = endpointIdentity(
    observation.method,
    observation.routePath,
  );
  const candidateKey = endpointCandidateIdentity(
    observation.method,
    observation.routePath,
  );
  const endpointSubject = {
    kind: "endpoint" as const,
    identityKey: subjectKey,
    displayName: `${observation.method} ${observation.routePath}`,
    role: "endpoint",
    basis: "nestjs-controller-route",
    confidence: (observation.ambiguous
      ? "ambiguous"
      : "certain") as CandidateConfidence,
  };
  const handlerSubject = {
    kind: "symbol" as const,
    identityKey: `symbol:nestjs-handler:${observation.filePath}:${observation.controllerName}.${observation.handlerName}`,
    displayName: `${observation.controllerName}.${observation.handlerName}`,
    role: "handler",
    basis: "nestjs-route-handler",
    confidence: "certain" as const,
  };
  const previousHandlerSubject = database
    .prepare(
      `SELECT subject.id, subject.identity_key, subject.display_name
       FROM evidence_identities evidence
       JOIN evidence_subjects link ON link.evidence_identity_id = evidence.id
       JOIN subject_identities subject ON subject.id = link.subject_identity_id
       WHERE evidence.identity_key = ? AND link.subject_role = 'handler'
         AND subject.identity_key != ?
       ORDER BY subject.created_at DESC, subject.id DESC LIMIT 1`,
    )
    .get(`${candidateKey}:handler`, handlerSubject.identityKey) as
    | { id: string; identity_key: string; display_name: string }
    | undefined;
  const guardSubjects = observation.guards.map((guard) => ({
    kind: "symbol" as const,
    identityKey: `symbol:nestjs-guard:${guard}`,
    displayName: guard,
    role: "guard",
    basis: "nestjs-use-guards",
    confidence: "certain" as const,
  }));
  const routeValue = {
    framework: "nestjs",
    method: observation.method,
    path: observation.routePath,
    pathKnown: observation.routeKnown,
    active: true,
  };
  const handlerValue = {
    controller: observation.controllerName,
    handler: observation.handlerName,
    signature: observation.handlerSignature,
  };
  const guardValue = {
    present: observation.guards.length > 0,
    guards: observation.guards,
    source: observation.guardSource,
    publicExemption: observation.publicExemption,
  };
  const documentationValue = {
    requirement: observation.documentationRequirement ?? null,
  };
  const frameworkValue = {
    framework: "nestjs",
    recognized: true,
    routePathStatic: observation.routeKnown,
  };
  const routeVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, handlerSubject],
    sourceKind: "framework-route",
    identityKey: `${candidateKey}:route`,
    fingerprint: fingerprint({
      routeValue,
      filePath: observation.filePath,
      line: observation.line,
      handler: handlerValue,
    }),
    materialFingerprint: fingerprint(routeValue),
    normalizedValue: routeValue,
    semanticLocation: subjectKey,
    provenance: {
      adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
      contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const handlerVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, handlerSubject],
    sourceKind: "route-handler",
    identityKey: `${candidateKey}:handler`,
    fingerprint: fingerprint({
      handlerValue,
      filePath: observation.filePath,
      line: observation.line,
      symbolId: observation.handlerSymbolId ?? null,
    }),
    materialFingerprint: fingerprint({ endpoint: subjectKey }),
    normalizedValue: handlerValue,
    semanticLocation: `${subjectKey}.handler`,
    provenance: {
      adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
      contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const handlerContinuity = previousHandlerSubject
    ? claims.persistSubjectContinuity({
        fromSubjectIdentityId: previousHandlerSubject.id,
        toSubjectIdentityId: subjectIdentity(
          "symbol",
          handlerSubject.identityKey,
          handlerSubject.displayName,
        ).id,
        basis: "stable-nestjs-endpoint-route",
        confidence: "certain",
        provenance: {
          adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
          contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
          repositoryRevision,
          endpointIdentityKey: subjectKey,
          fromHandler: previousHandlerSubject.display_name,
          toHandler: handlerSubject.displayName,
        },
      })
    : undefined;
  const guardVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, ...guardSubjects],
    sourceKind: "authentication-guard",
    identityKey: `${candidateKey}:guard`,
    fingerprint: fingerprint({ guardValue, filePath: observation.filePath }),
    materialFingerprint: fingerprint(guardValue),
    normalizedValue: guardValue,
    semanticLocation: `${subjectKey}.authentication`,
    provenance: {
      adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
      contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const documentationVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject, handlerSubject],
    sourceKind: "security-documentation",
    identityKey: `${candidateKey}:documentation`,
    fingerprint: fingerprint({
      documentationValue,
      filePath: observation.filePath,
      line: observation.line,
    }),
    materialFingerprint: fingerprint(documentationValue),
    normalizedValue: documentationValue,
    semanticLocation: `${subjectKey}.security-documentation`,
    provenance: {
      adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
      contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
      repositoryRevision,
    },
    filePath: observation.filePath,
    symbolId: observation.handlerSymbolId,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const frameworkVersion = claims.persistGenericEvidence({
    subjects: [endpointSubject],
    sourceKind: "framework-configuration",
    identityKey: `${candidateKey}:framework`,
    fingerprint: fingerprint({
      frameworkValue,
      filePath: observation.filePath,
    }),
    materialFingerprint: fingerprint(frameworkValue),
    normalizedValue: frameworkValue,
    semanticLocation: `${subjectKey}.framework`,
    provenance: {
      adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
      contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
      repositoryRevision,
      package: "@nestjs/common",
    },
    filePath: observation.filePath,
    spanStartLine: observation.line,
    spanEndLine: observation.endLine,
    repositoryRevision,
  });
  const confidence: CandidateConfidence = observation.ambiguous
    ? "ambiguous"
    : "certain";
  const candidate = candidates.persist({
    identityKey: candidateKey,
    candidateKind: "endpoint-authentication",
    proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
    discoveryMode: "deterministic",
    discoveryAdapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
    discoveryContractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
    confidence,
    normalizedStatement: {
      method: observation.method,
      path: observation.routePath,
      requirement: "endpoint-is-authenticated",
    },
    provenance: {
      repositoryRevision,
      adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
      contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
      handlerContinuityId: handlerContinuity?.id ?? null,
    },
    evidence: [
      {
        evidenceKey: `${candidateKey}:route`,
        evidenceVersionId: routeVersion.id,
        sourceKind: "framework-route",
        role: "route",
        provenance: { normalizedValue: routeValue },
      },
      {
        evidenceKey: `${candidateKey}:handler`,
        evidenceVersionId: handlerVersion.id,
        sourceKind: "route-handler",
        role: "handler",
        provenance: { normalizedValue: handlerValue },
      },
      {
        evidenceKey: `${candidateKey}:guard`,
        evidenceVersionId: guardVersion.id,
        sourceKind: "authentication-guard",
        role: "guard",
        provenance: { normalizedValue: guardValue },
      },
      {
        evidenceKey: `${candidateKey}:documentation`,
        evidenceVersionId: documentationVersion.id,
        sourceKind: "security-documentation",
        role: "documentation",
        provenance: { normalizedValue: documentationValue },
      },
      {
        evidenceKey: `${candidateKey}:framework`,
        evidenceVersionId: frameworkVersion.id,
        sourceKind: "framework-configuration",
        role: "framework",
        provenance: { normalizedValue: frameworkValue },
      },
    ],
    subjects: [endpointSubject, handlerSubject, ...guardSubjects],
  });
  return {
    ...candidate,
    proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
    confidence,
    sourceKinds: [
      "authentication-guard",
      "framework-route",
      "framework-configuration",
      "route-handler",
      "security-documentation",
    ],
    surfaced: true,
  };
}

export function persistNestEndpointCandidates(
  database: Database.Database,
  repositoryRevision: string,
  readSource: (filePath: string) => string | undefined,
): NestEndpointCandidateResult[] {
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
    const key = endpointIdentity(observation.method, observation.routePath);
    if (!uniqueObservations.has(key)) uniqueObservations.set(key, observation);
  }
  const discovered = [...uniqueObservations.values()].map((observation) =>
    persistObservation(database, repositoryRevision, observation),
  );
  const activeIdentityKeys = new Set(
    discovered.map((candidate) => candidate.identityKey),
  );
  const claims = new ClaimsStore(database);
  const candidates = new CandidateStore(database);
  const retired = candidates
    .listCurrent({ subjectKind: "endpoint" })
    .filter(
      (candidate) =>
        candidate.discoveryAdapterId === NEST_ENDPOINT_DISCOVERY_ADAPTER_ID &&
        candidate.candidateKind === "endpoint-authentication" &&
        !activeIdentityKeys.has(candidate.identityKey) &&
        database
          .prepare(
            `SELECT 1 AS present
             FROM candidate_reviews review
             JOIN claim_candidates observed ON observed.id = review.candidate_id
             WHERE observed.identity_key = ?
               AND review.decision = 'promote'
               AND review.effect = 'effective'
               AND review.promoted_claim_identity_id IS NOT NULL
             LIMIT 1`,
          )
          .get(candidate.identityKey),
    )
    .flatMap((candidate): NestEndpointCandidateResult[] => {
      const endpointSubject = candidate.subjects.find(
        (subject) => subject.role === "endpoint",
      );
      if (!endpointSubject) return [];
      const routeValue = {
        framework: "nestjs",
        method:
          typeof (candidate.normalizedStatement as Record<string, unknown>)
            .method === "string"
            ? (candidate.normalizedStatement as Record<string, string>).method
            : null,
        path:
          typeof (candidate.normalizedStatement as Record<string, unknown>)
            .path === "string"
            ? (candidate.normalizedStatement as Record<string, string>).path
            : null,
        pathKnown: true,
        active: false,
      };
      const routeVersion = claims.persistGenericEvidence({
        subjects: [
          {
            ...endpointSubject,
            basis: "nestjs-route-reconciliation",
            confidence: "certain",
          },
        ],
        sourceKind: "framework-route",
        identityKey: `${candidate.identityKey}:route`,
        fingerprint: fingerprint(routeValue),
        materialFingerprint: fingerprint(routeValue),
        normalizedValue: routeValue,
        semanticLocation: endpointSubject.identityKey,
        provenance: {
          adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
          contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
          repositoryRevision,
          transition: "route-missing",
        },
        repositoryRevision,
      });
      const persisted = candidates.persist({
        identityKey: candidate.identityKey,
        candidateKind: candidate.candidateKind,
        proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
        discoveryMode: "deterministic",
        discoveryAdapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
        discoveryContractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
        confidence: "certain",
        normalizedStatement: candidate.normalizedStatement,
        provenance: {
          repositoryRevision,
          adapterId: NEST_ENDPOINT_DISCOVERY_ADAPTER_ID,
          contractVersion: NEST_ENDPOINT_DISCOVERY_CONTRACT_VERSION,
          transition: "route-missing",
        },
        evidence: [
          {
            evidenceKey: `${candidate.identityKey}:route`,
            evidenceVersionId: routeVersion.id,
            sourceKind: "framework-route",
            role: "route",
            provenance: { normalizedValue: routeValue },
          },
        ],
        subjects: [
          {
            ...endpointSubject,
            basis: "nestjs-route-reconciliation",
            confidence: "certain",
          },
        ],
      });
      return [
        {
          ...persisted,
          proposedClaimType: "CLM-ENDPOINT-AUTHENTICATED",
          confidence: "certain",
          sourceKinds: ["framework-route"],
          surfaced: true,
        },
      ];
    });
  return [...discovered, ...retired];
}
