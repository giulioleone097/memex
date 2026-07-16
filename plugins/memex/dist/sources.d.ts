import { type SourceKind } from "./contracts.js";
import type { WikiLocation } from "./paths.js";
export declare const DEFAULT_SOURCE_RETENTION_RUNS = 20;
export declare const MAX_SOURCE_RETENTION_RUNS = 20;
export interface IngestSourceOptions {
    location: WikiLocation;
    envelope: unknown;
    retentionRuns?: number;
}
export interface IngestSourceResult {
    sourceId: string;
    kind: SourceKind;
    runHash: string;
    stored: boolean;
    acceptedItems: number;
    duplicateItems: number;
    retainedRuns: number;
}
export interface SourceSummary {
    sourceId: string;
    kind: SourceKind;
    runCount: number;
    itemCount: number;
    latestFetchedAt: string;
    latestRunHash: string;
}
export declare const PURGE_SCOPES: readonly ["raw", "schedules", "personal-wiki", "all"];
export type PurgeScope = (typeof PURGE_SCOPES)[number];
export type RemovedPurgeScope = Exclude<PurgeScope, "all">;
export interface PurgeDataOptions {
    location: WikiLocation;
    scope: PurgeScope;
}
export interface PurgeDataResult {
    requestedScope: PurgeScope;
    removedScopes: RemovedPurgeScope[];
}
export declare function canonicalJsonHash(value: unknown): string;
export declare function ingestSource(options: IngestSourceOptions): Promise<IngestSourceResult>;
export declare function listSources(location: WikiLocation): Promise<SourceSummary[]>;
export declare function purgeData(options: PurgeDataOptions): Promise<PurgeDataResult>;
