// Copyright 2025-2026 Benjamin Becker
// SPDX-License-Identifier: Apache-2.0

/**
 * Store Module
 *
 * Provides storage abstractions for artifacts, graphs, and run metadata.
 */

// Types and interfaces
export * from "./types.js";

// Memory store implementation
export { MemoryStore, createMemoryStore } from "./memoryStore.js";
export type { MemoryStoreOptions } from "./memoryStore.js";

// File store implementation
export { FileStore, createFileStore } from "./fileStore.js";
export type { FileStoreOptions } from "./fileStore.js";
