/**
 * Mock LLM Provider
 * 
 * Deterministic LLM provider for testing.
 * Returns configurable responses and captures requests for assertions.
 */

import type { LLMProvider, LLMRequest, LLMResponse, LLMProviderCapabilities } from '@intentweave/core';
import type { MockLLMConfig, MockLLMFixture } from './types.js';

/**
 * Mock LLM Provider Implementation
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  
  private readonly config: MockLLMConfig;
  private readonly capturedRequests: LLMRequest[] = [];
  
  constructor(config: MockLLMConfig = {}) {
    this.config = {
      defaultResponse: config.defaultResponse ?? '{"entities":[],"statements":[]}',
      defaultParsed: config.defaultParsed ?? { entities: [], statements: [] },
      latencyMs: config.latencyMs ?? 10,
      captureRequests: config.captureRequests ?? true,
      fixtures: config.fixtures ?? new Map(),
    };
  }
  
  /**
   * Always available for testing
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }
  
  /**
   * Mock capabilities
   */
  get capabilities(): LLMProviderCapabilities {
    return {
      maxInputTokens: 128000,
      supportsJsonSchema: true,
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsEmbeddings: false,
    };
  }
  
  /**
   * Complete a prompt with mock response
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    
    // Capture request if enabled
    if (this.config.captureRequests) {
      this.capturedRequests.push(structuredClone(request));
    }
    
    // Simulate latency
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));
    }
    
    // Check for fixture match
    const fixture = this.findFixture(request);
    
    if (fixture?.error) {
      return {
        content: '',
        tokensUsed: { prompt: 0, completion: 0 },
        latencyMs: Date.now() - startTime,
        model: 'mock',
        finishReason: 'error',
        error: fixture.error,
      };
    }
    
    const content = fixture?.content ?? this.config.defaultResponse ?? '';
    const parsed = fixture?.parsed ?? this.config.defaultParsed;
    
    return {
      content,
      parsed: request.responseSchema ? parsed : undefined,
      tokensUsed: {
        prompt: this.estimateTokens(request),
        completion: Math.ceil(content.length / 4),
      },
      latencyMs: Date.now() - startTime,
      model: 'mock',
      finishReason: 'stop',
    };
  }
  
  /**
   * Find a fixture matching the request
   */
  private findFixture(request: LLMRequest): MockLLMFixture | undefined {
    if (!this.config.fixtures) return undefined;
    
    // Check each message for a fixture match
    for (const msg of request.messages) {
      for (const [pattern, fixture] of this.config.fixtures) {
        if (msg.content.includes(pattern)) {
          return fixture;
        }
      }
    }
    
    return undefined;
  }
  
  /**
   * Estimate token count for a request
   */
  private estimateTokens(request: LLMRequest): number {
    let chars = 0;
    if (request.system) chars += request.system.length;
    for (const msg of request.messages) {
      chars += msg.content.length;
    }
    return Math.ceil(chars / 4);
  }
  
  // =============================================================================
  // Test Utilities
  // =============================================================================
  
  /**
   * Get all captured requests
   */
  getCapturedRequests(): LLMRequest[] {
    return [...this.capturedRequests];
  }
  
  /**
   * Get the last captured request
   */
  getLastRequest(): LLMRequest | undefined {
    return this.capturedRequests[this.capturedRequests.length - 1];
  }
  
  /**
   * Clear captured requests
   */
  clearCapturedRequests(): void {
    this.capturedRequests.length = 0;
  }
  
  /**
   * Reset the provider (alias for clearCapturedRequests)
   */
  reset(): void {
    this.clearCapturedRequests();
  }
  
  /**
   * Add a fixture for a specific prompt pattern
   */
  addFixture(pattern: string, fixture: MockLLMFixture): void {
    this.config.fixtures?.set(pattern, fixture);
  }
  
  /**
   * Remove a fixture
   */
  removeFixture(pattern: string): void {
    this.config.fixtures?.delete(pattern);
  }
  
  /**
   * Set the default response
   */
  setDefaultResponse(content: string, parsed?: unknown): void {
    this.config.defaultResponse = content;
    if (parsed !== undefined) {
      this.config.defaultParsed = parsed;
    }
  }
}

/**
 * Create a mock LLM provider
 */
export function createMockLLMProvider(config?: MockLLMConfig): MockLLMProvider {
  return new MockLLMProvider(config);
}

/**
 * Create a mock provider with entity extraction fixture
 */
export function createMockLLMProviderWithEntities(
  entities: Array<{ name: string; kind: string }>,
  statements: Array<{ subject: string; predicate: string; object: string }> = []
): MockLLMProvider {
  const response = JSON.stringify({ entities, statements });
  return new MockLLMProvider({
    defaultResponse: response,
    defaultParsed: { entities, statements },
  });
}
