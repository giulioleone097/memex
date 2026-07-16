export declare const GRAPH_SCANNER_VERSION = "memex-graph-v1";
export declare const GRAPH_CONTRACTS_SCHEMA_VERSION: 2;
export declare const GRAPH_DEFAULTS: {
    readonly defaultEntityLimit: 20;
    readonly defaultResponseBytes: number;
    readonly maxEntityLimit: 100;
    readonly maxFiles: 50000;
    readonly maxFileBytes: number;
    readonly maxRepositoryBytes: number;
    readonly maxResponseBytes: number;
    readonly maxTraversalDepth: 5;
};
export type GraphNodeKind = "repository" | "directory" | "file" | "module" | "symbol" | "concept" | "page" | "source";
export type GraphEdgeKind = "contains" | "declares" | "imports" | "exports" | "calls" | "inherits" | "implements" | "references" | "mentions" | "describes" | "grounds" | "related" | "member-of";
export type ScannerConfidence = "exact" | "resolved" | "heuristic";
export type AgentConfidence = "extracted" | "inferred" | "ambiguous";
export type GraphConfidence = ScannerConfidence | AgentConfidence;
export interface GraphFileV1 {
    path: string;
    language: string;
    contentHash: string;
    size: number;
}
export interface GraphNodeV1 {
    id: string;
    kind: GraphNodeKind;
    path: string;
    name: string;
    scope?: string;
    symbolKind?: string;
    startLine?: number;
    endLine?: number;
    summary?: string;
}
export interface GraphEdgeV1 {
    id: string;
    kind: GraphEdgeKind;
    from: string;
    to: string;
    confidence: GraphConfidence;
}
export interface GraphDiagnosticV1 {
    path: string;
    code: string;
    message: string;
}
export interface CodeGraphV1 {
    schemaVersion: typeof GRAPH_CONTRACTS_SCHEMA_VERSION;
    workspaceId: string;
    generatedAt: string;
    source: {
        gitHead?: string;
        dirtyFingerprint: string;
        scannerVersion: string;
    };
    files: GraphFileV1[];
    nodes: GraphNodeV1[];
    edges: GraphEdgeV1[];
    diagnostics: GraphDiagnosticV1[];
}
export interface EnrichmentShardV1 {
    sourcePath: string;
    sourceContentHash: string;
    nodes: GraphNodeV1[];
    edges: GraphEdgeV1[];
    enrichedAt: string;
}
export interface GraphLimits {
    maxFiles?: number;
    maxFileBytes?: number;
    maxRepositoryBytes?: number;
}
export interface GraphQueryLimits {
    limit?: number;
    responseByteLimit?: number;
    depth?: number;
}
export declare function isScannerEdgeKind(kind: GraphEdgeKind): boolean;
export declare function isAgentEdgeKind(kind: GraphEdgeKind): boolean;
export declare function validEdgeConfidence(kind: GraphEdgeKind, confidence: GraphConfidence): boolean;
export declare function isGraphNodeKind(value: unknown): value is GraphNodeKind;
export declare function isGraphEdgeKind(value: unknown): value is GraphEdgeKind;
export declare function isGraphConfidence(value: unknown): value is GraphConfidence;
export declare function createGraphNodeId(kind: GraphNodeKind, path: string, name: string, symbolKind?: string, discriminator?: string): string;
export declare function createGraphEdgeId(kind: GraphEdgeKind, from: string, to: string, confidence: GraphConfidence): string;
export declare function graphHash(parts: readonly string[]): string;
export declare function canonicalizeGraph(graph: CodeGraphV1): CodeGraphV1;
export declare function parseCodeGraph(value: unknown): CodeGraphV1;
export declare function mergeEnrichment(graph: CodeGraphV1, shards: readonly EnrichmentShardV1[]): CodeGraphV1;
export declare function parseEnrichmentShard(value: unknown): EnrichmentShardV1;
