export declare const GRAPH_SCANNER_VERSION = "openwiki-graph-v1";
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
export type GraphNodeKind = "repository" | "directory" | "file" | "module" | "symbol";
export type GraphEdgeKind = "contains" | "declares" | "imports" | "exports" | "calls" | "inherits" | "implements" | "references";
export type GraphConfidence = "exact" | "resolved" | "heuristic";
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
    symbolKind?: string;
    startLine?: number;
    endLine?: number;
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
    schemaVersion: 1;
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
export declare function createGraphNodeId(kind: GraphNodeKind, path: string, name: string, symbolKind?: string, discriminator?: string): string;
export declare function createGraphEdgeId(kind: GraphEdgeKind, from: string, to: string, confidence: GraphConfidence): string;
export declare function graphHash(parts: readonly string[]): string;
export declare function canonicalizeGraph(graph: CodeGraphV1): CodeGraphV1;
export declare function parseCodeGraph(value: unknown): CodeGraphV1;
