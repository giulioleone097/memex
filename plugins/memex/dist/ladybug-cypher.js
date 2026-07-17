/** Schema mirroring the CodeGraphV1 node/edge model (see design §5). */
export const LADYBUG_SCHEMA_DDL = [
    "CREATE NODE TABLE IF NOT EXISTS Node("
        + "id STRING PRIMARY KEY, kind STRING, path STRING, name STRING, "
        + "scope STRING, symbolKind STRING, startLine INT64, endLine INT64, summary STRING)",
    "CREATE REL TABLE IF NOT EXISTS Edge(FROM Node TO Node, id STRING, kind STRING, confidence STRING)",
];
const NODE_RETURN = "n.id AS id, n.kind AS kind, n.path AS path, n.name AS name, n.scope AS scope, "
    + "n.symbolKind AS symbolKind, n.startLine AS startLine, n.endLine AS endLine, n.summary AS summary";
export const NODE_BY_ID_CYPHER = `MATCH (n:Node {id: $id}) RETURN ${NODE_RETURN}`;
export function adjacencyCypher(direction) {
    const pattern = direction === "outbound"
        ? "(n:Node {id: $id})-[e:Edge]->(m:Node)"
        : "(m:Node)-[e:Edge]->(n:Node {id: $id})";
    return `MATCH ${pattern} RETURN e.id AS edgeId, e.kind AS kind, e.confidence AS confidence, m.id AS otherId LIMIT $limit`;
}
export function allNodesCypher(withKind) {
    const where = withKind ? " WHERE n.kind = $kind" : "";
    return `MATCH (n:Node)${where} RETURN ${NODE_RETURN}`;
}
export const ALL_EDGES_CYPHER = "MATCH (a:Node)-[e:Edge]->(b:Node) RETURN e.id AS id, e.kind AS kind, e.confidence AS confidence, a.id AS `from`, b.id AS `to`";
export function nodeInsertCypher() {
    return "UNWIND $rows AS r CREATE (n:Node {"
        + "id: r.id, kind: r.kind, path: r.path, name: r.name, scope: r.scope, "
        + "symbolKind: r.symbolKind, startLine: r.startLine, endLine: r.endLine, summary: r.summary})";
}
export function edgeInsertCypher() {
    return "UNWIND $rows AS r MATCH (a:Node {id: r.from}), (b:Node {id: r.to}) "
        + "CREATE (a)-[:Edge {id: r.id, kind: r.kind, confidence: r.confidence}]->(b)";
}
const asString = (value) => {
    if (typeof value === "string")
        return value;
    if (value === undefined || value === null)
        return "";
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
        return String(value);
    // Ladybug can return values as boxed primitive wrappers; unwrap before stringifying.
    const primitive = value.valueOf();
    if (typeof primitive === "string")
        return primitive;
    if (typeof primitive === "number" || typeof primitive === "bigint" || typeof primitive === "boolean")
        return String(primitive);
    return "";
};
const asInt = (value) => {
    if (value === undefined || value === null)
        return 0;
    const n = Number(value); // handles boxed Number and bigint-ish values Ladybug returns for INT64
    return Number.isFinite(n) ? Math.trunc(n) : 0;
};
export function nodeRowsParam(nodes) {
    return {
        rows: nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            path: asString(node.path),
            name: asString(node.name),
            scope: asString(node.scope),
            symbolKind: asString(node.symbolKind),
            startLine: asInt(node.startLine),
            endLine: asInt(node.endLine),
            summary: asString(node.summary),
        })),
    };
}
export function edgeRowsParam(edges) {
    return {
        rows: edges.map((edge) => ({
            id: edge.id,
            from: edge.from,
            to: edge.to,
            kind: edge.kind,
            confidence: edge.confidence,
        })),
    };
}
export function rowToNode(row) {
    const node = {
        id: String(row.id),
        kind: String(row.kind),
        path: asString(row.path),
        name: asString(row.name),
    };
    const scope = asString(row.scope);
    if (scope)
        node.scope = scope;
    const symbolKind = asString(row.symbolKind);
    if (symbolKind)
        node.symbolKind = symbolKind;
    const startLine = asInt(row.startLine);
    if (startLine)
        node.startLine = startLine;
    const endLine = asInt(row.endLine);
    if (endLine)
        node.endLine = endLine;
    const summary = asString(row.summary);
    if (summary)
        node.summary = summary;
    return node;
}
export function rowToEdge(row) {
    return {
        id: String(row.id),
        kind: String(row.kind),
        from: String(row.from),
        to: String(row.to),
        confidence: String(row.confidence),
    };
}
const MUTATION = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|COPY|ALTER|INSTALL|LOAD|ATTACH|DETACH|EXPORT|IMPORT|CALL)\b/i;
/**
 * Conservative read-only guard for the public `cypher()` surface. Strips
 * comments, string literals, `AS <alias>` clauses, and `.property` accessors
 * (so a read query with an alias/property named like a keyword is not falsely
 * rejected), then rejects any remaining mutation/side-effecting keyword.
 */
export function isReadOnlyCypher(query) {
    const stripped = query
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ")
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/\bAS\s+`?[A-Za-z_][A-Za-z0-9_]*`?/gi, " ")
        .replace(/\.`?[A-Za-z_][A-Za-z0-9_]*`?/g, " ");
    return !MUTATION.test(stripped);
}
