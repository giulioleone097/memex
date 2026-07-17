import { type LadybugConnection } from "./ladybug-backend.js";
import type { CypherTierResolution } from "./graph-index.js";
import type { GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";
export interface OpenWasmOptions {
    vendorRoot?: string;
    /** ":memory:" (default) or an on-disk path for a persistent database. */
    databasePath?: string;
}
/**
 * Opens a LadybugConnection backed by the vendored wasm engine. Throws a
 * MemexError if the assets are missing/corrupt or the module cannot load — the
 * tier resolver catches this and degrades to pure with the message as the reason.
 * The returned connection's close() releases only the connection; call
 * shutdownLadybugWasm() once at process teardown to terminate the worker thread.
 */
export declare function openLadybugWasmConnection(options?: OpenWasmOptions): Promise<LadybugConnection>;
/**
 * Builds the wasm Cypher tier: opens a connection, syncs the graph snapshot into
 * it, and returns the CypherCapable engine. Throws on failure (the resolver
 * catches and degrades to pure). `close()` releases the connection only; call
 * shutdownLadybugWasm() at process teardown.
 */
export declare function openWasmTier(graph: {
    nodes: readonly GraphNodeV1[];
    edges: readonly GraphEdgeV1[];
}, databasePath?: string): Promise<CypherTierResolution>;
/** Terminates the wasm module's worker thread. Idempotent; safe if never opened. */
export declare function shutdownLadybugWasm(): Promise<void>;
