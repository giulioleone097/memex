import type { CodeGraphV1, GraphEdgeV1, GraphNodeV1 } from "./graph-contracts.js";
import { GRAPH_DEFAULTS } from "./graph-contracts.js";
import { OpenWikiError } from "./errors.js";

export interface GraphResult { nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; truncated: boolean; unresolvedEdgeCount: number; }
export interface QueryGraphOptions { query: string; limit?: number; responseByteLimit?: number; }
export interface ImpactResult extends GraphResult { paths: Array<{ nodeId: string; depth: number; via?: string }>; }

export function queryGraph(graph: CodeGraphV1, options: QueryGraphOptions): GraphResult {
  if (options.query.trim().length === 0) throw new OpenWikiError("INVALID_ARGUMENT", "Graph query must not be empty.");
  const limit = entityLimit(options.limit); const byteLimit = responseLimit(options.responseByteLimit);
  const needle = options.query.toLocaleLowerCase();
  const matching = graph.nodes.filter((node) => [node.name, node.path, node.symbolKind ?? ""].some((value) => value.toLocaleLowerCase().includes(needle)));
  return bounded(graph, matching, limit, byteLimit);
}

export function contextGraph(graph: CodeGraphV1, target: string, limit?: number, responseByteLimit?: number): GraphResult {
  const roots = matchTargets(graph, target); if (roots.length === 0) throw new OpenWikiError("NOT_FOUND", "Graph target was not found.");
  const ids = new Set(roots.map((node) => node.id));
  for (const edge of graph.edges) if (ids.has(edge.from) || ids.has(edge.to)) { ids.add(edge.from); ids.add(edge.to); }
  return bounded(graph, graph.nodes.filter((node) => ids.has(node.id)), entityLimit(limit), responseLimit(responseByteLimit));
}

export function impactGraph(graph: CodeGraphV1, target: string, direction: "inbound" | "outbound" | "both", depth?: number, limit?: number, responseByteLimit?: number): ImpactResult {
  const roots = matchTargets(graph, target); if (roots.length === 0) throw new OpenWikiError("NOT_FOUND", "Graph target was not found.");
  const maxDepth = depth ?? GRAPH_DEFAULTS.maxTraversalDepth; if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > GRAPH_DEFAULTS.maxTraversalDepth) throw new OpenWikiError("INVALID_ARGUMENT", "Graph traversal depth must be between 1 and 5.");
  const visited = new Set(roots.map((node) => node.id)); const paths: Array<{ nodeId: string; depth: number; via?: string }> = roots.map((node) => ({ nodeId: node.id, depth: 0 })); let frontier = [...visited]; let truncated = false;
  for (let currentDepth = 1; currentDepth <= maxDepth && frontier.length > 0; currentDepth += 1) { const next: string[] = []; for (const id of frontier) for (const edge of graph.edges) { const candidate = direction === "inbound" ? (edge.to === id ? edge.from : undefined) : direction === "outbound" ? (edge.from === id ? edge.to : undefined) : edge.from === id ? edge.to : edge.to === id ? edge.from : undefined; if (candidate && !visited.has(candidate)) { visited.add(candidate); next.push(candidate); paths.push({ nodeId: candidate, depth: currentDepth, via: edge.id }); } } frontier = next; }
  if (frontier.length > 0) truncated = true;
  const result = bounded(graph, graph.nodes.filter((node) => visited.has(node.id)), entityLimit(limit), responseLimit(responseByteLimit));
  return { ...result, truncated: truncated || result.truncated, paths: paths.filter((entry) => result.nodes.some((node) => node.id === entry.nodeId)) };
}

export function matchTargets(graph: CodeGraphV1, target: string): GraphNodeV1[] { const needle = target.toLocaleLowerCase(); return graph.nodes.filter((node) => node.id === target || node.path === target || node.name.toLocaleLowerCase() === needle).sort((a, b) => a.id.localeCompare(b.id)); }

function bounded(graph: CodeGraphV1, candidates: readonly GraphNodeV1[], limit: number, byteLimit: number): GraphResult {
  let nodes = [...candidates].sort((a, b) => a.id.localeCompare(b.id)); let truncated = nodes.length > limit; nodes = nodes.slice(0, limit); const nodeIds = new Set(nodes.map((node) => node.id)); let edges = graph.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).sort((a, b) => a.id.localeCompare(b.id));
  while (nodes.length > 0 && Buffer.byteLength(JSON.stringify({ nodes, edges }), "utf8") > byteLimit) { nodes = nodes.slice(0, -1); const ids = new Set(nodes.map((node) => node.id)); edges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)); truncated = true; }
  return { nodes, edges, truncated, unresolvedEdgeCount: graph.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("UNRESOLVED") || diagnostic.code.startsWith("AMBIGUOUS")).length };
}
function entityLimit(value: number | undefined): number { const result = value ?? GRAPH_DEFAULTS.defaultEntityLimit; if (!Number.isSafeInteger(result) || result < 1 || result > GRAPH_DEFAULTS.maxEntityLimit) throw new OpenWikiError("INVALID_ARGUMENT", "Graph entity limit must be between 1 and 100."); return result; }
function responseLimit(value: number | undefined): number { const result = value ?? GRAPH_DEFAULTS.defaultResponseBytes; if (!Number.isSafeInteger(result) || result < 256 || result > GRAPH_DEFAULTS.maxResponseBytes) throw new OpenWikiError("INVALID_ARGUMENT", "Graph response limit is outside the supported range."); return result; }
