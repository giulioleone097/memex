# Memex Slice 2c — Structure Analytics and the Self-Maintaining Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic community detection, god-node/centrality analytics, confidence-weighted shortest-path and node-explanation queries, and a self-maintaining `graph-report.md` wiki page to the unified Memex graph, with full CLI + MCP parity, per `docs/superpowers/specs/2026-07-14-memex-prd.md` §7 slice 2c.

**Architecture:** Three new pure/storage modules — `analyze.ts` (deterministic graph algorithms operating on a full in-memory `CodeGraphV1`), `analysis-store.ts` (a small sibling store, `data/<workspace-id>/analysis/communities.json`, holding the persisted community snapshot), and `report.ts` (pure Markdown rendering) — plumbed into the existing `graph.ts` orchestration layer, `adapter.ts` dispatch, `cli.ts` flags, and `mcp.ts` tool schema, following the exact conventions the `build`/`status`/`query`/`context`/`impact`/`changes`/`map` actions already establish. Community computation and `member-of` edge persistence are triggered by the new `report` action (not `build`), because communities must reflect the *unified* graph (code + concept + page + source planes) after both `build` and 2a's `enrich` have run; `communities`/`explain`/`path` stay cheap, generation-checked reads.

**Tech Stack:** TypeScript (strict, `plugins/openwiki/tsconfig.json`), Node >= 20 built-ins only, `node --test`, eslint (`typescript-eslint` strictTypeChecked), zero new runtime dependencies.

## Global Constraints

- Runtime forbids: network access, model credentials, native compilation, `npm install`, processes beyond Node >= 20 and Git.
- Graph mutation boundary preserved verbatim: analytics read the persisted graph and never execute repository code; the only new write target is `data/<workspace-id>/analysis/communities.json` (sibling to `graph/`) plus a new graph generation carrying `member-of` edges — never outside `~/.openwiki/data/<workspace-id>/`.
- All operations return bounded JSON with stable machine error codes; no new error codes are required for this slice (existing `INVALID_ARGUMENT`, `NOT_FOUND`, `NOT_INITIALIZED`, `INVALID_STATE` cover every failure mode below).
- No `any`, no unchecked casts; discriminated unions + runtime validation for every new persisted contract, matching `graph-contracts.ts`'s hand-rolled validator style.
- `exactOptionalPropertyTypes: true` is enabled: never assign an optional property the literal value `undefined`; use the `...(x === undefined ? {} : { x })` spread idiom already used throughout `graph.ts`/`graph-store.ts`.
- `noUncheckedIndexedAccess: true` is enabled: every array/Map index access is `T | undefined` and must be narrowed before use.
- Silent fallback forbidden: a stale communities snapshot is served with an explicit `stale: true` flag, never silently treated as fresh (matches the existing `graph status` `fresh`/`reason` convention).
- TDD per task: failing test → minimal implementation → pass → commit. Suite: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`.
- Commits: no AI attribution trailers; concrete behavior-focused messages, prefixed `feat(openwiki):`, `test(openwiki):`, or `docs(openwiki):` as appropriate.
- **Binding schema-v2 dependency (slice 2a, assumed already merged):** `graph-contracts.ts` exports
  ```ts
  export type GraphNodeKind = "repository" | "directory" | "file" | "module" | "symbol"
    | "concept" | "page" | "source";
  export type GraphEdgeKind = "contains" | "declares" | "imports" | "exports" | "calls"
    | "inherits" | "implements" | "references"
    | "mentions" | "describes" | "grounds" | "related" | "member-of";
  export type ScannerConfidence = "exact" | "resolved" | "heuristic";
  export type AgentConfidence   = "extracted" | "inferred" | "ambiguous";
  export type GraphConfidence = ScannerConfidence | AgentConfidence;
  ```
  with the validation rule "`member-of` accepts only `\"exact\"`" already enforced by `parseCodeGraph`. Every task below imports these names as-is. **If slice 2a has not actually landed these exact names when this plan is executed, stop and reconcile with the orchestrator before writing any code — do not invent a different schema.**
- Confidence-to-weight mapping (shared with slice 2b's `retrieve.ts`, reused here for `path` and `computeCommunities`): `exact`/`extracted` → `1.0`, `resolved`/`inferred` → `0.7`, `heuristic`/`ambiguous` → `0.4`.
- Label propagation: seeded by ascending node-id order, max 20 iterations, deterministic, ties broken by lexicographically smallest label.
- New graph actions are exactly: `path --from --to`, `explain --target`, `communities`, `report`. No other action name is introduced (deviation requires orchestrator approval per the master plan).

---

## Task 1: `analyze.ts` — deterministic community detection

**Files:**
- Create: `plugins/openwiki/src/analyze.ts`
- Test: `plugins/openwiki/tests/unit/analyze.test.mjs`

**Interfaces:**
- Consumes: `CodeGraphV1`, `GraphConfidence`, `GraphEdgeV1`, `GraphNodeV1` from `./graph-contracts.js`; `OpenWikiError` from `./errors.js`.
- Produces: `confidenceWeight(confidence: GraphConfidence): number` and `computeCommunities(graph: CodeGraphV1): Map<string, string>` (nodeId → communityId, where every communityId is itself an existing node id — the label-propagation "leader"). Both are relied on by Tasks 2, 3, 4, and 6.

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/analyze.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix plugins/openwiki run build 2>&1 | tail -5 ; node --prefix plugins/openwiki --test tests/unit/analyze.test.mjs`
Expected: FAIL — build fails or the test errors with `Cannot find module '../../dist/analyze.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/openwiki/src/analyze.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/unit/analyze.test.mjs`
Expected: PASS (5 tests, 0 failures).

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/analyze.ts tests/unit/analyze.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): add deterministic label-propagation community detection"
```

---

## Task 2: `analyze.ts` — god nodes and confidence-weighted shortest path

**Files:**
- Modify: `plugins/openwiki/src/analyze.ts`
- Modify: `plugins/openwiki/tests/unit/analyze.test.mjs`

**Interfaces:**
- Consumes: `confidenceWeight` from Task 1; `GraphNodeV1` from `./graph-contracts.js`.
- Produces: `computeGodNodes(graph: CodeGraphV1, limit: number): Array<{ nodeId: string; degree: number }>` and `computeShortestPath(graph: CodeGraphV1, from: string, to: string): GraphPathResult | undefined` where `GraphPathResult = { nodeIds: string[]; edgeIds: string[]; totalWeight: number }`. Relied on by Task 6 (report) and Task 8 (path action).

- [ ] **Step 1: Write the failing test**

Append to `plugins/openwiki/tests/unit/analyze.test.mjs` (add the import and the new `describe` block; keep the existing content above it):

```js
import { computeGodNodes, computeShortestPath } from "../../dist/analyze.js";
```

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/unit/analyze.test.mjs`
Expected: FAIL with `computeGodNodes is not a function` (import error).

- [ ] **Step 3: Write the minimal implementation**

Append to `plugins/openwiki/src/analyze.ts` (extend the top import to include `GraphNodeV1`, `GraphEdgeV1` — see the exact final import line in Task 3's Step 3):

```ts
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
```

Also add the `OpenWikiError` import at the top of `analyze.ts`:

```ts
import { OpenWikiError } from "./errors.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/unit/analyze.test.mjs`
Expected: PASS (9 tests, 0 failures).

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/analyze.ts tests/unit/analyze.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): add god-node ranking and confidence-weighted shortest path"
```

---

## Task 3: `analyze.ts` — surprising connections, coverage, suggested questions, member-of synthesis

**Files:**
- Modify: `plugins/openwiki/src/analyze.ts`
- Modify: `plugins/openwiki/tests/unit/analyze.test.mjs`

**Interfaces:**
- Consumes: `createGraphEdgeId`, `GraphEdgeKind`, `GraphEdgeV1` from `./graph-contracts.js`; `CommunitySummaryV1`-shaped input (structurally, not imported — see below) for `computeSuggestedQuestions`.
- Produces: `planeOf(node): "code" | "concept" | "wiki" | "source"`, `computeSurprisingConnections(graph, limit)`, `computeCoverageStats(graph)`, `computeSuggestedQuestions(godNodes, communities, graph)`, `synthesizeMemberOfEdges(graph, communities)`, `summarizeCommunities(graph, communities)`, `findCitingPages(nodes, edges, targetId)`. Relied on by Task 4 (`analysis-store.ts`'s `CommunitySummaryV1` shape must match `summarizeCommunities`'s return element), Task 6 (report orchestration), and Task 9 (`explain`'s citing-pages lookup — extracted here, rather than inlined in `graph.ts`, specifically so it is a pure function directly unit-testable with a hand-built synthetic graph, independent of the lazy graph index; see the Step 1 test below and Task 9's note).

- [ ] **Step 1: Write the failing test**

Append to `plugins/openwiki/tests/unit/analyze.test.mjs`:

```js
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
```

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/unit/analyze.test.mjs`
Expected: FAIL with `planeOf is not a function` (import error).

- [ ] **Step 3: Write the minimal implementation**

Replace the top import line of `plugins/openwiki/src/analyze.ts` with:

```ts
import { createGraphEdgeId, type CodeGraphV1, type GraphConfidence, type GraphEdgeKind, type GraphEdgeV1, type GraphNodeV1 } from "./graph-contracts.js";
import { OpenWikiError } from "./errors.js";
```

Append to `plugins/openwiki/src/analyze.ts`:

```ts
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
const TERM_PATTERN = /[\p{L}\p{N}_$.-]+/gu;

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
```

**Design note — self-loop `member-of` edges are intentional:** `synthesizeMemberOfEdges` gives a community's leader node a `member-of` edge to itself (the test above, "synthesizes one deterministic member-of edge per node," confirms every node — including the leader — gets exactly one such edge, and the leader's points back to its own id). This is correct, not an oversight: there is no dedicated `community` node kind (see Objection 2 in this plan's self-review), so a community's id is always an existing "leader" node's id, and the leader is necessarily a member of its own community. Downstream consumers should read this with that in mind: `explain`'s neighborhood traversal (Task 9) and the report's community table (Task 6) will show a leader node adjacent to itself via `member-of`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/unit/analyze.test.mjs`
Expected: PASS (17 tests, 0 failures).

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/analyze.ts tests/unit/analyze.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): add surprising-connection ranking, coverage stats, and member-of synthesis"
```

---

## Task 4: `analysis-store.ts` — persisted communities snapshot

**Files:**
- Create: `plugins/openwiki/src/analysis-store.ts`
- Test: `plugins/openwiki/tests/unit/analysis-store.test.mjs`

**Interfaces:**
- Consumes: `atomicWriteFile`, `withWikiLock` from `./atomic.js`; `resolveWikiLocation` from `./paths.js`; `OpenWikiError` from `./errors.js`.
- Produces: `CommunitySummaryV1`, `CommunitiesSnapshotV1` (`{ schemaVersion: 1; generation: string; generatedAt: string; communities: CommunitySummaryV1[]; membership: Record<string, string> }`), `AnalysisStorage`, `resolveAnalysisStorage(root, homeDir?)`, `probeAnalysisStorage(root, homeDir?)`, `writeCommunitiesSnapshot(storage, snapshot)`, `readCommunitiesSnapshot(storage)`, `parseCommunitiesSnapshot(value)`. Relied on by Task 6 (write), Task 7 (`communities` read), Task 9 (`explain` community lookup).
- Field shape must exactly match `analyze.ts`'s `CommunitySummary` (Task 3) — same field names (`id`, `memberCount`, `topTerms`, `members`, `membersTruncated`) so `summarizeCommunities`'s output can be persisted without transformation.

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/analysis-store.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { OpenWikiError } from "../../dist/errors.js";
import {
  parseCommunitiesSnapshot,
  probeAnalysisStorage,
  readCommunitiesSnapshot,
  resolveAnalysisStorage,
  writeCommunitiesSnapshot,
} from "../../dist/analysis-store.js";

const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-analysis-store-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("analysis-store: communities snapshot persistence", () => {
  test("analysis-store: reports uninitialized before any snapshot is written", async () => {
    const root = await temporaryRoot("repository");
    await mkdir(root, { recursive: true });
    const home = await temporaryRoot("home");
    const probed = await probeAnalysisStorage(root, home);
    assert.equal(probed.initialized, false);
  });

  test("analysis-store: writes and reads back a snapshot with round-tripped fields", async () => {
    const root = await temporaryRoot("repository");
    await mkdir(root, { recursive: true });
    const home = await temporaryRoot("home");
    const resolved = await resolveAnalysisStorage(root, home);
    const snapshot = {
      schemaVersion: 1,
      generation: "g-abc",
      generatedAt: "2026-07-14T00:00:00.000Z",
      communities: [
        { id: "leader", memberCount: 2, topTerms: ["catalog"], members: ["leader", "member"], membersTruncated: false },
      ],
      membership: { leader: "leader", member: "leader" },
    };
    await writeCommunitiesSnapshot(resolved.storage, snapshot);
    const probed = await probeAnalysisStorage(root, home);
    assert.equal(probed.initialized, true);
    const read = await readCommunitiesSnapshot(resolved.storage);
    assert.deepEqual(read, snapshot);
  });

  test("analysis-store: rejects a malformed snapshot on read", () => {
    assert.throws(() => parseCommunitiesSnapshot({ schemaVersion: 2 }), OpenWikiError);
    assert.throws(() => parseCommunitiesSnapshot({ schemaVersion: 1, generation: "g", generatedAt: "t", communities: [{}], membership: {} }), OpenWikiError);
  });

  test("analysis-store: throws NOT_INITIALIZED reading a missing snapshot", async () => {
    const root = await temporaryRoot("repository");
    await mkdir(root, { recursive: true });
    const home = await temporaryRoot("home");
    const resolved = await resolveAnalysisStorage(root, home);
    await assert.rejects(readCommunitiesSnapshot(resolved.storage), (error) => error instanceof OpenWikiError && error.code === "NOT_INITIALIZED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix plugins/openwiki run build 2>&1 | tail -5 ; node --prefix plugins/openwiki --test tests/unit/analysis-store.test.mjs`
Expected: FAIL — `Cannot find module '../../dist/analysis-store.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/openwiki/src/analysis-store.ts`:

```ts
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, withWikiLock } from "./atomic.js";
import { OpenWikiError } from "./errors.js";
import { resolveWikiLocation } from "./paths.js";

// Field shape kept in sync by hand with CommunitySummary in analyze.ts (Task 3); if one gains/loses a field,
// update the other to match.
export interface CommunitySummaryV1 {
  id: string;
  memberCount: number;
  topTerms: string[];
  members: string[];
  membersTruncated: boolean;
}

export interface CommunitiesSnapshotV1 {
  schemaVersion: 1;
  generation: string;
  generatedAt: string;
  communities: CommunitySummaryV1[];
  membership: Record<string, string>;
}

export interface AnalysisStorage {
  root: string;
  manifestPath: string;
}

export async function resolveAnalysisStorage(root: string, homeDir?: string): Promise<{ storage: AnalysisStorage; workspaceId: string }> {
  const location = await resolveWikiLocation({ mode: "code", root, ...(homeDir === undefined ? {} : { homeDir }) });
  const analysisRoot = path.join(location.dataRoot, "analysis");
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 });
  return { workspaceId: location.workspaceId, storage: { root: analysisRoot, manifestPath: path.join(analysisRoot, "communities.json") } };
}

export async function probeAnalysisStorage(root: string, homeDir?: string): Promise<{ initialized: boolean; storage: AnalysisStorage }> {
  const resolved = await resolveAnalysisStorage(root, homeDir);
  try {
    await readFile(resolved.storage.manifestPath, "utf8");
    return { initialized: true, storage: resolved.storage };
  } catch {
    return { initialized: false, storage: resolved.storage };
  }
}

export async function writeCommunitiesSnapshot(storage: AnalysisStorage, snapshot: CommunitiesSnapshotV1): Promise<void> {
  await withWikiLock(storage.root, async () => {
    await atomicWriteFile(storage.manifestPath, `${JSON.stringify(snapshot)}\n`);
  });
}

export async function readCommunitiesSnapshot(storage: AnalysisStorage): Promise<CommunitiesSnapshotV1> {
  let raw: string;
  try {
    raw = await readFile(storage.manifestPath, "utf8");
  } catch {
    throw new OpenWikiError("NOT_INITIALIZED", "No recoverable OpenWiki communities snapshot exists.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenWikiError("INVALID_STATE", "Communities snapshot is invalid JSON.");
  }
  return parseCommunitiesSnapshot(parsed);
}

export function parseCommunitiesSnapshot(value: unknown): CommunitiesSnapshotV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.generation !== "string" ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.communities) ||
    !isRecord(value.membership)
  ) {
    throw new OpenWikiError("INVALID_STATE", "Communities snapshot schema is invalid.");
  }
  const membership: Record<string, string> = {};
  for (const [nodeId, communityId] of Object.entries(value.membership)) {
    if (typeof communityId !== "string") {
      throw new OpenWikiError("INVALID_STATE", "Communities snapshot membership is invalid.");
    }
    membership[nodeId] = communityId;
  }
  return {
    schemaVersion: 1,
    generation: value.generation,
    generatedAt: value.generatedAt,
    communities: value.communities.map(parseCommunitySummary),
    membership,
  };
}

function parseCommunitySummary(value: unknown): CommunitySummaryV1 {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !nonNegativeInteger(value.memberCount) ||
    !Array.isArray(value.topTerms) ||
    !value.topTerms.every((term) => typeof term === "string") ||
    !Array.isArray(value.members) ||
    !value.members.every((member) => typeof member === "string") ||
    typeof value.membersTruncated !== "boolean"
  ) {
    throw new OpenWikiError("INVALID_STATE", "Community summary is invalid.");
  }
  return { id: value.id, memberCount: value.memberCount, topTerms: value.topTerms, members: value.members, membersTruncated: value.membersTruncated };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/unit/analysis-store.test.mjs`
Expected: PASS (4 tests, 0 failures).

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/analysis-store.ts tests/unit/analysis-store.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): add persisted communities snapshot store"
```

---

## Task 5: `report.ts` — Markdown rendering

**Files:**
- Create: `plugins/openwiki/src/report.ts`
- Test: `plugins/openwiki/tests/unit/report.test.mjs`

**Interfaces:**
- Consumes: `GraphConfidence`, `GraphEdgeKind`, `GraphEdgeV1`, `GraphNodeV1` from `./graph-contracts.js`; `CommunitySummaryV1` from `./analysis-store.js`.
- Produces: `GraphReportInputV1` and `renderGraphReportMarkdown(input: GraphReportInputV1): string`. Relied on by Task 6.

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/report.test.mjs`:

```js
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderGraphReportMarkdown } from "../../dist/report.js";

function node(id, kind, path, name) {
  return { id, kind, path, name };
}

describe("report: graph-report.md rendering", () => {
  test("report: renders every required section with real content", () => {
    const markdown = renderGraphReportMarkdown({
      root: "/repo",
      generation: "g-abc",
      generatedAt: "2026-07-14T00:00:00.000Z",
      godNodes: [{ node: node("hub", "symbol", "src/hub.ts", "hub"), degree: 7 }],
      communities: [{ id: "hub", memberCount: 3, topTerms: ["hub", "service"], members: ["hub"], membersTruncated: false }],
      surprisingConnections: [
        {
          from: node("concept-a", "concept", "concepts/a.md", "Catalog"),
          to: node("sym-a", "symbol", "src/catalog.ts", "listActiveProducts"),
          kind: "mentions",
          confidence: "extracted",
          priority: "concept-code",
        },
      ],
      suggestedQuestions: ["What depends on hub (src/hub.ts), and what would break if it changed?"],
      coverage: { totalCodeNodes: 10, describedCodeNodes: 4, coverageRatio: 0.4 },
      ambiguousEdges: [{ edge: { id: "e-amb", kind: "related", from: "concept-a", to: "concept-b", confidence: "ambiguous" }, from: node("concept-a", "concept", "concepts/a.md", "Catalog"), to: undefined }],
    });

    assert.match(markdown, /^# Graph Report/u);
    assert.match(markdown, /## God nodes/u);
    assert.match(markdown, /hub.*7/u);
    assert.match(markdown, /## Communities/u);
    assert.match(markdown, /hub, service/u);
    assert.match(markdown, /## Surprising connections/u);
    assert.match(markdown, /Catalog.*listActiveProducts|listActiveProducts.*Catalog/u);
    assert.match(markdown, /concept-code/u);
    assert.match(markdown, /## Suggested questions/u);
    assert.match(markdown, /What depends on hub/u);
    assert.match(markdown, /## Coverage/u);
    assert.match(markdown, /4 of 10 code nodes/u);
    assert.match(markdown, /## Ambiguous edges pending review/u);
    assert.match(markdown, /Catalog.*concept-b|concept-b.*Catalog/u);
    assert.match(markdown, /g-abc/u);
  });

  test("report: renders explicit empty-state text for every empty section", () => {
    const markdown = renderGraphReportMarkdown({
      root: "/repo",
      generation: "g-empty",
      generatedAt: "2026-07-14T00:00:00.000Z",
      godNodes: [],
      communities: [],
      surprisingConnections: [],
      suggestedQuestions: [],
      coverage: { totalCodeNodes: 0, describedCodeNodes: 0, coverageRatio: 0 },
      ambiguousEdges: [],
    });
    assert.match(markdown, /No god nodes identified yet\./u);
    assert.match(markdown, /No communities identified yet\./u);
    assert.match(markdown, /No cross-plane connections identified yet\./u);
    assert.match(markdown, /No suggested questions yet\./u);
    assert.match(markdown, /No ambiguous edges pending review\./u);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix plugins/openwiki run build 2>&1 | tail -5 ; node --prefix plugins/openwiki --test tests/unit/report.test.mjs`
Expected: FAIL — `Cannot find module '../../dist/report.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/openwiki/src/report.ts`:

```ts
import type { GraphConfidence, GraphEdgeKind, GraphEdgeV1, GraphNodeV1 } from "./graph-contracts.js";
import type { CommunitySummaryV1 } from "./analysis-store.js";

export interface GraphReportInputV1 {
  root: string;
  generation: string;
  generatedAt: string;
  godNodes: Array<{ node: GraphNodeV1; degree: number }>;
  communities: CommunitySummaryV1[];
  surprisingConnections: Array<{ from: GraphNodeV1; to: GraphNodeV1; kind: GraphEdgeKind; confidence: GraphConfidence; priority: "concept-code" | "cross-plane" }>;
  suggestedQuestions: string[];
  coverage: { totalCodeNodes: number; describedCodeNodes: number; coverageRatio: number };
  ambiguousEdges: Array<{ edge: GraphEdgeV1; from: GraphNodeV1 | undefined; to: GraphNodeV1 | undefined }>;
}

export function renderGraphReportMarkdown(input: GraphReportInputV1): string {
  const lines: string[] = [];
  lines.push("# Graph Report");
  lines.push("");
  lines.push(
    `Generated ${input.generatedAt} from graph generation \`${input.generation}\`. This page is regenerated by \`update\` via \`graph --action report\`; do not edit it by hand.`,
  );
  lines.push("");

  lines.push("## God nodes");
  lines.push("");
  if (input.godNodes.length === 0) {
    lines.push("No god nodes identified yet.");
  } else {
    lines.push("| Node | Path | Degree |");
    lines.push("| --- | --- | --- |");
    for (const godNode of input.godNodes) {
      lines.push(`| ${godNode.node.name} | ${godNode.node.path} | ${String(godNode.degree)} |`);
    }
  }
  lines.push("");

  lines.push("## Communities");
  lines.push("");
  if (input.communities.length === 0) {
    lines.push("No communities identified yet.");
  } else {
    lines.push("| Community | Members | Top terms |");
    lines.push("| --- | --- | --- |");
    for (const community of input.communities) {
      lines.push(`| ${community.id} | ${String(community.memberCount)} | ${community.topTerms.join(", ") || "(none)"} |`);
    }
  }
  lines.push("");

  lines.push("## Surprising connections");
  lines.push("");
  if (input.surprisingConnections.length === 0) {
    lines.push("No cross-plane connections identified yet.");
  } else {
    lines.push("| From | To | Kind | Confidence | Priority |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const connection of input.surprisingConnections) {
      lines.push(
        `| ${connection.from.name} (${connection.from.path}) | ${connection.to.name} (${connection.to.path}) | ${connection.kind} | ${connection.confidence} | ${connection.priority} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Suggested questions");
  lines.push("");
  if (input.suggestedQuestions.length === 0) {
    lines.push("No suggested questions yet.");
  } else {
    for (const question of input.suggestedQuestions) {
      lines.push(`- ${question}`);
    }
  }
  lines.push("");

  lines.push("## Coverage");
  lines.push("");
  lines.push(
    `${String(input.coverage.describedCodeNodes)} of ${String(input.coverage.totalCodeNodes)} code nodes are described by a wiki page or concept (${(input.coverage.coverageRatio * 100).toFixed(1)}%).`,
  );
  lines.push("");

  lines.push("## Ambiguous edges pending review");
  lines.push("");
  if (input.ambiguousEdges.length === 0) {
    lines.push("No ambiguous edges pending review.");
  } else {
    lines.push("| From | To | Kind |");
    lines.push("| --- | --- | --- |");
    for (const entry of input.ambiguousEdges) {
      lines.push(`| ${entry.from?.name ?? entry.edge.from} | ${entry.to?.name ?? entry.edge.to} | ${entry.edge.kind} |`);
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/unit/report.test.mjs`
Expected: PASS (2 tests, 0 failures).

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/report.ts tests/unit/report.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): render the graph-report.md markdown page"
```

---

## Task 6: `graph.ts` — wire the `report` action (compute, persist, render, write)

**Files:**
- Modify: `plugins/openwiki/src/graph.ts`
- Create: `plugins/openwiki/tests/integration/graph-index-v2-precondition.test.mjs` (Step 0 — gates this task and Task 9 on slice 2a's `graph-index.ts` guard widening; see the Critical finding in this plan's review history)
- Create: `plugins/openwiki/tests/integration/graph-analytics.test.mjs`

**Interfaces:**
- Consumes: `computeCommunities`, `computeCoverageStats`, `computeGodNodes`, `computeSuggestedQuestions`, `computeSurprisingConnections`, `summarizeCommunities`, `synthesizeMemberOfEdges` from `./analyze.js`; `resolveAnalysisStorage`, `writeCommunitiesSnapshot` from `./analysis-store.js`; `renderGraphReportMarkdown` from `./report.js`; `writePage` from `./wiki.js`; `resolveWikiLocation` from `./paths.js`; existing `canonicalizeGraph`, `readGraphShard`, `readManifest`, `readStoredGraph`, `resolveGraphStorage`, `writeGraph` from `graph-store.js`/`graph-contracts.js` (already imported in `graph.ts`). For Step 0 only: `openGraphIndex`, `resolveGraphStorage`, `writeGraph` from `graph-store.js` and `createGraphEdgeId`, `createGraphNodeId` from `graph-contracts.js` — all already exported today; Step 0 exercises them directly against a hand-built schema-v2 graph and makes no production code change.
- Produces: `renderGraphReport(options: GraphOperationBase & { now?: string }): Promise<GraphReportEnvelope>` where `GraphReportEnvelope = { schemaVersion: 1; action: "report"; root: string; page: "graph-report.md"; written: true; communityCount: number; godNodeCount: number; surprisingConnectionCount: number; ambiguousEdgeCount: number; coverageRatio: number; generation: string; generatedAt: string }`. Relied on by Task 10 (adapter dispatch).

**Design note (read before implementing):** community computation and `member-of` persistence live in `report`, not `build`, because communities must reflect the whole unified graph (code + concept/page/source planes from 2a's `enrich`), and `build` only assembles the code plane. `report` reads whatever the currently persisted graph is (via the same `readStoredGraph` the existing `buildGraph` already uses for diffing), regardless of whether `build` or `enrich` wrote it last. Re-running `report` with no repository changes is idempotent and byte-identical (member-of edges are excluded from `computeCommunities`'s own input, so recomputing on a graph that already has them produces the same edges, and `writeGraph` treats an unchanged canonical graph as an already-published generation — no new generation is created).

- [ ] **Step 0: Precondition — verify slice 2a has widened `graph-index.ts`'s lazy-index guards for the schema-v2 vocabulary**

`report`'s `member-of` edges (this task) and `explain`'s citing-pages/community lookups (Task 9) are read back through the *lazy, bucketed* graph index (`openGraphIndex` → `GraphIndexPort.node`/`edge`/`inbound`/`outbound`/`architectureSummary`), not through `readStoredGraph`'s full-graph path. That index has its own, independent kind/confidence validation in `plugins/openwiki/src/graph-index.ts`. Slice 2a's plan (`docs/superpowers/plans/2026-07-14-memex-plan-2a.md`, Task 3) is responsible for widening that validation from the five original node kinds / eight original edge kinds / three scanner confidences to the full schema-v2 vocabulary (`concept`/`page`/`source` nodes; `mentions`/`describes`/`grounds`/`related`/`member-of` edges; `extracted`/`inferred`/`ambiguous` agent confidences), by importing and reusing `isGraphNodeKind`/`isGraphEdgeKind`/`isGraphConfidence` from `graph-contracts.ts` (2a Task 1) instead of `graph-index.ts`'s own hand-rolled guards. **This plan does not implement that widening — it is out of scope for 2c and owned by 2a's Task 3.** This step exists solely to prove, with a real test against the real code (not by trusting 2a's plan text), that the widening has actually landed before any of this task's own code depends on it, and to fail fast with an actionable message if it has not.

Create `plugins/openwiki/tests/integration/graph-index-v2-precondition.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { createGraphEdgeId, createGraphNodeId } from "../../dist/graph-contracts.js";
import { openGraphIndex, resolveGraphStorage, writeGraph } from "../../dist/graph-store.js";
import { OpenWikiError } from "../../dist/errors.js";

const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-graph-index-v2-precondition-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph analytics: precondition (slice 2a schema-v2 index widening)", () => {
  test("precondition: the lazy bucketed graph index reads back schema-v2 node kinds, edge kinds, and agent confidences without INVALID_STATE", async () => {
    const root = await temporaryRoot("repository");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);

    const repositoryId = createGraphNodeId("repository", ".", "repository");
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const conceptId = createGraphNodeId("concept", "concepts/x.md", "x");
    const sourceId = createGraphNodeId("source", "docs/spec.md", "spec");
    const describesId = createGraphEdgeId("describes", pageId, conceptId, "extracted");
    const mentionsId = createGraphEdgeId("mentions", conceptId, repositoryId, "inferred");
    const relatedId = createGraphEdgeId("related", conceptId, sourceId, "ambiguous");
    const memberOfId = createGraphEdgeId("member-of", conceptId, repositoryId, "exact");

    const graph = {
      schemaVersion: 2,
      workspaceId: resolved.workspaceId,
      generatedAt: "2026-07-14T00:00:00.000Z",
      source: { dirtyFingerprint: "a".repeat(64), scannerVersion: "openwiki-graph-v1" },
      files: [],
      nodes: [
        { id: repositoryId, kind: "repository", path: ".", name: "repository" },
        { id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" },
        { id: conceptId, kind: "concept", path: "concepts/x.md", name: "x" },
        { id: sourceId, kind: "source", path: "docs/spec.md", name: "spec" },
      ],
      edges: [
        { id: describesId, kind: "describes", from: pageId, to: conceptId, confidence: "extracted" },
        { id: mentionsId, kind: "mentions", from: conceptId, to: repositoryId, confidence: "inferred" },
        { id: relatedId, kind: "related", from: conceptId, to: sourceId, confidence: "ambiguous" },
        { id: memberOfId, kind: "member-of", from: conceptId, to: repositoryId, confidence: "exact" },
      ],
      diagnostics: [],
    };

    try {
      await writeGraph(resolved.storage, graph, []);
      const index = await openGraphIndex(resolved.storage);
      await index.node(conceptId);
      await index.edge(describesId);
      await index.edge(mentionsId);
      await index.edge(relatedId);
      await index.edge(memberOfId);
      await index.inbound(conceptId, 10);
      await index.outbound(conceptId, 10);
      await index.architectureSummary();
    } catch (error) {
      if (error instanceof OpenWikiError && error.code === "INVALID_STATE") {
        throw new Error(
          "PRECONDITION FAILED: graph-index.ts's lazy-index kind/confidence guards do not yet accept the schema-v2 " +
            "vocabulary (concept/page/source node kinds; mentions/describes/grounds/related/member-of edge kinds; " +
            "extracted/inferred/ambiguous agent confidences). Slice 2c's report/explain actions cannot pass without " +
            "this. This plan does not widen those guards itself — that is owned by slice 2a's plan " +
            "(docs/superpowers/plans/2026-07-14-memex-plan-2a.md, Task 3, which imports isGraphNodeKind/isGraphEdgeKind/" +
            "isGraphConfidence from graph-contracts.ts). Land slice 2a's Task 3 first, then re-run this test before " +
            "proceeding with Task 6's Step 1 or any later task in this plan.",
          { cause: error },
        );
      }
      throw error;
    }
  });
});
```

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/integration/graph-index-v2-precondition.test.mjs`
Expected: PASS (1 test, 0 failures) once slice 2a's Task 3 has landed. If it fails with the `PRECONDITION FAILED` message above, stop — do not proceed with this task's Step 1, or any later task in this plan, until slice 2a's guard-widening is merged and this test passes. This is the reproducible defect the orchestrator adjudicated as blocking Task 6 and Task 9 until resolved (schema-v2 `member-of`/`concept`/`page`/`source` reads throwing `INVALID_STATE` through the lazy index).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/integration/graph-analytics.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { OpenWikiError } from "../../dist/errors.js";
import { buildGraph, renderGraphReport } from "../../dist/graph.js";
import { readPage } from "../../dist/wiki.js";
import { initializeWiki } from "../../dist/wiki.js";
import { resolveWikiLocation } from "../../dist/paths.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-graph-analytics-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await temporaryRoot("repository");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "openwiki@example.test"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "hub.ts"), "export function hub() { return 1; }\n");
  await writeFile(path.join(root, "src", "leaf.ts"), "import { hub } from './hub'; export function leaf() { return hub(); }\n");
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "initial graph"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph analytics: report action", () => {
  test("graph: report computes communities, persists member-of edges, and writes graph-report.md", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const result = await renderGraphReport({ root, homeDir });
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.action, "report");
    assert.equal(result.page, "graph-report.md");
    assert.equal(result.written, true);
    assert.ok(result.communityCount >= 1);
    assert.ok(result.godNodeCount >= 1);
    assert.equal(typeof result.coverageRatio, "number");
    assert.match(result.generation, /^g-[a-f0-9]{64}$/u);
    assert.equal(Number.isNaN(Date.parse(result.generatedAt)), false);

    const location = await resolveWikiLocation({ mode: "code", root, homeDir });
    const page = await readPage(location, "graph-report.md");
    assert.match(page.content, /^# Graph Report/u);
    assert.match(page.content, /## God nodes/u);
    assert.match(page.content, /## Communities/u);
    assert.match(page.content, /## Surprising connections/u);
    assert.match(page.content, /## Suggested questions/u);
    assert.match(page.content, /## Coverage/u);
    assert.match(page.content, /## Ambiguous edges pending review/u);
  });

  test("graph: report is idempotent — a second run with no repository changes reuses the same generation", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const first = await renderGraphReport({ root, homeDir });
    const second = await renderGraphReport({ root, homeDir });
    assert.equal(first.generation, second.generation);
    assert.equal(first.communityCount, second.communityCount);
  });

  test("graph: report fails with NOT_INITIALIZED when no graph has been built yet", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await assert.rejects(renderGraphReport({ root, homeDir }), (error) => error instanceof OpenWikiError && error.code === "NOT_INITIALIZED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix plugins/openwiki run build 2>&1 | tail -5 ; node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: FAIL — `renderGraphReport is not a function` (import error).

- [ ] **Step 3: Write the minimal implementation**

In `plugins/openwiki/src/graph.ts`, change the import block at the top (lines 1–19) to add the new imports. Replace:

```ts
import path from "node:path";

import {
  GRAPH_DEFAULTS,
  GRAPH_SCANNER_VERSION,
  canonicalizeGraph,
  createGraphEdgeId,
  createGraphNodeId,
  type CodeGraphV1,
  type GraphDiagnosticV1,
  type GraphEdgeKind,
  type GraphEdgeV1,
  type GraphNodeV1,
} from "./graph-contracts.js";
import { entityLimit, responseLimit, type GraphResult, type ImpactResult } from "./graph-query.js";
import { changedRepositoryEvidence, currentGitFingerprint, enumerateRepositoryMetadata, openGraphIndex, probeGraphStorage, readGraphShard, readManifest, readRepositoryFile, readStoredGraph, repositoryMetadataFingerprint, resolveGraphStorage, resolveRepositorySourceIds, writeGraph, type GraphShard } from "./graph-store.js";
import type { GraphIndexPort } from "./graph-index.js";
import { scanSourceFile } from "./graph-scan.js";
import { OpenWikiError } from "./errors.js";
```

with:

```ts
import path from "node:path";

import {
  GRAPH_DEFAULTS,
  GRAPH_SCANNER_VERSION,
  canonicalizeGraph,
  createGraphEdgeId,
  createGraphNodeId,
  type CodeGraphV1,
  type GraphConfidence,
  type GraphDiagnosticV1,
  type GraphEdgeKind,
  type GraphEdgeV1,
  type GraphNodeV1,
} from "./graph-contracts.js";
import { entityLimit, responseLimit, type GraphResult, type ImpactResult } from "./graph-query.js";
import { changedRepositoryEvidence, currentGitFingerprint, enumerateRepositoryMetadata, openGraphIndex, probeGraphStorage, readGraphShard, readManifest, readRepositoryFile, readStoredGraph, repositoryMetadataFingerprint, resolveGraphStorage, resolveRepositorySourceIds, writeGraph, type GraphShard } from "./graph-store.js";
import type { GraphIndexPort } from "./graph-index.js";
import { scanSourceFile } from "./graph-scan.js";
import {
  computeCommunities,
  computeCoverageStats,
  computeGodNodes,
  computeSuggestedQuestions,
  computeSurprisingConnections,
  summarizeCommunities,
  synthesizeMemberOfEdges,
} from "./analyze.js";
import { resolveAnalysisStorage, writeCommunitiesSnapshot } from "./analysis-store.js";
import { renderGraphReportMarkdown } from "./report.js";
import { resolveWikiLocation } from "./paths.js";
import { writePage } from "./wiki.js";
import { OpenWikiError } from "./errors.js";

const GOD_NODE_LIMIT = 20;
const SURPRISING_CONNECTION_LIMIT = 20;
const AMBIGUOUS_EDGE_LIMIT = 50;
```

Append to the end of `plugins/openwiki/src/graph.ts`:

```ts
export interface GraphReportOptions extends GraphOperationBase {
  now?: string;
}

export interface GraphReportEnvelope {
  schemaVersion: 1;
  action: "report";
  root: string;
  page: "graph-report.md";
  written: true;
  communityCount: number;
  godNodeCount: number;
  surprisingConnectionCount: number;
  ambiguousEdgeCount: number;
  coverageRatio: number;
  generation: string;
  generatedAt: string;
}

export async function renderGraphReport(options: GraphReportOptions): Promise<GraphReportEnvelope> {
  const resolved = await resolveGraphStorage(options.root, options.homeDir);
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- report recomputes structural analytics over the full unified graph, not a bounded query path.
  const baseGraph = await readStoredGraph(resolved.storage);
  const manifest = await readManifest(resolved.storage);
  const shards = await Promise.all(manifest.shards.map((entry) => readGraphShard(resolved.storage, entry.shard)));

  const communities = computeCommunities(baseGraph);
  const memberOfEdges = synthesizeMemberOfEdges(baseGraph, communities);
  const existingEdgeIds = new Set(baseGraph.edges.map((edge) => edge.id));
  const mergedEdges = [...baseGraph.edges, ...memberOfEdges.filter((edge) => !existingEdgeIds.has(edge.id))];
  const graphWithCommunities = canonicalizeGraph({ ...baseGraph, edges: mergedEdges });

  await writeGraph(resolved.storage, graphWithCommunities, shards);
  const updatedManifest = await readManifest(resolved.storage);

  const nodesById = new Map(graphWithCommunities.nodes.map((node) => [node.id, node]));
  const godNodes = computeGodNodes(graphWithCommunities, GOD_NODE_LIMIT);
  const godNodeEntries = godNodes
    .map((entry) => ({ node: nodesById.get(entry.nodeId), degree: entry.degree }))
    .filter((entry): entry is { node: GraphNodeV1; degree: number } => entry.node !== undefined);
  const communitySummaries = summarizeCommunities(graphWithCommunities, communities);
  const membership = Object.fromEntries(communities);

  const generatedAt = options.now ?? new Date().toISOString();
  const analysisResolved = await resolveAnalysisStorage(options.root, options.homeDir);
  await writeCommunitiesSnapshot(analysisResolved.storage, {
    schemaVersion: 1,
    generation: updatedManifest.generation,
    generatedAt,
    communities: communitySummaries,
    membership,
  });

  const surprisingConnections = computeSurprisingConnections(graphWithCommunities, SURPRISING_CONNECTION_LIMIT)
    .map((connection) => ({ from: nodesById.get(connection.from), to: nodesById.get(connection.to), kind: connection.kind, confidence: connection.confidence, priority: connection.priority }))
    .filter((entry): entry is { from: GraphNodeV1; to: GraphNodeV1; kind: GraphEdgeKind; confidence: GraphConfidence; priority: "concept-code" | "cross-plane" } => entry.from !== undefined && entry.to !== undefined);
  const coverage = computeCoverageStats(graphWithCommunities);
  const suggestedQuestions = computeSuggestedQuestions(godNodes, communitySummaries, graphWithCommunities);
  const ambiguousEdges = graphWithCommunities.edges
    .filter((edge) => edge.confidence === "ambiguous")
    .slice(0, AMBIGUOUS_EDGE_LIMIT)
    .map((edge) => ({ edge, from: nodesById.get(edge.from), to: nodesById.get(edge.to) }));

  const markdown = renderGraphReportMarkdown({
    root: resolved.repositoryRoot,
    generation: updatedManifest.generation,
    generatedAt,
    godNodes: godNodeEntries,
    communities: communitySummaries,
    surprisingConnections,
    suggestedQuestions,
    coverage,
    ambiguousEdges,
  });

  const location = await resolveWikiLocation({ mode: "code", root: options.root, ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }) });
  await writePage(location, "graph-report.md", markdown);

  return {
    schemaVersion: 1,
    action: "report",
    root: resolved.repositoryRoot,
    page: "graph-report.md",
    written: true,
    communityCount: communitySummaries.length,
    godNodeCount: godNodeEntries.length,
    surprisingConnectionCount: surprisingConnections.length,
    ambiguousEdgeCount: ambiguousEdges.length,
    coverageRatio: coverage.coverageRatio,
    generation: updatedManifest.generation,
    generatedAt,
  };
}
```

Note: this task's import edit adds only the symbols its own code above actually uses (`computeCommunities`, `computeCoverageStats`, `computeGodNodes`, `computeSuggestedQuestions`, `computeSurprisingConnections`, `summarizeCommunities`, `synthesizeMemberOfEdges`, `GraphConfidence`, `resolveAnalysisStorage`, `writeCommunitiesSnapshot`), so this task's own Step 5 lint run passes standalone with no conditional escape hatch. `computeShortestPath` (from `./analyze.js`) and `matchTargets` (from `./graph-query.js`) are added by Task 8, the first task that consumes them; `probeAnalysisStorage`, `readCommunitiesSnapshot`, and `type CommunitySummaryV1` (from `./analysis-store.js`) are added by Task 7, the first task that consumes them. Each task widens exactly the import line it needs — no task pre-loads a symbol only a later task consumes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: PASS (3 tests, 0 failures).

- [ ] **Step 5: Typecheck, lint, and full regression**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS, no regressions in the pre-existing suite (in particular `tests/unit/graph.test.mjs` and `tests/integration/graph-repository.test.mjs`, which exercise `buildGraph`/`getArchitectureMap` unchanged by this task).

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/graph.ts tests/integration/graph-analytics.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): wire the graph report action end to end"
```

---

## Task 7: `graph.ts` — wire the `communities` read action

**Files:**
- Modify: `plugins/openwiki/src/graph.ts`
- Modify: `plugins/openwiki/tests/integration/graph-analytics.test.mjs`

**Interfaces:**
- Consumes: `probeAnalysisStorage`, `readCommunitiesSnapshot`, `CommunitySummaryV1` (Task 4 — this task's own edit widens the `./analysis-store.js` import Task 6 added, since Task 6 does not use these three); `resolveGraphStorage`, `readManifest` (existing).
- Produces: `listGraphCommunities(options: GraphOperationBase): Promise<GraphCommunitiesEnvelope>` where `GraphCommunitiesEnvelope = { schemaVersion: 1; action: "communities"; root: string; communities: CommunitySummaryV1[]; stale: boolean; generation?: string; generatedAt?: string; truncated: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `plugins/openwiki/tests/integration/graph-analytics.test.mjs` (add `listGraphCommunities` to the existing `graph.js` import):

```js
import { buildGraph, listGraphCommunities, renderGraphReport } from "../../dist/graph.js";
```

```js
describe("graph analytics: communities action", () => {
  test("graph: communities lists the persisted snapshot with a fresh flag when generations match", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    const report = await renderGraphReport({ root, homeDir });

    const communities = await listGraphCommunities({ root, homeDir });
    assert.equal(communities.schemaVersion, 1);
    assert.equal(communities.action, "communities");
    assert.equal(communities.stale, false);
    assert.equal(communities.generation, report.generation);
    assert.ok(communities.communities.length >= 1);
    for (const community of communities.communities) {
      assert.equal(typeof community.id, "string");
      assert.ok(Number.isInteger(community.memberCount) && community.memberCount >= 1);
      assert.ok(Array.isArray(community.topTerms));
    }
  });

  test("graph: communities reports stale when the graph is rebuilt after the last report", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    await renderGraphReport({ root, homeDir });

    await writeFile(path.join(root, "src", "leaf.ts"), "import { hub } from './hub'; export function leaf() { return hub() + 1; }\n");
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "-m", "second commit"]);
    await buildGraph({ root, homeDir, force: true });

    const communities = await listGraphCommunities({ root, homeDir });
    assert.equal(communities.stale, true);
  });

  test("graph: communities returns an empty, stale result before any report has run", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const communities = await listGraphCommunities({ root, homeDir });
    assert.deepEqual(communities.communities, []);
    assert.equal(communities.stale, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: FAIL — `listGraphCommunities is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `plugins/openwiki/src/graph.ts`, widen the `./analysis-store.js` import Task 6 added (this task is the first to consume `probeAnalysisStorage`, `readCommunitiesSnapshot`, and the `CommunitySummaryV1` type). Replace:

```ts
import { resolveAnalysisStorage, writeCommunitiesSnapshot } from "./analysis-store.js";
```

with:

```ts
import { probeAnalysisStorage, readCommunitiesSnapshot, resolveAnalysisStorage, writeCommunitiesSnapshot, type CommunitySummaryV1 } from "./analysis-store.js";
```

Append to `plugins/openwiki/src/graph.ts`:

```ts
export interface GraphCommunitiesEnvelope {
  schemaVersion: 1;
  action: "communities";
  root: string;
  communities: CommunitySummaryV1[];
  stale: boolean;
  generation?: string;
  generatedAt?: string;
  truncated: boolean;
}

export async function listGraphCommunities(options: GraphOperationBase): Promise<GraphCommunitiesEnvelope> {
  const resolved = await resolveGraphStorage(options.root, options.homeDir);
  const analysis = await probeAnalysisStorage(options.root, options.homeDir);
  if (!analysis.initialized) {
    return { schemaVersion: 1, action: "communities", root: resolved.repositoryRoot, communities: [], stale: true, truncated: false };
  }
  const snapshot = await readCommunitiesSnapshot(analysis.storage);
  const manifest = await readManifest(resolved.storage).catch(() => undefined);
  const stale = manifest === undefined || manifest.generation !== snapshot.generation;
  const max = entityLimit(options.limit);
  const truncated = snapshot.communities.length > max;
  return {
    schemaVersion: 1,
    action: "communities",
    root: resolved.repositoryRoot,
    communities: snapshot.communities.slice(0, max),
    stale,
    generation: snapshot.generation,
    generatedAt: snapshot.generatedAt,
    truncated,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: PASS (6 tests, 0 failures).

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/graph.ts tests/integration/graph-analytics.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): wire the graph communities read action with staleness reporting"
```

---

## Task 8: `graph.ts` — wire the `path` action

**Files:**
- Modify: `plugins/openwiki/src/graph.ts`
- Modify: `plugins/openwiki/tests/integration/graph-analytics.test.mjs`

**Interfaces:**
- Consumes: `computeShortestPath` (Task 2 — this task's own edit adds it to the `./analyze.js` import Task 6 added, since Task 6 does not use it); `matchTargets` (existing `graph-query.js` export — this task's own edit adds it to the `./graph-query.js` import, since Task 6 does not use it either).
- Produces: `getGraphPath(options: GraphPathOptions): Promise<GraphPathEnvelope>` where `GraphPathOptions extends GraphOperationBase { from: string; to: string }` and `GraphPathEnvelope = { schemaVersion: 1; action: "path"; root: string; from: string; to: string; found: boolean; nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; totalWeight?: number; truncated: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `plugins/openwiki/tests/integration/graph-analytics.test.mjs` (add `getGraphPath` to the `graph.js` import):

```js
import { buildGraph, getGraphPath, listGraphCommunities, renderGraphReport } from "../../dist/graph.js";
```

```js
describe("graph analytics: path action", () => {
  test("graph: path finds a deterministic confidence-weighted route between two symbols", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const first = await getGraphPath({ root, homeDir, from: "leaf", to: "hub" });
    const second = await getGraphPath({ root, homeDir, from: "leaf", to: "hub" });
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.action, "path");
    assert.equal(first.found, true);
    assert.ok(first.nodes.some((candidate) => candidate.name === "leaf"));
    assert.ok(first.nodes.some((candidate) => candidate.name === "hub"));
    assert.deepEqual(first, second);
  });

  test("graph: path reports found:false for two real but disconnected targets", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await writeFile(path.join(root, "src", "island.ts"), "export function island() { return 0; }\n");
    await git(root, ["add", "--all"]);
    await git(root, ["commit", "-m", "add island"]);
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const result = await getGraphPath({ root, homeDir, from: "island", to: "hub" });
    assert.equal(result.found, false);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
  });

  test("graph: path rejects an unknown endpoint with NOT_FOUND", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    await assert.rejects(getGraphPath({ root, homeDir, from: "hub", to: "doesNotExist" }), (error) => error instanceof OpenWikiError && error.code === "NOT_FOUND");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: FAIL — `getGraphPath is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `plugins/openwiki/src/graph.ts`, widen the two imports Task 6 added (this task is the first to consume `computeShortestPath` and `matchTargets`). Replace:

```ts
import { entityLimit, responseLimit, type GraphResult, type ImpactResult } from "./graph-query.js";
```

with:

```ts
import { entityLimit, matchTargets, responseLimit, type GraphResult, type ImpactResult } from "./graph-query.js";
```

Replace:

```ts
import {
  computeCommunities,
  computeCoverageStats,
  computeGodNodes,
  computeSuggestedQuestions,
  computeSurprisingConnections,
  summarizeCommunities,
  synthesizeMemberOfEdges,
} from "./analyze.js";
```

with:

```ts
import {
  computeCommunities,
  computeCoverageStats,
  computeGodNodes,
  computeShortestPath,
  computeSuggestedQuestions,
  computeSurprisingConnections,
  summarizeCommunities,
  synthesizeMemberOfEdges,
} from "./analyze.js";
```

Append to `plugins/openwiki/src/graph.ts`:

```ts
export interface GraphPathOptions extends GraphOperationBase {
  from: string;
  to: string;
}

export interface GraphPathEnvelope {
  schemaVersion: 1;
  action: "path";
  root: string;
  from: string;
  to: string;
  found: boolean;
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
  totalWeight?: number;
  truncated: boolean;
}

export async function getGraphPath(options: GraphPathOptions): Promise<GraphPathEnvelope> {
  const resolved = await resolveGraphStorage(options.root, options.homeDir);
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- path needs the full graph for a global shortest-path computation, not a bounded query path.
  const graph = await readStoredGraph(resolved.storage);
  const fromNode = matchTargets(graph, options.from)[0];
  const toNode = matchTargets(graph, options.to)[0];
  if (fromNode === undefined || toNode === undefined) {
    throw new OpenWikiError("NOT_FOUND", "Graph target was not found.");
  }

  const found = computeShortestPath(graph, fromNode.id, toNode.id);
  if (found === undefined) {
    return { schemaVersion: 1, action: "path", root: resolved.repositoryRoot, from: options.from, to: options.to, found: false, nodes: [], edges: [], truncated: false };
  }

  const max = entityLimit(options.limit);
  const truncated = found.nodeIds.length > max;
  const boundedIds = new Set(found.nodeIds.slice(0, max));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const nodes = found.nodeIds
    .filter((id) => boundedIds.has(id))
    .map((id) => nodesById.get(id))
    .filter((node): node is GraphNodeV1 => node !== undefined);
  const edges = found.edgeIds
    .map((id) => edgesById.get(id))
    .filter((edge): edge is GraphEdgeV1 => edge !== undefined && boundedIds.has(edge.from) && boundedIds.has(edge.to));

  return {
    schemaVersion: 1,
    action: "path",
    root: resolved.repositoryRoot,
    from: options.from,
    to: options.to,
    found: true,
    nodes,
    edges,
    totalWeight: found.totalWeight,
    truncated,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: PASS (9 tests, 0 failures).

- [ ] **Step 5: Typecheck and lint**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/graph.ts tests/integration/graph-analytics.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): wire the graph path action with confidence-weighted routing"
```

---

## Task 9: `graph.ts` — wire the `explain` action

**Files:**
- Modify: `plugins/openwiki/src/graph.ts`
- Modify: `plugins/openwiki/tests/integration/graph-analytics.test.mjs`

**Interfaces:**
- Consumes: existing `getGraphContext` (this file); `probeAnalysisStorage`, `readCommunitiesSnapshot` (Task 4, imported via Task 7's edit); `findCitingPages` (Task 3 — this task's own edit adds it to the `./analyze.js` import); `resolveGraphStorage`, `readManifest` (existing).
- Produces: `explainGraphNode(options: TargetGraphOptions): Promise<GraphExplainEnvelope>` where `GraphExplainEnvelope = { schemaVersion: 1; action: "explain"; root: string; target: string; node: GraphNodeV1; neighborhood: { nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; truncated: boolean }; community?: { id: string; memberCount: number; topTerms: string[] }; communityStale: boolean; citingPages: GraphNodeV1[]; diagnostics: GraphDiagnosticV1[] }`. Note: `explain` reuses `getGraphContext`'s existing lenient (lazy-index, ranked-candidate) target resolution rather than `path`'s strict exact match, matching how `context`/`impact` already resolve targets.
- **This task's own Step 1 test is the report→explain round trip that reproduces the Critical defect the orchestrator adjudicated in review (schema-v2 `member-of` edges read back through the lazy index throwing `INVALID_STATE`).** It only passes because Task 6's Step 0 precondition already proved the lazy index accepts the widened vocabulary; if Task 6's Step 0 has not been satisfied, this task's Step 2 will fail with `INVALID_STATE`, not the `explainGraphNode is not a function` error described below — do not weaken this test's assertions to work around that; go fix the Step 0 precondition instead. Task 14 repeats this same report→explain round trip end to end (CLI + MCP) as this slice's final proof.

- [ ] **Step 1: Write the failing test**

Append to `plugins/openwiki/tests/integration/graph-analytics.test.mjs` (add `explainGraphNode` to the `graph.js` import):

```js
import { buildGraph, explainGraphNode, getGraphPath, listGraphCommunities, renderGraphReport } from "../../dist/graph.js";
```

```js
describe("graph analytics: explain action", () => {
  test("graph: explain returns the node, its neighborhood, and its community after a report has run", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });
    await renderGraphReport({ root, homeDir });

    const explanation = await explainGraphNode({ root, homeDir, target: "hub" });
    assert.equal(explanation.schemaVersion, 1);
    assert.equal(explanation.action, "explain");
    assert.equal(explanation.node.name, "hub");
    assert.ok(explanation.neighborhood.nodes.some((candidate) => candidate.name === "leaf"));
    assert.equal(explanation.communityStale, false);
    assert.ok(explanation.community !== undefined);
    assert.ok(Number.isInteger(explanation.community.memberCount) && explanation.community.memberCount >= 1);
    assert.deepEqual(explanation.citingPages, []);
  });

  test("graph: explain reports communityStale before any report has run and omits community", async () => {
    const root = await repository();
    const homeDir = await temporaryRoot("home");
    await initializeWiki({ mode: "code", root, homeDir });
    await buildGraph({ root, homeDir, force: true });

    const explanation = await explainGraphNode({ root, homeDir, target: "hub" });
    assert.equal(explanation.community, undefined);
    assert.equal(explanation.communityStale, true);
  });
});
```

Both tests above assert `citingPages: []` because this plan's own fixtures contain no `page`-kind node (that plane only exists once slice 2a's `enrich` has run) — that is expected and correct here, not a coverage gap: `findCitingPages` (Task 3) already has direct, real, non-empty positive-path unit test coverage (`analyze: findCitingPages returns pages that describe or mention the target...`) that does not depend on the lazy graph index or on 2a's `enrich` having run. The end-to-end, real-data proof that `explain` surfaces citing pages on an actually-enriched workspace is left to the Task T9.1 dogfooding re-run per the master plan, which runs after slice 2a's `enrich` is available.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: FAIL — `explainGraphNode is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `plugins/openwiki/src/graph.ts`, widen the `./analyze.js` import (this task is the first to consume `findCitingPages`). Replace:

```ts
import {
  computeCommunities,
  computeCoverageStats,
  computeGodNodes,
  computeShortestPath,
  computeSuggestedQuestions,
  computeSurprisingConnections,
  summarizeCommunities,
  synthesizeMemberOfEdges,
} from "./analyze.js";
```

with:

```ts
import {
  computeCommunities,
  computeCoverageStats,
  computeGodNodes,
  computeShortestPath,
  computeSuggestedQuestions,
  computeSurprisingConnections,
  findCitingPages,
  summarizeCommunities,
  synthesizeMemberOfEdges,
} from "./analyze.js";
```

Append to `plugins/openwiki/src/graph.ts`:

```ts
export interface GraphExplainEnvelope {
  schemaVersion: 1;
  action: "explain";
  root: string;
  target: string;
  node: GraphNodeV1;
  neighborhood: { nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; truncated: boolean };
  community?: { id: string; memberCount: number; topTerms: string[] };
  communityStale: boolean;
  citingPages: GraphNodeV1[];
  diagnostics: GraphDiagnosticV1[];
}

export async function explainGraphNode(options: TargetGraphOptions): Promise<GraphExplainEnvelope> {
  const context = await getGraphContext(options);
  const needle = options.target.toLocaleLowerCase();
  const node =
    context.nodes.find((candidate) => candidate.id === options.target || candidate.path === options.target || candidate.name.toLocaleLowerCase() === needle) ??
    context.nodes[0];
  if (node === undefined) {
    throw new OpenWikiError("NOT_FOUND", "Graph target was not found.");
  }

  const citingPages = findCitingPages(context.nodes, context.edges, node.id);

  const analysis = await probeAnalysisStorage(options.root, options.homeDir);
  let community: GraphExplainEnvelope["community"];
  let communityStale = true;
  if (analysis.initialized) {
    const snapshot = await readCommunitiesSnapshot(analysis.storage);
    const graphResolved = await resolveGraphStorage(options.root, options.homeDir);
    const manifest = await readManifest(graphResolved.storage).catch(() => undefined);
    communityStale = manifest === undefined || manifest.generation !== snapshot.generation;
    const communityId = snapshot.membership[node.id];
    const summary = communityId === undefined ? undefined : snapshot.communities.find((entry) => entry.id === communityId);
    if (summary !== undefined) {
      community = { id: summary.id, memberCount: summary.memberCount, topTerms: summary.topTerms };
    }
  }

  return {
    schemaVersion: 1,
    action: "explain",
    root: context.root,
    target: options.target,
    node,
    neighborhood: { nodes: context.nodes, edges: context.edges, truncated: context.truncated },
    ...(community === undefined ? {} : { community }),
    communityStale,
    citingPages,
    diagnostics: context.diagnostics,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/integration/graph-analytics.test.mjs`
Expected: PASS (11 tests, 0 failures).

- [ ] **Step 5: Typecheck, lint, and full regression**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS across the whole suite.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/graph.ts tests/integration/graph-analytics.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): wire the graph explain action with community and citing-page lookup"
```

---

## Task 10: `cli.ts` + `adapter.ts` — dispatch, flags, and public DTO fields for the four new actions

**Files:**
- Modify: `plugins/openwiki/src/cli.ts:18-45` (VALUE_FLAGS set)
- Modify: `plugins/openwiki/src/adapter.ts` (GRAPH_ACTIONS, `GraphAction` type, `dispatchGraph`, `graphPublicFields`, `GraphOperations` interface, `loadGraph`)
- Modify: `plugins/openwiki/tests/integration/cli.test.mjs` (extend the existing graph tests)

**Interfaces:**
- Consumes: `getGraphPath`, `explainGraphNode`, `listGraphCommunities`, `renderGraphReport` from `./graph.js` (Tasks 6–9).
- Produces: CLI flags `--from`, `--to`; adapter actions `path`, `explain`, `communities`, `report` fully wired end to end through `dispatch()`.

- [ ] **Step 1: Write the failing test**

In `plugins/openwiki/tests/integration/cli.test.mjs`, extend the existing `"CLI graph rejects invalid limits and action-incompatible native flags"` test's `invalidCases` array (around line 453) by adding these entries before the closing `];`:

```js
      ["path requires from and to", [...base, "--action", "path"]],
      ["path requires to", [...base, "--action", "path", "--from", "hub"]],
      ["explain requires target", [...base, "--action", "explain"]],
      ["report rejects target", [...base, "--action", "report", "--target", "hub"]],
      ["report rejects limit", [...base, "--action", "report", "--limit", "5"]],
      ["communities rejects limit-incompatible force", [...base, "--action", "communities", "--force"]],
```

Then rename the existing `"CLI graph passes seven native actions and bounded inputs to stable DTOs"` test (around line 479) to `"CLI graph passes eleven native actions and bounded inputs to stable DTOs"`, and insert the following block immediately after the existing `map` assertions (right before `assert.equal(runGit(repository, ["rev-parse", "HEAD"]).trim(), baseHead);`):

```js
    const report = assertSuccess(runCli([...graph, "report"], { home }));
    assertGraphCommon(report, "report", repository);
    assert.equal(report.page, "graph-report.md");
    assert.equal(report.written, true);
    assert.ok(Number.isInteger(report.communityCount));
    assert.match(report.generation, /^g-[a-f0-9]{64}$/u);

    const communities = assertSuccess(runCli([...graph, "communities", "--limit", "5"], { home }));
    assertGraphCommon(communities, "communities", repository);
    assert.equal(typeof communities.stale, "boolean");
    assert.ok(Array.isArray(communities.communities));

    const explain = assertSuccess(runCli([...graph, "explain", "--target", "add", "--limit", "5"], { home }));
    assertGraphCommon(explain, "explain", repository);
    assert.equal(explain.node.name, "add");
    assert.ok(Array.isArray(explain.neighborhood.nodes));
    assert.equal(typeof explain.communityStale, "boolean");

    const pathResult = assertSuccess(runCli([...graph, "path", "--from", "add", "--to", "double"], { home }));
    assertGraphCommon(pathResult, "path", repository);
    assert.equal(typeof pathResult.found, "boolean");
    assert.ok(Array.isArray(pathResult.nodes));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/integration/cli.test.mjs`
Expected: FAIL — `--action report` etc. rejected with `Unknown flag: --from.` or `Argument action is invalid.`

- [ ] **Step 3: Write the minimal implementation**

In `plugins/openwiki/src/cli.ts`, replace the `VALUE_FLAGS` set:

```ts
const VALUE_FLAGS = new Set([
  "mode",
  "root",
  "page",
  "content",
  "content-file",
  "envelope-file",
  "query",
  "limit",
  "command",
  "run-id",
  "started-at",
  "completed-at",
  "summary",
  "last-git-head",
  "previous-head",
  "action",
  "id",
  "operation",
  "cron",
  "timezone",
  "source-id",
  "scope",
  "target",
  "base",
  "direction",
  "depth",
]);
```

with:

```ts
const VALUE_FLAGS = new Set([
  "mode",
  "root",
  "page",
  "content",
  "content-file",
  "envelope-file",
  "query",
  "limit",
  "command",
  "run-id",
  "started-at",
  "completed-at",
  "summary",
  "last-git-head",
  "previous-head",
  "action",
  "id",
  "operation",
  "cron",
  "timezone",
  "source-id",
  "scope",
  "target",
  "base",
  "direction",
  "depth",
  "from",
  "to",
]);
```

In `plugins/openwiki/src/adapter.ts`, replace the `GraphAction` type and `GRAPH_ACTIONS` array:

```ts
type GraphAction = "build" | "status" | "query" | "context" | "impact" | "changes" | "map";

const GRAPH_ACTIONS: readonly GraphAction[] = [
  "build",
  "status",
  "query",
  "context",
  "impact",
  "changes",
  "map",
];
```

with:

```ts
type GraphAction = "build" | "status" | "query" | "context" | "impact" | "changes" | "map" | "path" | "explain" | "communities" | "report";

const GRAPH_ACTIONS: readonly GraphAction[] = [
  "build",
  "status",
  "query",
  "context",
  "impact",
  "changes",
  "map",
  "path",
  "explain",
  "communities",
  "report",
];
```

Replace the `dispatchGraph` function body's `assertKeys` call and add the new branches. Replace:

```ts
async function dispatchGraph(input: InputRecord): Promise<unknown> {
  assertKeys(input, ["mode", "root", "action", "force", "query", "target", "base", "direction", "depth", "limit"]);
```

with:

```ts
async function dispatchGraph(input: InputRecord): Promise<unknown> {
  assertKeys(input, ["mode", "root", "action", "force", "query", "target", "base", "direction", "depth", "limit", "from", "to"]);
```

Replace:

```ts
  const direction = has(input, "direction") ? readEnum(input, "direction", ["inbound", "outbound", "both"] as const) : undefined;
  const depth = readOptionalBoundedInteger(input, "depth", 1, 5);
  const graph = await loadGraph();
```

with:

```ts
  const direction = has(input, "direction") ? readEnum(input, "direction", ["inbound", "outbound", "both"] as const) : undefined;
  const depth = readOptionalBoundedInteger(input, "depth", 1, 5);
  const from = readOptionalString(input, "from");
  const to = readOptionalString(input, "to");
  const graph = await loadGraph();
```

Replace the final two lines of `dispatchGraph` (the `map`-only fallback):

```ts
  assertAbsent(input, ["force", "query", "target", "base", "direction", "depth"]);
  return publicGraphResult("map", root, await graph.getArchitectureMap({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, ...(limit === undefined ? {} : { limit }) }), limit);
}
```

with:

```ts
  if (action === "path") {
    assertAbsent(input, ["force", "query", "target", "base", "direction", "depth"]);
    if (from === undefined || to === undefined) throw invalid("Graph path requires from and to.");
    return publicGraphResult("path", root, await graph.getGraphPath({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, from, to, ...(limit === undefined ? {} : { limit }) }), limit);
  }
  if (action === "explain") {
    assertAbsent(input, ["force", "query", "base", "direction", "depth", "from", "to"]);
    if (target === undefined) throw invalid("Graph explain requires target.");
    return publicGraphResult("explain", root, await graph.explainGraphNode({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, target, ...(limit === undefined ? {} : { limit }) }), limit);
  }
  if (action === "communities") {
    assertAbsent(input, ["force", "query", "target", "base", "direction", "depth", "from", "to"]);
    return publicGraphResult("communities", root, await graph.listGraphCommunities({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, ...(limit === undefined ? {} : { limit }) }), limit);
  }
  if (action === "report") {
    assertAbsent(input, ["force", "query", "target", "base", "direction", "depth", "from", "to", "limit"]);
    return publicGraphResult("report", root, await graph.renderGraphReport({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT }), limit);
  }
  assertAbsent(input, ["force", "query", "target", "base", "direction", "depth", "from", "to"]);
  return publicGraphResult("map", root, await graph.getArchitectureMap({ root, homeDir: os.homedir(), responseByteLimit: GRAPH_RESPONSE_BYTE_LIMIT, ...(limit === undefined ? {} : { limit }) }), limit);
}
```

Note: `report`'s `GraphReportEnvelope` (Task 6) is not a bounded list — it is a fixed-shape set of counts plus a page-write confirmation, and `renderGraphReport` never reads a `limit` option anywhere in its body. `communities`/`explain`/`path` genuinely bound their list output by `limit` (Tasks 7–9 all call `entityLimit(options.limit)`), so `--limit` stays accepted for those three. `report` instead rejects `--limit` outright above (added to its `assertAbsent` list, matching how this same branch already rejects `--target`, and how `communities` already rejects `--force`), and `renderGraphReport` is called with no `limit` field in its options at all — an accepted-but-silently-ignored parameter is exactly the kind of inert flag this plan's Global Constraints forbid.

Replace `graphPublicFields`'s `map` case and add the four new cases. Replace:

```ts
    case "map":
      return ["schemaVersion", "action", "root", "modules", "hubs", "cycles", "flows", "truncated", "diagnostics"];
  }
}
```

with:

```ts
    case "map":
      return ["schemaVersion", "action", "root", "modules", "hubs", "cycles", "flows", "truncated", "diagnostics"];
    case "path":
      return ["schemaVersion", "action", "root", "from", "to", "found", "nodes", "edges", "totalWeight", "truncated"];
    case "explain":
      return ["schemaVersion", "action", "root", "target", "node", "neighborhood", "community", "communityStale", "citingPages", "diagnostics"];
    case "communities":
      return ["schemaVersion", "action", "root", "communities", "stale", "generation", "generatedAt", "truncated"];
    case "report":
      return ["schemaVersion", "action", "root", "page", "written", "communityCount", "godNodeCount", "surprisingConnectionCount", "ambiguousEdgeCount", "coverageRatio", "generation", "generatedAt"];
  }
}
```

Replace the `GraphOperations` interface and `loadGraph` function:

```ts
interface GraphOperations {
  buildGraph(options: InputRecord): Promise<unknown>;
  getGraphStatus(options: InputRecord): Promise<unknown>;
  queryGraph(options: InputRecord): Promise<unknown>;
  getGraphContext(options: InputRecord): Promise<unknown>;
  analyzeGraphImpact(options: InputRecord): Promise<unknown>;
  analyzeGraphChanges(options: InputRecord): Promise<unknown>;
  getArchitectureMap(options: InputRecord): Promise<unknown>;
}

async function loadGraph(): Promise<GraphOperations> {
  const moduleValue: unknown = await import(new URL("./graph.js", import.meta.url).href);
  const module = readRecord(moduleValue, "Native graph module is invalid.");
  return {
    buildGraph: readAsyncFunction(module, "buildGraph"),
    getGraphStatus: readAsyncFunction(module, "getGraphStatus"),
    queryGraph: readAsyncFunction(module, "queryGraph"),
    getGraphContext: readAsyncFunction(module, "getGraphContext"),
    analyzeGraphImpact: readAsyncFunction(module, "analyzeGraphImpact"),
    analyzeGraphChanges: readAsyncFunction(module, "analyzeGraphChanges"),
    getArchitectureMap: readAsyncFunction(module, "getArchitectureMap"),
  };
}
```

with:

```ts
interface GraphOperations {
  buildGraph(options: InputRecord): Promise<unknown>;
  getGraphStatus(options: InputRecord): Promise<unknown>;
  queryGraph(options: InputRecord): Promise<unknown>;
  getGraphContext(options: InputRecord): Promise<unknown>;
  analyzeGraphImpact(options: InputRecord): Promise<unknown>;
  analyzeGraphChanges(options: InputRecord): Promise<unknown>;
  getArchitectureMap(options: InputRecord): Promise<unknown>;
  getGraphPath(options: InputRecord): Promise<unknown>;
  explainGraphNode(options: InputRecord): Promise<unknown>;
  listGraphCommunities(options: InputRecord): Promise<unknown>;
  renderGraphReport(options: InputRecord): Promise<unknown>;
}

async function loadGraph(): Promise<GraphOperations> {
  const moduleValue: unknown = await import(new URL("./graph.js", import.meta.url).href);
  const module = readRecord(moduleValue, "Native graph module is invalid.");
  return {
    buildGraph: readAsyncFunction(module, "buildGraph"),
    getGraphStatus: readAsyncFunction(module, "getGraphStatus"),
    queryGraph: readAsyncFunction(module, "queryGraph"),
    getGraphContext: readAsyncFunction(module, "getGraphContext"),
    analyzeGraphImpact: readAsyncFunction(module, "analyzeGraphImpact"),
    analyzeGraphChanges: readAsyncFunction(module, "analyzeGraphChanges"),
    getArchitectureMap: readAsyncFunction(module, "getArchitectureMap"),
    getGraphPath: readAsyncFunction(module, "getGraphPath"),
    explainGraphNode: readAsyncFunction(module, "explainGraphNode"),
    listGraphCommunities: readAsyncFunction(module, "listGraphCommunities"),
    renderGraphReport: readAsyncFunction(module, "renderGraphReport"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/integration/cli.test.mjs`
Expected: PASS, all cases including the six new invalid-argument cases and the four new action assertions.

- [ ] **Step 5: Typecheck, lint, and full regression**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS across the whole suite.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/cli.ts src/adapter.ts tests/integration/cli.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): dispatch path, explain, communities, and report through the CLI adapter"
```

---

## Task 11: `mcp.ts` — schema branches and MCP parity

**Files:**
- Modify: `plugins/openwiki/src/mcp.ts` (`graphSchema` function)
- Modify: `plugins/openwiki/tests/integration/mcp.test.mjs`

**Interfaces:**
- Consumes: nothing new (schema-only change; dispatch already routes through `adapter.ts`'s `dispatch()`, unchanged by this task).
- Produces: MCP `graph` tool `inputSchema.oneOf` gains four branches (`path`, `explain`, `communities`, `report`), mirroring the CLI contract exactly.

- [ ] **Step 1: Write the failing test**

In `plugins/openwiki/tests/integration/mcp.test.mjs`, replace the `graphBranches` length assertion and `assertGraphSchema`'s `expected` map. Replace:

```js
function graphBranches(tool) {
  assert.equal(JSON.stringify(tool).toLowerCase().includes("gitnexus"), false);
  assert.equal(JSON.stringify(tool).includes("provider"), false);
  assert.ok(Array.isArray(tool.inputSchema.oneOf));
  assert.equal(tool.inputSchema.oneOf.length, 7);
  return new Map(
    tool.inputSchema.oneOf.map((branch) => [branch.properties.action.const, branch]),
  );
}

function assertGraphSchema(tool) {
  const branches = graphBranches(tool);
  const expected = {
    build: { properties: ["action", "force", "root"], required: ["action", "root"] },
    status: { properties: ["action", "root"], required: ["action", "root"] },
    query: { properties: ["action", "limit", "query", "root"], required: ["action", "query", "root"] },
    context: { properties: ["action", "limit", "root", "target"], required: ["action", "root", "target"] },
    impact: {
      properties: ["action", "depth", "direction", "limit", "root", "target"],
      required: ["action", "root", "target"],
    },
    changes: { properties: ["action", "base", "limit", "root"], required: ["action", "root"] },
    map: { properties: ["action", "limit", "root"], required: ["action", "root"] },
  };
```

with:

```js
function graphBranches(tool) {
  assert.equal(JSON.stringify(tool).toLowerCase().includes("gitnexus"), false);
  assert.equal(JSON.stringify(tool).includes("provider"), false);
  assert.ok(Array.isArray(tool.inputSchema.oneOf));
  assert.equal(tool.inputSchema.oneOf.length, 11);
  return new Map(
    tool.inputSchema.oneOf.map((branch) => [branch.properties.action.const, branch]),
  );
}

function assertGraphSchema(tool) {
  const branches = graphBranches(tool);
  const expected = {
    build: { properties: ["action", "force", "root"], required: ["action", "root"] },
    status: { properties: ["action", "root"], required: ["action", "root"] },
    query: { properties: ["action", "limit", "query", "root"], required: ["action", "query", "root"] },
    context: { properties: ["action", "limit", "root", "target"], required: ["action", "root", "target"] },
    impact: {
      properties: ["action", "depth", "direction", "limit", "root", "target"],
      required: ["action", "root", "target"],
    },
    changes: { properties: ["action", "base", "limit", "root"], required: ["action", "root"] },
    map: { properties: ["action", "limit", "root"], required: ["action", "root"] },
    path: { properties: ["action", "from", "limit", "root", "to"], required: ["action", "root", "from", "to"] },
    explain: { properties: ["action", "limit", "root", "target"], required: ["action", "root", "target"] },
    communities: { properties: ["action", "limit", "root"], required: ["action", "root"] },
    report: { properties: ["action", "root"], required: ["action", "root"] },
  };
```

Then, immediately after this test's existing `"MCP graph passes native inputs to bounded DTOs..."` test (after the loop that asserts the three invalid cases, before the closing `});` of that test), append:

```js
    const reportResponse = await request(session, 7, "tools/call", {
      name: "graph",
      arguments: { root: repository, action: "report" },
    });
    const report = parseToolEnvelope(reportResponse, false).data;
    assertGraphCommon(report, "report", repository);
    assert.equal(report.page, "graph-report.md");
    assert.equal(report.written, true);

    const communitiesResponse = await request(session, 8, "tools/call", {
      name: "graph",
      arguments: { root: repository, action: "communities", limit: 5 },
    });
    const communities = parseToolEnvelope(communitiesResponse, false).data;
    assertGraphCommon(communities, "communities", repository);
    assert.ok(Array.isArray(communities.communities));

    const explainResponse = await request(session, 9, "tools/call", {
      name: "graph",
      arguments: { root: repository, action: "explain", target: "add" },
    });
    const explanation = parseToolEnvelope(explainResponse, false).data;
    assertGraphCommon(explanation, "explain", repository);
    assert.equal(explanation.node.name, "add");

    const pathResponse = await request(session, 10, "tools/call", {
      name: "graph",
      arguments: { root: repository, action: "path", from: "add", to: "add" },
    });
    const pathResult = parseToolEnvelope(pathResponse, false).data;
    assertGraphCommon(pathResult, "path", repository);
    assert.equal(pathResult.found, true);
```

(Note: `src/math.ts` in this test's repository defines only `add`; using `from: "add", to: "add"` exercises the trivial-path branch without requiring a second symbol.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/integration/mcp.test.mjs`
Expected: FAIL — `oneOf.length` assertion fails (`7` expected vs. actual `7` still, because `mcp.ts` hasn't changed yet — the test now expects `11` and fails).

- [ ] **Step 3: Write the minimal implementation**

In `plugins/openwiki/src/mcp.ts`, replace the `graphSchema` function body:

```ts
function graphSchema(): JsonRecord {
  return {
    oneOf: [
      object({ action: { const: "build" }, root, force: { type: "boolean" } }, ["action", "root"]),
      object({ action: { const: "status" }, root }, ["action", "root"]),
      object({ action: { const: "query" }, root, query: { type: "string", minLength: 1 }, limit }, ["action", "root", "query"]),
      object({ action: { const: "context" }, root, target: { type: "string", minLength: 1 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "impact" }, root, target: { type: "string", minLength: 1 }, direction: { type: "string", enum: ["inbound", "outbound", "both"] }, depth: { type: "integer", minimum: 1, maximum: 5 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "changes" }, root, base: { type: "string", minLength: 1 }, limit }, ["action", "root"]),
      object({ action: { const: "map" }, root, limit }, ["action", "root"]),
    ],
  };
}
```

with:

```ts
function graphSchema(): JsonRecord {
  return {
    oneOf: [
      object({ action: { const: "build" }, root, force: { type: "boolean" } }, ["action", "root"]),
      object({ action: { const: "status" }, root }, ["action", "root"]),
      object({ action: { const: "query" }, root, query: { type: "string", minLength: 1 }, limit }, ["action", "root", "query"]),
      object({ action: { const: "context" }, root, target: { type: "string", minLength: 1 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "impact" }, root, target: { type: "string", minLength: 1 }, direction: { type: "string", enum: ["inbound", "outbound", "both"] }, depth: { type: "integer", minimum: 1, maximum: 5 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "changes" }, root, base: { type: "string", minLength: 1 }, limit }, ["action", "root"]),
      object({ action: { const: "map" }, root, limit }, ["action", "root"]),
      object({ action: { const: "path" }, root, from: { type: "string", minLength: 1 }, to: { type: "string", minLength: 1 }, limit }, ["action", "root", "from", "to"]),
      object({ action: { const: "explain" }, root, target: { type: "string", minLength: 1 }, limit }, ["action", "root", "target"]),
      object({ action: { const: "communities" }, root, limit }, ["action", "root"]),
      object({ action: { const: "report" }, root }, ["action", "root"]),
    ],
  };
}
```

Note: `report`'s MCP schema branch omits `limit` (unlike `path`/`explain`/`communities`) to match the CLI/adapter's own rejection of `--limit` for `report` (Task 10, review finding I3) — the two surfaces must stay contractually identical, and a schema that silently accepted `limit` here while the CLI rejected it would itself be a parity bug.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/integration/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, and full regression**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS, with one known, already-scoped exception: `npm test` runs `node --test`, which also discovers `tests/e2e/plugin-clients.e2e.test.mjs`. That file's existing `GRAPH_ACTIONS` constant still hardcodes the pre-2c 7-action list, so its `assert.deepEqual(graph.inputSchema.oneOf.map(...), GRAPH_ACTIONS)` assertion will now FAIL — the real schema this task just shipped returns 11 branches. This is expected, not a regression to chase down here; Task 12 fixes it next by updating only that one constant (no further `src/` change). Do not weaken this task's own MCP-schema tests to paper over that failure.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add src/mcp.ts tests/integration/mcp.test.mjs
git -C "plugins/openwiki" commit -m "feat(openwiki): expose path, explain, communities, and report through MCP"
```

---

## Task 12: `plugin-clients.e2e.test.mjs` — installer/tool-inventory parity for the new actions

**Files:**
- Modify: `plugins/openwiki/tests/e2e/plugin-clients.e2e.test.mjs`

**Interfaces:**
- Consumes: nothing new; this is a parity assertion over `mcp.ts`'s `tools/list` response (Task 11) already exercised through both installed hosts.

- [ ] **Step 1: Write the failing test**

In `plugins/openwiki/tests/e2e/plugin-clients.e2e.test.mjs`, replace the `GRAPH_ACTIONS` constant:

```js
const GRAPH_ACTIONS = ["build", "status", "query", "context", "impact", "changes", "map"];
```

with:

```js
const GRAPH_ACTIONS = ["build", "status", "query", "context", "impact", "changes", "map", "path", "explain", "communities", "report"];
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --prefix plugins/openwiki --test tests/e2e/plugin-clients.e2e.test.mjs`
Expected: FAIL. By this point Task 11 has already updated `mcp.ts` so `graph.inputSchema.oneOf` returns 11 branches (`build`/`status`/`query`/`context`/`impact`/`changes`/`map`/`path`/`explain`/`communities`/`report`); this file's `GRAPH_ACTIONS` constant, before this step's edit above, still lists only the original 7. The failure is `assert.deepEqual(<actual, 11 items>, <GRAPH_ACTIONS, 7 items>)` — a real drift between the shipped schema and this test's fixture, not a build error (this same drift is exactly what already made this test fail as soon as Task 11 landed, per Task 11's own Step 5 note). Step 1's edit above is what resolves it.

- [ ] **Step 3: Confirm — no production code changes required**

This task only updates the test fixture constant; Task 11 already implements the corresponding `mcp.ts` schema. No `src/` edit is needed here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/e2e/plugin-clients.e2e.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full regression**

Run: `npm --prefix plugins/openwiki test`
Expected: PASS across the whole suite.

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add tests/e2e/plugin-clients.e2e.test.mjs
git -C "plugins/openwiki" commit -m "test(openwiki): assert MCP tool-inventory parity for the four new graph actions"
```

---

## Task 13: Skill documentation — `openwiki-graph` and `openwiki-update`

**Files:**
- Modify: `plugins/openwiki/skills/openwiki-graph/SKILL.md`
- Modify: `plugins/openwiki/skills/openwiki-update/SKILL.md`

**Interfaces:** none (documentation only); this task has no code-level TDD cycle, so its acceptance criterion is a full suite run plus a manual content check.

- [ ] **Step 1: Update `openwiki-graph/SKILL.md`'s Procedure section**

In `plugins/openwiki/skills/openwiki-graph/SKILL.md`, immediately after step 4's fenced code block of bounded actions (`query`/`context`/`impact`/`changes`/`map`), insert a new step 4b (renumber subsequent steps 5→6, 6→7):

```markdown
4b. After a successful build, `enrich` (owned by the concept/wiki-plane skill), or an earlier `report`, the following actions are also available:

   ```text
   <cli> graph --mode code --root <root> --action report --json
   <cli> graph --mode code --root <root> --action communities --limit <1..100> --json
   <cli> graph --mode code --root <root> --action explain --target "<file-or-symbol>" --limit <1..100> --json
   <cli> graph --mode code --root <root> --action path --from "<node>" --to "<node>" --json
   ```

   `report` is the only one of these four that writes: it recomputes deterministic label-propagation communities and god-node degree over the currently persisted graph, persists `member-of` edges plus a `communities.json` snapshot in the private store, and writes the `graph-report.md` wiki page. Run it once after `build` (and, when the concept/wiki plane exists, after `enrich`) whenever the report or community data must reflect the latest graph. `communities`, `explain`, and `path` are read-only and report a `stale`/`communityStale` flag when the last `report` run predates the current graph generation; never treat a stale community as current without disclosing it. `path` requires an exact `--from`/`--to` match (id, path, name, or qualified name); `explain` resolves its `--target` the same lenient way `context` does.
```

- [ ] **Step 2: Update `openwiki-graph/SKILL.md`'s Mutation boundary section**

Replace:

```markdown
## Mutation boundary

Graph build and refresh read repository files but never execute, import, compile, or evaluate repository code. They write only private, atomic OpenWiki graph data under `~/.openwiki/data/<workspace-id>/graph/`; they never write source files, wiki files, instruction files, dependency files, or provider credentials. The graph stores metadata, hashes, nodes, edges, and diagnostics, never source-file bodies. Query, context, impact, changes, map, and status are read-only. Source refactoring and rename remain outside this workflow.
```

with:

```markdown
## Mutation boundary

Graph build and refresh read repository files but never execute, import, compile, or evaluate repository code. Build writes only private, atomic OpenWiki graph data under `~/.openwiki/data/<workspace-id>/graph/`; report additionally writes the private `~/.openwiki/data/<workspace-id>/analysis/communities.json` snapshot and the `graph-report.md` wiki page under the workspace's confined wiki root — no other action writes anywhere. None of these ever write source files, instruction files, dependency files, or provider credentials. The graph stores metadata, hashes, nodes, edges, and diagnostics, never source-file bodies. Query, context, impact, changes, map, status, communities, explain, and path are read-only. Source refactoring and rename remain outside this workflow.
```

- [ ] **Step 3: Wire report regeneration into `openwiki-update/SKILL.md`'s Procedure**

In `plugins/openwiki/skills/openwiki-update/SKILL.md`, replace step 1:

```markdown
1. Run `status` using the same mode/root. In code mode, delegate graph freshness and changed-path mapping to `openwiki-graph`'s `changes` action; that skill owns graph status, authorized refresh, limits, and confidence reporting. In personal mode, skip graph work.
```

with:

```markdown
1. Run `status` using the same mode/root. In code mode, delegate graph freshness and changed-path mapping to `openwiki-graph`'s `changes` action; that skill owns graph status, authorized refresh, limits, and confidence reporting. After an authorized graph build (and, when the concept/wiki plane exists, `enrich`), run `openwiki-graph`'s `report` action so `graph-report.md` reflects the current unified graph; treat its output as one of the changed pages for this run. In personal mode, skip graph and report work.
```

- [ ] **Step 4: Run the full suite to confirm no packaging test depends on the old skill text verbatim**

Run: `npm --prefix plugins/openwiki test`
Expected: PASS (no test asserts the literal removed/replaced prose; if any packaging test fails on an exact-string match, update that assertion to the new wording rather than reverting the documentation change).

- [ ] **Step 5: Commit**

```bash
git -C "plugins/openwiki" add skills/openwiki-graph/SKILL.md skills/openwiki-update/SKILL.md
git -C "plugins/openwiki" commit -m "docs(openwiki): document report, communities, explain, and path in the graph and update skills"
```

---

## Task 14: Final slice e2e — full lifecycle, determinism, and MCP mirroring on the bundled fixture repo

**Files:**
- Modify: `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs`

**Interfaces:**
- Consumes: `createRepositoryHarness`, `initializeWiki`, `runCliSuccess`, `runCliError`, `assertGraphResult`, `git`, `runProcess`, `MCP_PATH` (all already defined in this file).
- Produces: one new `test()` inside the existing `describe("OpenWiki real runtime journey", ...)` block, proving the slice end to end on the bundled fixture repository (`tests/fixtures/sample-repo`, symbols `listActiveProducts`/`findProductBySku`/`summarizeCatalog`).
- This test's `report` call followed by `explain --target listActiveProducts` on the same workspace (both over the CLI and mirrored over MCP) is the slice's final, real-process report→explain round trip — the same regression class Task 9's integration test already proves in-process. Both depend on Task 6's Step 0 precondition having verified that slice 2a widened `graph-index.ts`'s lazy-index guards; if that precondition was never satisfied, this test fails with `INVALID_STATE`, not a clean assertion mismatch — treat that as proof the precondition was skipped, not as a defect in this test.

- [ ] **Step 1: Write the failing test**

Append the following `test()` inside the existing `describe("OpenWiki real runtime journey", ...)` block in `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs` (after the `"builds and incrementally refreshes the proprietary bounded code graph without GitNexus"` test):

```js
  test("slice 2c: report/communities/path/explain are deterministic across two runs and mirrored over MCP", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    const graphTarget = ["--mode", "code", "--root", harness.repositoryRoot];

    await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "build", "--force"]);

    const reportFirst = await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "report"]);
    const reportData = assertGraphResult(reportFirst, "report", harness.repositoryRoot);
    assert.equal(reportData.page, "graph-report.md");
    assert.equal(reportData.written, true);
    assert.ok(reportData.communityCount >= 1);
    assert.match(reportData.generation, /^g-[a-f0-9]{64}$/u);

    const reportPageRaw = await readFile(join(harness.repositoryRoot, "openwiki", "graph-report.md"), "utf8");
    for (const heading of [
      "# Graph Report",
      "## God nodes",
      "## Communities",
      "## Surprising connections",
      "## Suggested questions",
      "## Coverage",
      "## Ambiguous edges pending review",
    ]) {
      assert.ok(reportPageRaw.includes(heading), `graph-report.md is missing "${heading}"`);
    }
    assertSemanticText(reportPageRaw, [/listActiveProducts|findProductBySku|summarizeCatalog/u]);

    const communitiesFirst = await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "communities", "--limit", "10"]);
    const communitiesSecond = await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "communities", "--limit", "10"]);
    assert.deepEqual(communitiesFirst.json.data, communitiesSecond.json.data);
    assert.equal(communitiesFirst.json.data.stale, false);

    const explainFirst = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "explain",
      "--target",
      "listActiveProducts",
      "--limit",
      "10",
    ]);
    const explainSecond = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "explain",
      "--target",
      "listActiveProducts",
      "--limit",
      "10",
    ]);
    assert.deepEqual(explainFirst.json.data, explainSecond.json.data);
    assert.equal(explainFirst.json.data.node.name, "listActiveProducts");
    assert.equal(explainFirst.json.data.communityStale, false);

    const pathFirst = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "path",
      "--from",
      "listActiveProducts",
      "--to",
      "summarizeCatalog",
    ]);
    const pathSecond = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "path",
      "--from",
      "listActiveProducts",
      "--to",
      "summarizeCatalog",
    ]);
    assert.deepEqual(pathFirst.json.data, pathSecond.json.data);
    assert.equal(pathFirst.json.data.found, true);
    assert.ok(pathFirst.json.data.nodes.some((candidate) => candidate.name === "listActiveProducts"));
    assert.ok(pathFirst.json.data.nodes.some((candidate) => candidate.name === "summarizeCatalog"));

    await runCliError(
      harness,
      ["graph", ...graphTarget, "--action", "path", "--from", "listActiveProducts", "--to", "doesNotExist"],
      "NOT_FOUND",
    );

    assert.ok(existsSync(MCP_PATH), `Missing compiled MCP adapter: ${MCP_PATH}.`);
    const mcpRequests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "slice-2c-e2e", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "report" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "communities", limit: 10 } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "explain", target: "listActiveProducts", limit: 10 } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "graph", arguments: { root: harness.repositoryRoot, action: "path", from: "listActiveProducts", to: "summarizeCatalog" } } },
    ];
    const mcpResult = await runProcess(process.execPath, [MCP_PATH], {
      cwd: harness.repositoryRoot,
      env: harness.env,
      input: `${mcpRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    });
    assert.equal(mcpResult.code, 0, mcpResult.stderr || mcpResult.stdout);
    assert.equal(mcpResult.stderr, "");
    const mcpResponses = mcpResult.stdout
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const byId = new Map(mcpResponses.map((response) => [response.id, response]));
    const parseEnvelope = (id) => JSON.parse(byId.get(id).result.content[0].text);
    assert.equal(parseEnvelope(2).data.action, "report");
    assert.deepEqual(parseEnvelope(3).data, communitiesFirst.json.data);
    assert.deepEqual(parseEnvelope(4).data, explainFirst.json.data);
    assert.deepEqual(parseEnvelope(5).data, pathFirst.json.data);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix plugins/openwiki run build 2>&1 | tail -5 ; node --prefix plugins/openwiki --test tests/e2e/runtime.e2e.test.mjs`
Expected: FAIL — `--action report` etc. not yet recognized if Tasks 1–13 are not yet built into `dist/`; once Tasks 1–13 are complete this specific test is the one that should fail first with a clean, informative assertion error (not a build error) if any of Tasks 1–13 is incomplete, since it exercises every new action together for the first time end to end.

- [ ] **Step 3: Confirm — no production code changes required**

This task only adds a test; all production code was implemented in Tasks 1–11. If this test fails after Tasks 1–13 are complete, treat it as a real regression per `superpowers:systematic-debugging` — do not weaken the assertions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --prefix plugins/openwiki --test tests/e2e/runtime.e2e.test.mjs`
Expected: PASS.

- [ ] **Step 5: Full gate — build, typecheck, lint, full test suite**

Run: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS, zero regressions across unit, integration, and e2e suites (this is slice 2c's exit gate; also satisfies the master plan's Phase 2 exit criterion that `path`/`explain`/`communities`/`report` are exercised on the bundled fixture repo from both the CLI and MCP with recorded evidence).

- [ ] **Step 6: Commit**

```bash
git -C "plugins/openwiki" add tests/e2e/runtime.e2e.test.mjs
git -C "plugins/openwiki" commit -m "test(openwiki): prove the full 2c lifecycle deterministically across CLI and MCP"
```

---

## Self-review (performed at authoring)

**1. Spec coverage** (PRD §7 slice 2c, line by line):

| PRD requirement | Task |
|---|---|
| Deterministic label-propagation communities, seeded by ascending node id, max 20 iterations | Task 1 |
| `member-of` edges persisted, confidence `exact` | Tasks 3, 6 |
| `communities` read action: member counts + top terms | Tasks 3 (`summarizeCommunities`), 7, 10, 11 |
| God nodes (degree analytics) | Task 2 |
| Surprising connections, concept↔code ranked above same-plane | Task 3 |
| `path --from --to`: shortest confidence-weighted path, weights 1.0/0.7/0.4 | Tasks 2, 8 |
| `explain --target`: node + neighborhood + communities + citing pages | Task 9 |
| Graph report page: god nodes, communities, surprising connections, suggested questions, coverage stats, ambiguous edges | Tasks 5, 6 |
| Report regenerated by `update` | Task 13 |
| CLI + MCP parity, identical JSON contracts | Tasks 10, 11, 12 |
| `enrich` exposed as the single new write tool with `write`/`ingest` discipline | Out of scope for 2c — owned by slice 2a's plan (`enrich` is a 2a deliverable per the master plan; this plan only *consumes* the resulting concept/page/source planes in `computeSurprisingConnections`, `computeCoverageStats`, and `explain`'s citing-pages lookup). |
| Final slice e2e: fixture repo, report page sections asserted, deterministic path/explain/communities across two runs, MCP mirrors each action | Task 14 |

**2. Placeholder scan:** every step above contains complete, runnable TypeScript/JavaScript — no `TBD`, no "add appropriate handling," no elided code. Every task's import edits add exactly the symbols that task's own new code consumes: Task 6 imports only what `renderGraphReport` itself calls; `computeShortestPath` and `matchTargets` are added by Task 8 (the first task that calls them); `probeAnalysisStorage`, `readCommunitiesSnapshot`, and the `CommunitySummaryV1` type are added by Task 7 (the first task that uses them); `findCitingPages` is added by Task 9 (the first and only task that calls it). No task pre-loads a symbol only a later task consumes, so each task's own lint run passes standalone with no conditional escape hatch.

**3. Type consistency:** `CommunitySummary` (Task 3, `analyze.ts`) and `CommunitySummaryV1` (Task 4, `analysis-store.ts`) intentionally share the exact same field set (`id`, `memberCount`, `topTerms`, `members`, `membersTruncated`) so `summarizeCommunities`'s return value needs no adapter before being persisted (Task 6) or rendered (Task 5). `GraphPathResult` (Task 2) is consumed as-is by `getGraphPath` (Task 8). `GraphReportEnvelope`, `GraphCommunitiesEnvelope`, `GraphPathEnvelope`, `GraphExplainEnvelope` (Tasks 6–9) are each consumed by exactly one `graphPublicFields` case (Task 10) with matching field names verified against the literal interface definitions.

## Objections and design decisions requiring orchestrator sign-off

1. **Where community computation lives.** The PRD lists `communities` as a "read action," but computing and persisting `member-of` edges is inescapably a write (it bumps the graph generation and writes a new private snapshot). This plan resolves the tension by making `report` — not `build` — the action that recomputes and persists communities, because communities must reflect the *unified* graph (code + concept/page/source planes), and only `report` is guaranteed to run after both `build` and 2a's `enrich`. `communities`, `explain`, and `path` stay pure reads and disclose staleness via a `stale`/`communityStale` flag rather than silently recomputing. This is an interpretation of an ambiguous contract, not a literal deviation from the closed action list (`path`/`explain`/`communities`/`report` — no new action name was introduced), and I believe it is correct, but it should be confirmed before Task 6 executes.
2. **`member-of` edge endpoints without a new node kind.** The binding contract's `GraphNodeKind` union (concept/page/source, plus the original five) has no `community` kind, yet `parseCodeGraph` requires every edge's `to` to reference an existing node id. This plan resolves it *without* extending `GraphNodeKind`: label propagation's `communityId` is always the id of an existing "leader" node (the node whose label won propagation), so `member-of` edges validate against the existing edge-endpoint invariant with zero schema changes. This is a design choice worth flagging even though no contract text needed to change.
3. **Integration point inside `graph.ts` assumes today's shape.** `renderGraphReport` (Task 6) is written against `graph.ts`'s current `resolveGraphStorage`/`readStoredGraph`/`readManifest`/`readGraphShard`/`writeGraph` signatures, as read on 2026-07-14, before slices 2a/2b have merged. If 2a/2b change these signatures (e.g., `GraphShard` gaining enrichment-specific fields), Task 6's implementation step must be adapted at execution time to the real signatures — the integration point (hook after `readStoredGraph`, before any `write*` call) is chosen specifically to be robust to that drift, but the literal code will need re-verification against the merged 2a/2b code before this task starts. This objection is about `graph.ts`'s own function signatures; the separate `graph-index.ts` lazy-index guard-widening dependency (a prior review round found this plan's `report`/`explain` actions would throw `INVALID_STATE` if slice 2a had not widened those guards) is no longer left as prose — Task 6's Step 0 is a real, automated precondition test for exactly that dependency.
4. **Communities snapshot members are capped but membership is not.** `CommunitySummaryV1.members` caps at 200 entries per community (avoiding unbounded private-file growth); `explain`'s community lookup instead uses a separate, uncapped `membership: Record<string, string>` (nodeId → communityId) in the same snapshot, so membership lookups stay exact for communities larger than 200 members even though the `communities` action's listed member array is truncated. This is called out because it means the snapshot file's size is bounded by node count, not by a small constant — acceptable for this store (private, not subject to the CLI response-byte-limit contract) but worth confirming against expected repository sizes during dogfooding.

## Risks

- **2a/2b merge drift.** As noted in objection 3, this plan's exact `graph.ts` diffs assume no signature changes from slices 2a/2b. Re-read `graph.ts`, `graph-contracts.ts`, and `graph-store.ts` immediately before starting Task 6 and adjust the diff context accordingly if they differ from what is quoted in this plan. Task 6's Step 0 turns the specific, previously-identified `graph-index.ts` guard-widening half of this risk into a concrete, automated gate (a real test against the real code) rather than a manual re-read instruction.
- **`report`'s two-write pattern is not fully atomic.** `renderGraphReport` calls `writeGraph` (graph + member-of edges) and then, separately, `writeCommunitiesSnapshot` (its own lock scope via `withWikiLock`). A crash between the two leaves the communities snapshot referencing a slightly stale generation; this is self-correcting on the next `report` run and is always surfaced via the `stale`/`communityStale` flags rather than silently served as fresh, but it is not a single transaction.
- **Performance on large graphs.** `report` and `path` both load the full graph via `readStoredGraph` (the same pattern `buildGraph` already uses for diffing), not the lazy bucketed index. This is consistent with the binding contract's literal `computeCommunities(graph: CodeGraphV1)`/`computeGodNodes(graph: CodeGraphV1, limit)` signatures, but on very large repositories this is a real memory/time cost; the master plan's Phase 2 exit criterion ("full build of this repository < 60 s") should be re-measured with `report` included during the Task T9.1 dogfooding re-run.
