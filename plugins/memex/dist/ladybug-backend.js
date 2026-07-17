import { MemexError } from "./errors.js";
import { LADYBUG_SCHEMA_DDL, nodeInsertCypher, edgeInsertCypher, nodeRowsParam, edgeRowsParam, isReadOnlyCypher, } from "./ladybug-cypher.js";
const DEFAULT_BATCH_SIZE = 5000;
export class LadybugCypherEngine {
    connection;
    constructor(connection) {
        this.connection = connection;
    }
    async cypher(query, params) {
        if (!isReadOnlyCypher(query)) {
            throw new MemexError("GRAPH_CYPHER_READONLY", "Only read-only Cypher (MATCH/RETURN and friends) is allowed on the derived graph database.");
        }
        try {
            return await this.connection.query(query, params);
        }
        catch (error) {
            throw new MemexError("GRAPH_CYPHER_FAILED", error.message);
        }
    }
    close() {
        return this.connection.close();
    }
}
/**
 * Rebuilds the derived graph in Ladybug from an in-memory graph snapshot
 * (sourced from the content-addressed shards). Idempotent DDL (`IF NOT EXISTS`)
 * then batched `UNWIND` inserts. Assumes a freshly created database; callers
 * that reuse a path should drop/recreate before syncing.
 */
export async function syncGraphToLadybug(connection, graph, batchSize = DEFAULT_BATCH_SIZE) {
    const size = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
    for (const ddl of LADYBUG_SCHEMA_DDL) {
        await connection.query(ddl);
    }
    const nodeCypher = nodeInsertCypher();
    for (let offset = 0; offset < graph.nodes.length; offset += size) {
        const batch = graph.nodes.slice(offset, offset + size);
        await connection.query(nodeCypher, nodeRowsParam(batch));
    }
    const edgeCypher = edgeInsertCypher();
    for (let offset = 0; offset < graph.edges.length; offset += size) {
        const batch = graph.edges.slice(offset, offset + size);
        await connection.query(edgeCypher, edgeRowsParam(batch));
    }
}
