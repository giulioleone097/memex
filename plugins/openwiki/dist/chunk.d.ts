import { type GraphNodeV1 } from "./graph-contracts.js";
export interface ChunkRef {
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    plane: "code" | "concept" | "wiki";
    nodeId?: string;
    contentHash: string;
}
export declare function estimateTokens(text: string): number;
export declare function chunkMarkdown(path: string, text: string): ChunkRef[];
export declare function symbolChunkText(node: GraphNodeV1): string;
export declare function chunkSymbols(nodes: readonly GraphNodeV1[]): ChunkRef[];
export declare function parseChunkRef(value: unknown): ChunkRef;
