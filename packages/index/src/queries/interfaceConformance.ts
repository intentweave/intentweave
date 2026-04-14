// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * CARI Query: interfaceConformance (5.2)
 *
 * Detect when a class claims to implement an interface but the method
 * signatures have diverged — missing methods, missing properties, or
 * changed signatures. More precise than tsc for cross-package scenarios
 * because it checks the unified symbol table across all packages.
 *
 * $0 / no LLM — pure SQLite query on AX-extracted symbols.
 */

import type Database from "better-sqlite3";
import type {
  InterfaceConformanceResult,
  ConformanceViolation,
} from "../types.js";
import { openIndex } from "./shared.js";

/** Row shape for class symbols with an implements clause. */
interface ClassRow {
  name: string;
  file_path: string;
  implements: string; // JSON array
}

/** Row shape for a member (method/property) symbol. */
interface MemberRow {
  name: string;
  kind: string;
  signature: string | null;
  container: string;
  file_path: string;
}

/**
 * Check interface conformance from a database file path.
 */
export function interfaceConformance(
  dbPath: string,
): InterfaceConformanceResult {
  const db = openIndex(dbPath);
  try {
    return interfaceConformanceFromDb(db);
  } finally {
    db.close();
  }
}

/**
 * Core conformance checking logic against an open database.
 */
export function interfaceConformanceFromDb(
  db: Database.Database,
): InterfaceConformanceResult {
  // Check if the implements column exists (older indexes may not have it)
  const columns = db.prepare(`PRAGMA table_info(symbols)`).all() as Array<{
    name: string;
  }>;
  const hasImplements = columns.some((c) => c.name === "implements");

  if (!hasImplements) {
    return {
      violations: [],
      totalViolations: 0,
      pairsChecked: 0,
      byType: { missingMethod: 0, missingProperty: 0, signatureMismatch: 0 },
    };
  }

  // 1. Find all class symbols that have an implements clause
  const classes = db
    .prepare(
      `SELECT name, file_path, implements
       FROM symbols
       WHERE kind = 'class' AND implements IS NOT NULL`,
    )
    .all() as ClassRow[];

  if (classes.length === 0) {
    return {
      violations: [],
      totalViolations: 0,
      pairsChecked: 0,
      byType: { missingMethod: 0, missingProperty: 0, signatureMismatch: 0 },
    };
  }

  // 2. Build a lookup of all interface names → file_path
  const interfaceRows = db
    .prepare(`SELECT name, file_path FROM symbols WHERE kind = 'interface'`)
    .all() as Array<{ name: string; file_path: string }>;

  const interfaceFiles = new Map<string, string>();
  for (const row of interfaceRows) {
    interfaceFiles.set(row.name, row.file_path);
  }

  // 3. Prepare member query (methods + properties of a given container)
  const memberStmt = db.prepare(
    `SELECT name, kind, signature, container, file_path
     FROM symbols
     WHERE container = ? AND kind IN ('method', 'property')`,
  );

  // 4. Check each (class, interface) pair
  const violations: ConformanceViolation[] = [];
  let pairsChecked = 0;

  for (const cls of classes) {
    let implementsList: string[];
    try {
      implementsList = JSON.parse(cls.implements);
    } catch {
      continue;
    }
    if (!Array.isArray(implementsList)) continue;

    for (const ifaceName of implementsList) {
      const ifaceFile = interfaceFiles.get(ifaceName);
      if (!ifaceFile) continue; // interface not in the codebase (external dependency)

      pairsChecked++;

      // Get interface members
      const ifaceMembers = memberStmt.all(ifaceName) as MemberRow[];
      // Get class members
      const classMembers = memberStmt.all(cls.name) as MemberRow[];

      // Build class member lookup: name → MemberRow
      const classMemberMap = new Map<string, MemberRow>();
      for (const m of classMembers) {
        classMemberMap.set(m.name, m);
      }

      for (const ifaceMember of ifaceMembers) {
        const classMember = classMemberMap.get(ifaceMember.name);

        if (!classMember) {
          // Missing member
          violations.push({
            className: cls.name,
            classFile: cls.file_path,
            interfaceName: ifaceName,
            interfaceFile: ifaceFile,
            type:
              ifaceMember.kind === "method"
                ? "missing-method"
                : "missing-property",
            memberName: ifaceMember.name,
            expectedSignature: ifaceMember.signature ?? undefined,
          });
          continue;
        }

        // Both exist — compare signatures if available
        if (
          ifaceMember.signature &&
          classMember.signature &&
          ifaceMember.kind === "method"
        ) {
          const ifaceSig = normalizeSignature(ifaceMember.signature);
          const classSig = normalizeSignature(classMember.signature);

          if (ifaceSig !== classSig) {
            violations.push({
              className: cls.name,
              classFile: cls.file_path,
              interfaceName: ifaceName,
              interfaceFile: ifaceFile,
              type: "signature-mismatch",
              memberName: ifaceMember.name,
              expectedSignature: ifaceMember.signature,
              actualSignature: classMember.signature,
            });
          }
        }
      }
    }
  }

  // Sort: missing methods first, then missing properties, then mismatches
  const typeOrder = {
    "missing-method": 0,
    "missing-property": 1,
    "signature-mismatch": 2,
  };
  violations.sort((a, b) => {
    const to = typeOrder[a.type] - typeOrder[b.type];
    if (to !== 0) return to;
    const cn = a.className.localeCompare(b.className);
    if (cn !== 0) return cn;
    return a.memberName.localeCompare(b.memberName);
  });

  return {
    violations,
    totalViolations: violations.length,
    pairsChecked,
    byType: {
      missingMethod: violations.filter((v) => v.type === "missing-method")
        .length,
      missingProperty: violations.filter((v) => v.type === "missing-property")
        .length,
      signatureMismatch: violations.filter(
        (v) => v.type === "signature-mismatch",
      ).length,
    },
  };
}

/**
 * Normalize a method signature for comparison.
 * Strips the method name prefix, leading whitespace, visibility modifiers,
 * async keyword, and trailing semicolons so we compare just the parameter
 * list and return type.
 */
function normalizeSignature(sig: string): string {
  let s = sig.trim();
  // Remove visibility modifiers
  s = s.replace(/^(public|private|protected)\s+/, "");
  // Remove async
  s = s.replace(/^async\s+/, "");
  // Remove static
  s = s.replace(/^static\s+/, "");
  // Extract from first "(" to end — the parameter list + return type
  const parenIdx = s.indexOf("(");
  if (parenIdx >= 0) {
    s = s.substring(parenIdx);
  }
  // Remove trailing semicolons
  s = s.replace(/;\s*$/, "");
  return s.trim();
}
