import type { CodeGraphV1, GraphConfidence } from "./graph-contracts.js";
import { OpenWikiError } from "./errors.js";

const MAX_LABEL_PROPAGATION_ITERATIONS = 20;

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
    if (edge.kind === "member-of") {
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
