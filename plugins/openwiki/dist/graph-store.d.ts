import { type CodeGraphV1 } from "./graph-contracts.js";
import { GRAPH_STORE_SCHEMA_VERSION, type GraphIndexManifest, type GraphIndexPort } from "./graph-index.js";
import { type SourceScan } from "./graph-scan.js";
export interface GraphShard {
    path: string;
    language: string;
    contentHash: string;
    size: number;
    sourceId: string;
    scan: SourceScan;
}
export interface RepositoryFileMetadata {
    path: string;
    size: number;
    language: string;
    sourceId?: string;
}
export interface GraphManifest {
    schemaVersion: typeof GRAPH_STORE_SCHEMA_VERSION;
    scannerVersion: string;
    generation: string;
    snapshot: string;
    index: GraphIndexManifest;
    generatedAt: string;
    source: CodeGraphV1["source"];
    counts: {
        files: number;
        nodes: number;
        edges: number;
        diagnostics: number;
    };
    shards: Array<{
        path: string;
        contentHash: string;
        sourceId: string;
        shard: string;
    }>;
}
export interface GraphStorage {
    root: string;
    manifestPath: string;
    previousManifestPath: string;
    writeLockPath: string;
    generationRoot: string;
    shardRoot: string;
    snapshotRoot: string;
}
export interface GraphStorageProbe {
    initialized: boolean;
    storage: GraphStorage;
    workspaceId: string;
    repositoryRoot: string;
}
export interface GraphChangeEvidence {
    paths: string[];
    head?: string;
    changeState: "working-tree" | "committed" | "clean";
}
export declare function resolveGraphStorage(root: string, homeDir?: string): Promise<{
    storage: GraphStorage;
    workspaceId: string;
    repositoryRoot: string;
}>;
export declare function probeGraphStorage(root: string, homeDir?: string): Promise<GraphStorageProbe>;
export declare function enumerateRepositoryMetadata(root: string, limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxRepositoryBytes: number;
}): Promise<RepositoryFileMetadata[]>;
export declare function readRepositoryFile(root: string, file: RepositoryFileMetadata): Promise<{
    path: string;
    content: string;
    size: number;
    contentHash: string;
    language: string;
    sourceId: string;
}>;
export declare function resolveRepositorySourceIds(root: string, files: readonly RepositoryFileMetadata[]): Promise<Array<RepositoryFileMetadata & {
    sourceId: string;
}>>;
export declare function enumerateRepositoryFiles(root: string, limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxRepositoryBytes: number;
}): Promise<Array<{
    path: string;
    content: string;
    size: number;
    contentHash: string;
    language: string;
}>>;
/** @deprecated Compatibility reader. Stage B query paths must use openGraphIndex. */
export declare function readStoredGraph(storage: GraphStorage): Promise<CodeGraphV1>;
export declare function readGraphShard(storage: GraphStorage, shardName: string): Promise<GraphShard>;
export declare function readManifest(storage: GraphStorage): Promise<GraphManifest>;
export declare function openGraphIndex(storage: GraphStorage): Promise<GraphIndexPort>;
export declare function writeGraph(storage: GraphStorage, graph: CodeGraphV1, shards: readonly GraphShard[]): Promise<{
    manifestPath: string;
    reusedShardCount: number;
}>;
export declare function withGraphWriteLock<T>(storage: GraphStorage, operation: () => Promise<T>): Promise<T>;
export declare function currentGitFingerprint(root: string): Promise<{
    gitHead?: string;
}>;
export declare function repositoryFingerprint(files: ReadonlyArray<{
    path: string;
    contentHash: string;
    size: number;
}>): string;
export declare function repositoryMetadataFingerprint(files: ReadonlyArray<{
    path: string;
    sourceId: string;
    size: number;
}>): string;
export declare function changedRepositoryPaths(root: string, base?: string): Promise<string[]>;
export declare function changedRepositoryEvidence(root: string, base?: string): Promise<GraphChangeEvidence>;
