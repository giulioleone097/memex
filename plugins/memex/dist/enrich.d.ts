export interface EnrichOptions {
    root: string;
    homeDir?: string;
    envelope: unknown;
    now?: string;
}
export interface EnrichResult {
    action: "enrich";
    sourcePath: string;
    sourceContentHash: string;
    applied: boolean;
    nodesWritten: number;
    edgesWritten: number;
    nodeIds: Record<string, string>;
    generatedAt: string;
}
export declare function enrichGraph(options: EnrichOptions): Promise<EnrichResult>;
