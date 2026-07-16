import { type ChunkRef } from "./chunk.js";
export interface LexicalIndex {
    upsert(chunks: ReadonlyArray<{
        ref: ChunkRef;
        text: string;
    }>): Promise<void>;
    search(query: string, limit: number): Promise<Array<{
        ref: ChunkRef;
        score: number;
    }>>;
}
export declare function openLexicalIndex(storageRoot: string): Promise<LexicalIndex>;
