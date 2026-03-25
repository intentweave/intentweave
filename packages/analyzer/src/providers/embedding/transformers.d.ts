// Type shims for optional embedding dependencies (loaded at runtime via dynamic import)
declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<
    (
      texts: string | string[],
      options?: Record<string, unknown>,
    ) => Promise<{ data: Float32Array }[]>
  >;
}

declare module "@xenova/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<
    (
      texts: string | string[],
      options?: Record<string, unknown>,
    ) => Promise<{ data: Float32Array }[]>
  >;
}
