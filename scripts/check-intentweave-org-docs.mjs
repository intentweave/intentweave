#!/usr/bin/env node

import { execSync } from "node:child_process";

const DOC_PREFIX = "../intentweave.org/src/content/docs/";
const EXCLUDED_SEGMENTS = ["/community/", "/legal/"];

const minCompleteness = Number(process.env.IW_DOC_GATE_MIN_COMPLETENESS ?? "2");
const maxOrphaned = Number(process.env.IW_DOC_GATE_MAX_ORPHANED ?? "20");
const topN = Number(process.env.IW_DOC_GATE_TOP_N ?? "12");

function runJson(command) {
  const out = execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function isIntentweaveOrgTechDoc(docPath) {
  if (!docPath.startsWith(DOC_PREFIX)) return false;
  return !EXCLUDED_SEGMENTS.some((s) => docPath.includes(s));
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function main() {
  const orphaned = runJson("./iw.sh index orphaned-sections -f json");
  const completeness = runJson("./iw.sh index doc-completeness -f json");

  const techOrphaned = (orphaned.sections ?? []).filter((s) => isIntentweaveOrgTechDoc(s.docPath));

  const techDocs = (completeness.docs ?? []).filter((d) => isIntentweaveOrgTechDoc(d.docPath));
  const lowCompleteness = techDocs
    .filter((d) => d.completenessPercent < minCompleteness)
    .sort((a, b) => a.completenessPercent - b.completenessPercent || b.totalRelevantExports - a.totalRelevantExports);

  const worstOrphaned = [...techOrphaned]
    .sort((a, b) => b.ungroundedMentions - a.ungroundedMentions)
    .slice(0, topN);

  const worstCompleteness = lowCompleteness.slice(0, topN);

  console.log("Intentweave.org Technical Docs Gate");
  console.log(`Scope: ${DOC_PREFIX} (excluding ${EXCLUDED_SEGMENTS.join(", ")})`);
  console.log(`Thresholds: minCompleteness=${formatPercent(minCompleteness)}, maxOrphaned=${maxOrphaned}`);
  console.log("");
  console.log(`Tech docs analyzed: ${techDocs.length}`);
  console.log(`Orphaned sections (tech docs): ${techOrphaned.length}`);
  console.log(`Low completeness docs (< ${formatPercent(minCompleteness)}): ${lowCompleteness.length}`);

  if (worstOrphaned.length > 0) {
    console.log("\nTop orphaned sections:");
    for (const s of worstOrphaned) {
      console.log(`- ${s.docPath}:${s.line} :: \"${s.heading}\" (${s.ungroundedMentions} ungrounded)`);
    }
  }

  if (worstCompleteness.length > 0) {
    console.log(`\nLowest completeness docs (< ${formatPercent(minCompleteness)}):`);
    for (const d of worstCompleteness) {
      console.log(`- ${d.docPath} :: ${formatPercent(d.completenessPercent)} (${d.coveredExports}/${d.totalRelevantExports})`);
    }
  }

  const failed = techOrphaned.length > maxOrphaned || lowCompleteness.length > 0;

  if (failed) {
    console.error("\nFAIL: intentweave.org technical docs gate failed.");
    process.exit(1);
  }

  console.log("\nPASS: intentweave.org technical docs gate passed.");
}

main();
