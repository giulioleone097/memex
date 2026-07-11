export declare const WIKI_MODES: readonly ["code", "personal"];
export type WikiMode = (typeof WIKI_MODES)[number];
export declare const SOURCE_KINDS: readonly ["git-repo", "gmail", "hackernews", "notion", "slack", "web-search", "x"];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export declare const SOURCE_HOSTS: readonly ["codex", "claude", "cli"];
export type SourceHost = (typeof SOURCE_HOSTS)[number];
export declare const WIKI_COMMANDS: readonly ["init", "update", "ingest"];
export type WikiCommand = (typeof WIKI_COMMANDS)[number];
export declare const MAX_ENVELOPE_BYTES: number;
export declare const MAX_ENVELOPE_ITEMS = 500;
export declare const MAX_ITEM_TEXT_BYTES: number;
export declare const MAX_METADATA_VALUE_BYTES: number;
export interface WikiStateV1 {
    schemaVersion: 1;
    mode: WikiMode;
    workspaceId: string;
    wikiRoot: string;
    createdAt: string;
    updatedAt: string;
    contentHash: string;
    lastGitHead?: string;
    lastRun: {
        id: string;
        command: WikiCommand;
        startedAt: string;
        completedAt: string;
        changed: boolean;
        summary: string;
    };
}
export type SourceMetadataValue = string | number | boolean | null;
export interface SourceEnvelopeV1 {
    schemaVersion: 1;
    sourceId: string;
    kind: SourceKind;
    fetchedAt: string;
    cursor?: string;
    provenance: {
        host: SourceHost;
        accountHint?: string;
        query?: string;
    };
    items: Array<{
        externalId: string;
        title?: string;
        text: string;
        url?: string;
        occurredAt?: string;
        metadata?: Record<string, SourceMetadataValue>;
    }>;
}
export declare function parseWikiState(input: unknown): WikiStateV1;
export declare function parseSourceEnvelope(input: unknown): SourceEnvelopeV1;
