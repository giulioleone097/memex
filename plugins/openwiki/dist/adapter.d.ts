import { type OpenWikiJsonFailure, type OpenWikiJsonResult } from "./errors.js";
export declare const OPENWIKI_OPERATIONS: readonly ["init", "status", "context", "search", "ask", "read", "write", "ingest", "enrich", "finalize", "check", "doctor", "schedule", "purge", "graph"];
export type OpenWikiOperation = (typeof OPENWIKI_OPERATIONS)[number];
export interface DispatchRequest {
    operation: OpenWikiOperation;
    input: unknown;
}
export declare function dispatch(request: DispatchRequest): Promise<OpenWikiJsonResult<unknown>>;
export declare function toEnvelope(error: unknown): OpenWikiJsonFailure;
export declare function readCliTransport(filePath: string): Promise<string>;
