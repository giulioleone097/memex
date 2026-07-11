import { type CodeGraphV1, type GraphDiagnosticV1, type GraphEdgeV1, type GraphNodeV1 } from "./graph-contracts.js";
export declare const GRAPH_STORE_SCHEMA_VERSION: 2;
export interface GraphIndexManifest {
    schemaVersion: typeof GRAPH_STORE_SCHEMA_VERSION;
    scannerVersion: string;
    generation: string;
    nodeBuckets: string[];
    edgeBuckets: string[];
    inboundBuckets: string[];
    outboundBuckets: string[];
    symbolBuckets: string[];
    pathBuckets: string[];
    architecture: "architecture.json";
}
export interface GraphIndexMetrics {
    bytesRead: number;
    filesRead: number;
}
export interface GraphIndexStatus {
    generation: string;
    recovered: boolean;
    schemaVersion: typeof GRAPH_STORE_SCHEMA_VERSION;
    scannerVersion: string;
}
export interface GraphAdjacency {
    edges: GraphEdgeV1[];
    total: number;
    truncated: boolean;
}
export interface GraphIndexPort {
    node(id: string): Promise<GraphNodeV1 | undefined>;
    edge(id: string): Promise<GraphEdgeV1 | undefined>;
    rankedCandidates(query: string, limit: number): Promise<string[]>;
    inbound(id: string, limit: number): Promise<GraphAdjacency>;
    outbound(id: string, limit: number): Promise<GraphAdjacency>;
    changedPathSeeds(paths: readonly string[], limit: number): Promise<string[]>;
    architectureSummary(): Promise<Readonly<GraphArchitectureSummary>>;
    metrics(): GraphIndexMetrics;
    status(): GraphIndexStatus;
}
export interface GraphArchitectureSummary {
    modules: GraphNodeV1[];
    entrypoints: string[];
    hubs: Array<{
        id: string;
        degree: number;
    }>;
    flows: Array<{
        from: string;
        to: string;
        kind: GraphEdgeV1["kind"];
    }>;
    cycles: string[][];
    diagnostics: GraphDiagnosticV1[];
    fileCount: number;
    nodeCount: number;
    edgeCount: number;
}
export declare function writeGraphIndexGeneration(generationRoot: string, generation: string, graph: CodeGraphV1): Promise<GraphIndexManifest>;
export declare function openGraphIndexGeneration(generationRoot: string, expectedGeneration: string, recovered: boolean): Promise<GraphIndexPort>;
