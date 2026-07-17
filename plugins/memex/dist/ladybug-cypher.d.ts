import type { GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";
import type { CypherScalar } from "./graph-index.js";
/** Schema mirroring the CodeGraphV1 node/edge model (see design §5). */
export declare const LADYBUG_SCHEMA_DDL: readonly string[];
export declare const NODE_BY_ID_CYPHER = "MATCH (n:Node {id: $id}) RETURN n.id AS id, n.kind AS kind, n.path AS path, n.name AS name, n.scope AS scope, n.symbolKind AS symbolKind, n.startLine AS startLine, n.endLine AS endLine, n.summary AS summary";
export declare function adjacencyCypher(direction: "inbound" | "outbound"): string;
export declare function allNodesCypher(withKind: boolean): string;
export declare const ALL_EDGES_CYPHER = "MATCH (a:Node)-[e:Edge]->(b:Node) RETURN e.id AS id, e.kind AS kind, e.confidence AS confidence, a.id AS `from`, b.id AS `to`";
export declare function nodeInsertCypher(): string;
export declare function edgeInsertCypher(): string;
export declare function nodeRowsParam(nodes: readonly GraphNodeV1[]): {
    rows: Record<string, CypherScalar>[];
};
export declare function edgeRowsParam(edges: readonly GraphEdgeV1[]): {
    rows: Record<string, CypherScalar>[];
};
export declare function rowToNode(row: Record<string, unknown>): GraphNodeV1;
export declare function rowToEdge(row: Record<string, unknown>): GraphEdgeV1;
/**
 * Conservative read-only guard for the public `cypher()` surface. Strips
 * comments, string literals, `AS <alias>` clauses, and `.property` accessors
 * (so a read query with an alias/property named like a keyword is not falsely
 * rejected), then rejects any remaining mutation/side-effecting keyword.
 */
export declare function isReadOnlyCypher(query: string): boolean;
