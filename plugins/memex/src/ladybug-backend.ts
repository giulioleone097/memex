// Additive LadybugDB Cypher layer. LadybugCypherEngine implements CypherCapable
// only — the pure-TS GraphIndexPort remains the backbone. Both the wasm and
// native adapters provide a LadybugConnection; this module contains the
// engine-agnostic query surface, the read-only guard, and the shard→DB sync.
import type { CypherCapable, CypherResult, CypherParam } from "./graph-index.js";
import type { GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";
import { MemexError } from "./errors.js";
import {
  LADYBUG_SCHEMA_DDL,
  nodeInsertCypher,
  edgeInsertCypher,
  nodeRowsParam,
  edgeRowsParam,
  isReadOnlyCypher,
} from "./ladybug-cypher.js";

/**
 * Uniform connection surface adapted from the wasm/native Ladybug APIs. `query`
 * is the privileged path (used for DDL, bulk sync, and reads); the public
 * read-only guard lives in LadybugCypherEngine.cypher, not here.
 */
export interface LadybugConnection {
  query(cypher: string, params?: Record<string, CypherParam>): Promise<CypherResult>;
  close(): Promise<void>;
}

const DEFAULT_BATCH_SIZE = 5000;

export class LadybugCypherEngine implements CypherCapable {
  constructor(private readonly connection: LadybugConnection) {}

  async cypher(query: string, params?: Record<string, CypherParam>): Promise<CypherResult> {
    if (!isReadOnlyCypher(query)) {
      throw new MemexError(
        "GRAPH_CYPHER_READONLY",
        "Only read-only Cypher (MATCH/RETURN and friends) is allowed on the derived graph database.",
      );
    }
    try {
      return await this.connection.query(query, params);
    } catch (error) {
      throw new MemexError("GRAPH_CYPHER_FAILED", (error as Error).message);
    }
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}

/**
 * Rebuilds the derived graph in Ladybug from an in-memory graph snapshot
 * (sourced from the content-addressed shards). Idempotent DDL (`IF NOT EXISTS`)
 * then batched `UNWIND` inserts. Assumes a freshly created database; callers
 * that reuse a path should drop/recreate before syncing.
 */
export async function syncGraphToLadybug(
  connection: LadybugConnection,
  graph: { nodes: readonly GraphNodeV1[]; edges: readonly GraphEdgeV1[] },
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<void> {
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
