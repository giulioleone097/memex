import { createHash } from "node:crypto";
import { OpenWikiError } from "./errors.js";
export const GRAPH_SCANNER_VERSION = "openwiki-graph-v1";
export const GRAPH_CONTRACTS_SCHEMA_VERSION = 2;
export const GRAPH_DEFAULTS = {
    defaultEntityLimit: 20,
    defaultResponseBytes: 16 * 1024,
    maxEntityLimit: 100,
    maxFiles: 50_000,
    maxFileBytes: 5 * 1024 * 1024,
    maxRepositoryBytes: 512 * 1024 * 1024,
    maxResponseBytes: 64 * 1024,
    maxTraversalDepth: 5,
};
const NODE_KINDS = new Set(["repository", "directory", "file", "module", "symbol", "concept", "page", "source"]);
const SCANNER_EDGE_KINDS = new Set(["contains", "declares", "imports", "exports", "calls", "inherits", "implements", "references"]);
const AGENT_EDGE_KINDS = new Set(["mentions", "describes", "grounds", "related"]);
const EDGE_KINDS = new Set([...SCANNER_EDGE_KINDS, ...AGENT_EDGE_KINDS, "member-of"]);
const SCANNER_CONFIDENCES = new Set(["exact", "resolved", "heuristic"]);
const AGENT_CONFIDENCES = new Set(["extracted", "inferred", "ambiguous"]);
export function isScannerEdgeKind(kind) { return SCANNER_EDGE_KINDS.has(kind); }
export function isAgentEdgeKind(kind) { return AGENT_EDGE_KINDS.has(kind); }
export function validEdgeConfidence(kind, confidence) {
    if (kind === "member-of")
        return confidence === "exact";
    if (isAgentEdgeKind(kind))
        return AGENT_CONFIDENCES.has(confidence);
    return SCANNER_CONFIDENCES.has(confidence);
}
export function isGraphNodeKind(value) {
    return typeof value === "string" && NODE_KINDS.has(value);
}
export function isGraphEdgeKind(value) {
    return typeof value === "string" && EDGE_KINDS.has(value);
}
export function isGraphConfidence(value) {
    return typeof value === "string" && (SCANNER_CONFIDENCES.has(value) || AGENT_CONFIDENCES.has(value));
}
export function createGraphNodeId(kind, path, name, symbolKind, discriminator) {
    return graphHash(["node", kind, path, name, symbolKind ?? "", discriminator ?? ""]);
}
export function createGraphEdgeId(kind, from, to, confidence) {
    return graphHash(["edge", kind, from, to, confidence]);
}
const GRAPH_HASH_SEPARATOR = String.fromCharCode(0);
export function graphHash(parts) {
    return createHash("sha256").update(parts.join(GRAPH_HASH_SEPARATOR), "utf8").digest("hex");
}
export function canonicalizeGraph(graph) {
    return {
        ...graph,
        files: [...graph.files].sort((a, b) => a.path.localeCompare(b.path)),
        nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
        diagnostics: [...graph.diagnostics].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)),
    };
}
export function parseCodeGraph(value) {
    const record = object(value, "Graph must be an object.");
    assertKeys(record, ["schemaVersion", "workspaceId", "generatedAt", "source", "files", "nodes", "edges", "diagnostics"]);
    if (record.schemaVersion !== GRAPH_CONTRACTS_SCHEMA_VERSION)
        fail("Graph schema version is unsupported.");
    const source = object(record.source, "Graph source must be an object.");
    assertKeys(source, ["gitHead", "dirtyFingerprint", "scannerVersion"], true);
    const graph = {
        schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION,
        workspaceId: string(record.workspaceId, "Graph workspaceId must be a string."),
        generatedAt: timestamp(record.generatedAt),
        source: {
            ...(source.gitHead === undefined ? {} : { gitHead: string(source.gitHead, "Graph gitHead must be a string.") }),
            dirtyFingerprint: string(source.dirtyFingerprint, "Graph dirtyFingerprint must be a string."),
            scannerVersion: string(source.scannerVersion, "Graph scannerVersion must be a string."),
        },
        files: array(record.files, "Graph files must be an array.").map(parseFile),
        nodes: array(record.nodes, "Graph nodes must be an array.").map(parseNode),
        edges: array(record.edges, "Graph edges must be an array.").map(parseEdge),
        diagnostics: array(record.diagnostics, "Graph diagnostics must be an array.").map(parseDiagnostic),
    };
    const canonical = canonicalizeGraph(graph);
    if (JSON.stringify(graph.files) !== JSON.stringify(canonical.files) || JSON.stringify(graph.nodes) !== JSON.stringify(canonical.nodes) || JSON.stringify(graph.edges) !== JSON.stringify(canonical.edges) || JSON.stringify(graph.diagnostics) !== JSON.stringify(canonical.diagnostics))
        fail("Graph arrays must be canonically sorted.");
    const ids = new Set(canonical.nodes.map((node) => node.id));
    if (ids.size !== canonical.nodes.length || new Set(canonical.edges.map((edge) => edge.id)).size !== canonical.edges.length)
        fail("Graph IDs must be unique.");
    if (canonical.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to)))
        fail("Graph edge endpoints must exist.");
    return canonical;
}
function parseFile(value) { const r = object(value, "Graph file must be an object."); assertKeys(r, ["path", "language", "contentHash", "size"]); const size = number(r.size, "Graph file size must be a non-negative integer."); if (!Number.isSafeInteger(size) || size < 0)
    fail("Graph file size must be a non-negative integer."); return { path: relativePath(r.path), language: string(r.language, "Graph file language must be a string."), contentHash: hash(r.contentHash), size }; }
function parseNode(value) {
    const r = object(value, "Graph node must be an object.");
    assertKeys(r, ["id", "kind", "path", "name", "scope", "symbolKind", "startLine", "endLine", "summary"], true);
    const kind = string(r.kind, "Graph node kind must be a string.");
    if (!NODE_KINDS.has(kind))
        fail("Graph node kind is unsupported.");
    const node = { id: string(r.id, "Graph node id must be a string."), kind, path: relativePath(r.path), name: string(r.name, "Graph node name must be a string.") };
    if (r.scope !== undefined)
        node.scope = string(r.scope, "Graph symbol scope must be a string.");
    if (r.symbolKind !== undefined)
        node.symbolKind = string(r.symbolKind, "Graph symbol kind must be a string.");
    if (r.startLine !== undefined)
        node.startLine = line(r.startLine);
    if (r.endLine !== undefined)
        node.endLine = line(r.endLine);
    if (r.summary !== undefined)
        node.summary = string(r.summary, "Graph node summary must be a string.");
    if (node.endLine !== undefined && node.startLine !== undefined && node.endLine < node.startLine)
        fail("Graph node line range is invalid.");
    const discriminator = node.startLine === undefined ? undefined : node.scope === undefined ? String(node.startLine) : `${node.scope}${GRAPH_HASH_SEPARATOR}${node.startLine.toString()}`;
    if (node.id !== createGraphNodeId(node.kind, node.path, node.name, node.symbolKind, discriminator))
        fail("Graph node ID does not match its identity fields.");
    return node;
}
function parseEdge(value) {
    const r = object(value, "Graph edge must be an object.");
    assertKeys(r, ["id", "kind", "from", "to", "confidence"]);
    const kind = string(r.kind, "Graph edge kind must be a string.");
    const confidence = string(r.confidence, "Graph edge confidence must be a string.");
    if (!EDGE_KINDS.has(kind) || !validEdgeConfidence(kind, confidence))
        fail("Graph edge type is unsupported.");
    const edge = { id: string(r.id, "Graph edge id must be a string."), kind, from: string(r.from, "Graph edge from must be a string."), to: string(r.to, "Graph edge to must be a string."), confidence };
    if (edge.id !== createGraphEdgeId(edge.kind, edge.from, edge.to, edge.confidence))
        fail("Graph edge ID does not match its identity fields.");
    return edge;
}
function parseDiagnostic(value) { const r = object(value, "Graph diagnostic must be an object."); assertKeys(r, ["path", "code", "message"]); return { path: relativePath(r.path), code: string(r.code, "Graph diagnostic code must be a string."), message: string(r.message, "Graph diagnostic message must be a string.") }; }
function object(value, message) { if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(message); return value; }
function array(value, message) { if (!Array.isArray(value))
    fail(message); return value; }
function string(value, message) { if (typeof value !== "string" || value.length === 0)
    fail(message); return value; }
function number(value, message) { if (typeof value !== "number")
    fail(message); return value; }
function timestamp(value) { const text = string(value, "Graph generatedAt must be an ISO timestamp."); if (Number.isNaN(Date.parse(text)))
    fail("Graph generatedAt must be an ISO timestamp."); return text; }
function hash(value) { const text = string(value, "Graph contentHash must be a SHA-256 hash."); if (!/^[a-f0-9]{64}$/iu.test(text))
    fail("Graph contentHash must be a SHA-256 hash."); return text.toLowerCase(); }
function relativePath(value) { const text = string(value, "Graph path must be a non-empty relative path."); if (text !== "." && (text.startsWith("/") || text.includes("\\") || text.split("/").some((part) => part === "" || part === "." || part === "..")))
    fail("Graph path must be repository-relative."); return text; }
function line(value) { const result = number(value, "Graph line must be a positive integer."); if (!Number.isSafeInteger(result) || result < 1)
    fail("Graph line must be a positive integer."); return result; }
function assertKeys(record, keys, optional = false) { for (const key of Object.keys(record))
    if (!keys.includes(key))
        fail("Graph contains an unknown field."); if (!optional)
    for (const key of keys)
        if (!(key in record))
            fail("Graph is missing a required field."); }
function fail(message) { throw new OpenWikiError("INVALID_STATE", message); }
export function mergeEnrichment(graph, shards) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
    const diagnostics = [...graph.diagnostics];
    const ordered = [...shards].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.sourceContentHash.localeCompare(right.sourceContentHash));
    for (const shard of ordered)
        for (const node of shard.nodes)
            nodes.set(node.id, node);
    for (const shard of ordered) {
        for (const edge of shard.edges) {
            if (nodes.has(edge.from) && nodes.has(edge.to))
                edges.set(edge.id, edge);
            else
                diagnostics.push({ path: shard.sourcePath, code: "DANGLING_NODE_REF", message: `Enrichment edge ${edge.id} references a node that does not exist.` });
        }
    }
    return canonicalizeGraph({ ...graph, nodes: [...nodes.values()], edges: [...edges.values()], diagnostics });
}
export function parseEnrichmentShard(value) {
    const r = object(value, "Enrichment shard must be an object.");
    assertKeys(r, ["sourcePath", "sourceContentHash", "nodes", "edges", "enrichedAt"]);
    return {
        sourcePath: relativePath(r.sourcePath),
        sourceContentHash: hash(r.sourceContentHash),
        nodes: array(r.nodes, "Enrichment shard nodes must be an array.").map(parseNode),
        edges: array(r.edges, "Enrichment shard edges must be an array.").map(parseEdge),
        enrichedAt: timestamp(r.enrichedAt),
    };
}
