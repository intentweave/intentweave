/**
 * Store Interfaces for IntentWeave
 *
 * Defines the contracts for artifact and graph storage.
 * Implementations can be file-based, memory-based, or database-backed.
 */
import type { StagingSnapshot, ArtifactMeta, RunMeta } from '@intentweave/core';
export type { RunMeta } from '@intentweave/core';
/** Pipeline stages */
export type Stage = 'IN' | 'RX' | 'CX' | 'MX' | 'PX' | 'LX';
/** All stages in order */
export declare const STAGES: Stage[];
/**
 * Raw artifact content before parsing
 */
export interface Artifact {
    /** Unique identifier */
    id: string;
    /** Original file path or URI */
    path: string;
    /** Raw content */
    content: string;
    /** Metadata */
    meta: ArtifactMeta;
}
/**
 * Parsed chunk from an artifact
 */
export interface Chunk {
    /** Unique chunk identifier */
    id: string;
    /** Parent artifact ID */
    artifactId: string;
    /** Chunk content */
    content: string;
    /** Start position in original */
    start: number;
    /** End position in original */
    end: number;
    /** Optional section heading */
    heading?: string;
    /** Chunk index within artifact */
    index: number;
}
/**
 * Cross-artifact link proposal from LX stage
 */
export interface LinkProposal {
    id: string;
    sourceArtifact: string;
    sourceCgId: string;
    targetArtifact: string;
    targetCgId: string;
    predicate: 'REFINES' | 'DERIVED_FROM' | 'IMPLEMENTS' | 'DESCRIBES' | 'MAPS_TO';
    confidence: number;
    matchMethod: 'name' | 'alias' | 'structural' | 'profile' | 'semantic';
    evidence: Array<{
        text: string;
        artifactId: string;
    }>;
}
/**
 * Traceability coverage report
 */
export interface CoverageReport {
    /** Run identifier */
    runId: string;
    /** Coverage by artifact pair */
    coverage: Record<string, {
        total: number;
        linked: number;
        percentage: number;
        unlinked: Array<{
            cgId: string;
            name: string;
        }>;
    }>;
    /** Overall coverage */
    overall: {
        total: number;
        linked: number;
        percentage: number;
    };
}
/**
 * Validation finding
 */
export interface Finding {
    id: string;
    ruleId: string;
    severity: 'error' | 'warning' | 'info';
    entityCgId?: string;
    statementId?: string;
    message: string;
    suggestion?: string;
}
/**
 * Validation findings report
 */
export interface FindingsReport {
    runId: string;
    findings: Finding[];
    summary: {
        errors: number;
        warnings: number;
        info: number;
    };
}
/**
 * Options for reading artifacts
 */
export interface ReadArtifactOptions {
    /** Include parsed chunks */
    includeChunks?: boolean;
}
/**
 * Store for raw artifacts and chunks
 */
export interface ArtifactStore {
    /**
     * Read an artifact by ID
     */
    readArtifact(artifactId: string): Promise<Artifact | null>;
    /**
     * Write an artifact
     */
    writeArtifact(artifact: Artifact): Promise<void>;
    /**
     * List all artifact IDs
     */
    listArtifacts(): Promise<string[]>;
    /**
     * Read chunks for an artifact
     */
    readChunks(artifactId: string): Promise<Chunk[]>;
    /**
     * Write chunks for an artifact
     */
    writeChunks(artifactId: string, chunks: Chunk[]): Promise<void>;
    /**
     * Delete an artifact and its chunks
     */
    deleteArtifact(artifactId: string): Promise<void>;
    /**
     * Write stage output for an artifact
     */
    writeStageOutput(artifactId: string, stage: Stage, output: unknown): Promise<void>;
    /**
     * Read stage output for an artifact
     */
    readStageOutput<T = unknown>(artifactId: string, stage: Stage): Promise<T | null>;
    /**
     * Write run metadata
     */
    writeRunMeta(runId: string, meta: RunMeta): Promise<void>;
    /**
     * Read run metadata
     */
    readRunMeta(runId: string): Promise<RunMeta | null>;
}
/**
 * Options for reading graph snapshots
 */
export interface ReadSnapshotOptions {
    /** Filter by stage */
    stage?: Stage;
    /** Include only entities matching these types */
    entityTypes?: string[];
}
/**
 * Store for graph snapshots (per-stage)
 */
export interface GraphStore {
    /**
     * Read a snapshot for an artifact at a specific stage
     */
    readSnapshot(artifactId: string, stage: Stage): Promise<StagingSnapshot | null>;
    /**
     * Write a snapshot for an artifact at a specific stage
     */
    writeSnapshot(artifactId: string, stage: Stage, snapshot: StagingSnapshot): Promise<void>;
    /**
     * List all artifact IDs with snapshots
     */
    listArtifacts(): Promise<string[]>;
    /**
     * Get available stages for an artifact
     */
    getStages(artifactId: string): Promise<Stage[]>;
    /**
     * Delete all snapshots for an artifact
     */
    deleteArtifact(artifactId: string): Promise<void>;
}
/**
 * Aggregate outputs for a run
 */
export interface RunAggregates {
    /** Link proposals from LX */
    linkProposals?: LinkProposal[];
    /** Coverage report (simple) */
    coverage?: CoverageReport;
    /** Validation findings (simple) */
    findings?: FindingsReport;
    /** Rich coverage report from coverageReport module */
    richCoverage?: unknown;
    /** Rich validation output from coreRules module */
    richValidation?: unknown;
}
/**
 * Store for run metadata and aggregates
 */
export interface RunStore {
    /**
     * Get run metadata
     */
    getRunMeta(runId: string): Promise<RunMeta | null>;
    /**
     * Create or update run metadata
     */
    saveRunMeta(meta: RunMeta): Promise<void>;
    /**
     * List all run IDs
     */
    listRuns(): Promise<string[]>;
    /**
     * Get aggregates for a run
     */
    getAggregates(runId: string): Promise<RunAggregates>;
    /**
     * Save aggregates for a run
     */
    saveAggregates(runId: string, aggregates: Partial<RunAggregates>): Promise<void>;
    /**
     * Delete a run and all its data
     */
    deleteRun(runId: string): Promise<void>;
}
/**
 * Combined store providing all storage operations
 */
export interface Store extends ArtifactStore, GraphStore, RunStore {
    /**
     * Initialize the store (create directories, etc.)
     */
    init(): Promise<void>;
    /**
     * Close the store (cleanup connections, etc.)
     */
    close(): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map