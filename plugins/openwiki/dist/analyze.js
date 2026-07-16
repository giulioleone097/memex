import { createGraphEdgeId } from "./graph-contracts.js";
import { OpenWikiError } from "./errors.js";
const MAX_LABEL_PROPAGATION_ITERATIONS = 20;
export function confidenceWeight(confidence) {
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
export function computeCommunities(graph) {
    const nodeIds = graph.nodes.map((node) => node.id).sort((left, right) => left.localeCompare(right));
    const labels = new Map(nodeIds.map((id) => [id, id]));
    if (nodeIds.length === 0) {
        return labels;
    }
    const neighbors = new Map();
    const addNeighbor = (nodeId, neighbor, weight) => {
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
            const totals = new Map();
            for (const entry of entries) {
                const label = labels.get(entry.neighbor);
                if (label === undefined) {
                    continue;
                }
                totals.set(label, (totals.get(label) ?? 0) + entry.weight);
            }
            let bestLabel;
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
export function computeGodNodes(graph, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new OpenWikiError("INVALID_ARGUMENT", "God node limit must be a positive integer.");
    }
    const degree = new Map();
    for (const edge of graph.edges) {
        degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    return [...degree.entries()]
        .map(([nodeId, value]) => ({ nodeId, degree: value }))
        .sort((left, right) => right.degree - left.degree || left.nodeId.localeCompare(right.nodeId))
        .slice(0, limit);
}
export function computeShortestPath(graph, from, to) {
    const knownIds = new Set(graph.nodes.map((node) => node.id));
    if (!knownIds.has(from) || !knownIds.has(to)) {
        return undefined;
    }
    if (from === to) {
        return { nodeIds: [from], edgeIds: [], totalWeight: 0 };
    }
    const adjacency = new Map();
    const addEdge = (nodeId, neighbor, edgeId, cost) => {
        const entries = adjacency.get(nodeId) ?? [];
        entries.push({ neighbor, edgeId, cost });
        adjacency.set(nodeId, entries);
    };
    for (const edge of graph.edges) {
        const cost = 1 / confidenceWeight(edge.confidence);
        addEdge(edge.from, edge.to, edge.id, cost);
        addEdge(edge.to, edge.from, edge.id, cost);
    }
    const distances = new Map([[from, 0]]);
    const previous = new Map();
    const visited = new Set();
    for (;;) {
        let currentId;
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
    const pathNodeIds = [to];
    const pathEdgeIds = [];
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
export function planeOf(node) {
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
export function computeSurprisingConnections(graph, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new OpenWikiError("INVALID_ARGUMENT", "Surprising-connection limit must be a positive integer.");
    }
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const candidates = [];
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
export function computeCoverageStats(graph) {
    const codeNodes = graph.nodes.filter((node) => node.kind === "file" || node.kind === "symbol");
    const described = new Set();
    for (const edge of graph.edges) {
        if (edge.kind === "describes" || edge.kind === "mentions") {
            described.add(edge.to);
        }
    }
    const totalCodeNodes = codeNodes.length;
    const describedCodeNodes = codeNodes.filter((node) => described.has(node.id)).length;
    return { totalCodeNodes, describedCodeNodes, coverageRatio: totalCodeNodes === 0 ? 0 : describedCodeNodes / totalCodeNodes };
}
export function computeSuggestedQuestions(godNodes, communities, graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const questions = [];
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
export function synthesizeMemberOfEdges(graph, communities) {
    const edges = [];
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
const ANALYSIS_MAX_MEMBERS_PER_COMMUNITY = 200;
const ANALYSIS_MAX_TOP_TERMS = 5;
const TERM_PATTERN = /[\p{L}\p{N}_$]+/gu;
export function summarizeCommunities(graph, communities) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const grouped = new Map();
    for (const [nodeId, communityId] of communities) {
        const members = grouped.get(communityId) ?? [];
        members.push(nodeId);
        grouped.set(communityId, members);
    }
    const summaries = [];
    for (const [communityId, memberIds] of grouped) {
        const sortedMembers = [...memberIds].sort((left, right) => left.localeCompare(right));
        const termCounts = new Map();
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
export function findCitingPages(nodes, edges, targetId) {
    return nodes
        .filter((candidate) => candidate.kind === "page" && edges.some((edge) => (edge.kind === "describes" || edge.kind === "mentions") && edge.from === candidate.id && edge.to === targetId))
        .sort((left, right) => left.id.localeCompare(right.id));
}
