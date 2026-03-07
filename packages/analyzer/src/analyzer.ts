/**
 * Analyzer - Main orchestration for entity extraction and analysis
 * 
 * Coordinates extractors, LLM providers, and staging to process
 * documents and populate the knowledge graph.
 */

import type {
  Entity,
  Statement,
  StagingSnapshot,
  LLMProvider,
  ExtractionProvider,
  StagingProvider,
  DatabaseProvider,
  ArtifactMeta,
  ArtifactFormat,
  ArtifactRole,
  Chunk,
  EntitySchema,
  ExtractionProfile,
} from '@intentweave/core';
import { extractorRegistry, mergeExtractionResults, deduplicateEntities, deduplicateStatements } from './extractors/index.js';
import type { ExtractionResult, ExtractorOptions } from './extractors/index.js';
import type { Store, Artifact, Stage } from './stores/index.js';

/**
 * Analyzer configuration
 */
export interface AnalyzerConfig {
  /** LLM provider for low-level model access (deprecated, use extractionProvider) */
  llmProvider?: LLMProvider;
  
  /** Extraction provider for RX-stage entity/statement extraction */
  extractionProvider?: ExtractionProvider;
  
  /** Staging provider for buffering results */
  stagingProvider?: StagingProvider;
  
  /** Database provider for persistence */
  databaseProvider?: DatabaseProvider;
  
  /** Store for file-based persistence */
  store?: Store;
  
  /** Default namespace for new entities */
  defaultNamespace?: string;
  
  /** Enable parallel extraction */
  parallelExtraction?: boolean;
  
  /** Maximum concurrent extractions */
  maxConcurrency?: number;
}

/**
 * File to analyze
 */
export interface AnalysisFile {
  /** File path */
  path: string;
  
  /** File content */
  content: string;
  
  /** Optional namespace override */
  namespace?: string;
}

/**
 * Analysis result for a single file
 */
export interface FileAnalysisResult {
  path: string;
  entities: Entity[];
  statements: Statement[];
  warnings: string[];
  duration: number;
  success: boolean;
  error?: string;
}

/**
 * Batch analysis result
 */
export interface BatchAnalysisResult {
  files: FileAnalysisResult[];
  totalEntities: number;
  totalStatements: number;
  totalDuration: number;
  successCount: number;
  errorCount: number;
}

/**
 * Analyzer class - main entry point for document analysis
 */
export class Analyzer {
  private config: AnalyzerConfig;
  
  constructor(config: AnalyzerConfig = {}) {
    this.config = {
      defaultNamespace: 'default',
      parallelExtraction: false,
      maxConcurrency: 4,
      ...config,
    };
  }
  
  /**
   * Analyze a single file
   */
  async analyzeFile(file: AnalysisFile): Promise<FileAnalysisResult> {
    const startTime = Date.now();
    
    try {
      const extractors = extractorRegistry.findForFile(file.path);
      
      if (extractors.length === 0) {
        return {
          path: file.path,
          entities: [],
          statements: [],
          warnings: [`No extractor found for file: ${file.path}`],
          duration: Date.now() - startTime,
          success: true,
        };
      }
      
      const options: ExtractorOptions = {
        namespace: file.namespace ?? this.config.defaultNamespace,
        includeEvidence: true,
      };
      
      // Run all matching extractors
      const results: ExtractionResult[] = [];
      for (const extractor of extractors) {
        const result = await extractor.extract(file.content, file.path, options);
        results.push(result);
      }
      
      // Merge and deduplicate
      const merged = mergeExtractionResults(results);
      const entities = deduplicateEntities(merged.entities);
      const statements = deduplicateStatements(merged.statements);
      
      // Optionally enhance with extraction provider
      if (this.config.extractionProvider) {
        const enhanced = await this.enhanceWithExtraction(entities, statements, file.content, file.path);
        entities.push(...enhanced.entities);
        statements.push(...enhanced.statements);
      }
      
      // Stage results if provider available
      if (this.config.stagingProvider) {
        const runId = `run-${Date.now()}`;
        await this.config.stagingProvider.stageEntities(entities, runId);
        await this.config.stagingProvider.stageStatements(statements, runId);
      }
      
      return {
        path: file.path,
        entities,
        statements,
        warnings: merged.warnings,
        duration: Date.now() - startTime,
        success: true,
      };
    } catch (error) {
      return {
        path: file.path,
        entities: [],
        statements: [],
        warnings: [],
        duration: Date.now() - startTime,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * Analyze multiple files
   */
  async analyzeFiles(files: AnalysisFile[]): Promise<BatchAnalysisResult> {
    const startTime = Date.now();
    const results: FileAnalysisResult[] = [];
    
    if (this.config.parallelExtraction) {
      // Process in chunks for controlled concurrency
      const chunks = this.chunk(files, this.config.maxConcurrency!);
      for (const chunk of chunks) {
        const chunkResults = await Promise.all(
          chunk.map(file => this.analyzeFile(file))
        );
        results.push(...chunkResults);
      }
    } else {
      // Sequential processing
      for (const file of files) {
        const result = await this.analyzeFile(file);
        results.push(result);
      }
    }
    
    return {
      files: results,
      totalEntities: results.reduce((sum, r) => sum + r.entities.length, 0),
      totalStatements: results.reduce((sum, r) => sum + r.statements.length, 0),
      totalDuration: Date.now() - startTime,
      successCount: results.filter(r => r.success).length,
      errorCount: results.filter(r => !r.success).length,
    };
  }
  
  /**
   * Enhance extraction using ExtractionProvider (RX stage)
   */
  private async enhanceWithExtraction(
    existingEntities: Entity[],
    existingStatements: Statement[],
    content: string,
    filePath?: string
  ): Promise<{ entities: Entity[]; statements: Statement[] }> {
    if (!this.config.extractionProvider) {
      return { entities: [], statements: [] };
    }
    
    // Create a chunk from the content
    const chunk: Chunk = {
      id: `chunk-${Date.now()}`,
      content,
      index: 0,
      turnIndex: 0,
      filePath,
    };
    
    // Define schema and profile for extraction
    const schema: EntitySchema = {
      kinds: ['resource', 'action', 'state', 'role', 'service', 'event'],
      predicates: ['HAS_STATE', 'TRANSITIONS_TO', 'TRIGGERED_BY', 'CONTAINS', 'DEPENDS_ON'],
      hints: existingEntities.length > 0 
        ? [`Known entities: ${existingEntities.slice(0, 10).map(e => e.name).join(', ')}`]
        : undefined,
    };
    
    const profile: ExtractionProfile = {
      name: 'enhance',
      artifactRole: filePath?.endsWith('.md') ? 'spec' : 'code',
      confidence: 0.7,
    };
    
    // Extract using the provider
    const result = await this.config.extractionProvider.extract([chunk], schema, profile);
    
    return {
      entities: result.entities,
      statements: result.statements,
    };
  }
  
  /**
   * Split array into chunks
   */
  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
  
  /**
   * Get current staging snapshot
   */
  async getStagingSnapshot(): Promise<StagingSnapshot | null> {
    if (!this.config.stagingProvider) {
      return null;
    }
    return this.config.stagingProvider.getSnapshot();
  }
  
  /**
   * Commit staged data to database
   */
  async commitToDatabase(): Promise<{ created: number; updated: number } | null> {
    if (!this.config.stagingProvider || !this.config.databaseProvider) {
      return null;
    }
    
    const result = await this.config.stagingProvider.commit(this.config.databaseProvider);
    return { created: result.created, updated: result.updated };
  }

  /**
   * Write analysis result to store
   */
  async writeToStore(
    artifactId: string,
    stage: Stage,
    result: FileAnalysisResult
  ): Promise<void> {
    if (!this.config.store) {
      return;
    }

    const snapshot: StagingSnapshot = {
      entities: result.entities,
      statements: result.statements,
    };

    await this.config.store.writeSnapshot(artifactId, stage, snapshot);
  }

  /**
   * Write an artifact and its analysis result to store
   */
  async writeArtifactToStore(
    file: AnalysisFile,
    result: FileAnalysisResult,
    stage: Stage = 'RX'
  ): Promise<void> {
    if (!this.config.store) {
      return;
    }

    // Create artifact
    const artifact: Artifact = {
      id: file.path,
      path: file.path,
      content: file.content,
      meta: {
        path: file.path,
        format: this.detectFormat(file.path),
        role: this.inferRole(file.path),
      },
    };

    // Write artifact and snapshot
    await this.config.store.writeArtifact(artifact);
    await this.writeToStore(file.path, stage, result);
  }

  /**
   * Detect artifact format from file extension
   */
  private detectFormat(filePath: string): ArtifactFormat {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const formatMap: Record<string, ArtifactFormat> = {
      md: 'markdown',
      ts: 'typescript',
      js: 'javascript',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      py: 'python',
      sql: 'sql',
    };
    return formatMap[ext] ?? 'unknown';
  }

  /**
   * Infer artifact role from path
   */
  private inferRole(filePath: string): ArtifactRole {
    const lower = filePath.toLowerCase();
    if (lower.includes('spec') || lower.includes('requirement')) return 'spec';
    if (lower.includes('test') || lower.includes('.test.') || lower.includes('.spec.')) return 'test';
    if (lower.includes('readme') || lower.includes('docs/')) return 'doc';
    if (lower.includes('config') || lower.includes('.json') || lower.includes('.yaml')) return 'config';
    if (lower.includes('prompt') || lower.includes('intent')) return 'intent';
    return 'code';
  }
}

/**
 * Create an analyzer with default configuration
 */
export function createAnalyzer(config?: AnalyzerConfig): Analyzer {
  return new Analyzer(config);
}
