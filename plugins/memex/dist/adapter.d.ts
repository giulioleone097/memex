import { type MemexJsonFailure, type MemexJsonResult } from "./errors.js";
export declare const MEMEX_OPERATIONS: readonly ["init", "status", "context", "search", "retrieval_health", "ask", "read", "write", "ingest", "enrich", "finalize", "check", "doctor", "schedule", "purge", "graph", "migrate"];
export type MemexOperation = (typeof MEMEX_OPERATIONS)[number];
export type GraphAction = "build" | "status" | "query" | "context" | "impact" | "changes" | "map" | "path" | "explain" | "communities" | "report" | "cypher";
export declare const GRAPH_ACTIONS: readonly GraphAction[];
export interface DispatchRequest {
    operation: MemexOperation;
    input: unknown;
}
export declare function dispatch(request: DispatchRequest): Promise<MemexJsonResult<unknown>>;
export declare function toEnvelope(error: unknown): MemexJsonFailure;
export declare function readCliTransport(filePath: string): Promise<string>;
