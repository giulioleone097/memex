import { createGraphEdgeId, type CodeGraphV1, type GraphConfidence, type GraphEdgeKind, type GraphEdgeV1, type GraphNodeV1 } from "./graph-contracts.js";
import { OpenWikiError } from "./errors.js";

const MAX_LABEL_PROPAGATION_ITERATIONS = 20;

// Structural scaffolding edges (repository/directory/file/module containment, and a module
// declaring or re-exporting its own symbols) connect every node in a single-repository graph
// to a common ancestor. Traversing them for `path`/`communities` would make any two same-repo
// nodes trivially "connected" regardless of any real relationship between them. Both
// computeShortestPath and computeCommunities traverse only the semantic edge subgraph below,
// so "connected"/"same community" means "related", not "shares a directory tree". `member-of`
// is deliberately excluded too: it is computeCommunities's own output, never a traversal input.
const SEMANTIC_EDGE_KINDS = new Set<GraphEdgeKind>([
  "calls",
  "imports",
  "inherits",
  "implements",
  "references",
  "mentions",
  "describes",
  "grounds",
  "related",
]);

export function isSemanticEdgeKind(kind: GraphEdgeKind): boolean {
  return SEMANTIC_EDGE_KINDS.has(kind);
}

export function confidenceWeight(confidence: GraphConfidence): number {
  switch (confidence) {
    case "exact":
    case "extracted":
      return 1;
    case "resolved":
    case "inferred":
      return 0.7;
    case "heuristic":
    case "ambiguous":
      return 0.4;
  }
}

export function computeCommunities(graph: CodeGraphV1): Map<string, string> {
  const nodeIds = graph.nodes.map((node) => node.id).sort((left, right) => left.localeCompare(right));
  const labels = new Map<string, string>(nodeIds.map((id) => [id, id]));
  if (nodeIds.length === 0) {
    return labels;
  }

  const neighbors = new Map<string, Array<{ neighbor: string; weight: number }>>();
  const addNeighbor = (nodeId: string, neighbor: string, weight: number): void => {
    const entries = neighbors.get(nodeId) ?? [];
    entries.push({ neighbor, weight });
    neighbors.set(nodeId, entries);
  };
  for (const edge of graph.edges) {
    if (!isSemanticEdgeKind(edge.kind)) {
      continue;
    }
    const weight = confidenceWeight(edge.confidence);
    addNeighbor(edge.from, edge.to, weight);
    addNeighbor(edge.to, edge.from, weight);
  }

  for (let iteration = 0; iteration < MAX_LABEL_PROPAGATION_ITERATIONS; iteration += 1) {
    let changed = false;
    for (const nodeId of nodeIds) {
      const entries = neighbors.get(nodeId);
      if (entries === undefined || entries.length === 0) {
        continue;
      }
      const totals = new Map<string, number>();
      for (const entry of entries) {
        const label = labels.get(entry.neighbor);
        if (label === undefined) {
          continue;
        }
        totals.set(label, (totals.get(label) ?? 0) + entry.weight);
      }
      let bestLabel: string | undefined;
      let bestWeight = -Infinity;
      for (const [label, weight] of [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        if (weight > bestWeight) {
          bestWeight = weight;
          bestLabel = label;
        }
      }
      if (bestLabel !== undefined && bestLabel !== labels.get(nodeId)) {
        labels.set(nodeId, bestLabel);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return labels;
}

export interface GraphPathResult {
  nodeIds: string[];
  edgeIds: string[];
  totalWeight: number;
}

export function computeGodNodes(graph: CodeGraphV1, limit: number): Array<{ nodeId: string; degree: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new OpenWikiError("INVALID_ARGUMENT", "God node limit must be a positive integer.");
  }
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return [...degree.entries()]
    .map(([nodeId, value]) => ({ nodeId, degree: value }))
    .sort((left, right) => right.degree - left.degree || left.nodeId.localeCompare(right.nodeId))
    .slice(0, limit);
}

export function computeShortestPath(graph: CodeGraphV1, from: string, to: string): GraphPathResult | undefined {
  const knownIds = new Set(graph.nodes.map((node) => node.id));
  if (!knownIds.has(from) || !knownIds.has(to)) {
    return undefined;
  }
  if (from === to) {
    return { nodeIds: [from], edgeIds: [], totalWeight: 0 };
  }

  const adjacency = new Map<string, Array<{ neighbor: string; edgeId: string; cost: number }>>();
  const addEdge = (nodeId: string, neighbor: string, edgeId: string, cost: number): void => {
    const entries = adjacency.get(nodeId) ?? [];
    entries.push({ neighbor, edgeId, cost });
    adjacency.set(nodeId, entries);
  };
  for (const edge of graph.edges) {
    if (!isSemanticEdgeKind(edge.kind)) {
      continue;
    }
    const cost = 1 / confidenceWeight(edge.confidence);
    addEdge(edge.from, edge.to, edge.id, cost);
    addEdge(edge.to, edge.from, edge.id, cost);
  }

  const distances = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  const visited = new Set<string>();

  for (;;) {
    let currentId: string | undefined;
    let currentDistance = Infinity;
    for (const [nodeId, distance] of distances) {
      if (visited.has(nodeId)) {
        continue;
      }
      if (distance < currentDistance || (distance === currentDistance && (currentId === undefined || nodeId.localeCompare(currentId) < 0))) {
        currentId = nodeId;
        currentDistance = distance;
      }
    }
    if (currentId === undefined) {
      return undefined;
    }
    if (currentId === to) {
      break;
    }
    visited.add(currentId);
    const neighbors = [...(adjacency.get(currentId) ?? [])].sort((left, right) => left.neighbor.localeCompare(right.neighbor));
    for (const candidate of neighbors) {
      if (visited.has(candidate.neighbor)) {
        continue;
      }
      const tentative = currentDistance + candidate.cost;
      const existing = distances.get(candidate.neighbor);
      if (existing === undefined || tentative < existing) {
        distances.set(candidate.neighbor, tentative);
        previous.set(candidate.neighbor, { nodeId: currentId, edgeId: candidate.edgeId });
      }
    }
  }

  const pathNodeIds: string[] = [to];
  const pathEdgeIds: string[] = [];
  let cursor = to;
  while (cursor !== from) {
    const step = previous.get(cursor);
    if (step === undefined) {
      return undefined;
    }
    pathEdgeIds.push(step.edgeId);
    pathNodeIds.push(step.nodeId);
    cursor = step.nodeId;
  }
  pathNodeIds.reverse();
  pathEdgeIds.reverse();
  return { nodeIds: pathNodeIds, edgeIds: pathEdgeIds, totalWeight: distances.get(to) ?? 0 };
}

export type GraphPlane = "code" | "concept" | "wiki" | "source";

export function planeOf(node: GraphNodeV1): GraphPlane {
  switch (node.kind) {
    case "concept":
      return "concept";
    case "page":
      return "wiki";
    case "source":
      return "source";
    default:
      return "code";
  }
}

export interface SurprisingConnection {
  edgeId: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  confidence: GraphConfidence;
  priority: "concept-code" | "cross-plane";
}

export function computeSurprisingConnections(graph: CodeGraphV1, limit: number): SurprisingConnection[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new OpenWikiError("INVALID_ARGUMENT", "Surprising-connection limit must be a positive integer.");
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const candidates: SurprisingConnection[] = [];
  for (const edge of graph.edges) {
    if (edge.kind === "member-of" || edge.kind === "contains") {
      continue;
    }
    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const fromPlane = planeOf(from);
    const toPlane = planeOf(to);
    if (fromPlane === toPlane) {
      continue;
    }
    const conceptCode = (fromPlane === "concept" && toPlane === "code") || (fromPlane === "code" && toPlane === "concept");
    candidates.push({
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      confidence: edge.confidence,
      priority: conceptCode ? "concept-code" : "cross-plane",
    });
  }
  return candidates
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority === "concept-code" ? -1 : 1;
      }
      return confidenceWeight(right.confidence) - confidenceWeight(left.confidence) || left.edgeId.localeCompare(right.edgeId);
    })
    .slice(0, limit);
}

export interface CoverageStats {
  totalCodeNodes: number;
  describedCodeNodes: number;
  coverageRatio: number;
}

export function computeCoverageStats(graph: CodeGraphV1): CoverageStats {
  const codeNodes = graph.nodes.filter((node) => node.kind === "file" || node.kind === "symbol");
  const described = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "describes" || edge.kind === "mentions") {
      described.add(edge.to);
    }
  }
  const totalCodeNodes = codeNodes.length;
  const describedCodeNodes = codeNodes.filter((node) => described.has(node.id)).length;
  return { totalCodeNodes, describedCodeNodes, coverageRatio: totalCodeNodes === 0 ? 0 : describedCodeNodes / totalCodeNodes };
}

export interface CommunityQuestionInput {
  id: string;
  memberCount: number;
  topTerms: readonly string[];
}

export function computeSuggestedQuestions(
  godNodes: ReadonlyArray<{ nodeId: string; degree: number }>,
  communities: ReadonlyArray<CommunityQuestionInput>,
  graph: CodeGraphV1,
): string[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const questions: string[] = [];
  for (const godNode of godNodes.slice(0, 3)) {
    const node = nodesById.get(godNode.nodeId);
    if (node === undefined) {
      continue;
    }
    questions.push(`What depends on ${node.name} (${node.path}), and what would break if it changed?`);
  }
  for (const community of communities.slice(0, 3)) {
    if (community.memberCount <= 1) {
      continue;
    }
    const terms = community.topTerms.length > 0 ? community.topTerms.join(", ") : "no shared terms";
    questions.push(`What is the shared purpose of the ${String(community.memberCount)} nodes in community "${community.id}" (top terms: ${terms})?`);
  }
  return questions;
}

export function synthesizeMemberOfEdges(graph: CodeGraphV1, communities: ReadonlyMap<string, string>): GraphEdgeV1[] {
  const edges: GraphEdgeV1[] = [];
  for (const node of graph.nodes) {
    const communityId = communities.get(node.id);
    if (communityId === undefined) {
      continue;
    }
    edges.push({
      id: createGraphEdgeId("member-of", node.id, communityId, "exact"),
      kind: "member-of",
      from: node.id,
      to: communityId,
      confidence: "exact",
    });
  }
  return edges.sort((left, right) => left.id.localeCompare(right.id));
}

// Field shape kept in sync by hand with CommunitySummaryV1 in analysis-store.ts (Task 4) — analyze.ts must not
// import from the persistence layer, so the two interfaces are declared independently; if one gains/loses a
// field, update the other to match.
export interface CommunitySummary {
  id: string;
  memberCount: number;
  topTerms: string[];
  members: string[];
  membersTruncated: boolean;
}

const ANALYSIS_MAX_MEMBERS_PER_COMMUNITY = 200;
const ANALYSIS_MAX_TOP_TERMS = 5;
const TERM_PATTERN = /[\p{L}\p{N}_$]+/gu;

export function summarizeCommunities(graph: CodeGraphV1, communities: ReadonlyMap<string, string>): CommunitySummary[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const grouped = new Map<string, string[]>();
  for (const [nodeId, communityId] of communities) {
    const members = grouped.get(communityId) ?? [];
    members.push(nodeId);
    grouped.set(communityId, members);
  }
  const summaries: CommunitySummary[] = [];
  for (const [communityId, memberIds] of grouped) {
    const sortedMembers = [...memberIds].sort((left, right) => left.localeCompare(right));
    const termCounts = new Map<string, number>();
    for (const memberId of sortedMembers) {
      const node = nodesById.get(memberId);
      if (node === undefined) {
        continue;
      }
      for (const term of `${node.name} ${node.path}`.toLowerCase().match(TERM_PATTERN) ?? []) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      }
    }
    const topTerms = [...termCounts.entries()]
      .sort(([leftTerm, leftCount], [rightTerm, rightCount]) => rightCount - leftCount || leftTerm.localeCompare(rightTerm))
      .slice(0, ANALYSIS_MAX_TOP_TERMS)
      .map(([term]) => term);
    summaries.push({
      id: communityId,
      memberCount: sortedMembers.length,
      topTerms,
      members: sortedMembers.slice(0, ANALYSIS_MAX_MEMBERS_PER_COMMUNITY),
      membersTruncated: sortedMembers.length > ANALYSIS_MAX_MEMBERS_PER_COMMUNITY,
    });
  }
  return summaries.sort((left, right) => right.memberCount - left.memberCount || left.id.localeCompare(right.id));
}

export function findCitingPages(nodes: readonly GraphNodeV1[], edges: readonly GraphEdgeV1[], targetId: string): GraphNodeV1[] {
  return nodes
    .filter((candidate) => candidate.kind === "page" && edges.some((edge) => (edge.kind === "describes" || edge.kind === "mentions") && edge.from === candidate.id && edge.to === targetId))
    .sort((left, right) => left.id.localeCompare(right.id));
}
