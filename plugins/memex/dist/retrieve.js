import { chunkSymbols } from "./chunk.js";
import { MemexError } from "./errors.js";
const RRF_K = 60;
const ALL_SIGNALS = ["lexical", "vector", "graph"];
const CONFIDENCE_WEIGHT = {
    exact: 1.0, extracted: 1.0,
    resolved: 0.7, inferred: 0.7,
    heuristic: 0.4, ambiguous: 0.4,
};
const GRAPH_TEXT_SEED_LIMIT = 50;
const RELATED_NODE_LIMIT_MULTIPLIER = 2;
export async function search(request, ports) {
    const signals = validateSignals(request.signals);
    const oversample = Math.min(request.limit * 4, 200);
    const lists = [];
    if (signals.includes("lexical"))
        lists.push({ signal: "lexical", items: await ports.lexicalIndex.search(request.text, oversample) });
    let vectorItems = [];
    if (signals.includes("vector")) {
        if (ports.embedder === undefined || ports.vectorStore === undefined)
            throw new MemexError("MODEL_ASSET_MISSING", "Vector retrieval requires a loaded embedder and vector store.");
        const status = await ports.vectorStore.status();
        if (!status.compatible)
            throw new MemexError("INDEX_INCOMPATIBLE", "Vector store model does not match the loaded embedder.");
        vectorItems = await ports.vectorStore.search(await ports.embedder.embedQuery(request.text), oversample);
        lists.push({ signal: "vector", items: vectorItems });
    }
    if (signals.includes("graph")) {
        if (ports.graphIndex === undefined)
            throw new MemexError("NOT_INITIALIZED", "Graph retrieval requires a built graph index.");
        const lexicalItems = lists.find((list) => list.signal === "lexical")?.items ?? [];
        lists.push({ signal: "graph", items: await graphSignal(ports.graphIndex, request.text, lexicalItems, vectorItems, oversample) });
    }
    const fused = fuse(lists);
    return { schemaVersion: 1, evidence: fused.slice(0, request.limit), degraded: signals.length < ALL_SIGNALS.length, truncated: fused.length > request.limit };
}
export async function ask(question, limit, ports, freshness, signals) {
    // ask()'s own graphIndex (required by this function's signature) is always
    // used for relatedNodes/context expansion, independent of which signals
    // the caller narrowed search's *ranking* to via --signals — narrowing
    // still lowers `degraded` correctly since that flag comes from search().
    const result = await search({ text: question, limit, ...(signals === undefined ? {} : { signals }) }, ports);
    const seedIds = new Set();
    for (const item of result.evidence)
        if (item.ref.nodeId !== undefined)
            seedIds.add(item.ref.nodeId);
    const related = await relatedNodes(ports.graphIndex, seedIds, limit * RELATED_NODE_LIMIT_MULTIPLIER);
    return { schema: "memex.ask.v1", question, evidence: result.evidence, relatedNodes: related, degraded: result.degraded, stale: freshness.stale, truncated: result.truncated };
}
// Exported (not just used internally) so Task 11's CLI/MCP dispatch layer can
// resolve the same default/validated signal set *before* calling search()/
// ask(), and only construct the ports (embedder, vector store, graph index)
// that are actually needed — avoiding, e.g., loading the WASM embedder for a
// request that only asked for --signals lexical,graph.
export function validateSignals(signals) {
    if (signals === undefined)
        return [...ALL_SIGNALS];
    if (signals.length === 0)
        throw new MemexError("INVALID_ARGUMENT", "Signals must include at least one of lexical, vector, graph.");
    const unique = new Set(signals);
    for (const signal of unique)
        if (!ALL_SIGNALS.includes(signal))
            throw new MemexError("INVALID_ARGUMENT", `Unknown retrieval signal: ${signal}.`);
    return ALL_SIGNALS.filter((signal) => unique.has(signal));
}
function fuse(lists) {
    const byId = new Map();
    for (const list of lists) {
        list.items.forEach((item, index) => {
            const rank = index + 1;
            const existing = byId.get(item.ref.id) ?? { ref: item.ref, ranks: {}, score: 0 };
            existing.ranks = { ...existing.ranks, [list.signal]: rank };
            existing.score += 1 / (RRF_K + rank);
            if (item.confidence !== undefined)
                existing.confidence = item.confidence;
            byId.set(item.ref.id, existing);
        });
    }
    return [...byId.values()]
        .sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id))
        .map((entry) => ({
        ref: entry.ref,
        score: entry.score,
        ranks: entry.ranks,
        citation: `${entry.ref.path}#L${String(entry.ref.startLine)}-${String(entry.ref.endLine)}`,
        confidence: entry.confidence ?? planeConfidence(entry.ref.plane),
    }));
}
// TP.2 review finding I2: a chunk not reached via the graph signal still
// must carry a confidence label, not `undefined` by omission — PRD §7-2b
// requires confidence labels on every result. "code"-plane chunks are
// deterministically scanner-extracted symbol metadata (the same certainty
// tier the graph itself assigns scanner-derived edges); "wiki"/"concept"
// chunks are literal excerpts of human/agent-authored content, one tier down.
function planeConfidence(plane) {
    return plane === "code" ? "exact" : "extracted";
}
async function graphSignal(index, query, lexicalItems, vectorItems, limit) {
    const candidatesById = new Map();
    for (const item of [...lexicalItems, ...vectorItems])
        candidatesById.set(item.ref.id, item.ref);
    const candidateNodeIds = new Set();
    for (const ref of candidatesById.values())
        if (ref.nodeId !== undefined)
            candidateNodeIds.add(ref.nodeId);
    const seeds = new Set(candidateNodeIds);
    for (const id of await index.rankedCandidates(query, Math.min(limit, GRAPH_TEXT_SEED_LIMIT)).catch(() => []))
        seeds.add(id);
    if (seeds.size === 0)
        return [];
    const proximity = await graphProximity(index, [...seeds].sort((left, right) => left.localeCompare(right)), 2);
    const ranked = [];
    // Re-rank candidates that are already lexical/vector hits by their graph
    // proximity weight (unchanged from before this fix).
    for (const ref of candidatesById.values()) {
        if (ref.nodeId === undefined)
            continue;
        const entry = proximity.get(ref.nodeId);
        if (entry !== undefined)
            ranked.push({ ref, score: entry.weight, confidence: entry.confidence });
    }
    // TP.2 review round 2, N1: surface genuinely new candidates the graph
    // signal alone reached — nodes within depth 2 of a seed that were NOT
    // already a lexical/vector hit. Only `symbol`-kind nodes can be turned
    // into a ChunkRef here without a fresh file read: chunkSymbols (Task 3) is
    // a pure function of the node's own metadata, so it deterministically
    // reconstructs the exact ChunkRef reindex.ts already indexed for that
    // symbol at write time. `concept`/`page` nodes reached this way are not
    // surfaced — chunkMarkdown needs the full page text, which GraphIndexPort
    // has no way to provide — so they stay graph-invisible unless they are
    // independently a lexical/vector hit (design decision 1).
    for (const [nodeId, entry] of proximity) {
        if (candidateNodeIds.has(nodeId))
            continue;
        const node = await index.node(nodeId);
        if (node === undefined || node.kind !== "symbol")
            continue;
        const [chunk] = chunkSymbols([node]);
        if (chunk === undefined)
            continue;
        ranked.push({ ref: chunk, score: entry.weight, confidence: entry.confidence });
    }
    return ranked.sort((left, right) => right.score - left.score || left.ref.id.localeCompare(right.ref.id)).slice(0, limit);
}
// TP.2 review finding M1: combines edge-confidence weights along the path
// (no separate depth-decay term — the literal binding-contract spec is
// "edge weight by confidence... combine along the path", nothing more). This
// is a widest-path computation: the weight to reach a node is the maximum,
// over every path from any seed within maxDepth hops, of the product of that
// path's edge-confidence weights; ties are broken by keeping the first
// (lexicographically smallest-frontier-id-ordered) edge's confidence label
// found at the winning weight, which is deterministic since frontier
// iteration order is sorted below. Seeds themselves start at weight 1 with
// confidence "exact" (the strongest possible link: the seed chunk itself).
async function graphProximity(index, seeds, maxDepth) {
    const scores = new Map();
    for (const id of seeds)
        scores.set(id, { weight: 1, confidence: "exact" });
    let frontier = new Map(seeds.map((id) => [id, 1]));
    for (let depth = 1; depth <= maxDepth; depth += 1) {
        const next = new Map();
        for (const [id, incomingWeight] of [...frontier.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            const [inboundEdges, outboundEdges] = await Promise.all([index.inbound(id, 100), index.outbound(id, 100)]);
            for (const edge of [...inboundEdges.edges, ...outboundEdges.edges]) {
                const neighbor = edge.from === id ? edge.to : edge.from;
                const combined = incomingWeight * CONFIDENCE_WEIGHT[edge.confidence];
                const existing = next.get(neighbor);
                if (existing === undefined || combined > existing.weight)
                    next.set(neighbor, { weight: combined, confidence: edge.confidence });
            }
        }
        for (const [id, entry] of next) {
            const existing = scores.get(id);
            if (existing === undefined || entry.weight > existing.weight)
                scores.set(id, entry);
        }
        frontier = new Map([...next.entries()].map(([id, entry]) => [id, entry.weight]));
    }
    return scores;
}
async function relatedNodes(index, seedIds, limit) {
    if (seedIds.size === 0)
        return [];
    const proximity = await graphProximity(index, [...seedIds].sort((left, right) => left.localeCompare(right)), 2);
    const ids = [...proximity.keys()]
        .filter((id) => !seedIds.has(id))
        .sort((left, right) => (proximity.get(right)?.weight ?? 0) - (proximity.get(left)?.weight ?? 0) || left.localeCompare(right))
        .slice(0, limit);
    const nodes = await Promise.all(ids.map((id) => index.node(id)));
    return nodes.filter((node) => node !== undefined);
}
