import { type CodeGraphV1, type GraphConfidence, type GraphEdgeKind, type GraphEdgeV1, type GraphNodeV1 } from "./graph-contracts.js";
export declare function confidenceWeight(confidence: GraphConfidence): number;
export declare function computeCommunities(graph: CodeGraphV1): Map<string, string>;
export interface GraphPathResult {
    nodeIds: string[];
    edgeIds: string[];
    totalWeight: number;
}
export declare function computeGodNodes(graph: CodeGraphV1, limit: number): Array<{
    nodeId: string;
    degree: number;
}>;
export declare function computeShortestPath(graph: CodeGraphV1, from: string, to: string): GraphPathResult | undefined;
export type GraphPlane = "code" | "concept" | "wiki" | "source";
export declare function planeOf(node: GraphNodeV1): GraphPlane;
export interface SurprisingConnection {
    edgeId: string;
    from: string;
    to: string;
    kind: GraphEdgeKind;
    confidence: GraphConfidence;
    priority: "concept-code" | "cross-plane";
}
export declare function computeSurprisingConnections(graph: CodeGraphV1, limit: number): SurprisingConnection[];
export interface CoverageStats {
    totalCodeNodes: number;
    describedCodeNodes: number;
    coverageRatio: number;
}
export declare function computeCoverageStats(graph: CodeGraphV1): CoverageStats;
export interface CommunityQuestionInput {
    id: string;
    memberCount: number;
    topTerms: readonly string[];
}
export declare function computeSuggestedQuestions(godNodes: ReadonlyArray<{
    nodeId: string;
    degree: number;
}>, communities: ReadonlyArray<CommunityQuestionInput>, graph: CodeGraphV1): string[];
export declare function synthesizeMemberOfEdges(graph: CodeGraphV1, communities: ReadonlyMap<string, string>): GraphEdgeV1[];
export interface CommunitySummary {
    id: string;
    memberCount: number;
    topTerms: string[];
    members: string[];
    membersTruncated: boolean;
}
export declare function summarizeCommunities(graph: CodeGraphV1, communities: ReadonlyMap<string, string>): CommunitySummary[];
export declare function findCitingPages(nodes: readonly GraphNodeV1[], edges: readonly GraphEdgeV1[], targetId: string): GraphNodeV1[];
