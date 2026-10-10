import { parentPort } from "node:worker_threads";
import type { SemanticChunk } from "@intentweave/core";
import type { KwxChunkProcessor as KwxChunkProcessorType } from "./kwxChunkProcessor.js";
import type { KwxChunkProcessorOptions } from "./kwxChunkProcessor.js";

type WorkerSettings = Omit<KwxChunkProcessorOptions, "dictionary"> & {
  readonly dictionary?: readonly string[];
};

type WorkerCommand =
  | { readonly type: "configure"; readonly generation: number; readonly settings: WorkerSettings }
  | { readonly type: "chunk"; readonly taskId: number; readonly filePath: string; readonly chunk: SemanticChunk };

const port = parentPort;
if (!port) throw new Error("KWX chunk worker must be started as a worker thread.");

const processorUrl = new URL(
  import.meta.url.endsWith(".ts") ? "./kwxChunkProcessor.ts" : "./kwxChunkProcessor.js",
  import.meta.url,
);
const processorModule = await import(processorUrl.href) as typeof import("./kwxChunkProcessor.js");
let processor: KwxChunkProcessorType | undefined;
port.on("message", (command: WorkerCommand) => {
  if (command.type === "configure") {
    const dictionary = new Set(command.settings.dictionary ?? []);
    processor = new processorModule.KwxChunkProcessor({
      ...(command.settings.minLength !== undefined ? { minLength: command.settings.minLength } : {}),
      ...(command.settings.depth ? { depth: command.settings.depth } : {}),
      dictionary,
    });
    port.postMessage({ type: "configured", generation: command.generation });
    return;
  }

  try {
    if (!processor) throw new Error("KWX worker received a chunk before configuration.");
    port.postMessage({
      type: "chunk-result",
      taskId: command.taskId,
      mentions: processor.process(command.filePath, command.chunk),
    });
  } catch (error) {
    port.postMessage({
      type: "chunk-result",
      taskId: command.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});