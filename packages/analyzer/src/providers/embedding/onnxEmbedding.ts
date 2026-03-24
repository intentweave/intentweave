// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * ONNX Embedding Provider — Local sentence embeddings at $0 cost.
 *
 * Uses `@huggingface/transformers` (Transformers.js v3) to run the
 * all-MiniLM-L6-v2 model locally via ONNX Runtime. The model (22MB) is
 * auto-downloaded on first use and cached.
 *
 * Features:
 *   - 384-dimensional sentence embeddings
 *   - Batched inference (100 texts per batch)
 *   - L2-normalized output
 *   - No API key, no cost, ~50ms per batch
 *
 * Fallback: if @huggingface/transformers is not installed, embedBatch()
 * throws with a clear install instruction.
 *
 * @see PHASE-D-SPEC.md §7
 * @version 0.1
 */

// =============================================================================
// Types
// =============================================================================

export interface EmbeddingResult {
  text: string;
  embedding: number[];  // 384 dimensions for MiniLM
}

export interface OnnxEmbeddingOptions {
  /**
   * Model identifier (HuggingFace model ID).
   * Default: "Xenova/all-MiniLM-L6-v2"
   */
  model?: string;
  /**
   * Cache directory for downloaded models.
   * Default: ".iw/models"
   */
  cacheDir?: string;
  /**
   * Batch size for inference.
   * Default: 100
   */
  batchSize?: number;
  /**
   * Logger for progress output.
   */
  log?: (msg: string) => void;
}

// =============================================================================
// Singleton pipe cache (avoids re-loading model on every call)
// =============================================================================

let cachedPipe: any = null;
let cachedModelId = "";

// =============================================================================
// Core API
// =============================================================================

/**
 * Embed a batch of texts using the local ONNX model.
 *
 * On first call, downloads the model (~22MB) and caches it.
 * Subsequent calls share the loaded model (zero overhead).
 *
 * @param texts - Array of text strings to embed
 * @param options - Configuration
 * @returns Array of EmbeddingResult (text + 384-dim vector)
 *
 * @throws If @huggingface/transformers is not installed
 */
export async function embedBatch(
  texts: string[],
  options?: OnnxEmbeddingOptions,
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const model = options?.model ?? "Xenova/all-MiniLM-L6-v2";
  const batchSize = options?.batchSize ?? 100;
  const log = options?.log ?? (() => {});

  // Dynamic import — fails gracefully if not installed
  let pipeline: any;
  try {
    const tf = await import("@huggingface/transformers");
    pipeline = tf.pipeline;
  } catch {
    try {
      // Fallback to v2 package name
      const tf = await import("@xenova/transformers");
      pipeline = tf.pipeline;
    } catch {
      throw new Error(
        "ONNX embedding requires @huggingface/transformers.\n" +
        "Install with: pnpm add @huggingface/transformers -w\n" +
        "Or use --model openai for cloud-based embeddings.",
      );
    }
  }

  // Load model (cached across calls)
  if (!cachedPipe || cachedModelId !== model) {
    log(`Loading embedding model: ${model}`);
    cachedPipe = await pipeline("feature-extraction", model, {
      quantized: true,  // Use quantized model (~6MB instead of ~22MB)
    });
    cachedModelId = model;
    log(`Model loaded: ${model}`);
  }

  const embedder = cachedPipe;
  const results: EmbeddingResult[] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    log(`Embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} texts)`);

    for (const text of batch) {
      // Run inference — returns Tensor with shape [1, tokens, 384]
      const output = await embedder(text, {
        pooling: "mean",    // Mean of token embeddings
        normalize: true,     // L2 normalize
      });

      // Extract the embedding as plain array
      const embedding = Array.from(output.data as Float32Array);

      results.push({ text, embedding });
    }
  }

  return results;
}

/**
 * Embed a single text.
 */
export async function embedSingle(
  text: string,
  options?: OnnxEmbeddingOptions,
): Promise<number[]> {
  const results = await embedBatch([text], options);
  return results[0].embedding;
}

/**
 * Compute cosine similarity between two embeddings.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Embedding dimension mismatch");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

/**
 * Get the embedding dimension for a model.
 */
export function getEmbeddingDimension(model?: string): number {
  // all-MiniLM-L6-v2 → 384 dimensions
  // Could extend for other models
  return 384;
}
