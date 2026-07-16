import type { CodeGraphV1, GraphConfidence } from "./graph-contracts.js";

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
