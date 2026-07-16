import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeCommunities, confidenceWeight } from "../../dist/analyze.js";
import { computeGodNodes, computeShortestPath } from "../../dist/analyze.js";
import { isSemanticEdgeKind } from "../../dist/analyze.js";
import {
  computeCoverageStats,
  computeSuggestedQuestions,
  computeSurprisingConnections,
  findCitingPages,
  planeOf,
  summarizeCommunities,
  synthesizeMemberOfEdges,
} from "../../dist/analyze.js";

function typedNode(id, kind, path = "src/app.ts", name = id) {
  return { id, kind, path, name };
}

function graph(nodes, edges) {
  return {
    schemaVersion: 1,
    workspaceId: "workspace",
    generatedAt: "2026-07-14T00:00:00.000Z",
    source: { dirtyFingerprint: "f".repeat(64), scannerVersion: "openwiki-graph-v1" },
    files: [],
    nodes,
    edges,
    diagnostics: [],
  };
}

function node(id) {
  return { id, kind: "symbol", path: "src/app.ts", name: id };
}

function edge(id, kind, from, to, confidence) {
  return { id, kind, from, to, confidence };
}

describe("analyze: community detection", () => {
  test("analyze: maps confidence labels to the shared 1.0/0.7/0.4 weight scale", () => {
    assert.equal(confidenceWeight("exact"), 1);
    assert.equal(confidenceWeight("extracted"), 1);
    assert.equal(confidenceWeight("resolved"), 0.7);
    assert.equal(confidenceWeight("inferred"), 0.7);
    assert.equal(confidenceWeight("heuristic"), 0.4);
    assert.equal(confidenceWeight("ambiguous"), 0.4);
  });

  test("analyze: returns an empty community map for an empty graph", () => {
    assert.deepEqual(computeCommunities(graph([], [])), new Map());
  });

  test("analyze: isolated nodes form singleton communities led by themselves", () => {
    const result = computeCommunities(graph([node("a"), node("b")], []));
    assert.deepEqual([...result.entries()].sort(), [["a", "a"], ["b", "b"]]);
  });

  test("analyze: label propagation splits two triangles joined by one weak bridge deterministically", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d"), node("e"), node("f")];
    const edges = [
      edge("e-ab", "calls", "a", "b", "exact"),
      edge("e-bc", "calls", "b", "c", "exact"),
      edge("e-ca", "calls", "c", "a", "exact"),
      edge("e-de", "calls", "d", "e", "exact"),
      edge("e-ef", "calls", "e", "f", "exact"),
      edge("e-fd", "calls", "f", "d", "exact"),
      edge("e-cd", "references", "c", "d", "heuristic"),
    ];
    const result = computeCommunities(graph(nodes, edges));
    assert.deepEqual(
      [...result.entries()].sort(),
      [["a", "b"], ["b", "b"], ["c", "b"], ["d", "e"], ["e", "e"], ["f", "e"]],
    );
  });

  test("analyze: community detection is deterministic across repeated runs and ignores member-of edges", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [
      edge("e-ab", "calls", "a", "b", "exact"),
      edge("e-bc", "calls", "b", "c", "resolved"),
      edge("e-member", "member-of", "a", "z", "exact"),
    ];
    const first = computeCommunities(graph(nodes, edges));
    const second = computeCommunities(graph(nodes, edges));
    assert.deepEqual([...first.entries()].sort(), [...second.entries()].sort());
    assert.equal([...first.values()].includes("z"), false);
  });

  test("analyze: isSemanticEdgeKind excludes structural scaffolding kinds and member-of, includes real relationships", () => {
    assert.equal(isSemanticEdgeKind("contains"), false);
    assert.equal(isSemanticEdgeKind("declares"), false);
    assert.equal(isSemanticEdgeKind("exports"), false);
    assert.equal(isSemanticEdgeKind("member-of"), false);
    assert.equal(isSemanticEdgeKind("calls"), true);
    assert.equal(isSemanticEdgeKind("imports"), true);
    assert.equal(isSemanticEdgeKind("inherits"), true);
    assert.equal(isSemanticEdgeKind("implements"), true);
    assert.equal(isSemanticEdgeKind("references"), true);
    assert.equal(isSemanticEdgeKind("mentions"), true);
    assert.equal(isSemanticEdgeKind("describes"), true);
    assert.equal(isSemanticEdgeKind("grounds"), true);
    assert.equal(isSemanticEdgeKind("related"), true);
  });

  test("analyze: community detection ignores structural contains/declares/exports edges — two modules sharing only a directory do not become one community", () => {
    const nodes = [typedNode("moduleA", "module"), typedNode("moduleB", "module"), typedNode("dir", "directory")];
    const edges = [
      edge("e-contains-a", "contains", "dir", "moduleA", "exact"),
      edge("e-contains-b", "contains", "dir", "moduleB", "exact"),
      edge("e-declares-a", "declares", "moduleA", "moduleA", "exact"),
      edge("e-exports-b", "exports", "dir", "moduleB", "exact"),
    ];
    const result = computeCommunities(graph(nodes, edges));
    assert.notEqual(result.get("moduleA"), result.get("moduleB"));
    assert.equal(result.get("moduleA"), "moduleA");
    assert.equal(result.get("moduleB"), "moduleB");
    assert.equal(result.get("dir"), "dir");
  });
});

describe("analyze: god nodes and shortest path", () => {
  test("analyze: ranks god nodes by total degree, ties broken by node id", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const edges = [
      edge("e-ab", "calls", "a", "b", "exact"),
      edge("e-ac", "calls", "a", "c", "exact"),
      edge("e-ad", "calls", "a", "d", "exact"),
      edge("e-bc", "calls", "b", "c", "exact"),
    ];
    const result = computeGodNodes(graph(nodes, edges), 2);
    assert.deepEqual(result, [
      { nodeId: "a", degree: 3 },
      { nodeId: "b", degree: 2 },
    ]);
  });

  test("analyze: shortest path prefers a two-hop exact route over a one-hop heuristic shortcut", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [
      edge("e-ab", "calls", "a", "b", "exact"),
      edge("e-bc", "calls", "b", "c", "exact"),
      edge("e-ac", "references", "a", "c", "heuristic"),
    ];
    const result = computeShortestPath(graph(nodes, edges), "a", "c");
    assert.deepEqual(result, { nodeIds: ["a", "b", "c"], edgeIds: ["e-ab", "e-bc"], totalWeight: 2 });
  });

  test("analyze: shortest path returns undefined for unreachable or unknown endpoints", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("e-ab", "calls", "a", "b", "exact")];
    assert.equal(computeShortestPath(graph(nodes, edges), "a", "c"), undefined);
    assert.equal(computeShortestPath(graph(nodes, edges), "a", "z"), undefined);
  });

  test("analyze: shortest path from a node to itself is trivial", () => {
    const result = computeShortestPath(graph([node("a")], []), "a", "a");
    assert.deepEqual(result, { nodeIds: ["a"], edgeIds: [], totalWeight: 0 });
  });

  test("analyze: shortest path does not traverse structural contains/declares/exports edges — two files sharing only a directory are not \"connected\"", () => {
    const nodes = [typedNode("moduleA", "module"), typedNode("moduleB", "module"), typedNode("dir", "directory")];
    const edges = [
      edge("e-contains-a", "contains", "dir", "moduleA", "exact"),
      edge("e-contains-b", "contains", "dir", "moduleB", "exact"),
    ];
    assert.equal(computeShortestPath(graph(nodes, edges), "moduleA", "moduleB"), undefined);
  });
});

describe("analyze: surprising connections, coverage, questions, member-of", () => {
  test("analyze: classifies node planes by kind", () => {
    assert.equal(planeOf(typedNode("a", "symbol")), "code");
    assert.equal(planeOf(typedNode("b", "file")), "code");
    assert.equal(planeOf(typedNode("c", "concept")), "concept");
    assert.equal(planeOf(typedNode("d", "page")), "wiki");
    assert.equal(planeOf(typedNode("e", "source")), "source");
  });

  test("analyze: ranks concept-code surprising connections above other cross-plane edges", () => {
    const nodes = [
      typedNode("sym", "symbol"),
      typedNode("concept", "concept"),
      typedNode("page", "page"),
    ];
    const edges = [
      edge("e-describes", "describes", "page", "concept", "extracted"),
      edge("e-mentions", "mentions", "concept", "sym", "extracted"),
      edge("e-contains", "contains", "sym", "sym", "exact"),
    ];
    const result = computeSurprisingConnections(graph(nodes, edges), 10);
    assert.deepEqual(result.map((entry) => entry.edgeId), ["e-mentions", "e-describes"]);
    assert.equal(result[0].priority, "concept-code");
    assert.equal(result[1].priority, "cross-plane");
  });

  test("analyze: computes described-code coverage ratio from describes/mentions edges", () => {
    const nodes = [typedNode("f1", "file"), typedNode("f2", "file"), typedNode("concept", "concept")];
    const edges = [edge("e-describes", "describes", "concept", "f1", "extracted")];
    const stats = computeCoverageStats(graph(nodes, edges));
    assert.deepEqual(stats, { totalCodeNodes: 2, describedCodeNodes: 1, coverageRatio: 0.5 });
  });

  test("analyze: coverage ratio is zero, not NaN, when there are no code nodes", () => {
    assert.deepEqual(computeCoverageStats(graph([], [])), { totalCodeNodes: 0, describedCodeNodes: 0, coverageRatio: 0 });
  });

  test("analyze: suggests deterministic questions from god nodes and communities", () => {
    const g = graph([typedNode("hub", "symbol", "src/hub.ts", "hub")], []);
    const questions = computeSuggestedQuestions(
      [{ nodeId: "hub", degree: 9 }],
      [{ id: "hub", memberCount: 3, topTerms: ["hub", "service"], members: ["hub"], membersTruncated: false }],
      g,
    );
    assert.deepEqual(questions, [
      "What depends on hub (src/hub.ts), and what would break if it changed?",
      'What is the shared purpose of the 3 nodes in community "hub" (top terms: hub, service)?',
    ]);
  });

  test("analyze: synthesizes one deterministic member-of edge per node", () => {
    const g = graph([typedNode("a", "symbol"), typedNode("b", "symbol")], []);
    const communities = new Map([["a", "a"], ["b", "a"]]);
    const edges = synthesizeMemberOfEdges(g, communities);
    assert.equal(edges.length, 2);
    for (const memberEdge of edges) {
      assert.equal(memberEdge.kind, "member-of");
      assert.equal(memberEdge.confidence, "exact");
      assert.equal(memberEdge.to, "a");
    }
    assert.deepEqual(edges.map((entry) => entry.from).sort(), ["a", "b"]);
  });

  test("analyze: summarizes communities with bounded top terms sorted by frequency then term", () => {
    const nodes = [
      typedNode("catalogService", "symbol", "src/catalog-service.ts", "catalogService"),
      typedNode("catalogRepository", "symbol", "src/catalog-repository.ts", "catalogRepository"),
    ];
    const communities = new Map([["catalogService", "catalogService"], ["catalogRepository", "catalogService"]]);
    const summaries = summarizeCommunities(graph(nodes, []), communities);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, "catalogService");
    assert.equal(summaries[0].memberCount, 2);
    assert.deepEqual(summaries[0].members.sort(), ["catalogRepository", "catalogService"]);
    assert.ok(summaries[0].topTerms.includes("catalog"));
    assert.equal(summaries[0].membersTruncated, false);
  });

  test("analyze: findCitingPages returns pages that describe or mention the target, sorted by id, and ignores unrelated pages", () => {
    const nodes = [
      typedNode("page-b", "page", "pages/b.md", "B"),
      typedNode("page-a", "page", "pages/a.md", "A"),
      typedNode("sym", "symbol"),
      typedNode("unrelated-page", "page", "pages/c.md", "C"),
    ];
    const edges = [
      edge("e-describes", "describes", "page-b", "sym", "extracted"),
      edge("e-mentions", "mentions", "page-a", "sym", "inferred"),
      edge("e-other", "describes", "unrelated-page", "page-a", "extracted"),
    ];
    const result = findCitingPages(nodes, edges, "sym");
    assert.deepEqual(result.map((page) => page.id), ["page-a", "page-b"]);
  });
});
