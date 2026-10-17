// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded change scenarios for the O4 evaluation. Each scenario is a base and a head
 * revision of a small TypeScript repository, with the changes a correct detector must
 * report under the rules of the plan. The labels are written from those rules, and
 * the test compares the detector's output with them.
 */

import type { ObservedChange } from "./observationEvaluation.js";

export interface Scenario {
  name: string;
  /** Files at the base revision. */
  base: Record<string, string>;
  /** Files at the head revision. A path that is absent is deleted. */
  head: Record<string, string>;
  /** The changes a correct detector reports. A negative control has none. */
  labels: ObservedChange[];
}

const CHARGE = `export function charge(amount: number): void {\n  void amount;\n}\n`;
const REFUND = `export function refund(id: string): void {\n  void id;\n}\n`;
// A shared body keeps the similarity high enough for git to pair a renamed file.
const PAD = Array.from(
  { length: 40 },
  (_, index) => `export const CONST_${index} = ${index};\n`,
).join("");

const constants = (file: string, kind: "moved"): ObservedChange[] =>
  Array.from({ length: 40 }, (_, index) => ({
    identityKey: `symbol:variable:${file}#CONST_${index}`,
    kind,
  }));

export const SCENARIOS: Scenario[] = [
  {
    name: "unchanged (negative control)",
    base: { "src/a.ts": CHARGE },
    head: { "src/a.ts": CHARGE },
    labels: [],
  },
  {
    name: "signature change",
    base: { "src/a.ts": CHARGE },
    head: {
      "src/a.ts": `export function charge(amount: number, currency: string): void {\n  void amount;\n  void currency;\n}\n`,
    },
    labels: [
      {
        identityKey: "symbol:function:src/a.ts#charge",
        kind: "property-changed",
      },
    ],
  },
  {
    name: "file rename, same content",
    base: { "src/a.ts": CHARGE },
    head: { "src/b.ts": CHARGE },
    labels: [
      { identityKey: "file:src/a.ts", kind: "moved" },
      { identityKey: "module:src/a.ts", kind: "moved" },
      { identityKey: "symbol:function:src/a.ts#charge", kind: "moved" },
    ],
  },
  {
    name: "rename into a file with two same-name definitions",
    base: { "src/a.ts": PAD + CHARGE },
    head: {
      "src/c.ts":
        PAD +
        CHARGE +
        `\nexport function charge(a: number, b: number): void {\n  void a;\n  void b;\n}\n`,
    },
    labels: [
      {
        identityKey: "symbol:function:src/a.ts#charge",
        kind: "continuity-unclear",
      },
      {
        identityKey: "symbol:function:src/c.ts#charge~1",
        kind: "continuity-unclear",
      },
      {
        identityKey: "symbol:function:src/c.ts#charge~2",
        kind: "continuity-unclear",
      },
      { identityKey: "file:src/a.ts", kind: "moved" },
      { identityKey: "module:src/a.ts", kind: "moved" },
      ...constants("src/a.ts", "moved"),
    ],
  },
  {
    name: "removal with complete coverage",
    base: { "src/a.ts": CHARGE + "\n" + REFUND },
    head: { "src/a.ts": CHARGE },
    labels: [
      { identityKey: "symbol:function:src/a.ts#refund", kind: "removed" },
      { identityKey: "module:src/a.ts", kind: "property-changed" },
    ],
  },
  {
    name: "addition",
    base: { "src/a.ts": CHARGE },
    head: { "src/a.ts": CHARGE + "\nexport function audit(): void {}\n" },
    labels: [
      { identityKey: "symbol:function:src/a.ts#audit", kind: "added" },
      { identityKey: "module:src/a.ts", kind: "property-changed" },
    ],
  },
  {
    name: "same name in another file is never touched",
    base: { "src/a.ts": CHARGE, "src/c.ts": CHARGE },
    head: { "src/a.ts": "export const KEEP = 1;\n", "src/c.ts": CHARGE },
    labels: [
      { identityKey: "symbol:function:src/a.ts#charge", kind: "removed" },
      { identityKey: "symbol:variable:src/a.ts#KEEP", kind: "added" },
      { identityKey: "module:src/a.ts", kind: "property-changed" },
    ],
  },
  {
    name: "removal under partial coverage",
    base: { "src/a.ts": CHARGE + "\n" + REFUND },
    head: {
      "src/a.ts": CHARGE,
      "src/broken.ts": "export function (((\n",
    },
    labels: [
      {
        identityKey: "symbol:function:src/a.ts#refund",
        kind: "not_comparable",
      },
      { identityKey: "module:src/a.ts", kind: "property-changed" },
    ],
  },
];
