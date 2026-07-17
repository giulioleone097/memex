import type { CypherCapable, CypherResult, CypherParam } from "./graph-index.js";
import type { GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";
/**
 * Uniform connection surface adapted from the wasm/native Ladybug APIs. `query`
 * is the privileged path (used for DDL, bulk sync, and reads); the public
 * read-only guard lives in LadybugCypherEngine.cypher, not here.
 */
export interface LadybugConnection {
    query(cypher: string, params?: Record<string, CypherParam>, maxRows?: number): Promise<CypherResult>;
    close(): Promise<void>;
}
export declare class LadybugCypherEngine implements CypherCapable {
    private readonly connection;
    constructor(connection: LadybugConnection);
    cypher(query: string, params?: Record<string, CypherParam>, maxRows?: number): Promise<CypherResult>;
    close(): Promise<void>;
}
/**
 * Rebuilds the derived graph in Ladybug from an in-memory graph snapshot
 * (sourced from the content-addressed shards). Idempotent DDL (`IF NOT EXISTS`)
 * then batched `UNWIND` inserts. Assumes a freshly created database; callers
 * that reuse a path should drop/recreate before syncing.
 */
export declare function syncGraphToLadybug(connection: LadybugConnection, graph: {
    nodes: readonly GraphNodeV1[];
    edges: readonly GraphEdgeV1[];
}, batchSize?: number): Promise<void>;
