import { type CodeGraphV1, type GraphDiagnosticV1, type GraphEdgeV1, type GraphNodeV1 } from "./graph-contracts.js";
import { type ImpactResult } from "./graph-query.js";
export interface GraphOperationBase {
    root: string;
    homeDir?: string;
    limit?: number;
    responseByteLimit?: number;
}
export interface BuildGraphOptions extends GraphOperationBase {
    now?: string;
    force?: boolean;
    limits?: {
        maxFiles?: number;
        maxFileBytes?: number;
        maxRepositoryBytes?: number;
    };
}
export interface TargetGraphOptions extends GraphOperationBase {
    target: string;
}
export interface ImpactGraphOptions extends TargetGraphOptions {
    direction?: "inbound" | "outbound" | "both";
    depth?: number;
}
export interface QueryGraphOptions extends GraphOperationBase {
    query: string;
}
export interface GraphResultEnvelope {
    schemaVersion: 1;
    action: "query" | "context";
    root: string;
    nodes: GraphNodeV1[];
    edges: GraphEdgeV1[];
    truncated: boolean;
    diagnostics: GraphDiagnosticV1[];
}
export interface GraphImpactEnvelope extends Omit<GraphResultEnvelope, "action"> {
    action: "impact";
    direction: "inbound" | "outbound" | "both";
    depth: number;
    paths: ImpactResult["paths"];
}
export interface GraphChangesEnvelope extends Omit<GraphResultEnvelope, "action"> {
    action: "changes";
    changedPaths: string[];
    base?: string;
}
export declare function buildGraph(options: BuildGraphOptions): Promise<{
    schemaVersion: 1;
    action: "build";
    root: string;
    fresh: true;
    fullRebuild: boolean;
    head?: string;
    dirtyFingerprint: string;
    scannedFileCount: number;
    reusedFileCount: number;
    removedFileCount: number;
    fileCount: number;
    nodeCount: number;
    edgeCount: number;
    diagnosticCount: number;
    generatedAt: string;
    graph: CodeGraphV1;
    manifestPath: string;
    reusedShardCount: number;
}>;
export declare function getGraphStatus(options: GraphOperationBase): Promise<{
    schemaVersion: 1;
    action: "status";
    root: string;
    available: boolean;
    fresh: boolean;
    reason?: string;
    indexedHead?: string;
    currentHead?: string;
    counts?: {
        files: number;
        nodes: number;
        edges: number;
        diagnostics: number;
    };
    generatedAt?: string;
    graph?: CodeGraphV1;
}>;
export declare function queryGraphOperation(options: QueryGraphOptions): Promise<GraphResultEnvelope & {
    query: string;
}>;
export { queryGraphOperation as queryGraph };
export declare function getGraphContext(options: TargetGraphOptions): Promise<GraphResultEnvelope & {
    target: string;
}>;
export declare function analyzeGraphImpact(options: ImpactGraphOptions): Promise<GraphImpactEnvelope & {
    target: string;
}>;
export declare function analyzeGraphChanges(options: GraphOperationBase & {
    base?: string;
}): Promise<GraphChangesEnvelope>;
export declare function getArchitectureMap(options: GraphOperationBase): Promise<{
    schemaVersion: 1;
    action: "map";
    root: string;
    modules: GraphNodeV1[];
    hubs: GraphNodeV1[];
    cycles: string[][];
    flows: Array<{
        from: string;
        to: string;
        weight: number;
    }>;
    truncated: boolean;
    diagnostics: GraphDiagnosticV1[];
}>;
