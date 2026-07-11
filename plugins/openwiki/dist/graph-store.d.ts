import { type CodeGraphV1 } from "./graph-contracts.js";
import { type SourceScan } from "./graph-scan.js";
export interface GraphShard {
    path: string;
    language: string;
    contentHash: string;
    size: number;
    scan: SourceScan;
}
interface GraphManifest {
    schemaVersion: 1;
    snapshot: string;
    shards: Array<{
        path: string;
        contentHash: string;
        shard: string;
    }>;
}
export interface GraphStorage {
    root: string;
    manifestPath: string;
    previousManifestPath: string;
    shardRoot: string;
    snapshotRoot: string;
}
export declare function resolveGraphStorage(root: string, homeDir?: string): Promise<{
    storage: GraphStorage;
    workspaceId: string;
    repositoryRoot: string;
}>;
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
export declare function readStoredGraph(storage: GraphStorage): Promise<CodeGraphV1>;
export declare function readGraphShard(storage: GraphStorage, shardName: string): Promise<GraphShard>;
export declare function readManifest(storage: GraphStorage): Promise<GraphManifest>;
export declare function writeGraph(storage: GraphStorage, graph: CodeGraphV1, shards: readonly GraphShard[]): Promise<{
    manifestPath: string;
    reusedShardCount: number;
}>;
export declare function currentGitFingerprint(root: string): Promise<{
    gitHead?: string;
}>;
export declare function repositoryFingerprint(files: ReadonlyArray<{
    path: string;
    contentHash: string;
    size: number;
}>): string;
export declare function changedRepositoryPaths(root: string, base?: string): Promise<string[]>;
export {};
