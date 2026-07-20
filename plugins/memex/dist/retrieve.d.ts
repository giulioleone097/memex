import { type ChunkRef } from "./chunk.js";
import type { Embedder } from "./embedder.js";
import type { GraphConfidence, GraphNodeV1 } from "./graph-contracts.js";
import type { GraphIndexPort } from "./graph-index.js";
import type { LexicalIndex } from "./lexical-index.js";
import type { VectorStore } from "./vector-store.js";
import { type EvidenceProvenance } from "./evidence-identity.js";
export interface SearchRequest {
    text: string;
    limit: number;
    signals?: ReadonlyArray<"lexical" | "vector" | "graph">;
}
export interface EvidenceItem {
    ref: ChunkRef;
    score: number;
    ranks: {
        lexical?: number;
        vector?: number;
        graph?: number;
    };
    citation: string;
    confidence?: GraphConfidence;
    evidenceId: string;
    provenance: EvidenceProvenance;
}
export interface AskResultV1 {
    schema: "memex.ask.v1";
    question: string;
    evidence: EvidenceItem[];
    relatedNodes: GraphNodeV1[];
    degraded: boolean;
    stale: boolean;
    truncated: boolean;
}
export interface SearchResultV1 {
    schemaVersion: 1;
    evidence: EvidenceItem[];
    degraded: boolean;
    truncated: boolean;
}
export interface RetrievalEvidenceIdentity {
    projectScope?: string | ((ref: ChunkRef) => string | undefined);
    sourceIdentity?: string | ((ref: ChunkRef) => string | undefined);
    priorEvidenceId?: string | ((ref: ChunkRef) => string | undefined);
}
export interface RetrievalPorts {
    lexicalIndex: LexicalIndex;
    vectorStore?: VectorStore;
    embedder?: Embedder;
    graphIndex?: GraphIndexPort;
    evidenceIdentity?: RetrievalEvidenceIdentity;
}
type SignalName = "lexical" | "vector" | "graph";
export declare function search(request: SearchRequest, ports: RetrievalPorts): Promise<SearchResultV1>;
export declare function ask(question: string, limit: number, ports: RetrievalPorts & {
    graphIndex: GraphIndexPort;
}, freshness: {
    stale: boolean;
}, signals?: SearchRequest["signals"]): Promise<AskResultV1>;
export declare function validateSignals(signals: SearchRequest["signals"]): SignalName[];
export {};
