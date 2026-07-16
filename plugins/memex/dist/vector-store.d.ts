import { type ChunkRef } from "./chunk.js";
export interface VectorStore {
    upsert(entries: ReadonlyArray<{
        ref: ChunkRef;
        vector: Float32Array;
    }>): Promise<{
        written: number;
        reused: number;
    }>;
    search(vector: Float32Array, limit: number): Promise<Array<{
        ref: ChunkRef;
        score: number;
    }>>;
    status(): Promise<{
        modelId: string;
        dims: number;
        chunks: number;
        compatible: boolean;
        embeddingsAvailable: boolean;
        unavailableReason?: string;
    }>;
}
interface VectorModel {
    modelId: string;
    modelRevision: string;
    dims: number;
}
export declare function openVectorStore(storageRoot: string, model: VectorModel): Promise<VectorStore>;
export declare function readVectorChunkDigest(storageRoot: string): Promise<ReadonlyMap<string, string>>;
export declare function markEmbeddingsUnavailable(storageRoot: string, model: VectorModel, reason: string): Promise<void>;
export {};
