// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

import type { CandidateDetails } from "@intentweave/index";

interface DisplaySubject {
  role: string;
  kind: string;
  identityKey: string;
  displayName?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "an unknown value";
  return JSON.stringify(value);
}

export function claimTypeLabel(claimType: string): string {
  const labels: Record<string, string> = {
    "CLM-LITERAL": "Literal value",
    "CLM-DEFAULT": "Default value",
    "CLM-EFFECTIVE": "Effective value",
    "CLM-DOC-CONFORMANCE": "Documentation conformance",
    "CLM-PUBLIC-SYMBOL-DOCUMENTED": "Public symbol documentation",
    "CLM-ENDPOINT-AUTHENTICATED": "Endpoint authentication",
    "CLM-DEPENDENCY-CONFORMANCE": "Architecture dependency",
  };
  return labels[claimType] ?? claimType;
}

export function describeClaim(
  claimType: string,
  statement: unknown,
  parameterKey?: string | null,
): string {
  const value = record(statement);
  if (claimType === "CLM-DEPENDENCY-CONFORMANCE") {
    const source = stringValue(value.source) ?? "The source module";
    const target = stringValue(value.target) ?? "the target module";
    return `${source} must not import ${target}`;
  }
  if (claimType === "CLM-ENDPOINT-AUTHENTICATED") {
    const method = stringValue(value.method) ?? "HTTP endpoint";
    const route = stringValue(value.path) ?? "with an unknown route";
    return `${method} ${route} must be authenticated`;
  }
  if (claimType === "CLM-PUBLIC-SYMBOL-DOCUMENTED") {
    const kind = stringValue(value.symbolKind) ?? "symbol";
    const name = stringValue(value.symbolName) ?? "Unknown symbol";
    return `Public ${kind} ${name} must be documented`;
  }
  if (claimType === "CLM-DOC-CONFORMANCE") {
    return `Documentation for ${parameterKey ?? "the claim"} must match the effective value`;
  }
  if (
    claimType === "CLM-LITERAL" ||
    claimType === "CLM-DEFAULT" ||
    claimType === "CLM-EFFECTIVE"
  ) {
    const subject =
      stringValue(value.subject) ?? parameterKey ?? "The discovered value";
    const observedValue = value.value;
    if (claimType === "CLM-DEFAULT") {
      return `${subject} defaults to ${displayValue(observedValue)}`;
    }
    if (claimType === "CLM-EFFECTIVE") {
      return `${subject} resolves to ${displayValue(observedValue)}`;
    }
    return `${subject} equals ${displayValue(observedValue)}`;
  }
  return parameterKey
    ? `${claimType} for ${parameterKey}`
    : claimTypeLabel(claimType);
}

export function displaySubject(subject: DisplaySubject): string {
  return subject.displayName || subject.identityKey;
}

export function shortCandidateReference(candidateId: string): string {
  const match = /^candidate:([a-f0-9]{64})@(\d+)$/.exec(candidateId);
  return match
    ? `candidate:${match[1]!.slice(0, 10)}@${match[2]}`
    : candidateId;
}

export function candidateDisplayLines(
  candidate: CandidateDetails,
  options: { verbose?: boolean } = {},
): string[] {
  if (!options.verbose) {
    return [
      describeClaim(candidate.proposedClaimType, candidate.normalizedStatement),
      `  ${candidate.state}, confidence ${candidate.confidence}`,
      `  Ref: ${shortCandidateReference(candidate.id)}`,
    ];
  }
  const lines = [
    describeClaim(candidate.proposedClaimType, candidate.normalizedStatement),
    `  Status: ${candidate.state}`,
    `  Type: ${claimTypeLabel(candidate.proposedClaimType)} (${candidate.proposedClaimType})`,
    `  Confidence: ${candidate.confidence}`,
  ];
  if (candidate.subjects.length > 0) {
    lines.push(
      `  Subjects: ${candidate.subjects
        .map((subject) => `${subject.role}=${displaySubject(subject)}`)
        .join(", ")}`,
    );
  }
  const ruleId = stringValue(record(candidate.normalizedStatement).ruleId);
  if (ruleId) lines.push(`  Rule: ${ruleId}`);
  lines.push(`  Candidate ID: ${candidate.id}`);
  return lines;
}

export function candidateInboxLines(
  candidates: CandidateDetails[],
  options: { verbose?: boolean } = {},
): string[] {
  if (options.verbose) {
    return candidates.flatMap((candidate, index) => [
      ...(index === 0 ? [] : [""]),
      ...candidateDisplayLines(candidate, { verbose: true }),
    ]);
  }
  const architectureGroups = new Map<string, CandidateDetails[]>();
  const ungrouped: CandidateDetails[] = [];
  for (const candidate of candidates) {
    const ruleId = stringValue(record(candidate.normalizedStatement).ruleId);
    if (
      candidate.proposedClaimType !== "CLM-DEPENDENCY-CONFORMANCE" ||
      !ruleId
    ) {
      ungrouped.push(candidate);
      continue;
    }
    const group = architectureGroups.get(ruleId) ?? [];
    group.push(candidate);
    architectureGroups.set(ruleId, group);
  }
  const lines: string[] = [];
  for (const [ruleId, group] of architectureGroups) {
    lines.push(
      `Rule ${ruleId} (${group.length} Candidate${group.length === 1 ? "" : "s"})`,
    );
    for (const candidate of group) {
      lines.push(
        `  ${describeClaim(candidate.proposedClaimType, candidate.normalizedStatement)}`,
      );
      lines.push(
        `    ${candidate.state}, confidence ${candidate.confidence} | ${shortCandidateReference(candidate.id)}`,
      );
    }
  }
  for (const candidate of ungrouped) {
    if (lines.length > 0) lines.push("");
    lines.push(...candidateDisplayLines(candidate));
  }
  return lines;
}

export function humanizeReason(reason: string): string {
  const reasons: Record<string, string> = {
    "forbidden-dependency-detected": "A forbidden dependency was detected.",
    "dependency-policy-conformant":
      "No forbidden dependency was found in the complete applicable scope.",
    "architecture-policy-no-longer-present":
      "The governing architecture rule is no longer present.",
    "architecture-policy-correlation-ambiguous":
      "Multiple architecture rules could govern this dependency.",
    "architecture-rule-check-not-executed":
      "The architecture rule could not be evaluated.",
    "architecture-rule-scope-not-applicable":
      "The architecture rule does not match a current source file.",
    "architecture-rule-evidence-incomplete":
      "The matching source scope was not indexed completely.",
    "architecture-rule-result-missing":
      "The architecture evaluator did not return a result.",
    "warrant-changed": "Evidence relevant to the decision changed.",
  };
  const known = reasons[reason];
  if (known) return known;
  const words = reason.replaceAll("-", " ").replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}
