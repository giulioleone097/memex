import type { GraphConfidence, GraphEdgeKind, GraphEdgeV1, GraphNodeV1 } from "./graph-contracts.js";
import type { CommunitySummaryV1 } from "./analysis-store.js";
export interface GraphReportInputV1 {
    root: string;
    generation: string;
    generatedAt: string;
    godNodes: Array<{
        node: GraphNodeV1;
        degree: number;
    }>;
    communities: CommunitySummaryV1[];
    surprisingConnections: Array<{
        from: GraphNodeV1;
        to: GraphNodeV1;
        kind: GraphEdgeKind;
        confidence: GraphConfidence;
        priority: "concept-code" | "cross-plane";
    }>;
    suggestedQuestions: string[];
    coverage: {
        totalCodeNodes: number;
        describedCodeNodes: number;
        coverageRatio: number;
    };
    ambiguousEdges: Array<{
        edge: GraphEdgeV1;
        from: GraphNodeV1 | undefined;
        to: GraphNodeV1 | undefined;
    }>;
}
export declare function renderGraphReportMarkdown(input: GraphReportInputV1): string;
