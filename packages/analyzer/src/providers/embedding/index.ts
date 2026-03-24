// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Embedding Providers — Local and cloud-based embedding services.
 */

export {
  embedBatch,
  embedSingle,
  cosineSimilarity,
  getEmbeddingDimension,
} from "./onnxEmbedding.js";
export type {
  EmbeddingResult,
  OnnxEmbeddingOptions,
} from "./onnxEmbedding.js";
