import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeCommunities, confidenceWeight } from "../../dist/analyze.js";

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
