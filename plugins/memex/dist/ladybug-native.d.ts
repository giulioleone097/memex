import { type LadybugConnection } from "./ladybug-backend.js";
import type { CypherTierResolution } from "./graph-index.js";
import type { GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";
export interface OpenNativeOptions {
    /** ":memory:" (default) or an on-disk path. */
    databasePath?: string;
}
/**
 * Opens a native LadybugConnection, or returns null when `@ladybugdb/core` is
 * not installed / has no prebuilt binary for this platform (the expected,
 * non-exceptional case for the opt-in tier).
 */
export declare function openLadybugNativeConnection(options?: OpenNativeOptions): LadybugConnection | null;
/**
 * Builds the native Cypher tier by opening a native connection and syncing the
 * graph snapshot. Returns null when the native dependency is absent (resolver
 * degrades to wasm); throws only on an unexpected sync/engine failure.
 */
export declare function openNativeTier(graph: {
    nodes: readonly GraphNodeV1[];
    edges: readonly GraphEdgeV1[];
}, databasePath?: string): Promise<CypherTierResolution | null>;
