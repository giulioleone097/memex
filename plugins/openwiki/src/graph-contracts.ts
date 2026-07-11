import { createHash } from "node:crypto";

import { OpenWikiError } from "./errors.js";

export const GRAPH_SCANNER_VERSION = "openwiki-graph-v1";
export const GRAPH_DEFAULTS = {
  defaultEntityLimit: 20,
  defaultResponseBytes: 16 * 1024,
  maxEntityLimit: 100,
  maxFiles: 50_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxRepositoryBytes: 512 * 1024 * 1024,
  maxResponseBytes: 64 * 1024,
  maxTraversalDepth: 5,
} as const;

export type GraphNodeKind = "repository" | "directory" | "file" | "module" | "symbol";
export type GraphEdgeKind = "contains" | "declares" | "imports" | "exports" | "calls" | "inherits" | "implements" | "references";
export type GraphConfidence = "exact" | "resolved" | "heuristic";

export interface GraphFileV1 { path: string; language: string; contentHash: string; size: number; }
export interface GraphNodeV1 { id: string; kind: GraphNodeKind; path: string; name: string; symbolKind?: string; startLine?: number; endLine?: number; }
export interface GraphEdgeV1 { id: string; kind: GraphEdgeKind; from: string; to: string; confidence: GraphConfidence; }
export interface GraphDiagnosticV1 { path: string; code: string; message: string; }
export interface CodeGraphV1 {
  schemaVersion: 1; workspaceId: string; generatedAt: string;
  source: { gitHead?: string; dirtyFingerprint: string; scannerVersion: string };
  files: GraphFileV1[]; nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; diagnostics: GraphDiagnosticV1[];
}

export interface GraphLimits { maxFiles?: number; maxFileBytes?: number; maxRepositoryBytes?: number; }
export interface GraphQueryLimits { limit?: number; responseByteLimit?: number; depth?: number; }

const NODE_KINDS = new Set<GraphNodeKind>(["repository", "directory", "file", "module", "symbol"]);
const EDGE_KINDS = new Set<GraphEdgeKind>(["contains", "declares", "imports", "exports", "calls", "inherits", "implements", "references"]);
const CONFIDENCES = new Set<GraphConfidence>(["exact", "resolved", "heuristic"]);

export function createGraphNodeId(kind: GraphNodeKind, path: string, name: string, symbolKind?: string, discriminator?: string): string {
  return graphHash(["node", kind, path, name, symbolKind ?? "", discriminator ?? ""]);
}

export function createGraphEdgeId(kind: GraphEdgeKind, from: string, to: string, confidence: GraphConfidence): string {
  return graphHash(["edge", kind, from, to, confidence]);
}

export function graphHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

export function canonicalizeGraph(graph: CodeGraphV1): CodeGraphV1 {
  return {
    ...graph,
    files: [...graph.files].sort((a, b) => a.path.localeCompare(b.path)),
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [...graph.diagnostics].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)),
  };
}

export function parseCodeGraph(value: unknown): CodeGraphV1 {
  const record = object(value, "Graph must be an object.");
  assertKeys(record, ["schemaVersion", "workspaceId", "generatedAt", "source", "files", "nodes", "edges", "diagnostics"]);
  if (record.schemaVersion !== 1) fail("Graph schema version is unsupported.");
  const source = object(record.source, "Graph source must be an object.");
  assertKeys(source, ["gitHead", "dirtyFingerprint", "scannerVersion"], true);
  const graph: CodeGraphV1 = {
    schemaVersion: 1,
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
  if (JSON.stringify(graph.files) !== JSON.stringify(canonical.files) || JSON.stringify(graph.nodes) !== JSON.stringify(canonical.nodes) || JSON.stringify(graph.edges) !== JSON.stringify(canonical.edges) || JSON.stringify(graph.diagnostics) !== JSON.stringify(canonical.diagnostics)) fail("Graph arrays must be canonically sorted.");
  const ids = new Set(canonical.nodes.map((node) => node.id));
  if (ids.size !== canonical.nodes.length || new Set(canonical.edges.map((edge) => edge.id)).size !== canonical.edges.length) fail("Graph IDs must be unique.");
  if (canonical.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) fail("Graph edge endpoints must exist.");
  return canonical;
}

function parseFile(value: unknown): GraphFileV1 { const r = object(value, "Graph file must be an object."); assertKeys(r, ["path", "language", "contentHash", "size"]); const size = number(r.size, "Graph file size must be a non-negative integer."); if (!Number.isSafeInteger(size) || size < 0) fail("Graph file size must be a non-negative integer."); return { path: relativePath(r.path), language: string(r.language, "Graph file language must be a string."), contentHash: hash(r.contentHash), size }; }
function parseNode(value: unknown): GraphNodeV1 { const r = object(value, "Graph node must be an object."); assertKeys(r, ["id", "kind", "path", "name", "symbolKind", "startLine", "endLine"], true); const kind = string(r.kind, "Graph node kind must be a string.") as GraphNodeKind; if (!NODE_KINDS.has(kind)) fail("Graph node kind is unsupported."); const node: GraphNodeV1 = { id: string(r.id, "Graph node id must be a string."), kind, path: relativePath(r.path), name: string(r.name, "Graph node name must be a string.") }; if (r.symbolKind !== undefined) node.symbolKind = string(r.symbolKind, "Graph symbol kind must be a string."); if (r.startLine !== undefined) node.startLine = line(r.startLine); if (r.endLine !== undefined) node.endLine = line(r.endLine); if (node.endLine !== undefined && node.startLine !== undefined && node.endLine < node.startLine) fail("Graph node line range is invalid."); if (node.id !== createGraphNodeId(node.kind, node.path, node.name, node.symbolKind, node.startLine === undefined ? undefined : String(node.startLine))) fail("Graph node ID does not match its identity fields."); return node; }
function parseEdge(value: unknown): GraphEdgeV1 { const r = object(value, "Graph edge must be an object."); assertKeys(r, ["id", "kind", "from", "to", "confidence"]); const kind = string(r.kind, "Graph edge kind must be a string.") as GraphEdgeKind; const confidence = string(r.confidence, "Graph edge confidence must be a string.") as GraphConfidence; if (!EDGE_KINDS.has(kind) || !CONFIDENCES.has(confidence)) fail("Graph edge type is unsupported."); const edge = { id: string(r.id, "Graph edge id must be a string."), kind, from: string(r.from, "Graph edge from must be a string."), to: string(r.to, "Graph edge to must be a string."), confidence }; if (edge.id !== createGraphEdgeId(edge.kind, edge.from, edge.to, edge.confidence)) fail("Graph edge ID does not match its identity fields."); return edge; }
function parseDiagnostic(value: unknown): GraphDiagnosticV1 { const r = object(value, "Graph diagnostic must be an object."); assertKeys(r, ["path", "code", "message"]); return { path: relativePath(r.path), code: string(r.code, "Graph diagnostic code must be a string."), message: string(r.message, "Graph diagnostic message must be a string.") }; }
function object(value: unknown, message: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(message); return value as Record<string, unknown>; }
function array(value: unknown, message: string): unknown[] { if (!Array.isArray(value)) fail(message); return value; }
function string(value: unknown, message: string): string { if (typeof value !== "string" || value.length === 0) fail(message); return value; }
function number(value: unknown, message: string): number { if (typeof value !== "number") fail(message); return value; }
function timestamp(value: unknown): string { const text = string(value, "Graph generatedAt must be an ISO timestamp."); if (Number.isNaN(Date.parse(text))) fail("Graph generatedAt must be an ISO timestamp."); return text; }
function hash(value: unknown): string { const text = string(value, "Graph contentHash must be a SHA-256 hash."); if (!/^[a-f0-9]{64}$/iu.test(text)) fail("Graph contentHash must be a SHA-256 hash."); return text.toLowerCase(); }
function relativePath(value: unknown): string { const text = string(value, "Graph path must be a non-empty relative path."); if (text !== "." && (text.startsWith("/") || text.includes("\\") || text.split("/").some((part) => part === "" || part === "." || part === ".."))) fail("Graph path must be repository-relative."); return text; }
function line(value: unknown): number { const result = number(value, "Graph line must be a positive integer."); if (!Number.isSafeInteger(result) || result < 1) fail("Graph line must be a positive integer."); return result; }
function assertKeys(record: Record<string, unknown>, keys: readonly string[], optional = false): void { for (const key of Object.keys(record)) if (!keys.includes(key)) fail("Graph contains an unknown field."); if (!optional) for (const key of keys) if (!(key in record)) fail("Graph is missing a required field."); }
function fail(message: string): never { throw new OpenWikiError("INVALID_STATE", message); }
