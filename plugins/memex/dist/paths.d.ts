import type { WikiMode } from "./contracts.js";
export interface ResolveWikiLocationOptions {
    mode: WikiMode;
    root?: string;
    homeDir?: string;
}
export interface WikiLocation {
    mode: WikiMode;
    workspaceId: string;
    workspaceRoot?: string;
    wikiRoot: string;
    statePath: string;
    dataRoot: string;
}
export declare function legacyStorageRoot(homeDir: string): string;
export declare function hostHomeDir(): string;
export declare function resolveWikiLocation(options: ResolveWikiLocationOptions): Promise<WikiLocation>;
export declare function resolveConfinedMarkdownPath(location: WikiLocation, page: string): Promise<string>;
