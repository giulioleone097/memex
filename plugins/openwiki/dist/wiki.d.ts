import type { WikiCommand, WikiStateV1 } from "./contracts.js";
import type { GraphIndexPort } from "./graph-index.js";
import { type ResolveWikiLocationOptions, type WikiLocation } from "./paths.js";
export declare const REQUIRED_WIKI_PAGES: readonly ["quickstart.md", "architecture.md", "source-map.md", "workflows.md", "domain-concepts.md", "operations.md", "integrations.md", "testing.md"];
export interface InitializeWikiOptions extends ResolveWikiLocationOptions {
    templatesRoot?: string;
    now?: string;
    runId?: string;
}
export interface InitializeWikiResult {
    changed: boolean;
    createdPages: string[];
    location: WikiLocation;
    state: WikiStateV1;
}
export interface PageReadResult {
    page: string;
    content: string;
    lineCount: number;
}
export interface SearchResult {
    page: string;
    line: number;
    excerpt: string;
    score: number;
}
export interface FinalizeRunOptions {
    location: WikiLocation;
    command: WikiCommand;
    runId: string;
    startedAt: string;
    completedAt?: string;
    summary: string;
    lastGitHead?: string;
}
export interface FinalizeRunResult {
    changed: boolean;
    state: WikiStateV1;
}
export interface WikiCheckIssue {
    code: "BROKEN_LINK" | "DANGLING_NODE_REF" | "INVALID_STATE" | "MISSING_PAGE" | "MISSING_PAGE_EDGE" | "MISSING_PAGE_NODE" | "STALE_STATE" | "SYMLINK";
    message: string;
    page?: string;
}
export interface WikiCheckResult {
    ok: boolean;
    issues: WikiCheckIssue[];
}
export interface WikiCheckOptions {
    graph?: GraphIndexPort;
}
export declare function initializeWiki(options: InitializeWikiOptions): Promise<InitializeWikiResult>;
export declare function readPage(location: WikiLocation, page: string): Promise<PageReadResult>;
export declare function writePage(location: WikiLocation, page: string, content: string): Promise<void>;
export declare function searchWiki(location: WikiLocation, query: unknown, limit?: number): Promise<SearchResult[]>;
export declare function finalizeRun(options: FinalizeRunOptions): Promise<FinalizeRunResult>;
export declare function checkWiki(location: WikiLocation, options?: WikiCheckOptions): Promise<WikiCheckResult>;
export declare function createWikiContentHash(location: WikiLocation): Promise<string>;
