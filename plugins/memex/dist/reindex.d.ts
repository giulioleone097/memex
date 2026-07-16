import { type Embedder } from "./embedder.js";
import type { GraphIndexPort } from "./graph-index.js";
import { type WikiLocation } from "./paths.js";
export interface ReindexResult {
    chunked: number;
    embedded: number;
    reusedVectors: number;
    reusedLexical: number;
    embeddingsAvailable: boolean;
    unavailableReason?: string;
}
export interface ReindexPorts {
    vendorRoot?: string;
    loadEmbedder?: (vendorRoot: string) => Promise<Embedder>;
}
export declare function reindexWikiPage(location: WikiLocation, page: string, content: string, ports?: ReindexPorts): Promise<ReindexResult>;
export declare function reindexCodeSymbols(root: string, index: GraphIndexPort, homeDir?: string, ports?: ReindexPorts): Promise<ReindexResult>;
