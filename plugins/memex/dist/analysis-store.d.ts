export interface CommunitySummaryV1 {
    id: string;
    memberCount: number;
    topTerms: string[];
    members: string[];
    membersTruncated: boolean;
}
export interface CommunitiesSnapshotV1 {
    schemaVersion: 1;
    generation: string;
    generatedAt: string;
    communities: CommunitySummaryV1[];
    membership: Record<string, string>;
}
export interface AnalysisStorage {
    root: string;
    manifestPath: string;
}
export declare function resolveAnalysisStorage(root: string, homeDir?: string): Promise<{
    storage: AnalysisStorage;
    workspaceId: string;
}>;
export declare function probeAnalysisStorage(root: string, homeDir?: string): Promise<{
    initialized: boolean;
    storage: AnalysisStorage;
}>;
export declare function writeCommunitiesSnapshot(storage: AnalysisStorage, snapshot: CommunitiesSnapshotV1): Promise<void>;
export declare function readCommunitiesSnapshot(storage: AnalysisStorage): Promise<CommunitiesSnapshotV1>;
export declare function parseCommunitiesSnapshot(value: unknown): CommunitiesSnapshotV1;
