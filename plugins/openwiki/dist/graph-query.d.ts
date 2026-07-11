import type { CodeGraphV1, GraphEdgeV1, GraphNodeV1 } from "./graph-contracts.js";
export interface GraphResult {
    nodes: GraphNodeV1[];
    edges: GraphEdgeV1[];
    truncated: boolean;
    unresolvedEdgeCount: number;
}
export interface QueryGraphOptions {
    query: string;
    limit?: number;
    responseByteLimit?: number;
}
export interface ImpactResult extends GraphResult {
    paths: Array<{
        nodeId: string;
        depth: number;
        via?: string;
    }>;
}
export declare function queryGraph(graph: CodeGraphV1, options: QueryGraphOptions): GraphResult;
export declare function contextGraph(graph: CodeGraphV1, target: string, limit?: number, responseByteLimit?: number): GraphResult;
export declare function impactGraph(graph: CodeGraphV1, target: string, direction: "inbound" | "outbound" | "both", depth?: number, limit?: number, responseByteLimit?: number): ImpactResult;
export declare function matchTargets(graph: CodeGraphV1, target: string): GraphNodeV1[];
