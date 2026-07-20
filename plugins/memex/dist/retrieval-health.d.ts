import { type WikiLocation } from "./paths.js";
/** Stable discriminator for the additive retrieval-health read model. */
export declare const RETRIEVAL_HEALTH_SCHEMA: "memex.retrieval-health.v1";
export type RetrievalSignal = "lexical" | "vector" | "graph";
export type RetrievalProofStatus = "proven" | "failed" | "unknown";
export interface RetrievalHealthFailure {
    code: string;
    message: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
}
export interface RetrievalProofLayer {
    status: RetrievalProofStatus;
    checkedAt: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    failures: RetrievalHealthFailure[];
}
export interface RetrievalCoverageSignal {
    expected: number;
    indexed: number;
    ratio: number;
    ready: boolean;
}
export interface RetrievalHealth {
    schema: typeof RETRIEVAL_HEALTH_SCHEMA;
    ready: boolean;
    reasons: string[];
    proofLayers: {
        source: RetrievalProofLayer;
        installedCache: RetrievalProofLayer;
        registry: RetrievalProofLayer;
        hostMount: RetrievalProofLayer;
        liveCall: RetrievalProofLayer;
    };
    identity: {
        repositoryIdentity: string | null;
        hostLocalStorageKey: string;
        wikiHash: string | null;
        matches: boolean;
    };
    freshness: {
        status: "current" | "stale" | "unknown";
        indexedAt?: string;
        reason?: string;
    };
    coverage: {
        expected: number;
        indexed: number;
        lexical: RetrievalCoverageSignal;
        vector: RetrievalCoverageSignal;
    };
    graphGeneration: string | null;
    modelRevision: string | null;
    modelId: string | null;
    counts: {
        lexical: number;
        vector: number;
        graph: {
            files: number;
            nodes: number;
            edges: number;
            diagnostics: number;
        };
    };
    benchmarkFailures: {
        /** Normalized codes compatible with the benchmark gate report. */
        byCategory: Record<string, string[]>;
        bySignal: Record<RetrievalSignal, string[]>;
        /** Full inspectable evidence for each normalized failure code. */
        details: {
            byCategory: Record<string, RetrievalHealthFailure[]>;
            bySignal: Record<RetrievalSignal, RetrievalHealthFailure[]>;
        };
    };
    lastError: RetrievalHealthFailure | null;
    recovery: {
        required: boolean;
        action: string;
        commands: string[];
    };
    lastUpdate: {
        noOp: boolean | null;
        graphGenerated: boolean | null;
        reembedded: boolean | null;
    };
}
export interface RetrievalHealthOptions {
    /** Primarily useful to deterministic unit tests and host integrations. */
    now?: string;
    /** The caller can pass operation evidence when it already has it. */
    lastUpdate?: Partial<RetrievalHealth["lastUpdate"]>;
    /** Stable, portable repository/project scope resolved by the adapter. */
    projectScope?: string | null;
    /** Injectable only for deterministic registry regression tests. */
    vendorRoot?: string;
}
/**
 * Read retrieval health from the canonical source, private cache, vendor
 * registry, mounted host and live local ports. Every failed probe is retained
 * as structured input/output evidence; no layer is inferred from another.
 */
export declare function readRetrievalHealth(location: WikiLocation, options?: RetrievalHealthOptions): Promise<RetrievalHealth>;
/** Alias retained for callers that prefer a `get*` naming convention. */
export declare const getRetrievalHealth: typeof readRetrievalHealth;
