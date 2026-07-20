import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createEvidenceIdentity } from "../../dist/evidence-identity.js";
import { ask, search } from "../../dist/retrieve.js";

function ref(id, path, nodeId) {
  return { id, path, startLine: 1, endLine: 2, plane: "wiki", contentHash: id, ...(nodeId === undefined ? {} : { nodeId }) };
}

function fakeLexicalIndex(rankedRefs) {
  return { async upsert() { /* unused in these tests */ }, async search() { return rankedRefs.map((entry, index) => ({ ref: entry, score: rankedRefs.length - index })); } };
}

function fakeVectorStore(rankedRefs) {
  return {
    async upsert() { return { written: 0, reused: 0 }; },
    async search() { return rankedRefs.map((entry, index) => ({ ref: entry, score: 1 - index * 0.1 })); },
    async status() { return { modelId: "test-model", dims: 4, chunks: rankedRefs.length, compatible: true }; },
  };
}

function fakeEmbedder() {
  return { modelId: "test-model", dims: 4, async embedQuery() { return new Float32Array([1, 0, 0, 0]); }, async embedPassages(texts) { return texts.map(() => new Float32Array([1, 0, 0, 0])); } };
}

function fakeGraphIndex({ edges = [], nodes = new Map() } = {}) {
  const outbound = new Map();
  const inbound = new Map();
  for (const edge of edges) {
    outbound.set(edge.from, [...(outbound.get(edge.from) ?? []), edge]);
    inbound.set(edge.to, [...(inbound.get(edge.to) ?? []), edge]);
  }
  return {
    async node(id) { return nodes.get(id); },
    async edge() { return undefined; },
    async rankedCandidates() { return []; },
    async inbound(id, limit) { const list = inbound.get(id) ?? []; return { edges: list.slice(0, limit), total: list.length, truncated: list.length > limit }; },
    async outbound(id, limit) { const list = outbound.get(id) ?? []; return { edges: list.slice(0, limit), total: list.length, truncated: list.length > limit }; },
    async changedPathSeeds() { return []; },
    async architectureSummary() { return { modules: [], entrypoints: [], hubs: [], flows: [], cycles: [], diagnostics: [], fileCount: 0, nodeCount: 0, edgeCount: 0 }; },
    metrics() { return { bytesRead: 0, filesRead: 0 }; },
    status() { return { generation: "g-test", recovered: false, schemaVersion: 2, scannerVersion: "test" }; },
  };
}

test("retrieve.search: fuses lexical and vector signals via RRF with deterministic tie-break", async () => {
  const a = ref("a".repeat(64), "docs/a.md");
  const b = ref("b".repeat(64), "docs/b.md");
  const ports = { lexicalIndex: fakeLexicalIndex([a, b]), vectorStore: fakeVectorStore([b, a]), embedder: fakeEmbedder() };
  const result = await search({ text: "query", limit: 10, signals: ["lexical", "vector"] }, ports);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.degraded, true, "only 2 of 3 signals were requested");
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(result.evidence[0].ranks, { lexical: 1, vector: 2 });
  assert.equal(result.evidence[0].citation, "docs/a.md#L1-2");
  assert.equal(result.evidence[0].confidence, "extracted", "no graph signal reached this chunk, so confidence falls back to its wiki-plane default");
});

test("retrieve.search: default signals include all three and degraded is false", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const ports = { lexicalIndex: fakeLexicalIndex([a]), vectorStore: fakeVectorStore([a]), embedder: fakeEmbedder(), graphIndex: fakeGraphIndex() };
  const result = await search({ text: "query", limit: 5 }, ports);
  assert.equal(result.degraded, false);
});

test("retrieve.search: requesting vector without a vector store throws MODEL_ASSET_MISSING, never silently degrades", async () => {
  const ports = { lexicalIndex: fakeLexicalIndex([]) };
  await assert.rejects(search({ text: "query", limit: 5, signals: ["vector"] }, ports), { code: "MODEL_ASSET_MISSING" });
});

test("retrieve.search: an incompatible vector store throws INDEX_INCOMPATIBLE", async () => {
  const store = fakeVectorStore([]);
  store.status = async () => ({ modelId: "other-model", dims: 4, chunks: 0, compatible: false });
  const ports = { lexicalIndex: fakeLexicalIndex([]), vectorStore: store, embedder: fakeEmbedder() };
  await assert.rejects(search({ text: "query", limit: 5, signals: ["vector"] }, ports), { code: "INDEX_INCOMPATIBLE" });
});

test("retrieve.search: rejects an empty or unknown signals array", async () => {
  const ports = { lexicalIndex: fakeLexicalIndex([]) };
  await assert.rejects(search({ text: "q", limit: 5, signals: [] }, ports), { code: "INVALID_ARGUMENT" });
});

test("evidence identity: is deterministic, host-independent, and carries changed-content provenance", () => {
  const input = {
    projectScope: "repo:catalog",
    sourceIdentity: "src/catalog.ts",
    contentHash: "a".repeat(64),
    startLine: 10,
    endLine: 18,
  };
  const identityFromHostRoot = (root) => createEvidenceIdentity({
    ...input,
    sourceIdentity: path.relative(root, path.join(root, "src/catalog.ts")),
  });
  const first = identityFromHostRoot("/Users/alice/work/catalog");
  const second = identityFromHostRoot("/opt/builds/bob/catalog");
  assert.equal(first.evidenceId, second.evidenceId);
  assert.match(first.evidenceId, /^ev1:[a-f0-9]{64}$/u);
  assert.deepEqual(first.provenance, {
    projectScope: "repo:catalog",
    sourceIdentity: "src/catalog.ts",
    contentHash: "a".repeat(64),
    startLine: 10,
    endLine: 18,
  });

  const changed = createEvidenceIdentity({
    ...input,
    contentHash: "b".repeat(64),
    priorEvidenceId: first.evidenceId,
  });
  assert.notEqual(changed.evidenceId, first.evidenceId, "changed content must receive a new evidence ID");
  assert.equal(changed.provenance.priorEvidenceId, first.evidenceId);

  assert.throws(
    () => createEvidenceIdentity({ ...input, projectScope: "/Users/alice/catalog" }),
    /logical identity.*absolute host path/iu,
    "absolute project scopes must be rejected rather than hidden behind host-specific hashes",
  );
});

test("retrieve.search: deduplicates lexical/vector copies by evidenceId before top-k", async () => {
  const lexicalRef = ref("a".repeat(64), "docs/shared.md");
  const vectorRef = ref("b".repeat(64), "docs/shared.md");
  vectorRef.contentHash = lexicalRef.contentHash;
  const ports = {
    lexicalIndex: fakeLexicalIndex([lexicalRef]),
    vectorStore: fakeVectorStore([vectorRef]),
    embedder: fakeEmbedder(),
    evidenceIdentity: { projectScope: "repo:shared", sourceIdentity: (candidate) => candidate.path },
  };
  const first = await search({ text: "query", limit: 1, signals: ["lexical", "vector"] }, ports);
  const second = await search({ text: "query", limit: 1, signals: ["lexical", "vector"] }, ports);
  assert.equal(first.evidence.length, 1, "the same excerpt must occupy one top-k slot");
  assert.deepEqual(first.evidence, second.evidence, "fusion ordering and representative selection must be deterministic");
  assert.deepEqual(first.evidence[0].ranks, { lexical: 1, vector: 1 });
  assert.equal(first.evidence[0].provenance.projectScope, "repo:shared");
  assert.equal(first.evidence[0].evidenceId, second.evidence[0].evidenceId);
});

test("retrieve.search: lexical-only path is deterministic without vector assets", async () => {
  const a = ref("a".repeat(64), "docs/a.md");
  const ports = { lexicalIndex: fakeLexicalIndex([a]) };
  const first = await search({ text: "query", limit: 5, signals: ["lexical"] }, ports);
  const second = await search({ text: "query", limit: 5, signals: ["lexical"] }, ports);
  assert.deepEqual(first.evidence, second.evidence);
  assert.equal(first.evidence[0].provenance.projectScope, "memex:unscoped");
});

test("retrieve.search: emits priorEvidenceId when an indexed candidate carries changed-content lineage", async () => {
  const prior = createEvidenceIdentity({
    projectScope: "repo:history",
    sourceIdentity: "docs/history.md",
    contentHash: "a".repeat(64),
    startLine: 1,
    endLine: 2,
  });
  const changed = ref("c".repeat(64), "docs/history.md");
  changed.contentHash = "b".repeat(64);
  changed.priorEvidenceId = prior.evidenceId;
  const result = await search({ text: "history", limit: 5, signals: ["lexical"] }, {
    lexicalIndex: fakeLexicalIndex([changed]),
    evidenceIdentity: { projectScope: "repo:history" },
  });
  assert.equal(result.evidence[0].provenance.priorEvidenceId, prior.evidenceId);
  assert.notEqual(result.evidence[0].evidenceId, prior.evidenceId);
});

test("retrieve.search: ignores a legacy prior ref ID instead of failing retrieval", async () => {
  const legacy = ref("c".repeat(64), "docs/legacy.md");
  legacy.previousEvidenceId = "d".repeat(64);
  const result = await search({ text: "legacy", limit: 5, signals: ["lexical"] }, {
    lexicalIndex: fakeLexicalIndex([legacy]),
    evidenceIdentity: { projectScope: "repo:history" },
  });
  assert.equal(result.evidence.length, 1);
  assert.equal(Object.hasOwn(result.evidence[0].provenance, "priorEvidenceId"), false);
});

// TP.2 review round 2, N1: the previous version of this test asserted only
// that b — itself already a lexical hit and therefore already a BFS seed —
// received a graph rank and an "exact" confidence. Both held whether or not
// the connecting edge existed at all: every seed starts at the ceiling
// weight (1, "exact"), and no edge traversal can exceed a ceiling, so the
// assertions were a tautology (proved empirically by the reviewer: running
// the fixture with vs. without the edge produced identical output). This
// rewritten test instead proves a chunk that is NEITHER a lexical NOR a
// vector hit — b is never returned by any signal's search() below, it only
// exists as a graph node — is surfaced purely by the graph signal because it
// is a symbol node one hop from lexical hit a's seed (design decision 1).
// Design invariant (the reviewer's own falsification method, made explicit
// and automated): the companion test immediately below removes the edge and
// asserts b disappears from the results — this test's claim is not provable
// by inspection alone, so both directions are checked.
test("retrieve.search: graph signal surfaces a chunk that is neither a lexical nor a vector hit, reached only via BFS from a seed", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeB = { id: "node-b", kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 10, endLine: 20 };
  const edge = { id: "edge-1", kind: "calls", from: "node-a", to: "node-b", confidence: "exact" };
  const ports = {
    lexicalIndex: fakeLexicalIndex([a]),
    graphIndex: fakeGraphIndex({ edges: [edge], nodes: new Map([["node-b", nodeB]]) }),
  };
  const result = await search({ text: "query", limit: 10, signals: ["lexical", "graph"] }, ports);
  const graphOnlyHit = result.evidence.find((item) => item.ref.nodeId === "node-b");
  assert.ok(graphOnlyHit, "b must be surfaced purely by the graph signal — it is not a lexical or vector hit");
  assert.ok(Number.isInteger(graphOnlyHit.ranks.graph), "b must carry a graph rank");
  assert.equal(graphOnlyHit.ranks.lexical, undefined, "b must not carry a lexical rank — the fake lexical index never returned it");
  assert.equal(graphOnlyHit.ranks.vector, undefined, "b must not carry a vector rank — no vector signal was requested or returned it");
  assert.equal(graphOnlyHit.confidence, "exact", "b was reached via a single exact-confidence calls edge from seed a");
});

test("retrieve.search: removing the connecting edge removes the graph-only chunk from results (falsifies the previous test if the graph signal is a no-op)", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeB = { id: "node-b", kind: "symbol", path: "src/service.ts", name: "runCatalogSync", symbolKind: "function", startLine: 10, endLine: 20 };
  const ports = {
    lexicalIndex: fakeLexicalIndex([a]),
    graphIndex: fakeGraphIndex({ edges: [], nodes: new Map([["node-b", nodeB]]) }), // no edge from node-a to node-b
  };
  const result = await search({ text: "query", limit: 10, signals: ["lexical", "graph"] }, ports);
  assert.ok(!result.evidence.some((item) => item.ref.nodeId === "node-b"), "without the connecting edge, b is unreachable within depth 2 and must not appear in results");
});

test("retrieve.ask: wraps search with the memex.ask.v1 schema and passes through staleness", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeA = { id: "node-a", kind: "symbol", path: "docs/a.md", name: "a" };
  // node-b is a genuinely distinct, edge-connected node — relatedNodes()
  // deliberately excludes the seed itself (a node is never "related to
  // itself"; see retrieve.ts's relatedNodes filter(id => !seedIds.has(id))),
  // so a fixture with only the seed and zero edges could never populate
  // relatedNodes regardless of whether ask() wires the graph correctly. This
  // edge is what actually exercises that wiring. node-b is deliberately
  // "module"-kind, not "symbol"-kind: a symbol-kind neighbor would itself get
  // pulled into result.evidence by the graph *signal* (design decision 1),
  // making it a second seed too, and re-triggering the same self-exclusion —
  // "module" keeps node-b purely a relatedNodes-only neighbor, isolating the
  // thing this test actually checks (ask()'s relatedNodes wiring).
  const nodeB = { id: "node-b", kind: "module", path: "docs/b.md", name: "b" };
  const edge = { id: "edge-1", kind: "references", from: "node-a", to: "node-b", confidence: "exact" };
  const ports = { lexicalIndex: fakeLexicalIndex([a]), graphIndex: fakeGraphIndex({ edges: [edge], nodes: new Map([["node-a", nodeA], ["node-b", nodeB]]) }) };
  // Signals narrowed to lexical+graph: these ports have no vectorStore/embedder,
  // and search()'s default signal set (used when ask() is called without a
  // signals argument) always includes "vector", which would otherwise throw
  // MODEL_ASSET_MISSING here — this test's purpose is the ask()-specific
  // schema/staleness/relatedNodes wrapping, not re-proving search()'s own
  // default-signal behavior (already covered by "default signals include all
  // three" above).
  const result = await ask("what is a?", 5, ports, { stale: true }, ["lexical", "graph"]);
  assert.equal(result.schema, "memex.ask.v1");
  assert.equal(result.question, "what is a?");
  assert.equal(result.stale, true);
  assert.ok(result.evidence.length > 0);
  assert.ok(result.relatedNodes.some((node) => node.id === "node-b"), "node-b is one edge away from seed node-a and must be surfaced by ask()'s relatedNodes wiring");
});

test("retrieve.ask: forwards its own signals argument to narrow search's ranking and reports degraded", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  const nodeA = { id: "node-a", kind: "symbol", path: "docs/a.md", name: "a" };
  const ports = { lexicalIndex: fakeLexicalIndex([a]), vectorStore: fakeVectorStore([a]), embedder: fakeEmbedder(), graphIndex: fakeGraphIndex({ nodes: new Map([["node-a", nodeA]]) }) };
  const result = await ask("what is a?", 5, ports, { stale: false }, ["lexical", "graph"]);
  assert.equal(result.degraded, true, "narrowing to 2 of 3 signals must be reported as degraded");
});

// TP.2 review round 2, N1 recommendation 3: no test in this suite previously
// exercised a BFS hop beyond depth 0 (a seed itself) — the graph-signal tests
// above only ever go one hop deep. This test chains three edges (a->b->c->d)
// from a single seed (node-a) and proves relatedNodes performs genuine
// depth-2 expansion: node-c (exactly 2 hops away) must be reached, and
// node-d (3 hops away) must not — the binding contract's literal "BFS ≤
// depth 2" bound, proven in both directions rather than assumed.
test("retrieve.ask: relatedNodes performs genuine depth-2 BFS expansion — reaches a 2-hop node, not a 3-hop node", async () => {
  const a = ref("a".repeat(64), "docs/a.md", "node-a");
  // moduleB/C/D are "module"-kind, not "symbol"-kind: graphSignal's
  // non-seed-surfacing logic (decision 1) only turns symbol nodes into new
  // evidence, so these three are never added to result.evidence. That keeps
  // ask()'s relatedNodes seed set (drawn from evidence nodeIds) to exactly
  // {node-a} — a single, uncompounded BFS pass — so this test isolates the
  // depth-2 bound itself rather than the interaction between two BFS passes
  // (search()'s own graph signal, then ask()'s separate relatedNodes call).
  const moduleB = { id: "node-b", kind: "module", path: "src/b", name: "b" };
  const moduleC = { id: "node-c", kind: "module", path: "src/c", name: "c" };
  const moduleD = { id: "node-d", kind: "module", path: "src/d", name: "d" };
  const edges = [
    { id: "e1", kind: "calls", from: "node-a", to: "node-b", confidence: "exact" },
    { id: "e2", kind: "calls", from: "node-b", to: "node-c", confidence: "resolved" },
    { id: "e3", kind: "calls", from: "node-c", to: "node-d", confidence: "exact" },
  ];
  const ports = {
    lexicalIndex: fakeLexicalIndex([a]),
    graphIndex: fakeGraphIndex({ edges, nodes: new Map([["node-b", moduleB], ["node-c", moduleC], ["node-d", moduleD]]) }),
  };
  // Signals narrowed to lexical+graph — these ports have no vectorStore/
  // embedder, and ask()'s default signal set otherwise includes "vector"
  // (see the same note on the "wraps search" test above).
  const result = await ask("what calls a?", 5, ports, { stale: false }, ["lexical", "graph"]);
  assert.ok(result.relatedNodes.some((node) => node.id === "node-c"), "node-c is exactly 2 hops from seed node-a (a->b->c) and must be reached by BFS <= depth 2");
  assert.ok(!result.relatedNodes.some((node) => node.id === "node-d"), "node-d is 3 hops from seed node-a — outside the binding contract's BFS <= depth 2 bound — and must not be reached");
});
