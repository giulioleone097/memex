import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeCommunities, confidenceWeight } from "../../dist/analyze.js";
import { computeGodNodes, computeShortestPath } from "../../dist/analyze.js";

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
});
