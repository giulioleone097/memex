import type { CodeGraphV1, GraphEdgeV1, GraphNodeV1 } from "./graph-contracts.js";
import { GRAPH_DEFAULTS } from "./graph-contracts.js";
import { MemexError } from "./errors.js";

export interface GraphResult { nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; truncated: boolean; unresolvedEdgeCount: number; }
export interface QueryGraphOptions { query: string; limit?: number; responseByteLimit?: number; }
export interface ImpactResult extends GraphResult { paths: Array<{ nodeId: string; depth: number; via?: string }>; }

export function queryGraph(graph: CodeGraphV1, options: QueryGraphOptions): GraphResult {
  const query = options.query.trim(); if (query.length === 0) throw new MemexError("INVALID_ARGUMENT", "Graph query must not be empty.");
  const tokens = query.toLocaleLowerCase().split(/[^\p{L}\p{N}_$./-]+/u).filter(Boolean);
  const degree = degrees(graph);
  const matching = graph.nodes.map((node) => ({ node, score: score(node, query.toLocaleLowerCase(), tokens, degree.get(node.id) ?? 0) })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id)).map((candidate) => candidate.node);
  return bounded(graph, matching, entityLimit(options.limit), responseLimit(options.responseByteLimit));
}

export function contextGraph(graph: CodeGraphV1, target: string, limit?: number, responseByteLimit?: number): GraphResult {
  const roots = matchTargets(graph, target); if (roots.length === 0) throw new MemexError("NOT_FOUND", "Graph target was not found.");
  const ids = new Set(roots.map((node) => node.id)); for (const edge of graph.edges) if (ids.has(edge.from) || ids.has(edge.to)) { ids.add(edge.from); ids.add(edge.to); }
  return bounded(graph, graph.nodes.filter((node) => ids.has(node.id)), entityLimit(limit), responseLimit(responseByteLimit));
}

export function impactGraph(graph: CodeGraphV1, target: string, direction: "inbound" | "outbound" | "both", depth?: number, limit?: number, responseByteLimit?: number): ImpactResult {
  const roots = matchTargets(graph, target); if (roots.length === 0) throw new MemexError("NOT_FOUND", "Graph target was not found.");
  const maxDepth = traversalDepth(depth); const adjacency = adjacencyFor(graph, direction); const visited = new Set(roots.map((node) => node.id)); const paths: ImpactResult["paths"] = roots.map((node) => ({ nodeId: node.id, depth: 0 })); let frontier = [...visited].sort(); let depthTruncated = false;
  for (let currentDepth = 1; currentDepth <= maxDepth && frontier.length > 0; currentDepth += 1) { const next = new Set<string>(); for (const id of frontier) for (const edge of adjacency.get(id) ?? []) if (!visited.has(edge.nodeId)) { visited.add(edge.nodeId); next.add(edge.nodeId); paths.push({ nodeId: edge.nodeId, depth: currentDepth, via: edge.edgeId }); } frontier = [...next].sort(); if (currentDepth === maxDepth && frontier.length > 0) depthTruncated = true; }
  const result = bounded(graph, graph.nodes.filter((node) => visited.has(node.id)), entityLimit(limit), responseLimit(responseByteLimit));
  const nodeIds = new Set(result.nodes.map((node) => node.id));
  return { ...result, truncated: result.truncated || depthTruncated, paths: paths.filter((entry) => nodeIds.has(entry.nodeId)).sort((left, right) => left.depth - right.depth || left.nodeId.localeCompare(right.nodeId)) };
}

export function matchTargets(graph: CodeGraphV1, target: string): GraphNodeV1[] { const needle = target.toLocaleLowerCase(); return graph.nodes.filter((node) => node.id === target || node.path === target || node.name.toLocaleLowerCase() === needle || `${node.scope ?? ""}.${node.name}`.toLocaleLowerCase() === needle).sort((left, right) => left.id.localeCompare(right.id)); }
export function entityLimit(value: number | undefined): number { const result = value ?? GRAPH_DEFAULTS.defaultEntityLimit; if (!Number.isSafeInteger(result) || result < 1 || result > GRAPH_DEFAULTS.maxEntityLimit) throw new MemexError("INVALID_ARGUMENT", "Graph entity limit must be between 1 and 100."); return result; }
export function responseLimit(value: number | undefined): number { const result = value ?? GRAPH_DEFAULTS.defaultResponseBytes; if (!Number.isSafeInteger(result) || result < 256 || result > GRAPH_DEFAULTS.maxResponseBytes) throw new MemexError("INVALID_ARGUMENT", "Graph response limit must be between 256 and 65536."); return result; }

function bounded(graph: CodeGraphV1, candidates: readonly GraphNodeV1[], limit: number, byteLimit: number): GraphResult { let nodes = [...candidates].sort((left, right) => left.id.localeCompare(right.id)); let truncated = nodes.length > limit; nodes = nodes.slice(0, limit); let edges = containedEdges(graph, nodes); while (nodes.length > 0 && byteLength({ nodes, edges, truncated, unresolvedEdgeCount: 0 }) > byteLimit) { nodes = nodes.slice(0, -1); edges = containedEdges(graph, nodes); truncated = true; } return { nodes, edges, truncated, unresolvedEdgeCount: graph.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("UNRESOLVED") || diagnostic.code.startsWith("AMBIGUOUS")).length }; }
function containedEdges(graph: CodeGraphV1, nodes: readonly GraphNodeV1[]): GraphEdgeV1[] { const ids = new Set(nodes.map((node) => node.id)); return graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).sort((left, right) => left.id.localeCompare(right.id)); }
function traversalDepth(value: number | undefined): number { const result = value ?? GRAPH_DEFAULTS.maxTraversalDepth; if (!Number.isSafeInteger(result) || result < 1 || result > GRAPH_DEFAULTS.maxTraversalDepth) throw new MemexError("INVALID_ARGUMENT", "Graph traversal depth must be between 1 and 5."); return result; }
function score(node: GraphNodeV1, query: string, tokens: readonly string[], degree: number): number { const name = node.name.toLocaleLowerCase(); const path = node.path.toLocaleLowerCase(); const qualified = `${node.scope ?? ""}.${name}`.replace(/^\./u, ""); let value = 0; if (name === query || path === query) value += 1000; if (qualified === query) value += 900; if (qualified.startsWith(query)) value += 500; for (const token of tokens) if (name.includes(token) || path.includes(token) || qualified.includes(token)) value += 100; else return 0; return value + Math.min(degree, 50); }
function degrees(graph: CodeGraphV1): Map<string, number> { const result = new Map<string, number>(); for (const edge of graph.edges) { result.set(edge.from, (result.get(edge.from) ?? 0) + 1); result.set(edge.to, (result.get(edge.to) ?? 0) + 1); } return result; }
function adjacencyFor(graph: CodeGraphV1, direction: "inbound" | "outbound" | "both"): Map<string, Array<{ nodeId: string; edgeId: string }>> { const result = new Map<string, Array<{ nodeId: string; edgeId: string }>>(); const add = (from: string, nodeId: string, edgeId: string): void => { const entries = result.get(from) ?? []; entries.push({ nodeId, edgeId }); result.set(from, entries); }; for (const edge of graph.edges) { if (direction !== "outbound") add(edge.to, edge.from, edge.id); if (direction !== "inbound") add(edge.from, edge.to, edge.id); } for (const entries of result.values()) entries.sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.edgeId.localeCompare(right.edgeId)); return result; }
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
