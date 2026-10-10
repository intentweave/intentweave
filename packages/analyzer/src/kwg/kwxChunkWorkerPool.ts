import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { MentionRecord, SemanticChunk } from "@intentweave/core";
import type { KwxChunkProcessorOptions } from "./kwxChunkProcessor.js";

interface WorkerSettings {
  readonly minLength?: number;
  readonly depth?: "structured" | "full";
  readonly dictionary: readonly string[];
}

interface ConfigureCommand {
  readonly type: "configure";
  readonly generation: number;
  readonly settings: WorkerSettings;
}

interface ChunkCommand {
  readonly type: "chunk";
  readonly taskId: number;
  readonly filePath: string;
  readonly chunk: SemanticChunk;
}

interface ConfigureResult {
  readonly type: "configured";
  readonly generation: number;
}

interface ChunkResult {
  readonly type: "chunk-result";
  readonly taskId: number;
  readonly mentions?: MentionRecord[];
  readonly error?: string;
}

interface PendingTask {
  readonly command: ChunkCommand;
  readonly resolve: (mentions: MentionRecord[]) => void;
  readonly reject: (error: Error) => void;
}

export class KwxChunkWorkerPool {
  private readonly workers: Worker[];
  private readonly busy: boolean[];
  private readonly queue: PendingTask[] = [];
  private readonly pending = new Map<number, PendingTask>();
  private nextTaskId = 0;
  private nextGeneration = 0;
  private configurationWaiter?: {
    readonly generation: number;
    remaining: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  };
  private currentOptions?: KwxChunkProcessorOptions;
  private closed = false;
  private failure?: Error;
  private processing = false;

  constructor(readonly workerCount: number) {
    if (!Number.isInteger(workerCount) || workerCount < 2 || workerCount > 8) {
      throw new Error("KWX workerCount must be an integer from 2 through 8.");
    }

    const isTypeScriptSource = import.meta.url.endsWith(".ts");
    const workerUrl = new URL(isTypeScriptSource ? "./kwxChunkWorker.ts" : "./kwxChunkWorker.js", import.meta.url);
    const tsxLoaderPath = isTypeScriptSource ? createRequire(import.meta.url).resolve("tsx") : undefined;
    const workerOptions = tsxLoaderPath
      ? {
          execArgv: [
            "--require",
            join(dirname(tsxLoaderPath), "preflight.cjs"),
            "--import",
            pathToFileURL(tsxLoaderPath).href,
          ],
        }
      : {
          execArgv: getWorkerExecArgv(process.execArgv),
        };
    this.workers = Array.from({ length: workerCount }, () => new Worker(workerUrl, {
      ...workerOptions,
    }));
    this.busy = Array.from({ length: workerCount }, () => false);

    this.workers.forEach((worker, index) => {
      worker.on("message", (message: ConfigureResult | ChunkResult) => this.handleMessage(index, message));
      worker.on("error", (error: Error) => this.fail(error));
      worker.on("exit", (code: number) => {
        if (!this.closed && code !== 0) this.fail(new Error(`KWX worker ${index} exited with code ${code}.`));
      });
    });
  }

  async processChunks(
    filePath: string,
    chunks: readonly SemanticChunk[],
    options: KwxChunkProcessorOptions,
  ): Promise<MentionRecord[][]> {
    this.assertUsable();
    if (this.processing) throw new Error("KWX worker pool only supports one active stage call at a time.");
    this.processing = true;
    try {
      await this.configure(options);
      const promises = chunks.map((chunk) => new Promise<MentionRecord[]>((resolve, reject) => {
        const taskId = this.nextTaskId++;
        const command: ChunkCommand = { type: "chunk", taskId, filePath, chunk };
        const task = { command, resolve, reject };
        this.pending.set(taskId, task);
        this.queue.push(task);
      }));
      this.dispatch();
      return await Promise.all(promises);
    } finally {
      this.processing = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("KWX worker pool was closed before pending work completed.");
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    this.queue.length = 0;
    this.configurationWaiter?.reject(error);
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }

  private async configure(options: KwxChunkProcessorOptions): Promise<void> {
    if (this.currentOptions
      && this.currentOptions.minLength === options.minLength
      && this.currentOptions.depth === options.depth
      && this.currentOptions.dictionary === options.dictionary) return;

    const generation = this.nextGeneration++;
    const settings: WorkerSettings = {
      ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
      ...(options.depth ? { depth: options.depth } : {}),
      dictionary: options.dictionary ? [...options.dictionary] : [],
    };
    await new Promise<void>((resolve, reject) => {
      this.configurationWaiter = { generation, remaining: this.workers.length, resolve, reject };
      const command: ConfigureCommand = { type: "configure", generation, settings };
      for (const worker of this.workers) worker.postMessage(command);
    });
    this.currentOptions = options;
  }

  private handleMessage(workerIndex: number, message: ConfigureResult | ChunkResult): void {
    if (message.type === "configured") {
      const waiter = this.configurationWaiter;
      if (!waiter || waiter.generation !== message.generation) return;
      waiter.remaining -= 1;
      if (waiter.remaining === 0) {
        this.configurationWaiter = undefined;
        waiter.resolve();
      }
      return;
    }

    const task = this.pending.get(message.taskId);
    if (task) {
      this.pending.delete(message.taskId);
      if (message.error) task.reject(new Error(message.error));
      else task.resolve(message.mentions ?? []);
    }
    this.busy[workerIndex] = false;
    this.dispatch();
  }

  private dispatch(): void {
    if (this.closed || this.failure) return;
    for (let index = 0; index < this.workers.length; index += 1) {
      if (this.busy[index]) continue;
      const task = this.queue.shift();
      if (!task) return;
      this.busy[index] = true;
      try {
        this.workers[index]?.postMessage(task.command);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private assertUsable(): void {
    if (this.closed) throw new Error("KWX worker pool is closed.");
    if (this.failure) throw this.failure;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.configurationWaiter?.reject(error);
    this.configurationWaiter = undefined;
    for (const task of this.pending.values()) task.reject(error);
    this.pending.clear();
    this.queue.length = 0;
  }
}

export function createKwxChunkWorkerPool(workerCount: number): KwxChunkWorkerPool {
  return new KwxChunkWorkerPool(workerCount);
}

function getWorkerExecArgv(arguments_: readonly string[]): string[] {
  const allowedWithValue = new Set(["--import", "--require", "--conditions"]);
  const workerArguments: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    if (argument.startsWith("--import=") || argument.startsWith("--require=") || argument.startsWith("--conditions=")) {
      workerArguments.push(argument);
    } else if (allowedWithValue.has(flag) && arguments_[index + 1]) {
      workerArguments.push(argument, arguments_[index + 1]!);
      index += 1;
    }
  }
  return workerArguments;
}