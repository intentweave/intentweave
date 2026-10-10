import { describe, expect, it } from "vitest";
import type { KwxStageInput } from "@intentweave/core";
import { createKwxChunkWorkerPool } from "../kwg/kwxChunkWorkerPool.js";
import { runKwxStage } from "../kwg/kwxStage.js";

const input: KwxStageInput = {
  inOutput: {
    artifactId: "artifact:worker-parity",
    filePath: "docs/worker-parity.md",
    chunks: [
      {
        id: "chunk-0",
        content: "# CacheStore\n\nThe CacheStore uses Redis.",
        type: "section",
        title: "CacheStore",
        startLine: 1,
        endLine: 3,
      },
      {
        id: "chunk-1",
        content: "The Redis cache is deprecated; QueueWorker is planned.",
        type: "paragraph",
        startLine: 5,
        endLine: 5,
      },
      {
        id: "chunk-2",
        content: "Use **CacheStore** before sending work to QueueWorker.",
        type: "paragraph",
        startLine: 7,
        endLine: 7,
        metadata: { heading: "Worker design" },
      },
    ],
  },
};

describe("KWX chunk worker experiment", () => {
  it("matches serial output and preserves chunk order while reusing workers", async () => {
    const workerPool = createKwxChunkWorkerPool(2);
    const dictionary = new Set(["cachestore", "redis", "queueworker"]);
    try {
      for (const depth of ["full", "structured"] as const) {
        const options = { depth, dictionary };
        const serial = await runKwxStage(input, options);
        const concurrent = await runKwxStage(input, { ...options, workerPool });

        expect(concurrent.mentions).toEqual(serial.mentions);
        expect(concurrent.entities).toEqual(serial.entities);
        expect(concurrent.meta).toMatchObject({
          mentionCount: serial.meta.mentionCount,
          entityCount: serial.meta.entityCount,
          qualifiedMentionCount: serial.meta.qualifiedMentionCount,
        });
      }
    } finally {
      await workerPool.close();
    }
  });
});