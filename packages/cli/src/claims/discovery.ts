// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractClaimEvidence } from "@intentweave/ast-extractor";
import { load as yamlLoad } from "js-yaml";

export type DocumentationTarget = "default" | "effective";
export type DocumentationReason =
  | "documentation-assertion-missing"
  | "documentation-assertion-ambiguous"
  | "documentation-value-invalid";
export type ClaimScalar = string | number | boolean | null;

export interface DocumentationAssertionBinding {
  id: string;
  target: DocumentationTarget;
  scope?: string;
  pattern: string;
}

export interface ParameterBinding {
  configKeys: string[];
  codeDefaults: Array<{ file: string; export?: string; option?: string }>;
  documentation: Array<{
    file: string;
    assertions: DocumentationAssertionBinding[];
  }>;
}

export interface ClaimsBindings {
  parameters: Record<string, ParameterBinding>;
}

export interface DocumentationEvidenceObservation {
  kind: "evidence";
  parameterKey: string;
  assertionId: string;
  identityKey: string;
  semanticLocation: string;
  normalizedValue: ClaimScalar;
  filePath: string;
  line: number;
  pattern: string;
}

export interface DocumentationInconclusiveObservation {
  kind: "inconclusive";
  parameterKey: string;
  assertionId: string;
  filePath: string;
  reason: DocumentationReason;
}

export type DocumentationObservation =
  | DocumentationEvidenceObservation
  | DocumentationInconclusiveObservation;

export interface CodeEvidenceObservation {
  parameterKey: string;
  claimType: "CLM-DEFAULT" | "CLM-LITERAL";
  sourceKind: "code-default" | "code-annotation";
  identityKey: string;
  semanticLocation: string;
  normalizedValue: ClaimScalar;
  filePath: string;
  symbolId: string;
  line: number;
  bindingBasis?: "explicit-map" | "r1-discovery";
  bindingConfidence?: "certain" | "probable";
}

export interface CodeInconclusiveObservation {
  parameterKey: string;
  sourceKind: "code-default";
  filePath: string;
  bindingName: string;
  reason: "code-default-binding-missing";
}

export type CodeObservation = CodeEvidenceObservation | CodeInconclusiveObservation;

export interface ScopeRegistryEntry {
  name: string;
  capabilities: string[];
}

export interface ScopeEvidenceObservation {
  sourceKind: "scope-registry";
  identityKey: string;
  semanticLocation: string;
  normalizedValue: string[];
  scope: string;
}

export interface ConfigEvidenceObservation {
  kind: "evidence";
  parameterKey: string;
  sourceKind: "config";
  identityKey: string;
  semanticLocation: string;
  normalizedValue: ClaimScalar;
  scope: string;
  filePath: string;
}

export interface ConfigInconclusiveObservation {
  kind: "inconclusive";
  parameterKey: string;
  sourceKind: "config";
  scope: string;
  reason: "config-value-missing" | "config-value-invalid";
}

export type ConfigObservation =
  | ConfigEvidenceObservation
  | ConfigInconclusiveObservation;

export class ClaimsBindingError extends Error {}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaimsBindingError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClaimsBindingError(`${label} must be a non-empty string`);
  }
  return value;
}

function parseScalar(value: string): ClaimScalar | undefined {
  const normalized = value.trim();
  if (normalized === "null") return null;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^-?(?:\d[\d_]*)(?:\.\d[\d_]*)?$/.test(normalized)) {
    return Number(normalized.replaceAll("_", ""));
  }
  if (/^(['"]).*\1$/.test(normalized)) return normalized.slice(1, -1);
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(normalized)) return normalized;
  return undefined;
}

function scalarFromYaml(value: unknown): ClaimScalar | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function getKeyPath(value: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function parseClaimsBindings(raw: unknown): ClaimsBindings {
  const root = requireRecord(raw, "Claims bindings");
  const parameters = requireRecord(root.parameters, "parameters");
  const parsed: Record<string, ParameterBinding> = {};

  for (const [parameterKey, value] of Object.entries(parameters)) {
    const parameter = requireRecord(value, `parameters.${parameterKey}`);
    const configKeys = Array.isArray(parameter.configKeys)
      ? parameter.configKeys.map((key, index) =>
          requireString(key, `${parameterKey}.configKeys[${index}]`),
        )
      : [];
    const codeDefaults = Array.isArray(parameter.codeDefaults)
      ? parameter.codeDefaults.map((entry, index) => {
          const binding = requireRecord(entry, `${parameterKey}.codeDefaults[${index}]`);
          const exportName =
            binding.export === undefined
              ? undefined
              : requireString(binding.export, `${parameterKey}.codeDefaults[${index}].export`);
          const option =
            binding.option === undefined
              ? undefined
              : requireString(binding.option, `${parameterKey}.codeDefaults[${index}].option`);
          if ((exportName === undefined) === (option === undefined)) {
            throw new ClaimsBindingError(
              `${parameterKey}.codeDefaults[${index}] must define exactly one of export or option`,
            );
          }
          return {
            file: requireString(binding.file, `${parameterKey}.codeDefaults[${index}].file`),
            ...(exportName ? { export: exportName } : { option: option! }),
          };
        })
      : [];
    const assertionIds = new Set<string>();
    const documentation = Array.isArray(parameter.documentation)
      ? parameter.documentation.map((entry, documentIndex) => {
          const document = requireRecord(
            entry,
            `${parameterKey}.documentation[${documentIndex}]`,
          );
          const file = requireString(
            document.file,
            `${parameterKey}.documentation[${documentIndex}].file`,
          );
          if (!Array.isArray(document.assertions)) {
            throw new ClaimsBindingError(`${parameterKey}.${file}.assertions must be an array`);
          }
          const assertions = document.assertions.map((assertion, assertionIndex) => {
            const parsedAssertion = requireRecord(
              assertion,
              `${parameterKey}.${file}.assertions[${assertionIndex}]`,
            );
            const id = requireString(parsedAssertion.id, "assertion.id");
            if (assertionIds.has(id)) {
              throw new ClaimsBindingError(
                `Assertion id ${id} must be unique within ${parameterKey}`,
              );
            }
            assertionIds.add(id);
            const targetValue = requireString(parsedAssertion.target, "assertion.target");
            if (targetValue !== "default" && targetValue !== "effective") {
              throw new ClaimsBindingError(`Unknown documentation target ${targetValue}`);
            }
            const target: DocumentationTarget = targetValue;
            const scope = parsedAssertion.scope;
            if (scope !== undefined && typeof scope !== "string") {
              throw new ClaimsBindingError("assertion.scope must be a string");
            }
            if (target === "effective" && !scope) {
              throw new ClaimsBindingError("target effective requires assertion.scope");
            }
            const pattern = requireString(parsedAssertion.pattern, "assertion.pattern");
            if (!pattern.includes("(?<value>")) {
              throw new ClaimsBindingError("assertion.pattern must define a named value capture");
            }
            try {
              new RegExp(pattern);
            } catch (error) {
              throw new ClaimsBindingError(
                `Invalid documentation pattern: ${(error as Error).message}`,
              );
            }
            return { id, target, scope, pattern };
          });
          return { file, assertions };
        })
      : [];
    parsed[parameterKey] = { configKeys, codeDefaults, documentation };
  }
  return { parameters: parsed };
}

export function loadClaimsBindings(workspaceRoot: string): ClaimsBindings {
  const filePath = path.join(workspaceRoot, "intentweave.bindings.yaml");
  if (!existsSync(filePath)) {
    throw new ClaimsBindingError(
      `Claims bindings not found at ${filePath}`,
    );
  }
  return parseClaimsBindings(yamlLoad(readFileSync(filePath, "utf-8")));
}

/** Bindings enrich discovered claims, but are not required for code discovery. */
export function loadOptionalClaimsBindings(
  workspaceRoot: string,
): ClaimsBindings | undefined {
  const filePath = path.join(workspaceRoot, "intentweave.bindings.yaml");
  return existsSync(filePath)
    ? parseClaimsBindings(yamlLoad(readFileSync(filePath, "utf-8")))
    : undefined;
}

export function parseScopeRegistry(raw: unknown): ScopeRegistryEntry[] {
  const root = requireRecord(raw, "Scope registry");
  if (!Array.isArray(root.environments)) {
    throw new ClaimsBindingError("Scope registry environments must be an array");
  }
  const seen = new Set<string>();
  return root.environments.map((entry, index) => {
    const environment = requireRecord(entry, `environments[${index}]`);
    const name = requireString(environment.name, `environments[${index}].name`);
    if (seen.has(name)) {
      throw new ClaimsBindingError(`Scope ${name} must be unique`);
    }
    seen.add(name);
    if (!Array.isArray(environment.capabilities)) {
      throw new ClaimsBindingError(`environments[${index}].capabilities must be an array`);
    }
    const capabilities = environment.capabilities
      .map((capability, capabilityIndex) =>
        requireString(
          capability,
          `environments[${index}].capabilities[${capabilityIndex}]`,
        ),
      )
      .sort();
    return { name, capabilities };
  });
}

export function extractScopeRegistryEvidence(
  scopes: ScopeRegistryEntry[],
): ScopeEvidenceObservation[] {
  return scopes.map((scope) => ({
    sourceKind: "scope-registry",
    identityKey: `scope-registry:${scope.name}`,
    semanticLocation: scope.name,
    normalizedValue: scope.capabilities,
    scope: scope.name,
  }));
}

/**
 * Reads only registered parameter key paths from a requested registered scope.
 * An absent config file or key is evidence insufficiency, never a guessed default.
 */
export function extractScopeConfigEvidence(
  bindings: ClaimsBindings,
  scopes: ScopeRegistryEntry[],
  readScopeConfig: (scope: string) => string | undefined,
  requestedScope?: string,
): ConfigObservation[] {
  const selectedScopes = requestedScope
    ? scopes.filter((scope) => scope.name === requestedScope)
    : scopes;
  if (requestedScope && selectedScopes.length === 0) {
    throw new ClaimsBindingError(`Unknown scope ${requestedScope}`);
  }
  const observations: ConfigObservation[] = [];
  for (const scope of selectedScopes) {
    const rawConfig = readScopeConfig(scope.name);
    let config: unknown;
    try {
      config = rawConfig === undefined ? undefined : yamlLoad(rawConfig);
    } catch (error) {
      throw new ClaimsBindingError(
        `Invalid configuration for ${scope.name}: ${(error as Error).message}`,
      );
    }
    for (const [parameterKey, parameter] of Object.entries(bindings.parameters)) {
      for (const configKey of parameter.configKeys) {
        const value = getKeyPath(config, configKey);
        const normalizedValue = scalarFromYaml(value);
        if (normalizedValue === undefined) {
          observations.push({
            kind: "inconclusive",
            parameterKey,
            sourceKind: "config",
            scope: scope.name,
            reason: value === undefined ? "config-value-missing" : "config-value-invalid",
          });
          continue;
        }
        observations.push({
          kind: "evidence",
          parameterKey,
          sourceKind: "config",
          identityKey: `${parameterKey}:config:${scope.name}:${configKey}`,
          semanticLocation: configKey,
          normalizedValue,
          scope: scope.name,
          filePath: `config/${scope.name}.yaml`,
        });
      }
    }
  }
  return observations;
}

export function extractDocumentationAssertions(
  bindings: ClaimsBindings,
  readDocument: (filePath: string) => string,
): DocumentationObservation[] {
  const observations: DocumentationObservation[] = [];
  for (const [parameterKey, parameter] of Object.entries(bindings.parameters)) {
    for (const document of parameter.documentation) {
      const lines = readDocument(document.file).split(/\r?\n/);
      for (const assertion of document.assertions) {
        const matches = lines.flatMap((line, index) => {
          const match = new RegExp(assertion.pattern).exec(line);
          return match ? [{ match, line: index + 1 }] : [];
        });
        if (matches.length !== 1) {
          observations.push({
            kind: "inconclusive",
            parameterKey,
            assertionId: assertion.id,
            filePath: document.file,
            reason:
              matches.length === 0
                ? "documentation-assertion-missing"
                : "documentation-assertion-ambiguous",
          });
          continue;
        }
        const value = parseScalar(matches[0].match.groups?.value ?? "");
        if (value === undefined) {
          observations.push({
            kind: "inconclusive",
            parameterKey,
            assertionId: assertion.id,
            filePath: document.file,
            reason: "documentation-value-invalid",
          });
          continue;
        }
        observations.push({
          kind: "evidence",
          parameterKey,
          assertionId: assertion.id,
          identityKey: `${parameterKey}:documentation:${assertion.id}`,
          semanticLocation:
            assertion.target === "default"
              ? `${parameterKey}.default`
              : `${parameterKey}.override[${assertion.scope}]`,
          normalizedValue: value,
          filePath: document.file,
          line: matches[0].line,
          pattern: assertion.pattern,
        });
      }
    }
  }
  return observations;
}

/** Extract R1 evidence only from code files explicitly listed in the bindings. */
export function extractBoundCodeEvidence(
  bindings: ClaimsBindings,
  readCode: (filePath: string) => string,
): CodeObservation[] {
  const observations: CodeObservation[] = [];
  for (const [parameterKey, parameter] of Object.entries(bindings.parameters)) {
    for (const binding of parameter.codeDefaults) {
      const bindingName = binding.export ?? binding.option;
      if (!bindingName) continue;
      const evidence = extractClaimEvidence(readCode(binding.file), binding.file);
      const literal = evidence.literalBindings.find(
        (candidate) => candidate.name === bindingName,
      );
      if (!literal) {
        observations.push({
          parameterKey,
          sourceKind: "code-default",
          filePath: binding.file,
          bindingName,
          reason: "code-default-binding-missing",
        });
        continue;
      }
      observations.push({
        parameterKey,
        claimType: "CLM-DEFAULT",
        sourceKind: "code-default",
        identityKey: `${parameterKey}:code-default:${binding.file}:${bindingName}`,
        semanticLocation: parameterKey,
        normalizedValue: literal.normalizedValue,
        filePath: binding.file,
        symbolId: literal.symbolId,
        line: literal.span.startLine,
        bindingBasis: "explicit-map",
        bindingConfidence: "certain",
      });
      for (const annotation of evidence.codeAnnotations) {
        if (annotation.targetSymbolId !== literal.symbolId) continue;
        observations.push({
          parameterKey,
          claimType: "CLM-DEFAULT",
          sourceKind: "code-annotation",
          identityKey: `${parameterKey}:code-annotation:${binding.file}:${binding.export}:default`,
          semanticLocation: `${parameterKey}.default`,
          normalizedValue: annotation.normalizedValue,
          filePath: binding.file,
          symbolId: literal.symbolId,
          line: annotation.span.startLine,
          bindingBasis: "explicit-map",
          bindingConfidence: "certain",
        });
      }
    }
  }
  return observations;
}

/**
 * Discover provisional default and literal claims from strong R1 bindings.
 * Explicit bindings win for the same file and symbol and are emitted by
 * `extractBoundCodeEvidence` instead, preventing duplicate claim identities.
 */
export function extractDiscoveredCodeEvidence(
  filePaths: string[],
  readCode: (filePath: string) => string,
  bindings: ClaimsBindings = { parameters: {} },
): CodeEvidenceObservation[] {
  const explicitlyBound = new Set(
    Object.values(bindings.parameters).flatMap((parameter) =>
      parameter.codeDefaults.flatMap((binding) => {
        const bindingName = binding.export ?? binding.option;
        return bindingName ? [`${binding.file}\0${bindingName}`] : [];
      }),
    ),
  );
  const observations: CodeEvidenceObservation[] = [];

  for (const filePath of [...filePaths].sort()) {
    const evidence = extractClaimEvidence(readCode(filePath), filePath);
    for (const literal of evidence.literalBindings) {
      if (explicitlyBound.has(`${filePath}\0${literal.name}`)) continue;
      const annotations = evidence.codeAnnotations.filter(
        (annotation) => annotation.targetSymbolId === literal.symbolId,
      );
      const constantName = /^[A-Z][A-Z0-9_]*$/.test(literal.name);
      const materializeClaim =
        annotations.length > 0 ||
        literal.exported ||
        (literal.topLevel && constantName) ||
        literal.kind === "parameter-default" ||
        literal.kind === "destructuring-default";
      if (!materializeClaim) continue;
      const parameterKey = `code:${literal.symbolId}:${literal.structureFingerprint.slice(0, 12)}`;
      const claimType =
        annotations.length > 0 ||
        literal.kind === "parameter-default" ||
        literal.kind === "destructuring-default" ||
        (/(?:^|_)DEFAULT(?:_|$)/.test(literal.name) ||
          /(?:^|_)default(?:_|[A-Z]|$)/.test(literal.name))
          ? "CLM-DEFAULT"
          : "CLM-LITERAL";
      observations.push({
        parameterKey,
        claimType,
        sourceKind: "code-default",
        identityKey: `${parameterKey}:literal`,
        semanticLocation: parameterKey,
        normalizedValue: literal.normalizedValue,
        filePath,
        symbolId: literal.symbolId,
        line: literal.span.startLine,
        bindingBasis: "r1-discovery",
        bindingConfidence: "probable",
      });
      for (const annotation of annotations) {
        observations.push({
          parameterKey,
          claimType,
          sourceKind: "code-annotation",
          identityKey: `${parameterKey}:annotation:default`,
          semanticLocation: `${parameterKey}.default`,
          normalizedValue: annotation.normalizedValue,
          filePath,
          symbolId: literal.symbolId,
          line: annotation.span.startLine,
          bindingBasis: "r1-discovery",
          bindingConfidence: "probable",
        });
      }
    }
  }

  return observations;
}
