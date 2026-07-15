# Memex Slice 2a Implementation Plan — Unified Graph: Concept and Wiki Planes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Path note:** every path below uses `plugins/openwiki/...` because that is the tree that exists today. Phase 1 (`T1.1`–`T1.4` in the master plan) renames `plugins/openwiki` → `plugins/memex` as a separate, later phase. When this slice executes after that rename has landed, apply the identical relative paths under `plugins/memex/...` instead — nothing else about this plan changes.

**Goal:** Extend the existing native code graph into a unified graph that also holds agent-authored concept and wiki-page data, and ship the `enrich` write operation end-to-end (contracts → store → operation → CLI → MCP → skills → `check` invariants), so the wiki's pages become graph-anchored, cited knowledge rather than free-floating markdown.

**Architecture:** The deterministic scanner keeps building the code plane exactly as it does today (`graph-scan.ts` → `graph.ts#assembleGraph` → `graph-store.ts` shards). A new, parallel "enrichment shard" — keyed by `(sourcePath, sourceContentHash)`, one per enriched file — carries agent-authored `concept`/`page`/`source` nodes and `mentions`/`describes`/`grounds`/`related` edges. `enrich.ts` validates, redacts, hash-verifies, and atomically persists one enrichment shard per call; `graph.ts#buildGraph` merges the currently-known enrichment shards back into every rebuild so a routine code rescan never erases curated concept data. `wiki.ts#checkWiki` gains graph-anchoring invariants that only activate when a graph is available, so the existing personal-mode and pre-build code paths keep working unchanged.

**Tech Stack:** TypeScript (strict, `plugins/openwiki/tsconfig.json`), Node >= 20 built-ins only, `node --test`, eslint (`typescript-eslint` strict-type-checked), zero runtime npm dependencies. No new dependency is added by this slice.

## Global Constraints

- Runtime forbids: network access, model credentials, native compilation, `npm install`, processes beyond Node >= 20 and Git.
- Graph mutation boundary preserved verbatim: build/enrich/index never execute repository code, never write outside `~/.openwiki/data/<workspace-id>/` (becomes `~/.memex/...` only after the separate Phase 1 rename), never store source-file bodies.
- All operations return bounded JSON with stable machine error codes. This slice introduces **no new error codes** — every failure mode is covered by the existing `OPENWIKI_ERROR_CODES` set (`INVALID_ARGUMENT`, `SOURCE_TOO_LARGE`, `NOT_INITIALIZED`, `PATH_OUTSIDE_ROOT`, `SYMLINK_ESCAPE`, `NOT_FOUND`, `INVALID_STATE`).
- No `any`, no unchecked casts; discriminated unions + runtime validation for every new contract, following the existing `assertKeys`/`object`/`string`/`requireRecord`/`requireKnownKeys` style already used in `graph-contracts.ts` and `contracts.ts`.
- Silent fallback forbidden: an unresolved enrich edge reference is a hard `INVALID_ARGUMENT` at write time, never silently dropped; a dangling reference discovered later (because a rebuild removed the code node it pointed at) is pruned from the live graph and surfaced as a diagnostic, never silently left inconsistent.
- Confidence-per-edge-kind (binding, from the master plan): scanner edge kinds (`contains|declares|imports|exports|calls|inherits|implements|references`) accept only `exact|resolved|heuristic`; agent edge kinds (`mentions|describes|grounds|related`) accept only `extracted|inferred|ambiguous`; `member-of` accepts only `exact`.
- Enrich envelope caps (binding): ≤ 200 nodes, ≤ 800 edges, ≤ 256 KiB total envelope size.
- TDD per task: failing test → minimal implementation → pass → commit.
- Suite: `npm --prefix plugins/openwiki run build && npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`.
- Commits: no AI attribution trailers; concrete behavior-focused messages, matching existing history style (`feat(openwiki): ...`, `fix(openwiki): ...`, `test: ...`).

## Design decisions not fully pinned by the PRD/master plan (read before starting)

The binding contracts in the master plan fix type names and signatures but leave a few mechanics unspecified. This plan makes the following concrete, testable choices. They are implementation detail, not contract deviations — every type in the binding contract block keeps its exact name and shape.

1. **`CodeGraphV1.schemaVersion` bumps from `1` to `2`.** This is the literal "graph-contracts.ts schema v2" from the master plan. It is **only** the data-snapshot schema (`CodeGraphV1`/`GraphNodeV1`/`GraphEdgeV1`), not the CLI/MCP **operation-envelope** wire format (`GraphResultEnvelope`, `BuildGraphResult`, `GraphStatusResult`, etc. in `graph.ts`), which keeps `schemaVersion: 1` unchanged — those wrappers are a separate, already-stable public response contract whose shape (`{nodes, edges, truncated, diagnostics, ...}`) does not change in this slice. Do not "helpfully" bump every literal `schemaVersion: 1` you find via grep; Task 1 lists the exact three call sites that must change and explains why the rest must not.

   A genuine pre-2a `CodeGraphV1` snapshot (`schemaVersion: 1`, actually written to disk before this slice shipped) is, by design, no longer parseable by `parseCodeGraph` after this bump — its node/edge vocabulary predates confidence-per-edge-kind validation, and silently accepting it would defeat the point of the stricter check; Task 1's own test asserts this rejection. "The store stays shard-compatible" (this decision, above) is satisfied in the precise sense that actually matters operationally, not by making old snapshots parseable: the sole caller of the deprecated `readStoredGraph` — inside `buildGraph`, used only to diff `changedPaths` against the previous build — already treats *any* parse failure identically to "no previous graph was ever built," an existing, pre-2a, already-shipped code path whose visible, non-silent consequence is `buildMode: "full"`, `fullRebuild: true`, and `changedPaths` listing every current file. Upgrading a pre-2a workspace to this slice costs its first post-upgrade `graph build` exactly one full rescan, reported explicitly in that build's own JSON response — never a crash, and never a mislabeled "fresh"/"incremental" result. Task 4 adds a test proving this transition behaves exactly this way, not just asserting it in prose.
2. **`GraphManifest.schemaVersion` (the store/index format) is left at `GRAPH_STORE_SCHEMA_VERSION = 2`, unchanged.** It already equals `2` today for an unrelated reason (the Stage-B lazy-index refactor that predates this slice). The master plan's "manifest gains schemaVersion: 2" is satisfied by decision 1 above (the persisted `CodeGraphV1` snapshot embedded in each generation carries `schemaVersion: 2`); the store/index format itself does not need a second bump because enrichment shards are a **new, additive** manifest field (`enrichmentShards`), not a change to the existing bucket/shard format. **Flagged for orchestrator review** in the report — this is the one place this plan's reading of the binding contract could plausibly differ from what was intended when it was written.
3. **"Backward read of v1 shards"** is satisfied structurally: the existing `GraphShard` (code-scan shard) format is untouched byte-for-byte, and `parseManifest` treats a missing `enrichmentShards` field as `[]` — a manifest written before this slice ships opens exactly as it does today, with zero enrichment shards, and needs no migration step.
4. **Enrich edge `from`/`to` reference grammar.** The binding contract types `from`/`to` as plain `string`, without specifying how an agent references a node. This plan resolves a reference two ways: (a) the literal 64-hex-lowercase graph node id — for referencing any node that already exists in the persisted graph (a code node from a prior `graph query`/`context`, or a concept/page node from an earlier `enrich` call), verified against the open graph index; (b) the composite shorthand `` `${kind}:${path}:${name}` `` (kind is `concept` or `page`) — for referencing a node declared in the **same** envelope's `nodes` array, resolved locally without needing the agent to precompute a hash. Any other value is rejected with `INVALID_ARGUMENT`.
5. **`source` nodes and `grounds` edges are auto-synthesized by `enrich.ts`**, not agent-declared. `EnrichEnvelopeV1.nodes` only allows `concept`/`page` per the binding contract (there is no way for the agent to declare a `source` node), so every `enrich` call synthesizes exactly one `source` node identified by `(sourcePath, sourceContentHash)` and one `grounds` edge from that source to each node the envelope introduces, with confidence `"extracted"` (the strongest agent-confidence tier — the source is the direct, hash-verified origin of the extraction). This is what actually populates the `source` node kind and the `grounds` edge kind; without it, slice 2a would ship two vocabulary members that nothing ever creates.
6. **`check`'s new invariants only activate when a graph is available.** A personal-mode wiki has no graph at all, and a code-mode wiki immediately after `init` (before `graph build`) has none yet either. In both cases the existing checks still run; the three new invariants (page↔graph anchoring, describes/mentions coverage, no dangling references) are skipped with no issue raised — not because they are optional, but because there is nothing yet to check. The Task 8 skill updates make `enrich` a mandatory step in the normal `init`/`update` procedure, so in the real end-to-end flow the invariants are enforced as the PRD's acceptance criteria require; Task 9's e2e test proves this ordering.

## Binding contracts reproduced for reference (from the master plan; do not rename)

```ts
// graph-contracts.ts (schema v2; store stays shard-compatible, manifest gains schemaVersion: 2)
export type GraphNodeKind = "repository" | "directory" | "file" | "module" | "symbol"
  | "concept" | "page" | "source";
export type GraphEdgeKind = "contains" | "declares" | "imports" | "exports" | "calls"
  | "inherits" | "implements" | "references"
  | "mentions" | "describes" | "grounds" | "related" | "member-of";
export type ScannerConfidence = "exact" | "resolved" | "heuristic";      // deterministic planes
export type AgentConfidence   = "extracted" | "inferred" | "ambiguous";  // agent-authored edges
export type GraphConfidence = ScannerConfidence | AgentConfidence;
// Validation rule: scanner edge kinds accept only ScannerConfidence; mentions|describes|grounds|related accept only AgentConfidence; member-of accepts only "exact" (computed).

// enrich.ts
export interface EnrichEnvelopeV1 {
  schema: "memex.enrich.v1";
  sourcePath: string;          // repo-relative origin of the extraction
  sourceContentHash: string;   // sha256 of that file at extraction time
  nodes: ReadonlyArray<{ kind: "concept" | "page"; name: string; path: string; summary?: string }>;
  edges: ReadonlyArray<{ kind: "mentions" | "describes" | "grounds" | "related";
                         from: string; to: string; confidence: AgentConfidence }>;
}
// Operation `enrich`: validate → redact → cap (≤ 200 nodes, ≤ 800 edges, ≤ 256 KiB) → atomic enrichment shard keyed by (sourcePath, sourceContentHash); unchanged hash → no-op.
```

The `schema` tag is kept as the literal `"memex.enrich.v1"` string exactly as specified, even though the package is still named `openwiki` until Phase 1 lands — the envelope schema tag is a contract identifier, not a package name, and the binding contract fixes its exact value.

---

## Task 1: `graph-contracts.ts` — v2 node/edge kinds, confidence model, enrichment shard type

**Files:**
- Modify: `plugins/openwiki/src/graph-contracts.ts`
- Modify: `plugins/openwiki/tests/unit/graph.test.mjs` (fix a pre-existing regression: line 51 currently asserts that `schemaVersion: 2` is *rejected* — it must become the accepted value)
- Modify: `plugins/openwiki/tests/unit/graph-store-v2.test.mjs` (fixture literal `schemaVersion: 1` → `2`)
- Modify: `plugins/openwiki/tests/integration/graph-store-concurrency.test.mjs` (fixture literal `schemaVersion: 1` → `2` — **only** the `CodeGraphV1` fixture at line 37; the lock-file JSON literal at line 38 is a different, unrelated schema and must not change)
- Test: `plugins/openwiki/tests/unit/graph-contracts-v2.test.mjs` (new)

**Interfaces:**
- Produces: `GRAPH_CONTRACTS_SCHEMA_VERSION`, widened `GraphNodeKind`/`GraphEdgeKind`, `ScannerConfidence`/`AgentConfidence`/`GraphConfidence`, `GraphNodeV1.summary?: string`, `isScannerEdgeKind(kind)`, `isAgentEdgeKind(kind)`, `validEdgeConfidence(kind, confidence)`, `isGraphNodeKind(value)`, `isGraphEdgeKind(value)`, `isGraphConfidence(value)`, `EnrichmentShardV1`, `mergeEnrichment(graph, shards)`, `parseEnrichmentShard(value)` — all consumed by Tasks 3, 4, 5, 7. In particular, `isGraphNodeKind`/`isGraphEdgeKind`/`isGraphConfidence` exist so Task 3 can widen `graph-index.ts`'s own, independent copy of these guards by reusing this file's vocabulary instead of hand-duplicating it a second time — see Task 3 for why that duplication is exactly what caused the read-path regression this revision fixes.

- [ ] **Step 1: Write the failing contract test**

Create `plugins/openwiki/tests/unit/graph-contracts-v2.test.mjs`:

```js
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  GRAPH_CONTRACTS_SCHEMA_VERSION,
  createGraphEdgeId,
  createGraphNodeId,
  isAgentEdgeKind,
  isGraphConfidence,
  isGraphEdgeKind,
  isGraphNodeKind,
  isScannerEdgeKind,
  mergeEnrichment,
  parseCodeGraph,
  parseEnrichmentShard,
  validEdgeConfidence,
} from "../../dist/graph-contracts.js";
import { OpenWikiError } from "../../dist/errors.js";

function baseGraph(overrides = {}) {
  return {
    schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION,
    workspaceId: "workspace",
    generatedAt: "2026-07-11T00:00:00.000Z",
    source: { dirtyFingerprint: "b".repeat(64), scannerVersion: "openwiki-graph-v1" },
    files: [],
    nodes: [],
    edges: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("graph contracts v2", () => {
  test("accepts schemaVersion 2 with concept, page, and source node kinds", () => {
    const conceptId = createGraphNodeId("concept", "concepts/rate-limiting.md", "rate limiting");
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const sourceId = createGraphNodeId("source", "architecture.md", "c".repeat(64));
    const describesId = createGraphEdgeId("describes", pageId, conceptId, "extracted");
    const parsed = parseCodeGraph(baseGraph({
      nodes: [
        { id: conceptId, kind: "concept", path: "concepts/rate-limiting.md", name: "rate limiting", summary: "Token bucket limiter." },
        { id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" },
        { id: sourceId, kind: "source", path: "architecture.md", name: "c".repeat(64) },
      ].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [{ id: describesId, kind: "describes", from: pageId, to: conceptId, confidence: "extracted" }],
    }));
    assert.equal(parsed.nodes.length, 3);
    assert.equal(parsed.edges[0].confidence, "extracted");
    assert.equal(parsed.nodes.find((node) => node.kind === "concept").summary, "Token bucket limiter.");
  });

  test("rejects an unsupported schema version, including the pre-2a value of 1", () => {
    assert.throws(() => parseCodeGraph({ ...baseGraph(), schemaVersion: 3 }), OpenWikiError);
    assert.throws(() => parseCodeGraph({ ...baseGraph(), schemaVersion: 1 }), OpenWikiError);
  });

  test("validates confidence per edge kind: scanner kinds reject agent labels and vice versa", () => {
    assert.equal(validEdgeConfidence("calls", "exact"), true);
    assert.equal(validEdgeConfidence("calls", "extracted"), false);
    assert.equal(validEdgeConfidence("mentions", "extracted"), true);
    assert.equal(validEdgeConfidence("mentions", "exact"), false);
    assert.equal(validEdgeConfidence("member-of", "exact"), true);
    assert.equal(validEdgeConfidence("member-of", "extracted"), false);
    assert.equal(isScannerEdgeKind("calls"), true);
    assert.equal(isAgentEdgeKind("calls"), false);
    assert.equal(isAgentEdgeKind("mentions"), true);

    const repositoryId = createGraphNodeId("repository", ".", "workspace");
    const fileId = createGraphNodeId("file", "src/index.ts", "index.ts");
    assert.throws(() => parseCodeGraph(baseGraph({
      files: [{ path: "src/index.ts", language: "typescript", contentHash: "c".repeat(64), size: 12 }],
      nodes: [
        { id: repositoryId, kind: "repository", path: ".", name: "workspace" },
        { id: fileId, kind: "file", path: "src/index.ts", name: "index.ts" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [{ id: createGraphEdgeId("contains", repositoryId, fileId, "extracted"), kind: "contains", from: repositoryId, to: fileId, confidence: "extracted" }],
    })), OpenWikiError);
  });

  test("mergeEnrichment appends concept/page nodes and agent edges, pruning dangling references into diagnostics", () => {
    const repositoryId = createGraphNodeId("repository", ".", "workspace");
    const graph = baseGraph({ nodes: [{ id: repositoryId, kind: "repository", path: ".", name: "workspace" }] });
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const conceptId = createGraphNodeId("concept", "concepts/x.md", "x");
    const validEdgeId = createGraphEdgeId("describes", pageId, conceptId, "extracted");
    const danglingEdgeId = createGraphEdgeId("mentions", pageId, "0".repeat(64), "inferred");
    const shard = {
      sourcePath: "architecture.md",
      sourceContentHash: "d".repeat(64),
      nodes: [
        { id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" },
        { id: conceptId, kind: "concept", path: "concepts/x.md", name: "x" },
      ],
      edges: [
        { id: validEdgeId, kind: "describes", from: pageId, to: conceptId, confidence: "extracted" },
        { id: danglingEdgeId, kind: "mentions", from: pageId, to: "0".repeat(64), confidence: "inferred" },
      ],
      enrichedAt: "2026-07-14T00:00:00.000Z",
    };
    const merged = mergeEnrichment(graph, [shard]);
    assert.equal(merged.nodes.length, 3);
    assert.deepEqual(merged.edges.map((edge) => edge.id), [validEdgeId]);
    assert.equal(merged.diagnostics.some((diagnostic) => diagnostic.code === "DANGLING_NODE_REF"), true);
  });

  test("parseEnrichmentShard validates shape and round-trips", () => {
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const shard = {
      sourcePath: "architecture.md",
      sourceContentHash: "e".repeat(64),
      nodes: [{ id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" }],
      edges: [],
      enrichedAt: "2026-07-14T00:00:00.000Z",
    };
    assert.deepEqual(parseEnrichmentShard(shard), shard);
    assert.throws(() => parseEnrichmentShard({ ...shard, sourceContentHash: "not-a-hash" }), OpenWikiError);
  });

  test("exports isGraphNodeKind/isGraphEdgeKind/isGraphConfidence for graph-index.ts to reuse", () => {
    assert.equal(isGraphNodeKind("concept"), true);
    assert.equal(isGraphNodeKind("symbol"), true);
    assert.equal(isGraphNodeKind("not-a-kind"), false);
    assert.equal(isGraphEdgeKind("mentions"), true);
    assert.equal(isGraphEdgeKind("calls"), true);
    assert.equal(isGraphEdgeKind("member-of"), true);
    assert.equal(isGraphEdgeKind("not-a-kind"), false);
    assert.equal(isGraphConfidence("exact"), true);
    assert.equal(isGraphConfidence("extracted"), true);
    assert.equal(isGraphConfidence("not-a-confidence"), false);
  });

  test("computes the same scoped-symbol discriminator graph.ts's node() helper uses, so scoped symbols round-trip", () => {
    const repositoryId = createGraphNodeId("repository", ".", "workspace");
    const methodId = createGraphNodeId("symbol", "src/service.ts", "run", "function", `Service\u0000${String(3)}`);
    const parsed = parseCodeGraph(baseGraph({
      nodes: [
        { id: repositoryId, kind: "repository", path: ".", name: "workspace" },
        { id: methodId, kind: "symbol", path: "src/service.ts", name: "run", scope: "Service", symbolKind: "function", startLine: 3, endLine: 4 },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    }));
    assert.ok(parsed.nodes.some((node) => node.id === methodId));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/graph-contracts-v2.test.mjs`
Expected: FAIL — build fails or the test fails, because `GRAPH_CONTRACTS_SCHEMA_VERSION`, `isScannerEdgeKind`, `isAgentEdgeKind`, `validEdgeConfidence`, `mergeEnrichment`, `parseEnrichmentShard` do not exist yet, and `schemaVersion: 2` is currently rejected.

- [ ] **Step 3: Implement the graph-contracts.ts changes**

Replace the top of `plugins/openwiki/src/graph-contracts.ts` — **from the start through the original `const CONFIDENCES = new Set<GraphConfidence>(["exact", "resolved", "heuristic"]);` line**, i.e. through and including the pre-existing `NODE_KINDS`/`EDGE_KINDS`/`CONFIDENCES` declarations, not merely through the `GraphQueryLimits` interface three lines above them. (Stopping at `GraphQueryLimits` leaves the current file's own `NODE_KINDS`/`EDGE_KINDS` consts in place a few lines further down, which collide with the new declarations below and fail to compile with "Cannot redeclare block-scoped variable.") — with:

```ts
import { createHash } from "node:crypto";

import { OpenWikiError } from "./errors.js";

export const GRAPH_SCANNER_VERSION = "openwiki-graph-v1";
export const GRAPH_CONTRACTS_SCHEMA_VERSION = 2 as const;
export const GRAPH_DEFAULTS = {
  defaultEntityLimit: 20,
  defaultResponseBytes: 16 * 1024,
  maxEntityLimit: 100,
  maxFiles: 50_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxRepositoryBytes: 512 * 1024 * 1024,
  maxResponseBytes: 64 * 1024,
  maxTraversalDepth: 5,
} as const;

export type GraphNodeKind =
  | "repository" | "directory" | "file" | "module" | "symbol"
  | "concept" | "page" | "source";
export type GraphEdgeKind =
  | "contains" | "declares" | "imports" | "exports" | "calls" | "inherits" | "implements" | "references"
  | "mentions" | "describes" | "grounds" | "related" | "member-of";
export type ScannerConfidence = "exact" | "resolved" | "heuristic";
export type AgentConfidence = "extracted" | "inferred" | "ambiguous";
export type GraphConfidence = ScannerConfidence | AgentConfidence;

export interface GraphFileV1 { path: string; language: string; contentHash: string; size: number; }
export interface GraphNodeV1 { id: string; kind: GraphNodeKind; path: string; name: string; scope?: string; symbolKind?: string; startLine?: number; endLine?: number; summary?: string; }
export interface GraphEdgeV1 { id: string; kind: GraphEdgeKind; from: string; to: string; confidence: GraphConfidence; }
export interface GraphDiagnosticV1 { path: string; code: string; message: string; }
export interface CodeGraphV1 {
  schemaVersion: typeof GRAPH_CONTRACTS_SCHEMA_VERSION; workspaceId: string; generatedAt: string;
  source: { gitHead?: string; dirtyFingerprint: string; scannerVersion: string };
  files: GraphFileV1[]; nodes: GraphNodeV1[]; edges: GraphEdgeV1[]; diagnostics: GraphDiagnosticV1[];
}

export interface EnrichmentShardV1 {
  sourcePath: string;
  sourceContentHash: string;
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
  enrichedAt: string;
}

export interface GraphLimits { maxFiles?: number; maxFileBytes?: number; maxRepositoryBytes?: number; }
export interface GraphQueryLimits { limit?: number; responseByteLimit?: number; depth?: number; }

const NODE_KINDS = new Set<GraphNodeKind>(["repository", "directory", "file", "module", "symbol", "concept", "page", "source"]);
const SCANNER_EDGE_KINDS = new Set<GraphEdgeKind>(["contains", "declares", "imports", "exports", "calls", "inherits", "implements", "references"]);
const AGENT_EDGE_KINDS = new Set<GraphEdgeKind>(["mentions", "describes", "grounds", "related"]);
const EDGE_KINDS = new Set<GraphEdgeKind>([...SCANNER_EDGE_KINDS, ...AGENT_EDGE_KINDS, "member-of"]);
const SCANNER_CONFIDENCES = new Set<GraphConfidence>(["exact", "resolved", "heuristic"]);
const AGENT_CONFIDENCES = new Set<GraphConfidence>(["extracted", "inferred", "ambiguous"]);

export function isScannerEdgeKind(kind: GraphEdgeKind): boolean { return SCANNER_EDGE_KINDS.has(kind); }
export function isAgentEdgeKind(kind: GraphEdgeKind): boolean { return AGENT_EDGE_KINDS.has(kind); }

export function validEdgeConfidence(kind: GraphEdgeKind, confidence: GraphConfidence): boolean {
  if (kind === "member-of") return confidence === "exact";
  if (isAgentEdgeKind(kind)) return AGENT_CONFIDENCES.has(confidence);
  return SCANNER_CONFIDENCES.has(confidence);
}

export function isGraphNodeKind(value: unknown): value is GraphNodeKind {
  return typeof value === "string" && NODE_KINDS.has(value as GraphNodeKind);
}
export function isGraphEdgeKind(value: unknown): value is GraphEdgeKind {
  return typeof value === "string" && EDGE_KINDS.has(value as GraphEdgeKind);
}
export function isGraphConfidence(value: unknown): value is GraphConfidence {
  return typeof value === "string" && (SCANNER_CONFIDENCES.has(value as GraphConfidence) || AGENT_CONFIDENCES.has(value as GraphConfidence));
}
```

These three exports exist specifically so `graph-index.ts` (Task 3) can reuse this file's own vocabulary instead of maintaining a second, hand-written copy of the same kind/confidence checks — which is exactly what let `graph-index.ts`'s independent guards silently fall out of sync with this file's widened vocabulary. Every other file that needs to recognize a node/edge kind or a confidence label should import these rather than redefining them.

Update `createGraphNodeId`/`createGraphEdgeId`/`graphHash`/`canonicalizeGraph` — **no changes needed**, they already operate generically on the widened kind/confidence unions.

Update `parseCodeGraph`'s schema check:

```ts
export function parseCodeGraph(value: unknown): CodeGraphV1 {
  const record = object(value, "Graph must be an object.");
  assertKeys(record, ["schemaVersion", "workspaceId", "generatedAt", "source", "files", "nodes", "edges", "diagnostics"]);
  if (record.schemaVersion !== GRAPH_CONTRACTS_SCHEMA_VERSION) fail("Graph schema version is unsupported.");
  const source = object(record.source, "Graph source must be an object.");
  assertKeys(source, ["gitHead", "dirtyFingerprint", "scannerVersion"], true);
  const graph: CodeGraphV1 = {
    schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION,
    workspaceId: string(record.workspaceId, "Graph workspaceId must be a string."),
    generatedAt: timestamp(record.generatedAt),
    source: {
      ...(source.gitHead === undefined ? {} : { gitHead: string(source.gitHead, "Graph gitHead must be a string.") }),
      dirtyFingerprint: string(source.dirtyFingerprint, "Graph dirtyFingerprint must be a string."),
      scannerVersion: string(source.scannerVersion, "Graph scannerVersion must be a string."),
    },
    files: array(record.files, "Graph files must be an array.").map(parseFile),
    nodes: array(record.nodes, "Graph nodes must be an array.").map(parseNode),
    edges: array(record.edges, "Graph edges must be an array.").map(parseEdge),
    diagnostics: array(record.diagnostics, "Graph diagnostics must be an array.").map(parseDiagnostic),
  };
  const canonical = canonicalizeGraph(graph);
  if (JSON.stringify(graph.files) !== JSON.stringify(canonical.files) || JSON.stringify(graph.nodes) !== JSON.stringify(canonical.nodes) || JSON.stringify(graph.edges) !== JSON.stringify(canonical.edges) || JSON.stringify(graph.diagnostics) !== JSON.stringify(canonical.diagnostics)) fail("Graph arrays must be canonically sorted.");
  const ids = new Set(canonical.nodes.map((node) => node.id));
  if (ids.size !== canonical.nodes.length || new Set(canonical.edges.map((edge) => edge.id)).size !== canonical.edges.length) fail("Graph IDs must be unique.");
  if (canonical.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) fail("Graph edge endpoints must exist.");
  return canonical;
}
```

Update `parseNode` to accept the widened kind set and the optional `summary` field:

```ts
function parseNode(value: unknown): GraphNodeV1 {
  const r = object(value, "Graph node must be an object.");
  assertKeys(r, ["id", "kind", "path", "name", "scope", "symbolKind", "startLine", "endLine", "summary"], true);
  const kind = string(r.kind, "Graph node kind must be a string.") as GraphNodeKind;
  if (!NODE_KINDS.has(kind)) fail("Graph node kind is unsupported.");
  const node: GraphNodeV1 = { id: string(r.id, "Graph node id must be a string."), kind, path: relativePath(r.path), name: string(r.name, "Graph node name must be a string.") };
  if (r.scope !== undefined) node.scope = string(r.scope, "Graph symbol scope must be a string.");
  if (r.symbolKind !== undefined) node.symbolKind = string(r.symbolKind, "Graph symbol kind must be a string.");
  if (r.startLine !== undefined) node.startLine = line(r.startLine);
  if (r.endLine !== undefined) node.endLine = line(r.endLine);
  if (r.summary !== undefined) node.summary = string(r.summary, "Graph node summary must be a string.");
  if (node.endLine !== undefined && node.startLine !== undefined && node.endLine < node.startLine) fail("Graph node line range is invalid.");
  const discriminator = node.startLine === undefined ? undefined : node.scope === undefined ? String(node.startLine) : `${node.scope}\u0000${node.startLine.toString()}`;
  if (node.id !== createGraphNodeId(node.kind, node.path, node.name, node.symbolKind, discriminator)) fail("Graph node ID does not match its identity fields.");
  return node;
}
```

**The separator in that template literal must be the null-byte escape `\u0000`, exactly as shown above — not a space, and not any other character.** `graph.ts`'s own `node()` helper (the function `assembleGraph` calls to actually construct symbol nodes) computes this exact discriminator today as `` `${scope}\u0000${startLine.toString()}` ``. Task 4 does not touch that helper, so the two must keep agreeing byte-for-byte. If they ever diverge, every symbol with both a `scope` and a `startLine` — essentially every class method or nested function in a real codebase — gets an id here that disagrees with the id `graph.ts` actually assigned it, and `parseCodeGraph`'s round-trip check (`node.id !== createGraphNodeId(...)`) rejects every such node. The only current caller of this path is the deprecated `readStoredGraph`, wrapped in `.catch(() => undefined)`, so a divergence here would not crash anything — it would silently degrade every subsequent build on such a repository to a forced full rescan forever, which is exactly the "silent fallback" this plan's Global Constraints forbid. Task 1's own test in Step 1 (above) exercises a scoped, positioned symbol specifically to guard against this.

Update `parseEdge` to use `EDGE_KINDS` and `validEdgeConfidence` instead of the flat `CONFIDENCES` set (remove the old `CONFIDENCES` constant entirely):

```ts
function parseEdge(value: unknown): GraphEdgeV1 {
  const r = object(value, "Graph edge must be an object.");
  assertKeys(r, ["id", "kind", "from", "to", "confidence"]);
  const kind = string(r.kind, "Graph edge kind must be a string.") as GraphEdgeKind;
  const confidence = string(r.confidence, "Graph edge confidence must be a string.") as GraphConfidence;
  if (!EDGE_KINDS.has(kind) || !validEdgeConfidence(kind, confidence)) fail("Graph edge type is unsupported.");
  const edge = { id: string(r.id, "Graph edge id must be a string."), kind, from: string(r.from, "Graph edge from must be a string."), to: string(r.to, "Graph edge to must be a string."), confidence };
  if (edge.id !== createGraphEdgeId(edge.kind, edge.from, edge.to, edge.confidence)) fail("Graph edge ID does not match its identity fields.");
  return edge;
}
```

Add `mergeEnrichment` and `parseEnrichmentShard` at the end of the file, before the private helper functions:

```ts
export function mergeEnrichment(graph: CodeGraphV1, shards: readonly EnrichmentShardV1[]): CodeGraphV1 {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const diagnostics = [...graph.diagnostics];
  const ordered = [...shards].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.sourceContentHash.localeCompare(right.sourceContentHash));
  for (const shard of ordered) for (const node of shard.nodes) nodes.set(node.id, node);
  for (const shard of ordered) {
    for (const edge of shard.edges) {
      if (nodes.has(edge.from) && nodes.has(edge.to)) edges.set(edge.id, edge);
      else diagnostics.push({ path: shard.sourcePath, code: "DANGLING_NODE_REF", message: `Enrichment edge ${edge.id} references a node that does not exist.` });
    }
  }
  return canonicalizeGraph({ ...graph, nodes: [...nodes.values()], edges: [...edges.values()], diagnostics });
}

export function parseEnrichmentShard(value: unknown): EnrichmentShardV1 {
  const r = object(value, "Enrichment shard must be an object.");
  assertKeys(r, ["sourcePath", "sourceContentHash", "nodes", "edges", "enrichedAt"]);
  return {
    sourcePath: relativePath(r.sourcePath),
    sourceContentHash: hash(r.sourceContentHash),
    nodes: array(r.nodes, "Enrichment shard nodes must be an array.").map(parseNode),
    edges: array(r.edges, "Enrichment shard edges must be an array.").map(parseEdge),
    enrichedAt: timestamp(r.enrichedAt),
  };
}
```

- [ ] **Step 4: Fix the pre-existing regression in `graph.test.mjs`**

In `plugins/openwiki/tests/unit/graph.test.mjs`, change the fixture helper's `schemaVersion: 1,` (line 22) to `schemaVersion: 2,`, and change the assertion at line 51 from asserting that `schemaVersion: 2` is rejected to asserting the two genuinely-invalid values are rejected:

```ts
    assert.throws(() => parseCodeGraph({ ...graph(), schemaVersion: 1 }), OpenWikiError);
    assert.throws(() => parseCodeGraph({ ...graph(), schemaVersion: 3 }), OpenWikiError);
```

- [ ] **Step 5: Fix the pre-existing fixtures in `graph-store-v2.test.mjs` and `graph-store-concurrency.test.mjs`**

In `plugins/openwiki/tests/unit/graph-store-v2.test.mjs`, change the `graph(label)` helper's `schemaVersion: 1,` (line 42) to `schemaVersion: 2,`.

In `plugins/openwiki/tests/integration/graph-store-concurrency.test.mjs`, change **only** line 37's `writeGraph(resolved.storage, { schemaVersion: 1, ...` to `writeGraph(resolved.storage, { schemaVersion: 2, ...`. Leave line 38's lock-file JSON (`{ schemaVersion: 1, pid: ..., token: "test-writer" }`) untouched — it is the writer-lock record format (`graph-store.ts`'s `withGraphWriteLock`), a different, unrelated schema that this slice does not touch.

- [ ] **Step 6: Run the new and updated tests**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/graph-contracts-v2.test.mjs plugins/openwiki/tests/unit/graph.test.mjs plugins/openwiki/tests/unit/graph-store-v2.test.mjs plugins/openwiki/tests/integration/graph-store-concurrency.test.mjs`
Expected: PASS, all four files.

- [ ] **Step 7: Run the full suite for a non-regression check**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS. (`graph-analysis.test.mjs`, `graph-repository.test.mjs`, and every other test that calls `buildGraph()`/`assembleGraph()` rather than constructing a literal `CodeGraphV1` fixture is unaffected, since `buildGraph`'s own `schemaVersion: 1` on its *returned envelope* is untouched — only the internal snapshot's schema bumped, and Task 4 updates the one place that constructs it.)

Note: this step is expected to show a typecheck/build **failure** at `graph.ts`'s `assembleGraph` (still emitting `schemaVersion: 1` into a `CodeGraphV1`, which now requires literal `2`) until Task 4 lands. That is expected and acceptable to leave red between Task 1 and Task 4 in this plan's sequencing; do not paper over it by reverting Task 1's schema check. If your workflow requires every task to leave the suite green, pull the one-line `assembleGraph` fix (`schemaVersion: 1` → `schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION`) forward into this task's commit instead of Task 4's.

- [ ] **Step 8: Commit**

```bash
git add plugins/openwiki/src/graph-contracts.ts plugins/openwiki/tests/unit/graph-contracts-v2.test.mjs plugins/openwiki/tests/unit/graph.test.mjs plugins/openwiki/tests/unit/graph-store-v2.test.mjs plugins/openwiki/tests/integration/graph-store-concurrency.test.mjs
git commit -m "feat(openwiki): add concept/page/source graph plane and confidence-per-edge-kind validation"
```

---

## Task 2: `contracts.ts` — `EnrichEnvelopeV1` and `parseEnrichEnvelope`

**Files:**
- Modify: `plugins/openwiki/src/contracts.ts`
- Test: `plugins/openwiki/tests/unit/enrich-contracts.test.mjs` (new)

**Interfaces:**
- Consumes: `AgentConfidence` from `./graph-contracts.js` (Task 1).
- Produces: `ENRICH_SCHEMA_TAG`, `MAX_ENRICH_NODES`, `MAX_ENRICH_EDGES`, `MAX_ENRICH_ENVELOPE_BYTES`, `EnrichEnvelopeV1`, `parseEnrichEnvelope(input: unknown): EnrichEnvelopeV1` — consumed by Task 5 (`enrich.ts`).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/unit/enrich-contracts.test.mjs`:

```js
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ENRICH_SCHEMA_TAG,
  MAX_ENRICH_EDGES,
  MAX_ENRICH_ENVELOPE_BYTES,
  MAX_ENRICH_NODES,
  parseEnrichEnvelope,
} from "../../dist/contracts.js";
import { OpenWikiError } from "../../dist/errors.js";

function envelope(overrides = {}) {
  return {
    schema: ENRICH_SCHEMA_TAG,
    sourcePath: "architecture.md",
    sourceContentHash: "a".repeat(64),
    nodes: [{ kind: "page", name: "architecture.md", path: "architecture.md" }],
    edges: [],
    ...overrides,
  };
}

function captureOpenWikiError(callback) {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof OpenWikiError);
    return error;
  }
  assert.fail("Expected OpenWikiError to be thrown.");
}

describe("enrich envelope contracts", () => {
  test("parses a valid enrich envelope", () => {
    assert.deepEqual(parseEnrichEnvelope(envelope()), envelope());
  });

  test("accepts concept nodes with an optional summary and agent-confidence edges", () => {
    const value = envelope({
      nodes: [
        { kind: "page", name: "architecture.md", path: "architecture.md" },
        { kind: "concept", name: "rate limiting", path: "concepts/rate-limiting.md", summary: "Token bucket limiter." },
      ],
      edges: [{ kind: "describes", from: "page:architecture.md:architecture.md", to: "concept:concepts/rate-limiting.md:rate limiting", confidence: "extracted" }],
    });
    assert.deepEqual(parseEnrichEnvelope(value), value);
  });

  test("rejects an unsupported schema tag", () => {
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ schema: "openwiki.enrich.v1" }))).code, "INVALID_ARGUMENT");
  });

  test("rejects unknown top-level, node, and edge fields", () => {
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ unexpected: true }))).code, "INVALID_ARGUMENT");
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ nodes: [{ kind: "page", name: "a", path: "a.md", unexpected: true }] }))).code, "INVALID_ARGUMENT");
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ edges: [{ kind: "mentions", from: "x", to: "y", confidence: "extracted", unexpected: true }] }))).code, "INVALID_ARGUMENT");
  });

  test("rejects an invalid sourceContentHash and a non-relative sourcePath", () => {
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ sourceContentHash: "not-a-hash" }))).code, "INVALID_ARGUMENT");
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ sourcePath: "/etc/passwd" }))).code, "INVALID_ARGUMENT");
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ sourcePath: "../escape.md" }))).code, "INVALID_ARGUMENT");
  });

  test("rejects an unsupported node kind and edge kind", () => {
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ nodes: [{ kind: "symbol", name: "a", path: "a.md" }] }))).code, "INVALID_ARGUMENT");
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ edges: [{ kind: "calls", from: "x", to: "y", confidence: "extracted" }] }))).code, "INVALID_ARGUMENT");
  });

  test("rejects an unsupported edge confidence label", () => {
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ edges: [{ kind: "mentions", from: "x", to: "y", confidence: "exact" }] }))).code, "INVALID_ARGUMENT");
  });

  test("enforces node, edge, and byte caps", () => {
    const tooManyNodes = Array.from({ length: MAX_ENRICH_NODES + 1 }, (_, index) => ({ kind: "concept", name: `concept-${String(index)}`, path: `concepts/${String(index)}.md` }));
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ nodes: tooManyNodes }))).code, "SOURCE_TOO_LARGE");

    const tooManyEdges = Array.from({ length: MAX_ENRICH_EDGES + 1 }, (_, index) => ({ kind: "related", from: `a-${String(index)}`, to: `b-${String(index)}`, confidence: "inferred" }));
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ edges: tooManyEdges }))).code, "SOURCE_TOO_LARGE");

    const oversizedSummary = "x".repeat(MAX_ENRICH_ENVELOPE_BYTES);
    assert.equal(captureOpenWikiError(() => parseEnrichEnvelope(envelope({ nodes: [{ kind: "concept", name: "big", path: "concepts/big.md", summary: oversizedSummary }] }))).code, "SOURCE_TOO_LARGE");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/enrich-contracts.test.mjs`
Expected: FAIL — build fails, `parseEnrichEnvelope` and friends do not exist yet.

- [ ] **Step 3: Implement `parseEnrichEnvelope` in contracts.ts**

Add the import at the top of `plugins/openwiki/src/contracts.ts`:

```ts
import { OpenWikiError, type OpenWikiErrorCode } from "./errors.js";
import { type AgentConfidence } from "./graph-contracts.js";
```

Add the following after the existing `SOURCE_ITEM_KEYS` constant block (before `parseWikiState`):

```ts
export const ENRICH_SCHEMA_TAG = "memex.enrich.v1";
export const MAX_ENRICH_ENVELOPE_BYTES = 256 * 1024;
export const MAX_ENRICH_NODES = 200;
export const MAX_ENRICH_EDGES = 800;

export type EnrichNodeKind = "concept" | "page";
export type EnrichEdgeKind = "mentions" | "describes" | "grounds" | "related";

export interface EnrichEnvelopeV1 {
  schema: typeof ENRICH_SCHEMA_TAG;
  sourcePath: string;
  sourceContentHash: string;
  nodes: ReadonlyArray<{ kind: EnrichNodeKind; name: string; path: string; summary?: string }>;
  edges: ReadonlyArray<{ kind: EnrichEdgeKind; from: string; to: string; confidence: AgentConfidence }>;
}

const ENRICH_ENVELOPE_KEYS = new Set(["schema", "sourcePath", "sourceContentHash", "nodes", "edges"]);
const ENRICH_NODE_KEYS = new Set(["kind", "name", "path", "summary"]);
const ENRICH_EDGE_KEYS = new Set(["kind", "from", "to", "confidence"]);
const ENRICH_NODE_KIND_SET = new Set<string>(["concept", "page"]);
const ENRICH_EDGE_KIND_SET = new Set<string>(["mentions", "describes", "grounds", "related"]);
const AGENT_CONFIDENCE_SET = new Set<string>(["extracted", "inferred", "ambiguous"]);
const HEX_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
```

Before adding the enrich parsing functions, generalize the existing private `enforceEnvelopeByteLimit(input: unknown): void` helper (used today only by `parseSourceEnvelope`) so both envelope kinds share one byte-limit check instead of two near-identical copies. Change its signature and body to:

```ts
function enforceEnvelopeByteLimit(input: unknown, maxBytes: number, label: string): void {
  let serializedValue: unknown;
  try {
    serializedValue = JSON.stringify(input);
  } catch {
    throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be JSON serializable.`);
  }

  if (typeof serializedValue !== "string") {
    throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be JSON serializable.`);
  }
  if (utf8ByteLength(serializedValue) > maxBytes) {
    throw new OpenWikiError(
      "SOURCE_TOO_LARGE",
      `${label} exceeds the ${String(maxBytes)} byte limit.`,
    );
  }
}
```

And update its one existing call site inside `parseSourceEnvelope` (currently `enforceEnvelopeByteLimit(input);` right after the `export function parseSourceEnvelope(input: unknown): SourceEnvelopeV1 {` line) to pass the two new arguments explicitly:

```ts
  enforceEnvelopeByteLimit(input, MAX_ENVELOPE_BYTES, "Source envelope");
```

Now add the parsing functions after `parseSourceEnvelope` and its helpers (anywhere below `parseProvenance`/`parseSourceItem` is fine — this plan places them right after `parseOptionalMetadata`):

```ts
export function parseEnrichEnvelope(input: unknown): EnrichEnvelopeV1 {
  enforceEnvelopeByteLimit(input, MAX_ENRICH_ENVELOPE_BYTES, "Enrich envelope");
  const envelope = requireRecord(input, "INVALID_ARGUMENT", "Enrich envelope must be an object.");
  requireKnownKeys(envelope, ENRICH_ENVELOPE_KEYS, "INVALID_ARGUMENT", "Enrich envelope");

  if (envelope.schema !== ENRICH_SCHEMA_TAG) {
    throw new OpenWikiError("INVALID_ARGUMENT", `Unsupported enrich envelope schema. Expected ${ENRICH_SCHEMA_TAG}.`);
  }

  const sourcePath = requireRelativePath(envelope.sourcePath, "Enrich envelope sourcePath");
  const sourceContentHash = requireHash(envelope.sourceContentHash, "Enrich envelope sourceContentHash");

  if (!Array.isArray(envelope.nodes)) {
    throw new OpenWikiError("INVALID_ARGUMENT", "Enrich envelope nodes must be an array.");
  }
  if (envelope.nodes.length > MAX_ENRICH_NODES) {
    throw new OpenWikiError("SOURCE_TOO_LARGE", `Enrich envelope exceeds the ${String(MAX_ENRICH_NODES)} node limit.`);
  }
  const nodes = envelope.nodes.map((node, index) => parseEnrichNode(node, index));

  if (!Array.isArray(envelope.edges)) {
    throw new OpenWikiError("INVALID_ARGUMENT", "Enrich envelope edges must be an array.");
  }
  if (envelope.edges.length > MAX_ENRICH_EDGES) {
    throw new OpenWikiError("SOURCE_TOO_LARGE", `Enrich envelope exceeds the ${String(MAX_ENRICH_EDGES)} edge limit.`);
  }
  const edges = envelope.edges.map((edge, index) => parseEnrichEdge(edge, index));

  return { schema: ENRICH_SCHEMA_TAG, sourcePath, sourceContentHash, nodes, edges };
}

function parseEnrichNode(input: unknown, index: number): EnrichEnvelopeV1["nodes"][number] {
  const label = `Enrich envelope node ${String(index)}`;
  const node = requireRecord(input, "INVALID_ARGUMENT", `${label} must be an object.`);
  requireKnownKeys(node, ENRICH_NODE_KEYS, "INVALID_ARGUMENT", label);
  if (typeof node.kind !== "string" || !ENRICH_NODE_KIND_SET.has(node.kind)) {
    throw new OpenWikiError("INVALID_ARGUMENT", `${label} kind must be concept or page.`);
  }
  const name = requireNonEmptyString(node.name, "INVALID_ARGUMENT", `${label} name`);
  const path = requireRelativePath(node.path, `${label} path`);
  const summary = readOptionalBoundedString(node, "summary", `${label} summary`);
  return { kind: node.kind as EnrichNodeKind, name, path, ...(summary === undefined ? {} : { summary }) };
}

function parseEnrichEdge(input: unknown, index: number): EnrichEnvelopeV1["edges"][number] {
  const label = `Enrich envelope edge ${String(index)}`;
  const edge = requireRecord(input, "INVALID_ARGUMENT", `${label} must be an object.`);
  requireKnownKeys(edge, ENRICH_EDGE_KEYS, "INVALID_ARGUMENT", label);
  if (typeof edge.kind !== "string" || !ENRICH_EDGE_KIND_SET.has(edge.kind)) {
    throw new OpenWikiError("INVALID_ARGUMENT", `${label} kind must be mentions, describes, grounds, or related.`);
  }
  const from = requireNonEmptyString(edge.from, "INVALID_ARGUMENT", `${label} from`);
  const to = requireNonEmptyString(edge.to, "INVALID_ARGUMENT", `${label} to`);
  if (typeof edge.confidence !== "string" || !AGENT_CONFIDENCE_SET.has(edge.confidence)) {
    throw new OpenWikiError("INVALID_ARGUMENT", `${label} confidence must be extracted, inferred, or ambiguous.`);
  }
  return { kind: edge.kind as EnrichEdgeKind, from, to, confidence: edge.confidence as AgentConfidence };
}

function requireRelativePath(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, "INVALID_ARGUMENT", label);
  if (text.startsWith("/") || text.includes("\\") || text.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be a repository-relative path.`);
  }
  return text;
}

function requireHash(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, "INVALID_ARGUMENT", label);
  if (!HEX_SHA256_PATTERN.test(text)) {
    throw new OpenWikiError("INVALID_ARGUMENT", `${label} must be a SHA-256 hash.`);
  }
  return text.toLowerCase();
}

```

This reuses the existing `requireRecord`, `requireKnownKeys`, `requireNonEmptyString`, `readOptionalBoundedString` (bounding `summary` at the existing `MAX_ITEM_TEXT_BYTES`), `utf8ByteLength`, and now-generalized `enforceEnvelopeByteLimit` helpers already defined in the file — no duplicate validation helpers are introduced.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/enrich-contracts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/openwiki/src/contracts.ts plugins/openwiki/tests/unit/enrich-contracts.test.mjs
git commit -m "feat(openwiki): add and validate the enrich envelope contract"
```

---

## Task 3: `graph-index.ts` full enumeration + `graph-store.ts` enrichment shard storage

**Files:**
- Modify: `plugins/openwiki/src/graph-index.ts`
- Modify: `plugins/openwiki/src/graph-store.ts`
- Modify: `plugins/openwiki/tests/unit/graph-store-v2.test.mjs` (add `readdir` import, add three new tests)

**Interfaces:**
- Consumes: `EnrichmentShardV1`, `parseEnrichmentShard`, `isGraphNodeKind`, `isGraphEdgeKind`, `isGraphConfidence` from `./graph-contracts.js` (Task 1).
- Produces: `GraphIndexPort.allNodes()`/`allEdges()`; `GraphStorage.enrichmentRoot`; `GraphManifest.enrichmentShards`; `readEnrichmentShard(storage, shardName)`; `writeGraph(storage, graph, shards, enrichmentShards = [])` (4th parameter, defaulted so every existing call site keeps compiling unchanged); every existing `GraphIndexPort` read method (`node`, `edge`, `inbound`, `outbound`, `rankedCandidates`, `architectureSummary`) now recognizes the v2 node/edge/confidence vocabulary instead of throwing `INVALID_STATE` on it — consumed by Tasks 4, 5, 7, and by the five pre-existing graph read actions (`query`/`context`/`impact`/`changes`/`map`) on any workspace that has ever been enriched.

- [ ] **Step 1: Write the failing tests**

Add `readdir` to the existing `node:fs/promises` import in `plugins/openwiki/tests/unit/graph-store-v2.test.mjs`:

```js
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
```

Also add `readEnrichmentShard` to the existing `../../dist/graph-store.js` import:

```js
import {
  openGraphIndex,
  readEnrichmentShard,
  readGraphShard,
  probeGraphStorage,
  resolveGraphStorage,
  withGraphWriteLock,
  writeGraph,
  changedRepositoryPaths,
} from "../../dist/graph-store.js";
```

Append two new tests inside the `describe("graph store v2", ...)` block, right before its closing `});`:

```js
  test("allNodes and allEdges enumerate the complete bucketed graph", async () => {
    const root = await temporaryRoot("all");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);
    const source = graph("1");
    await writeGraph(resolved.storage, source, []);
    const index = await openGraphIndex(resolved.storage);
    const allNodes = await index.allNodes();
    const allEdges = await index.allEdges();
    assert.deepEqual(allNodes.map((node) => node.id).sort(), source.nodes.map((node) => node.id).sort());
    assert.deepEqual(allEdges.map((edge) => edge.id), source.edges.map((edge) => edge.id));
  });

  test("persists, reuses, and garbage collects enrichment shards alongside code shards", async () => {
    const root = await temporaryRoot("enrichment");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const shardV1 = { sourcePath: "architecture.md", sourceContentHash: "a".repeat(64), nodes: [{ id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" }], edges: [], enrichedAt: "2026-07-14T00:00:00.000Z" };
    await writeGraph(resolved.storage, graph("1"), [], [shardV1]);
    const manifestAfterFirst = JSON.parse(await readFile(resolved.storage.manifestPath, "utf8"));
    assert.equal(manifestAfterFirst.enrichmentShards.length, 1);
    const restored = await readEnrichmentShard(resolved.storage, manifestAfterFirst.enrichmentShards[0].shard);
    assert.deepEqual(restored, shardV1);

    const shardV2 = { ...shardV1, sourceContentHash: "b".repeat(64) };
    await writeGraph(resolved.storage, graph("1"), [], [shardV2]);
    const manifestAfterSecond = JSON.parse(await readFile(resolved.storage.manifestPath, "utf8"));
    assert.equal(manifestAfterSecond.enrichmentShards.length, 1);
    assert.equal(manifestAfterSecond.enrichmentShards[0].sourceContentHash, "b".repeat(64));

    await writeGraph(resolved.storage, graph("2"), [], []);
    await writeGraph(resolved.storage, graph("2"), [], []);
    assert.deepEqual(await readdir(resolved.storage.enrichmentRoot).catch(() => []), []);
  });

  test("reads back enriched node kinds, edge kinds, and agent confidence through every index read path without throwing", async () => {
    const root = await temporaryRoot("enriched-read");
    const home = await temporaryRoot("home");
    const resolved = await resolveGraphStorage(root, home);
    const repositoryId = createGraphNodeId("repository", ".", "repository");
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const conceptId = createGraphNodeId("concept", "concepts/x.md", "x");
    const describesId = createGraphEdgeId("describes", pageId, conceptId, "extracted");
    const enrichedGraph = {
      schemaVersion: 2,
      workspaceId: resolved.workspaceId,
      generatedAt: "2026-07-14T00:00:00.000Z",
      source: { dirtyFingerprint: "a".repeat(64), scannerVersion: "openwiki-graph-v1" },
      files: [],
      nodes: [
        { id: repositoryId, kind: "repository", path: ".", name: "repository" },
        { id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" },
        { id: conceptId, kind: "concept", path: "concepts/x.md", name: "x", summary: "A concept summary." },
      ],
      edges: [{ id: describesId, kind: "describes", from: pageId, to: conceptId, confidence: "extracted" }],
      diagnostics: [],
    };
    await writeGraph(resolved.storage, enrichedGraph, []);
    const index = await openGraphIndex(resolved.storage);

    const conceptNode = await index.node(conceptId);
    assert.equal(conceptNode.summary, "A concept summary.");
    assert.deepEqual(await index.edge(describesId), enrichedGraph.edges[0]);
    assert.equal((await index.inbound(conceptId, 10)).edges[0].kind, "describes");
    assert.equal((await index.outbound(pageId, 10)).edges[0].kind, "describes");
    const summary = await index.architectureSummary();
    assert.equal(summary.nodeCount, 3);
    const allNodes = await index.allNodes();
    const allEdges = await index.allEdges();
    assert.equal(allNodes.some((node) => node.kind === "concept"), true);
    assert.equal(allEdges.some((edge) => edge.kind === "describes" && edge.confidence === "extracted"), true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/graph-store-v2.test.mjs`
Expected: FAIL — `index.allNodes`/`allEdges` and `readEnrichmentShard` do not exist yet; `writeGraph`'s 4th parameter is not accepted; `enrichmentRoot`/`enrichmentShards` do not exist on the manifest; and, even once those exist, the third test still fails because `graph-index.ts`'s own local `isNodeKind`/`isEdgeKind`/`isConfidence` guards only recognize the pre-2a vocabulary — `index.node(conceptId)`, `index.edge(describesId)`, `index.inbound`/`outbound`, and `index.architectureSummary()` all throw `INVALID_STATE` reading back a `concept` node or a `describes` edge until Step 3 widens them.

- [ ] **Step 3: Implement `allNodes`/`allEdges` in graph-index.ts, and widen its own node/edge/confidence guards to the v2 vocabulary**

In `plugins/openwiki/src/graph-index.ts`, add the two methods to the `GraphIndexPort` interface:

```ts
export interface GraphIndexPort {
  node(id: string): Promise<GraphNodeV1 | undefined>;
  edge(id: string): Promise<GraphEdgeV1 | undefined>;
  rankedCandidates(query: string, limit: number): Promise<string[]>;
  inbound(id: string, limit: number): Promise<GraphAdjacency>;
  outbound(id: string, limit: number): Promise<GraphAdjacency>;
  changedPathSeeds(paths: readonly string[], limit: number): Promise<string[]>;
  architectureSummary(): Promise<Readonly<GraphArchitectureSummary>>;
  allNodes(): Promise<GraphNodeV1[]>;
  allEdges(): Promise<GraphEdgeV1[]>;
  metrics(): GraphIndexMetrics;
  status(): GraphIndexStatus;
}
```

In the object returned by `openGraphIndexGeneration`, add the two implementations right after `architectureSummary`:

```ts
    async architectureSummary() {
      return parseArchitectureSummary(await read(manifest.architecture));
    },
    async allNodes() {
      const nodes: GraphNodeV1[] = [];
      for (const bucket of manifest.nodeBuckets) {
        for (const node of parseNodeBucket(await read(`nodes/${bucket}.json`)).values()) nodes.push(node);
      }
      return nodes.sort((left, right) => left.id.localeCompare(right.id));
    },
    async allEdges() {
      const edges: GraphEdgeV1[] = [];
      for (const bucket of manifest.edgeBuckets) {
        for (const edge of parseEdgeRecordBucket(await read(`edges/${bucket}.json`)).values()) edges.push(edge);
      }
      return edges.sort((left, right) => left.id.localeCompare(right.id));
    },
    metrics() {
      return { bytesRead, filesRead };
    },
```

(The enumeration logic itself reuses the existing `read()` closure, which caches by relative path, and the existing `parseNodeBucket`/`parseEdgeRecordBucket` helpers already defined lower in the file. These are internal, full-graph-scan methods used only by `checkWiki`'s integrity audit in Task 7, not exposed as a bounded public CLI/MCP action, so they intentionally do not take a `limit`.)

**This file has its own, separate copy of node/edge/confidence validation that every read path in `GraphIndexPort` depends on, and it does not yet recognize the v2 vocabulary — fix that now, in this same step.** `parseNode`, `parseEdge`, and `parseFlow` (used respectively by `parseNodeBucket`, `parseEdgeRecordBucket`/`parseEdgeListBucket`, and `parseArchitectureSummary`) all gate on local `isNodeKind`/`isEdgeKind`/`isConfidence` functions that today only recognize the five original node kinds, eight original edge kinds, and three scanner confidences. Left unwidened, every one of `node`, `edge`, `inbound`, `outbound`, `rankedCandidates`, `architectureSummary`, and the two `allNodes`/`allEdges` methods just added throws `INVALID_STATE` the instant a `concept`/`page`/`source` node or a `mentions`/`describes`/`grounds`/`related`/`member-of` edge is read back from a bucket. Worse, `writeGraphIndexGeneration` samples `graph.edges.slice(0, 100)` into `architecture.json`'s `flows` array with no kind filter, so `architectureSummary()` — called by every existing graph read action (`query`, `context`, `impact`, `changes`, `map`) via `loadIndex()` in `graph.ts` — throws on any workspace that has ever been enriched, not just on the new `enrich`-specific paths.

Fix this by reusing `graph-contracts.ts`'s own guards (Task 1's `isGraphNodeKind`/`isGraphEdgeKind`/`isGraphConfidence`) instead of maintaining a second, hand-written copy — the duplication is exactly what let this drift happen. Update the import block at the top of `plugins/openwiki/src/graph-index.ts`:

```ts
import {
  GRAPH_SCANNER_VERSION,
  isGraphConfidence,
  isGraphEdgeKind,
  isGraphNodeKind,
  type CodeGraphV1,
  type GraphDiagnosticV1,
  type GraphEdgeV1,
  type GraphNodeV1,
} from "./graph-contracts.js";
```

Delete the three local guard functions near the bottom of the file entirely:

```ts
function isNodeKind(value: unknown): value is GraphNodeV1["kind"] { return value === "repository" || value === "directory" || value === "file" || value === "module" || value === "symbol"; }
function isEdgeKind(value: unknown): value is GraphEdgeV1["kind"] { return value === "contains" || value === "declares" || value === "imports" || value === "exports" || value === "calls" || value === "inherits" || value === "implements" || value === "references"; }
function isConfidence(value: unknown): value is GraphEdgeV1["confidence"] { return value === "exact" || value === "resolved" || value === "heuristic"; }
```

Update `parseNode`, replacing its `isNodeKind` call with `isGraphNodeKind` and adding the missing `summary` field, which the current function silently drops on every read (it copies only the fields it knows about, so a `concept`/`page` node's `summary` — written correctly by `writeGraphIndexGeneration` since it serializes the whole node object — vanishes the moment it round-trips back through this reader):

```ts
function parseNode(value: unknown): GraphNodeV1 {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string" || typeof value.name !== "string" || !isGraphNodeKind(value.kind)) throw new OpenWikiError("INVALID_STATE", "Graph node bucket is invalid.");
  const node: GraphNodeV1 = { id: value.id, kind: value.kind, path: value.path, name: value.name };
  if (value.symbolKind !== undefined) {
    if (typeof value.symbolKind !== "string") throw new OpenWikiError("INVALID_STATE", "Graph node bucket is invalid.");
    node.symbolKind = value.symbolKind;
  }
  if (value.scope !== undefined) {
    if (typeof value.scope !== "string") throw new OpenWikiError("INVALID_STATE", "Graph node bucket is invalid.");
    node.scope = value.scope;
  }
  if (value.startLine !== undefined) {
    if (!positiveInteger(value.startLine)) throw new OpenWikiError("INVALID_STATE", "Graph node bucket is invalid.");
    node.startLine = value.startLine;
  }
  if (value.endLine !== undefined) {
    if (!positiveInteger(value.endLine)) throw new OpenWikiError("INVALID_STATE", "Graph node bucket is invalid.");
    node.endLine = value.endLine;
  }
  if (value.summary !== undefined) {
    if (typeof value.summary !== "string") throw new OpenWikiError("INVALID_STATE", "Graph node bucket is invalid.");
    node.summary = value.summary;
  }
  return node;
}
```

Update `parseEdge`, replacing `isEdgeKind`/`isConfidence` with `isGraphEdgeKind`/`isGraphConfidence`:

```ts
function parseEdge(value: unknown): GraphEdgeV1 {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.from !== "string" || typeof value.to !== "string" || !isGraphEdgeKind(value.kind) || !isGraphConfidence(value.confidence)) throw new OpenWikiError("INVALID_STATE", "Graph edge bucket is invalid.");
  return { id: value.id, kind: value.kind, from: value.from, to: value.to, confidence: value.confidence };
}
```

Update `parseFlow`, replacing `isEdgeKind` with `isGraphEdgeKind` (this is the fix for the `architectureSummary()`/five-pre-existing-read-actions regression described above):

```ts
function parseFlow(value: unknown): { from: string; to: string; kind: GraphEdgeV1["kind"] } {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string" || !isGraphEdgeKind(value.kind)) throw new OpenWikiError("INVALID_STATE", "Graph architecture index is invalid.");
  return { from: value.from, to: value.to, kind: value.kind };
}
```

- [ ] **Step 4: Run the tests satisfied by this step alone**

The enrichment-shard-storage test still needs Step 5, so run the other two new tests individually:

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/graph-store-v2.test.mjs -t "allNodes and allEdges"`
Expected: PASS.

Run: `node --test plugins/openwiki/tests/unit/graph-store-v2.test.mjs -t "reads back enriched"`
Expected: PASS. (The enrichment-shard-storage test still fails — that's Step 5's job.)

- [ ] **Step 5: Implement enrichment shard storage in graph-store.ts**

In `plugins/openwiki/src/graph-store.ts`, update the import from `graph-contracts.js` to add `EnrichmentShardV1` and `parseEnrichmentShard`:

```ts
import { canonicalizeGraph, graphHash, parseCodeGraph, parseEnrichmentShard, GRAPH_SCANNER_VERSION, type CodeGraphV1, type EnrichmentShardV1 } from "./graph-contracts.js";
```

Extend `GraphManifest` and `GraphStorage`:

```ts
export interface GraphManifest {
  schemaVersion: typeof GRAPH_STORE_SCHEMA_VERSION;
  scannerVersion: string;
  generation: string;
  snapshot: string;
  index: GraphIndexManifest;
  generatedAt: string;
  source: CodeGraphV1["source"];
  counts: { files: number; nodes: number; edges: number; diagnostics: number };
  shards: Array<{ path: string; contentHash: string; sourceId: string; shard: string }>;
  enrichmentShards: Array<{ sourcePath: string; sourceContentHash: string; shard: string }>;
}
export interface GraphStorage {
  root: string;
  manifestPath: string;
  previousManifestPath: string;
  writeLockPath: string;
  generationRoot: string;
  shardRoot: string;
  enrichmentRoot: string;
  snapshotRoot: string;
}
```

Update `createStorage`:

```ts
function createStorage(root: string): GraphStorage {
  return { root, manifestPath: path.join(root, "manifest.json"), previousManifestPath: path.join(root, "manifest.previous.json"), writeLockPath: path.join(root, "writer.lock"), generationRoot: path.join(root, "generations"), shardRoot: path.join(root, "shards"), enrichmentRoot: path.join(root, "enrichment"), snapshotRoot: path.join(root, "snapshots") };
}
```

Add `readEnrichmentShard` and `enrichmentShardFileName` right after the existing `readGraphShard`:

```ts
export async function readGraphShard(storage: GraphStorage, shardName: string): Promise<GraphShard> {
  return parseShard(JSON.parse(await readFile(confinedStoredName(storage.shardRoot, shardName), "utf8")) as unknown);
}

export async function readEnrichmentShard(storage: GraphStorage, shardName: string): Promise<EnrichmentShardV1> {
  return parseEnrichmentShard(JSON.parse(await readFile(confinedStoredName(storage.enrichmentRoot, shardName), "utf8")) as unknown);
}

export function enrichmentShardFileName(sourcePath: string, sourceContentHash: string): string {
  return `${graphHash(["enrichment", sourcePath, sourceContentHash])}.json`;
}
```

Change the `writeGraph` and `writeGraphUnlocked` signatures to accept enrichment shards (4th parameter, defaulted to `[]`):

```ts
export async function writeGraph(storage: GraphStorage, graph: CodeGraphV1, shards: readonly GraphShard[], enrichmentShards: readonly EnrichmentShardV1[] = []): Promise<{ manifestPath: string; reusedShardCount: number }> {
  return withGraphWriteLock(storage, async () => writeGraphUnlocked(storage, graph, shards, enrichmentShards));
}
```

Update `writeGraphUnlocked` (replace the whole function):

```ts
async function writeGraphUnlocked(storage: GraphStorage, graph: CodeGraphV1, shards: readonly GraphShard[], enrichmentShards: readonly EnrichmentShardV1[]): Promise<{ manifestPath: string; reusedShardCount: number }> {
  const previous = await readManifest(storage).catch(() => undefined);
  const reusable = new Map(previous?.shards.map((entry) => [`${entry.path}\0${entry.contentHash}`, entry]) ?? []);
  await mkdir(storage.shardRoot, { recursive: true, mode: 0o700 });
  await mkdir(storage.enrichmentRoot, { recursive: true, mode: 0o700 });
  await mkdir(storage.generationRoot, { recursive: true, mode: 0o700 });
  await assertRegularDirectory(storage.shardRoot);
  await assertRegularDirectory(storage.enrichmentRoot);
  await assertRegularDirectory(storage.generationRoot);
  let reusedShardCount = 0;
  const manifestShards: GraphManifest["shards"] = [];
  for (const shard of shards) {
    const key = `${shard.path}\0${shard.contentHash}`;
    const reused = reusable.get(key);
    const shardFile = reused?.shard ?? `${graphHash([GRAPH_SCANNER_VERSION, shard.path, shard.language, shard.contentHash])}.json`;
    if (reused !== undefined) reusedShardCount += 1;
    else await atomicWriteFile(confinedStoredName(storage.shardRoot, shardFile), `${JSON.stringify(shard)}\n`);
    manifestShards.push({ path: shard.path, contentHash: shard.contentHash, sourceId: shard.sourceId, shard: shardFile });
  }
  const manifestEnrichmentShards: GraphManifest["enrichmentShards"] = [];
  for (const shard of enrichmentShards) {
    const fileName = enrichmentShardFileName(shard.sourcePath, shard.sourceContentHash);
    const target = confinedStoredName(storage.enrichmentRoot, fileName);
    if (!(await isRegularFile(target))) await atomicWriteFile(target, `${JSON.stringify(shard)}\n`);
    manifestEnrichmentShards.push({ sourcePath: shard.sourcePath, sourceContentHash: shard.sourceContentHash, shard: fileName });
  }
  const canonical = canonicalizeGraph(graph);
  const generation = `g-${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
  const generationPath = manifestGenerationPath(storage, generation);
  const published = await generationIsValid(storage, generation).catch(() => false);
  if (!published) {
    await rm(generationPath, { recursive: true, force: true });
    await mkdir(generationPath, { recursive: true, mode: 0o700 });
    await assertRegularDirectory(generationPath);
    const index = await writeGraphIndexGeneration(generationPath, generation, canonical);
    await atomicWriteFile(path.join(generationPath, "snapshot.json"), `${JSON.stringify(canonical)}\n`);
    const manifest: GraphManifest = {
      schemaVersion: GRAPH_STORE_SCHEMA_VERSION,
      scannerVersion: GRAPH_SCANNER_VERSION,
      generation,
      snapshot: `${generation}/snapshot.json`,
      index,
      generatedAt: canonical.generatedAt,
      source: canonical.source,
      counts: { files: canonical.files.length, nodes: canonical.nodes.length, edges: canonical.edges.length, diagnostics: canonical.diagnostics.length },
      shards: manifestShards.sort((left, right) => left.path.localeCompare(right.path)),
      enrichmentShards: manifestEnrichmentShards.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    };
    await publishManifest(storage, previous, manifest);
  } else {
    const existing = await readManifest(storage);
    if (existing.generation !== generation) throw new OpenWikiError("INVALID_STATE", "Graph generation publication changed during write.");
  }
  await garbageCollect(storage, previous);
  return { manifestPath: storage.manifestPath, reusedShardCount };
}
```

Update `garbageCollect` to also retain/collect enrichment shard files:

```ts
async function garbageCollect(storage: GraphStorage, previous: GraphManifest | undefined): Promise<void> {
  const current = await readManifest(storage).catch(() => undefined);
  const retained = new Set([current?.generation, previous?.generation].filter((value): value is string => value !== undefined));
  for (const entry of await readdir(storage.generationRoot).catch(() => [])) {
    if (safeGeneration(entry) && !retained.has(entry)) await rm(manifestGenerationPath(storage, entry), { recursive: true, force: true });
  }
  const shards = new Set((current?.shards ?? []).concat(previous?.shards ?? []).map((entry) => entry.shard));
  for (const entry of await readdir(storage.shardRoot).catch(() => [])) if (!shards.has(entry)) await rm(confinedStoredName(storage.shardRoot, entry), { force: true });
  const enrichmentShards = new Set((current?.enrichmentShards ?? []).concat(previous?.enrichmentShards ?? []).map((entry) => entry.shard));
  for (const entry of await readdir(storage.enrichmentRoot).catch(() => [])) if (!enrichmentShards.has(entry)) await rm(confinedStoredName(storage.enrichmentRoot, entry), { force: true });
}
```

Update `parseManifest` to treat a missing `enrichmentShards` field as `[]` (backward compatibility with manifests written before this task) and validate it canonically when present:

```ts
function parseManifest(value: unknown): GraphManifest {
  if (!isRecord(value) || value.schemaVersion !== GRAPH_STORE_SCHEMA_VERSION || value.scannerVersion !== GRAPH_SCANNER_VERSION || !safeGeneration(value.generation) || !safeSnapshot(value.snapshot) || !Array.isArray(value.shards) || (value.enrichmentShards !== undefined && !Array.isArray(value.enrichmentShards)) || typeof value.generatedAt !== "string" || !isRecord(value.source) || typeof value.source.dirtyFingerprint !== "string" || typeof value.source.scannerVersion !== "string" || !isRecord(value.counts) || !nonNegativeInteger(value.counts.files) || !nonNegativeInteger(value.counts.nodes) || !nonNegativeInteger(value.counts.edges) || !nonNegativeInteger(value.counts.diagnostics)) {
    throw new OpenWikiError("INVALID_STATE", "Graph manifest schema is incompatible.");
  }
  const index = parseManifestIndex(value.index, value.generation);
  const shards = value.shards.map(parseManifestShard).sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(shards) !== JSON.stringify(value.shards)) throw new OpenWikiError("INVALID_STATE", "Graph manifest shards are not canonical.");
  const enrichmentShardsInput = value.enrichmentShards ?? [];
  const enrichmentShards = enrichmentShardsInput.map(parseManifestEnrichmentShard).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  if (JSON.stringify(enrichmentShards) !== JSON.stringify(enrichmentShardsInput)) throw new OpenWikiError("INVALID_STATE", "Graph manifest enrichment shards are not canonical.");
  return { schemaVersion: GRAPH_STORE_SCHEMA_VERSION, scannerVersion: GRAPH_SCANNER_VERSION, generation: value.generation, snapshot: value.snapshot, index, generatedAt: value.generatedAt, source: { ...(typeof value.source.gitHead === "string" ? { gitHead: value.source.gitHead } : {}), dirtyFingerprint: value.source.dirtyFingerprint, scannerVersion: value.source.scannerVersion }, counts: { files: value.counts.files, nodes: value.counts.nodes, edges: value.counts.edges, diagnostics: value.counts.diagnostics }, shards, enrichmentShards };
}

function parseManifestEnrichmentShard(value: unknown): { sourcePath: string; sourceContentHash: string; shard: string } {
  if (!isRecord(value) || !safeRelativePath(value.sourcePath) || typeof value.sourceContentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(value.sourceContentHash) || !safeStoredName(value.shard)) throw new OpenWikiError("INVALID_STATE", "Graph manifest enrichment shard is invalid.");
  return { sourcePath: value.sourcePath, sourceContentHash: value.sourceContentHash, shard: value.shard };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/unit/graph-store-v2.test.mjs`
Expected: PASS, both new tests plus every pre-existing test in the file.

- [ ] **Step 7: Run the full suite**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS. (`writeGraph`'s existing two- and three-argument call sites throughout the test suite keep compiling because the 4th parameter defaults to `[]`.)

- [ ] **Step 8: Commit**

```bash
git add plugins/openwiki/src/graph-index.ts plugins/openwiki/src/graph-store.ts plugins/openwiki/tests/unit/graph-store-v2.test.mjs
git commit -m "feat(openwiki): persist enrichment shards alongside code shards with full-graph enumeration"
```

---

## Task 4: `graph.ts` — export `assembleGraph`, preserve enrichment across rebuilds

**Files:**
- Modify: `plugins/openwiki/src/graph.ts`
- Test: `plugins/openwiki/tests/integration/graph-enrichment.test.mjs` (new)

**Interfaces:**
- Consumes: `mergeEnrichment`, `GRAPH_CONTRACTS_SCHEMA_VERSION` from `./graph-contracts.js` (Task 1); `readEnrichmentShard` from `./graph-store.js` (Task 3).
- Produces: `export`-ed `assembleGraph(workspaceId, generatedAt, source, shards): CodeGraphV1` (previously private) — consumed by Task 5 (`enrich.ts`).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/integration/graph-enrichment.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { createGraphEdgeId, createGraphNodeId } from "../../dist/graph-contracts.js";
import { buildGraph } from "../../dist/graph.js";
import { openGraphIndex, resolveGraphStorage, writeGraph } from "../../dist/graph-store.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-graph-enrichment-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await temporaryRoot("repo");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "openwiki@example.test"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "worker.ts"), "export function run() { return 1; }\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

function seedGraph(workspaceId) {
  const repositoryId = createGraphNodeId("repository", ".", "repository");
  return { schemaVersion: 2, workspaceId, generatedAt: "2026-07-14T00:00:00.000Z", source: { dirtyFingerprint: "a".repeat(64), scannerVersion: "openwiki-graph-v1" }, files: [], nodes: [{ id: repositoryId, kind: "repository", path: ".", name: "repository" }], edges: [], diagnostics: [] };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("graph enrichment survives rebuild", () => {
  test("a subsequent graph build preserves prior enrichment shards and merges concept/page nodes", async () => {
    const root = await repository();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });

    const resolved = await resolveGraphStorage(root, home);
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const conceptId = createGraphNodeId("concept", "concepts/worker.md", "worker");
    const runId = createGraphNodeId("symbol", "src/worker.ts", "run", "function", "1");
    const shard = {
      sourcePath: "architecture.md",
      sourceContentHash: "a".repeat(64),
      nodes: [
        { id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" },
        { id: conceptId, kind: "concept", path: "concepts/worker.md", name: "worker" },
      ],
      edges: [
        { id: createGraphEdgeId("describes", pageId, conceptId, "extracted"), kind: "describes", from: pageId, to: conceptId, confidence: "extracted" },
        { id: createGraphEdgeId("mentions", pageId, runId, "inferred"), kind: "mentions", from: pageId, to: runId, confidence: "inferred" },
      ],
      enrichedAt: "2026-07-14T00:00:00.000Z",
    };
    await writeGraph(resolved.storage, seedGraph(resolved.workspaceId), [], [shard]);

    const rebuilt = await buildGraph({ root, homeDir: home });
    assert.equal(rebuilt.nodeCount >= 4, true);

    const indexAfter = await openGraphIndex((await resolveGraphStorage(root, home)).storage);
    assert.ok(await indexAfter.node(pageId));
    assert.ok(await indexAfter.node(conceptId));
    const edgesAfter = await indexAfter.allEdges();
    assert.equal(edgesAfter.some((edge) => edge.kind === "describes" && edge.from === pageId && edge.to === conceptId), true);
    assert.equal(edgesAfter.some((edge) => edge.kind === "mentions" && edge.to === runId), true);
  });

  test("a graph build prunes a mention edge whose target symbol was removed, recording a dangling diagnostic", async () => {
    const root = await repository();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const resolved = await resolveGraphStorage(root, home);
    const pageId = createGraphNodeId("page", "architecture.md", "architecture.md");
    const shard = {
      sourcePath: "architecture.md",
      sourceContentHash: "a".repeat(64),
      nodes: [{ id: pageId, kind: "page", path: "architecture.md", name: "architecture.md" }],
      edges: [{ id: createGraphEdgeId("mentions", pageId, "0".repeat(64), "inferred"), kind: "mentions", from: pageId, to: "0".repeat(64), confidence: "inferred" }],
      enrichedAt: "2026-07-14T00:00:00.000Z",
    };
    await writeGraph(resolved.storage, seedGraph(resolved.workspaceId), [], [shard]);

    const rebuilt = await buildGraph({ root, homeDir: home });
    assert.equal(rebuilt.diagnosticCount >= 1, true);
    const edgesAfter = await (await openGraphIndex((await resolveGraphStorage(root, home)).storage)).allEdges();
    assert.equal(edgesAfter.some((edge) => edge.to === "0".repeat(64)), false);
  });

  test("a pre-2a schemaVersion:1 snapshot degrades the next build to an explicit full rescan, never a crash or a false-fresh claim", async () => {
    const root = await repository();
    const home = await temporaryRoot("home");
    const first = await buildGraph({ root, homeDir: home });
    assert.equal(first.buildMode, "full");

    const resolved = await resolveGraphStorage(root, home);
    const manifest = JSON.parse(await readFile(resolved.storage.manifestPath, "utf8"));
    const snapshotPath = path.join(resolved.storage.generationRoot, manifest.snapshot);
    const legacySnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    await writeFile(snapshotPath, `${JSON.stringify({ ...legacySnapshot, schemaVersion: 1 })}\n`, "utf8");

    const second = await buildGraph({ root, homeDir: home });
    assert.equal(second.buildMode, "full");
    assert.equal(second.fullRebuild, true);
    assert.deepEqual(second.changedPaths.sort(), ["src/worker.ts"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/graph-enrichment.test.mjs`
Expected: FAIL — `writeGraph(..., seedGraph(...))` fails typecheck/build at `schemaVersion: 2` until Task 1 has landed, and (once Task 1 is in) `buildGraph` does not yet read or merge enrichment shards, so the merged nodes/edges are absent after rebuild. The fourth test (pre-2a snapshot degradation) exercises only pre-existing `buildGraph` behavior and needs no new implementation in this task, but still fails at the shared `npm run build` step until Task 1 and Task 3 have landed (both are prerequisites for this file to compile at all).

- [ ] **Step 3: Implement the buildGraph changes**

In `plugins/openwiki/src/graph.ts`, update the import block to add `GRAPH_CONTRACTS_SCHEMA_VERSION` and `mergeEnrichment`:

```ts
import {
  GRAPH_CONTRACTS_SCHEMA_VERSION,
  GRAPH_DEFAULTS,
  GRAPH_SCANNER_VERSION,
  canonicalizeGraph,
  createGraphEdgeId,
  createGraphNodeId,
  mergeEnrichment,
  type CodeGraphV1,
  type GraphDiagnosticV1,
  type GraphEdgeKind,
  type GraphEdgeV1,
  type GraphNodeV1,
} from "./graph-contracts.js";
import { entityLimit, responseLimit, type GraphResult, type ImpactResult } from "./graph-query.js";
import { changedRepositoryEvidence, currentGitFingerprint, enumerateRepositoryMetadata, openGraphIndex, probeGraphStorage, readEnrichmentShard, readGraphShard, readManifest, readRepositoryFile, readStoredGraph, repositoryMetadataFingerprint, resolveGraphStorage, resolveRepositorySourceIds, writeGraph, type GraphShard } from "./graph-store.js";
```

Replace `buildGraph` (only the parts shown change; the file-scanning `for` loop in the middle is untouched):

```ts
export async function buildGraph(options: BuildGraphOptions): Promise<BuildGraphResult> {
  const resolved = await resolveGraphStorage(options.root, options.homeDir);
  const limits = { maxFiles: options.limits?.maxFiles ?? GRAPH_DEFAULTS.maxFiles, maxFileBytes: options.limits?.maxFileBytes ?? GRAPH_DEFAULTS.maxFileBytes, maxRepositoryBytes: options.limits?.maxRepositoryBytes ?? GRAPH_DEFAULTS.maxRepositoryBytes };
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- build compares generations through the deprecated compatibility snapshot only.
  const previous = options.force ? undefined : await readStoredGraph(resolved.storage).catch(() => undefined);
  const manifest = await readManifest(resolved.storage).catch(() => undefined);
  const previousManifest = options.force ? undefined : manifest;
  const enrichmentShards = await Promise.all((manifest?.enrichmentShards ?? []).map((entry) => readEnrichmentShard(resolved.storage, entry.shard)));
  const metadata = await enumerateRepositoryMetadata(resolved.repositoryRoot, limits);
  const previousBySource = new Map(previousManifest?.shards.map((entry) => [`${entry.path}\u0000${entry.sourceId}`, entry]) ?? []);
  const shards: GraphShard[] = [];
  const sourceState: Array<{ path: string; size: number; sourceId: string }> = [];
  let reused = 0;
  for (const file of metadata) {
    const prior = file.sourceId === undefined ? undefined : previousBySource.get(`${file.path}\u0000${file.sourceId}`);
    if (prior !== undefined) {
      try {
        const shard = await readGraphShard(resolved.storage, prior.shard);
        if (shard.path === file.path && shard.sourceId === file.sourceId) { shards.push(shard); sourceState.push({ path: file.path, size: file.size, sourceId: file.sourceId }); reused += 1; continue; }
      } catch { /* corrupt private shard is rescanned */ }
    }
    let loaded;
    try { loaded = await readRepositoryFile(resolved.repositoryRoot, file); }
    catch (error) { if (error instanceof OpenWikiError && error.code === "UNSUPPORTED_SOURCE") continue; throw error; }
    const loadedPrior = previousBySource.get(`${loaded.path}\u0000${loaded.sourceId}`);
    if (loadedPrior !== undefined) {
      try {
        const shard = await readGraphShard(resolved.storage, loadedPrior.shard);
        if (shard.path === loaded.path && shard.sourceId === loaded.sourceId) { shards.push(shard); sourceState.push({ path: loaded.path, size: loaded.size, sourceId: loaded.sourceId }); reused += 1; continue; }
      } catch { /* corrupt private shard is rescanned */ }
    }
    shards.push({ path: loaded.path, language: loaded.language, contentHash: loaded.contentHash, size: loaded.size, sourceId: loaded.sourceId, scan: scanSourceFile({ path: loaded.path, language: loaded.language, content: loaded.content }) });
    sourceState.push({ path: loaded.path, size: loaded.size, sourceId: loaded.sourceId });
  }
  const git = await currentGitFingerprint(resolved.repositoryRoot);
  const fingerprint = { ...git, dirtyFingerprint: repositoryMetadataFingerprint(sourceState) };
  const generatedAt = options.now ?? new Date().toISOString();
  const codeGraph = assembleGraph(resolved.workspaceId, generatedAt, { ...fingerprint, scannerVersion: GRAPH_SCANNER_VERSION }, shards);
  const graph = mergeEnrichment(codeGraph, enrichmentShards);
  await writeGraph(resolved.storage, graph, shards, enrichmentShards);
  const changed = changedBuildPaths(previous, graph);
  const paths = boundedPaths(changed, options.limit);
  return { schemaVersion: 1, action: "build", root: resolved.repositoryRoot, fresh: true, buildMode: previous === undefined ? "full" : "incremental", fullRebuild: Boolean(options.force) || previous === undefined, ...(fingerprint.gitHead === undefined ? {} : { head: fingerprint.gitHead }), ...(previous?.source.gitHead === undefined ? {} : { previousHead: previous.source.gitHead }), dirtyFingerprint: fingerprint.dirtyFingerprint, changedPaths: paths.values, truncated: paths.truncated, scannedFileCount: metadata.length - reused, removedFileCount: Math.max(0, (previous?.files.length ?? 0) - metadata.length), fileCount: graph.files.length, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, diagnosticCount: graph.diagnostics.length, generatedAt };
}
```

Note the `schemaVersion: 1` on the **returned `BuildGraphResult` envelope** is deliberately unchanged (design decision 1 at the top of this plan) — only the internal `assembleGraph` snapshot bumps.

Export `assembleGraph` (was private) and bump its literal schema version, at the bottom of the file:

```ts
export function assembleGraph(workspaceId: string, generatedAt: string, source: CodeGraphV1["source"], shards: readonly GraphShard[]): CodeGraphV1 {
  const nodes: GraphNodeV1[] = []; const edges: GraphEdgeV1[] = []; const diagnostics: GraphDiagnosticV1[] = []; const repository = node("repository", ".", "repository"); nodes.push(repository); const directories = new Map<string, GraphNodeV1>(); const fileNodes = new Map<string, GraphNodeV1>(); const moduleNodes = new Map<string, GraphNodeV1>(); const symbolNodes = new Map<string, GraphNodeV1[]>(); const addEdge = (kind: GraphEdgeKind, from: GraphNodeV1, to: GraphNodeV1, confidence: GraphEdgeV1["confidence"]): void => { const edge: GraphEdgeV1 = { id: createGraphEdgeId(kind, from.id, to.id, confidence), kind, from: from.id, to: to.id, confidence }; if (!edges.some((candidate) => candidate.id === edge.id)) edges.push(edge); };
  for (const shard of shards) { let parent = repository; const parts = shard.path.split("/"); for (let index = 0; index < parts.length - 1; index += 1) { const directoryPath = parts.slice(0, index + 1).join("/"); let directory = directories.get(directoryPath); if (!directory) { directory = node("directory", directoryPath, parts[index] as string); directories.set(directoryPath, directory); nodes.push(directory); addEdge("contains", parent, directory, "exact"); } parent = directory; } const file = node("file", shard.path, parts.at(-1) as string); const module = node("module", shard.path, shard.path); nodes.push(file, module); fileNodes.set(shard.path, file); moduleNodes.set(shard.path, module); addEdge("contains", parent, file, "exact"); addEdge("contains", file, module, "exact"); for (const symbol of shard.scan.symbols) { const symbolNode = node("symbol", shard.path, symbol.name, symbol.kind, symbol.startLine, symbol.endLine, symbol.scope); nodes.push(symbolNode); addEdge("declares", module, symbolNode, "exact"); if (symbol.exported) addEdge("exports", module, symbolNode, "exact"); const named = symbolNodes.get(symbol.name) ?? []; named.push(symbolNode); symbolNodes.set(symbol.name, named); } diagnostics.push(...shard.scan.diagnostics); }
  for (const shard of shards) { const module = moduleNodes.get(shard.path); if (!module) continue; for (const imported of shard.scan.imports) { const targetPath = resolveImport(shard.path, imported, fileNodes); const target = targetPath ? moduleNodes.get(targetPath) : undefined; if (target) addEdge("imports", module, target, targetPath === imported ? "exact" : "resolved"); else diagnostics.push({ path: shard.path, code: "UNRESOLVED_IMPORT", message: `Unable to resolve import ${imported}.` }); } const localSymbols = nodes.filter((candidate) => candidate.kind === "symbol" && candidate.path === shard.path); const localByQualifiedName = new Map(localSymbols.map((symbol) => [`${symbol.scope === undefined ? "" : `${symbol.scope}.`}${symbol.name}`, symbol])); for (const relation of shard.scan.relations ?? []) { const from = localByQualifiedName.get(relation.fromQualifiedName); const target = symbolNodes.get(relation.target) ?? []; if (from && target.length === 1 && target[0]) addEdge(relation.kind, from, target[0], relation.confidence); else if (target.length > 1) diagnostics.push({ path: shard.path, code: "AMBIGUOUS_SYMBOL", message: `Symbol ${relation.target} is ambiguous.` }); else if (from) diagnostics.push({ path: shard.path, code: "UNRESOLVED_SYMBOL", message: `Unable to resolve symbol ${relation.target}.` }); } }
  return canonicalizeGraph({ schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION, workspaceId, generatedAt, source, files: shards.map(({ path: filePath, language, contentHash, size }) => ({ path: filePath, language, contentHash, size })), nodes, edges, diagnostics });
}
```

(This is the existing function body, unchanged except the `function` → `export function` keyword and the `schemaVersion: 1` → `schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION` literal on the last line.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/graph-enrichment.test.mjs`
Expected: PASS, all four tests.

- [ ] **Step 5: Run the full suite**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/openwiki/src/graph.ts plugins/openwiki/tests/integration/graph-enrichment.test.mjs
git commit -m "feat(openwiki): preserve enrichment shards across every graph build"
```

---

## Task 5: `enrich.ts` — the `enrich` operation

**Files:**
- Create: `plugins/openwiki/src/enrich.ts`
- Test: `plugins/openwiki/tests/integration/enrich.test.mjs` (new)

**Interfaces:**
- Consumes: `parseEnrichEnvelope` from `./contracts.js` (Task 2); `createGraphEdgeId`, `createGraphNodeId`, `mergeEnrichment`, `validEdgeConfidence`, `EnrichmentShardV1`, `GraphEdgeV1`, `GraphNodeV1` from `./graph-contracts.js` (Task 1); `assembleGraph` from `./graph.js` (Task 4); `openGraphIndex`, `readEnrichmentShard`, `readGraphShard`, `readManifest`, `resolveGraphStorage`, `withGraphWriteLock`, `writeGraph` from `./graph-store.js` (Task 3); `GraphIndexPort` from `./graph-index.js`; `redactSensitive` from `./redact.js`.
- Produces: `EnrichOptions`, `EnrichResult`, `enrichGraph(options): Promise<EnrichResult>` — consumed by Task 6 (`adapter.ts`).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/integration/enrich.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { enrichGraph } from "../../dist/enrich.js";
import { buildGraph } from "../../dist/graph.js";
import { openGraphIndex, resolveGraphStorage } from "../../dist/graph-store.js";
import { OpenWikiError } from "../../dist/errors.js";

const execFileAsync = promisify(execFile);
const roots = [];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-enrich-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function repositoryWithWikiPage() {
  const root = await temporaryRoot("repo");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "openwiki@example.test"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "worker.ts"), "export function run() { return 1; }\n");
  await mkdir(path.join(root, "openwiki"));
  await writeFile(path.join(root, "openwiki", "architecture.md"), "# Architecture\n\nThe worker performs background runs.\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function pageHash(root, relativePath) {
  return createHash("sha256").update(await readFile(path.join(root, relativePath))).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(overrides = {}) {
  return {
    schema: "memex.enrich.v1",
    sourcePath: "openwiki/architecture.md",
    sourceContentHash: "",
    nodes: [{ kind: "page", name: "openwiki/architecture.md", path: "openwiki/architecture.md" }],
    edges: [],
    ...overrides,
  };
}

describe("enrich operation", () => {
  test("requires a prior graph build", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    const hash = await pageHash(root, "openwiki/architecture.md");
    await assert.rejects(enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }) }), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "NOT_INITIALIZED");
      return true;
    });
  });

  test("persists a page node grounded by an auto-synthesized source node", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const hash = await pageHash(root, "openwiki/architecture.md");

    const result = await enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }), now: "2026-07-14T00:00:00.000Z" });
    assert.equal(result.applied, true);
    assert.equal(result.nodesWritten, 2);

    const pageId = createGraphNodeId("page", "openwiki/architecture.md", "openwiki/architecture.md");
    const resolved = await resolveGraphStorage(root, home);
    const index = await openGraphIndex(resolved.storage);
    assert.ok(await index.node(pageId));
    const edges = await index.allEdges();
    assert.equal(edges.some((edge) => edge.kind === "grounds" && edge.to === pageId), true);
  });

  test("references an existing code symbol node by its graph id in a mentions edge", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const hash = await pageHash(root, "openwiki/architecture.md");
    const runId = createGraphNodeId("symbol", "src/worker.ts", "run", "function", "1");

    const result = await enrichGraph({
      root,
      homeDir: home,
      envelope: envelope({
        sourceContentHash: hash,
        edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: runId, confidence: "inferred" }],
      }),
    });
    assert.equal(result.applied, true);

    const resolved = await resolveGraphStorage(root, home);
    const edges = await (await openGraphIndex(resolved.storage)).allEdges();
    assert.equal(edges.some((edge) => edge.kind === "mentions" && edge.to === runId), true);
  });

  test("is a no-op on an unchanged sourceContentHash and rejects an unresolved edge reference", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });
    const hash = await pageHash(root, "openwiki/architecture.md");

    await enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }) });
    const second = await enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: hash }) });
    assert.equal(second.applied, false);

    await assert.rejects(
      enrichGraph({
        root,
        homeDir: home,
        envelope: envelope({ sourceContentHash: hash, edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: "f".repeat(64), confidence: "inferred" }] }),
      }),
      (error) => {
        assert.ok(error instanceof OpenWikiError);
        assert.equal(error.code, "INVALID_ARGUMENT");
        return true;
      },
    );
  });

  test("rejects a sourceContentHash that does not match the current file content", async () => {
    const root = await repositoryWithWikiPage();
    const home = await temporaryRoot("home");
    await buildGraph({ root, homeDir: home });

    await assert.rejects(enrichGraph({ root, homeDir: home, envelope: envelope({ sourceContentHash: "0".repeat(64) }) }), (error) => {
      assert.ok(error instanceof OpenWikiError);
      assert.equal(error.code, "INVALID_ARGUMENT");
      return true;
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/enrich.test.mjs`
Expected: FAIL — `plugins/openwiki/src/enrich.ts` does not exist, so `dist/enrich.js` is missing and the build/import fails.

- [ ] **Step 3: Implement enrich.ts**

Create `plugins/openwiki/src/enrich.ts`:

```ts
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { parseEnrichEnvelope } from "./contracts.js";
import { OpenWikiError } from "./errors.js";
import {
  createGraphEdgeId,
  createGraphNodeId,
  mergeEnrichment,
  validEdgeConfidence,
  type EnrichmentShardV1,
  type GraphEdgeV1,
  type GraphNodeV1,
} from "./graph-contracts.js";
import { assembleGraph } from "./graph.js";
import type { GraphIndexPort } from "./graph-index.js";
import {
  openGraphIndex,
  readEnrichmentShard,
  readGraphShard,
  readManifest,
  resolveGraphStorage,
  withGraphWriteLock,
  writeGraph,
} from "./graph-store.js";
import { redactSensitive } from "./redact.js";

export interface EnrichOptions { root: string; homeDir?: string; envelope: unknown; now?: string; }
export interface EnrichResult {
  action: "enrich";
  sourcePath: string;
  sourceContentHash: string;
  applied: boolean;
  nodesWritten: number;
  edgesWritten: number;
  nodeIds: Record<string, string>;
  generatedAt: string;
}

export async function enrichGraph(options: EnrichOptions): Promise<EnrichResult> {
  const parsed = parseEnrichEnvelope(options.envelope);
  const redacted = parseEnrichEnvelope(redactSensitive(parsed));
  const resolved = await resolveGraphStorage(options.root, options.homeDir);
  await assertContentHashMatches(resolved.repositoryRoot, redacted.sourcePath, redacted.sourceContentHash);

  const localNodeIds = new Map<string, string>();
  const publicNodeIds = new Map<string, string>();
  const resolvedNodes: GraphNodeV1[] = [];
  for (const node of redacted.nodes) {
    const id = createGraphNodeId(node.kind, node.path, node.name);
    const key = localKey(node.kind, node.path, node.name);
    localNodeIds.set(key, id);
    localNodeIds.set(id, id);
    publicNodeIds.set(key, id);
    resolvedNodes.push({ id, kind: node.kind, path: node.path, name: node.name, ...(node.summary === undefined ? {} : { summary: node.summary }) });
  }

  return withGraphWriteLock(resolved.storage, async () => {
    const manifest = await readManifest(resolved.storage);
    const existing = manifest.enrichmentShards.find((entry) => entry.sourcePath === redacted.sourcePath);
    if (existing?.sourceContentHash === redacted.sourceContentHash) {
      return { action: "enrich" as const, sourcePath: redacted.sourcePath, sourceContentHash: redacted.sourceContentHash, applied: false, nodesWritten: 0, edgesWritten: 0, nodeIds: Object.fromEntries(publicNodeIds), generatedAt: manifest.generatedAt };
    }

    const index = await openGraphIndex(resolved.storage);
    const resolvedEdges: GraphEdgeV1[] = [];
    for (const edge of redacted.edges) {
      if (!validEdgeConfidence(edge.kind, edge.confidence)) throw new OpenWikiError("INVALID_ARGUMENT", "Enrich edge confidence is not valid for its edge kind.");
      const from = await resolveNodeRef(index, localNodeIds, edge.from);
      const to = await resolveNodeRef(index, localNodeIds, edge.to);
      resolvedEdges.push({ id: createGraphEdgeId(edge.kind, from, to, edge.confidence), kind: edge.kind, from, to, confidence: edge.confidence });
    }

    const now = options.now ?? new Date().toISOString();
    const sourceNodeId = createGraphNodeId("source", redacted.sourcePath, redacted.sourceContentHash);
    const sourceNode: GraphNodeV1 = { id: sourceNodeId, kind: "source", path: redacted.sourcePath, name: redacted.sourceContentHash };
    const groundsEdges: GraphEdgeV1[] = resolvedNodes.map((node) => ({ id: createGraphEdgeId("grounds", sourceNodeId, node.id, "extracted"), kind: "grounds", from: sourceNodeId, to: node.id, confidence: "extracted" }));

    const shard: EnrichmentShardV1 = {
      sourcePath: redacted.sourcePath,
      sourceContentHash: redacted.sourceContentHash,
      nodes: [sourceNode, ...resolvedNodes],
      edges: [...groundsEdges, ...resolvedEdges],
      enrichedAt: now,
    };

    const codeShards = await Promise.all(manifest.shards.map((entry) => readGraphShard(resolved.storage, entry.shard)));
    const codeGraph = assembleGraph(resolved.workspaceId, now, manifest.source, codeShards);
    const otherEnrichmentShards = await Promise.all(
      manifest.enrichmentShards.filter((entry) => entry.sourcePath !== redacted.sourcePath).map((entry) => readEnrichmentShard(resolved.storage, entry.shard)),
    );
    const enrichmentShards = [...otherEnrichmentShards, shard];
    const merged = mergeEnrichment(codeGraph, enrichmentShards);

    await writeGraph(resolved.storage, merged, codeShards, enrichmentShards);

    return { action: "enrich" as const, sourcePath: redacted.sourcePath, sourceContentHash: redacted.sourceContentHash, applied: true, nodesWritten: shard.nodes.length, edgesWritten: shard.edges.length, nodeIds: Object.fromEntries(publicNodeIds), generatedAt: now };
  });
}

async function resolveNodeRef(index: GraphIndexPort, localNodeIds: ReadonlyMap<string, string>, ref: string): Promise<string> {
  const local = localNodeIds.get(ref);
  if (local !== undefined) return local;
  if (/^[a-f0-9]{64}$/u.test(ref) && (await index.node(ref)) !== undefined) return ref;
  throw new OpenWikiError("INVALID_ARGUMENT", "Enrich edge references an unknown node.");
}

function localKey(kind: "concept" | "page", path: string, name: string): string {
  return `${kind}:${path}:${name}`;
}

async function assertContentHashMatches(repositoryRoot: string, sourcePath: string, expectedHash: string): Promise<void> {
  const absolute = path.resolve(repositoryRoot, sourcePath);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new OpenWikiError("PATH_OUTSIDE_ROOT", "Enrich sourcePath escapes the repository root.");
  }
  let details;
  try {
    details = await lstat(absolute);
  } catch {
    throw new OpenWikiError("NOT_FOUND", "Enrich sourcePath was not found.");
  }
  if (details.isSymbolicLink() || !details.isFile()) throw new OpenWikiError("SYMLINK_ESCAPE", "Enrich sourcePath must be a regular repository file.");
  const content = await readFile(absolute);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== expectedHash) throw new OpenWikiError("INVALID_ARGUMENT", "Enrich sourceContentHash does not match the current file content.");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/enrich.test.mjs`
Expected: PASS, all five tests.

- [ ] **Step 5: Run the full suite**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/openwiki/src/enrich.ts plugins/openwiki/tests/integration/enrich.test.mjs
git commit -m "feat(openwiki): add the enrich operation with hash-verified, capped, idempotent writes"
```

---

## Task 6: Wire `enrich` through the CLI, adapter, and MCP

**Files:**
- Modify: `plugins/openwiki/src/adapter.ts`
- Modify: `plugins/openwiki/src/cli.ts`
- Modify: `plugins/openwiki/src/mcp.ts`
- Modify: `plugins/openwiki/tests/integration/mcp.test.mjs`
- Test: append to `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs` (Task 9 adds the full e2e journey; this task adds the narrower adapter/CLI/MCP contract-parity tests)

**Interfaces:**
- Consumes: `enrichGraph` from `./enrich.js` (Task 5).
- Produces: `"enrich"` added to `OPENWIKI_OPERATIONS`; CLI `enrich --root <root> [--stdin | --envelope-file <path>]`; MCP tool `enrich`.

- [ ] **Step 1: Write the failing tests**

In `plugins/openwiki/tests/integration/mcp.test.mjs`, add `"enrich"` to `TOOL_NAMES` right after `"ingest"`:

```js
const TOOL_NAMES = [
  "init",
  "status",
  "context",
  "search",
  "read",
  "write",
  "ingest",
  "enrich",
  "finalize",
  "check",
  "doctor",
  "schedule",
  "purge",
  "graph",
];
```

Add `enrich` to `STABLE_ANNOTATIONS`, matching `ingest`'s tuple:

```js
const STABLE_ANNOTATIONS = {
  init: [false, false, true, false],
  status: [true, false, false, false],
  context: [true, false, false, false],
  search: [true, false, false, false],
  read: [true, false, false, false],
  write: [false, true, true, false],
  enrich: [false, true, true, false],
  finalize: [false, true, true, false],
  check: [true, false, false, false],
  graph: [false, true, true, false],
};
```

Update the test title and count assertion (`tools/list exposes exactly thirteen closed schemas` → `fourteen`):

```js
  test("MCP tools/list exposes exactly fourteen closed schemas and native graph action branches", async (t) => {
```

(Leave the body of that test untouched — it already asserts `tools.map(({ name }) => name)` deep-equals `TOOL_NAMES`, which now includes `enrich`.)

Add `createHash` to the top-level imports of `plugins/openwiki/tests/integration/mcp.test.mjs`:

```js
import { createHash } from "node:crypto";
```

Add a new test inside `describe("MCP stdio adapter", ...)`, after the `tools/call returns shared envelopes` test:

```js
  test("MCP enrich tool grounds a page node and is idempotent on an unchanged hash", async (t) => {
    const sandbox = makeTemporaryRoot(t, "mcp enrich");
    const home = join(sandbox, "home");
    mkdirSync(home);
    const root = join(sandbox, "repo");
    initializeGitRepository(root, {
      "src/worker.ts": "export function run() { return 1; }\n",
      "openwiki/architecture.md": "# Architecture\n\nThe worker performs background runs.\n",
    });
    const session = createMcpSession(t, { env: makeIsolatedEnvironment(home) });
    await makeReady(session);

    await request(session, 1, "tools/call", { name: "graph", arguments: { mode: "code", root, action: "build", force: true } });
    const queryResponse = await request(session, 2, "tools/call", { name: "graph", arguments: { mode: "code", root, action: "query", query: "run", limit: 5 } });
    const queryData = parseToolEnvelope(queryResponse, false);
    const symbolNode = queryData.data.nodes.find((node) => node.name === "run");
    assert.ok(symbolNode);

    const pageHash = createHash("sha256").update("# Architecture\n\nThe worker performs background runs.\n").digest("hex");
    const envelopeArguments = {
      root,
      envelope: {
        schema: "memex.enrich.v1",
        sourcePath: "openwiki/architecture.md",
        sourceContentHash: pageHash,
        nodes: [{ kind: "page", name: "openwiki/architecture.md", path: "openwiki/architecture.md" }],
        edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: symbolNode.id, confidence: "inferred" }],
      },
    };
    const firstEnrich = parseToolEnvelope(await request(session, 3, "tools/call", { name: "enrich", arguments: envelopeArguments }), false);
    assert.equal(firstEnrich.data.applied, true);

    const secondEnrich = parseToolEnvelope(await request(session, 4, "tools/call", { name: "enrich", arguments: envelopeArguments }), false);
    assert.equal(secondEnrich.data.applied, false);

    assert.equal((await session.finish()).code, 0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/mcp.test.mjs`
Expected: FAIL — `"enrich"` is not a known MCP tool name yet, and `tools/call` with `name: "enrich"` is rejected.

- [ ] **Step 3: Add `enrich` to adapter.ts**

In `plugins/openwiki/src/adapter.ts`, add `"enrich"` to `OPENWIKI_OPERATIONS` (right after `"ingest"`):

```ts
export const OPENWIKI_OPERATIONS = [
  "init",
  "status",
  "context",
  "search",
  "read",
  "write",
  "ingest",
  "enrich",
  "finalize",
  "check",
  "doctor",
  "schedule",
  "purge",
  "graph",
] as const;
```

Add the dispatch case inside `dispatchUnsafe`, right after the `"ingest"` case:

```ts
    case "ingest": {
      const location = await resolveWikiLocation(readLocation(input, ["mode", "root", "envelope"]));
      return ingestSource({ location, envelope: requireValue(input, "envelope") });
    }
    case "enrich": {
      assertKeys(input, ["root", "envelope"]);
      const root = readRequiredString(input, "root");
      const envelope = requireValue(input, "envelope");
      const enrich = await loadEnrich();
      return enrich.enrichGraph({ root, homeDir: hostHomeDir(), envelope });
    }
```

Add the lazy loader next to the existing `loadGraph`/`GraphOperations` block:

```ts
interface EnrichOperations {
  enrichGraph(options: InputRecord): Promise<unknown>;
}

async function loadEnrich(): Promise<EnrichOperations> {
  const moduleValue: unknown = await import(new URL("./enrich.js", import.meta.url).href);
  const module = readRecord(moduleValue, "Native enrich module is invalid.");
  return { enrichGraph: readAsyncFunction(module, "enrichGraph") };
}
```

- [ ] **Step 4: Add `enrich` to cli.ts**

In `plugins/openwiki/src/cli.ts`, extend the ingest-transport branch in `toRequest` to also cover `enrich` (both operations submit a JSON envelope via `--stdin` or a file flag):

```ts
  } else if (operation === "ingest" || operation === "enrich") {
    const raw = await readIngestTransport(flags, stdinText);
    delete inputValue["envelope-file"];
    delete inputValue.stdin;
    try {
      inputValue.envelope = JSON.parse(raw);
    } catch {
      throw invalid("Source envelope input must be valid JSON.");
    }
  } else if (flags.stdin === true || flags["content-file"] !== undefined || flags["envelope-file"] !== undefined) {
    throw invalid("Input transport is incompatible with this operation.");
  }
```

Update `runProcessCli`'s strict-UTF-8 stdin gate to also apply to `enrich`:

```ts
async function runProcessCli(argv: readonly string[]): Promise<number> {
  try {
    const shouldReadStdin = argv.includes("--stdin");
    const stdinText = shouldReadStdin
      ? await readInputStream(argv[0] === "write" ? undefined : MAX_ENVELOPE_BYTES, argv[0] === "ingest" || argv[0] === "enrich")
      : "";
    return await main(argv, stdinText);
  } catch (error) {
    return emitFailure(error, argv.includes("--pretty"));
  }
}
```

- [ ] **Step 5: Add `enrich` to mcp.ts**

In `plugins/openwiki/src/mcp.ts`, add the tool definition to the `tools` array, right after `ingest`:

```ts
const tools: readonly ToolDefinition[] = [
  tool("init", "Initialize an OpenWiki workspace.", commonMode({ root }, []), [false, false, true, false]),
  tool("status", "Read OpenWiki state and source summaries.", commonMode({ root }, []), [true, false, false, false]),
  tool("context", "Collect bounded Git repository context.", object({ root, previousHead: { type: "string", minLength: 1 } }, ["root"]), [true, false, false, false]),
  tool("search", "Search grounded wiki pages.", commonMode({ root, query: { type: "string", minLength: 1 }, limit }, ["query"]), [true, false, false, false]),
  tool("read", "Read one grounded wiki page.", commonMode({ root, page: { type: "string", minLength: 1 } }, ["page"]), [true, false, false, false]),
  tool("write", "Write one confined wiki page.", commonMode({ root, page: { type: "string", minLength: 1 }, content: { type: "string" } }, ["page", "content"]), [false, true, true, false]),
  tool("ingest", "Store one validated source envelope.", commonMode({ root, envelope: { type: "object", additionalProperties: true } }, ["envelope"]), [false, true, true, false]),
  tool("enrich", "Store one validated concept/page enrichment envelope, grounded in graph evidence.", object({ root, envelope: { type: "object", additionalProperties: true } }, ["root", "envelope"]), [false, true, true, false]),
  tool("finalize", "Finalize a wiki update run.", commonMode({ root, command: { type: "string", enum: ["init", "update", "ingest"] }, runId: { type: "string", minLength: 1 }, startedAt: { type: "string", minLength: 1 }, completedAt: { type: "string", minLength: 1 }, summary: { type: "string", minLength: 1 }, lastGitHead: { type: "string", minLength: 1 } }, ["command", "runId", "startedAt", "summary"]), [false, true, true, false]),
  tool("check", "Check wiki integrity.", commonMode({ root }, []), [true, false, false, false]),
  tool("doctor", "Run local runtime diagnostics.", commonMode({ root }, []), [true, false, false, false]),
  tool("schedule", "Set, list, or remove local schedule intent.", scheduleSchema(), [false, true, true, false]),
  tool("purge", "Purge selected local OpenWiki data.", commonMode({ root, scope: { type: "string", enum: ["raw", "schedules", "personal-wiki", "all"] } }, ["scope"]), [false, true, true, false]),
  tool("graph", "Build or query the native bounded code graph.", graphSchema(), [false, true, true, false]),
];
```

(`enrich`'s schema deliberately does not go through `commonMode` — enrich has no `mode` concept, it is always code-mode-only, matching how `dispatchGraph` also reads `root` directly rather than through `resolveWikiLocation`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add plugins/openwiki/src/adapter.ts plugins/openwiki/src/cli.ts plugins/openwiki/src/mcp.ts plugins/openwiki/tests/integration/mcp.test.mjs
git commit -m "feat(openwiki): expose enrich through the CLI, adapter dispatch, and MCP tool surface"
```

---

## Task 7: `check` enforces page-to-graph anchoring invariants

**Files:**
- Modify: `plugins/openwiki/src/wiki.ts`
- Modify: `plugins/openwiki/src/adapter.ts`
- Test: `plugins/openwiki/tests/integration/wiki-graph-check.test.mjs` (new)

**Interfaces:**
- Consumes: `GraphIndexPort` from `./graph-index.js`.
- Produces: `WikiCheckIssue.code` widened with `"MISSING_PAGE_NODE" | "MISSING_PAGE_EDGE" | "DANGLING_NODE_REF"`; `WikiCheckOptions`; `checkWiki(location, options?)` (2nd parameter, defaulted, so every existing call site keeps compiling).

- [ ] **Step 1: Write the failing test**

Create `plugins/openwiki/tests/integration/wiki-graph-check.test.mjs`:

```js
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { enrichGraph } from "../../dist/enrich.js";
import { buildGraph } from "../../dist/graph.js";
import { openGraphIndex, resolveGraphStorage } from "../../dist/graph-store.js";
import { checkWiki, initializeWiki } from "../../dist/wiki.js";

const execFileAsync = promisify(execFile);
const roots = [];
const STANDARD_PAGES = ["quickstart.md", "architecture.md", "source-map.md", "workflows.md", "domain-concepts.md", "operations.md", "integrations.md", "testing.md"];

async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `openwiki-wiki-graph-check-${label}-`));
  roots.push(root);
  return root;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("check enforces page-to-graph anchoring", () => {
  test("flags every standard page as missing a page node until enrichment grounds it", async () => {
    const root = await temporaryRoot("repo");
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.email", "openwiki@example.test"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    const home = await temporaryRoot("home");
    const initialized = await initializeWiki({ mode: "code", root, homeDir: home, now: "2026-07-14T00:00:00.000Z", runId: "init-1" });
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "wiki"]);
    await buildGraph({ root, homeDir: home });

    const withoutGraph = await checkWiki(initialized.location);
    assert.equal(withoutGraph.ok, true);

    const resolved = await resolveGraphStorage(root, home);
    const graphBeforeEnrich = await openGraphIndex(resolved.storage);
    const withGraphBeforeEnrich = await checkWiki(initialized.location, { graph: graphBeforeEnrich });
    assert.equal(withGraphBeforeEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_NODE" && issue.page === "quickstart.md"), true);

    for (const page of STANDARD_PAGES) {
      const content = await readFile(path.join(root, "openwiki", page));
      const hash = createHash("sha256").update(content).digest("hex");
      const isQuickstart = page === "quickstart.md";
      await enrichGraph({
        root,
        homeDir: home,
        envelope: {
          schema: "memex.enrich.v1",
          sourcePath: `openwiki/${page}`,
          sourceContentHash: hash,
          nodes: [
            { kind: "page", name: `openwiki/${page}`, path: `openwiki/${page}` },
            ...(isQuickstart ? [{ kind: "concept", name: "process model", path: "concepts/process-model.md" }] : []),
          ],
          edges: isQuickstart
            ? [{ kind: "describes", from: `page:openwiki/${page}:openwiki/${page}`, to: "concept:concepts/process-model.md:process model", confidence: "extracted" }]
            : [],
        },
      });
    }

    const resolvedAfter = await resolveGraphStorage(root, home);
    const graphAfter = await openGraphIndex(resolvedAfter.storage);
    const withGraphAfterEnrich = await checkWiki(initialized.location, { graph: graphAfter });
    assert.equal(withGraphAfterEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_NODE"), false);
    assert.equal(withGraphAfterEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_EDGE" && issue.page === "quickstart.md"), false);
    assert.equal(withGraphAfterEnrich.issues.some((issue) => issue.code === "MISSING_PAGE_EDGE" && issue.page === "architecture.md"), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/wiki-graph-check.test.mjs`
Expected: FAIL — `checkWiki` does not accept a second `options` parameter yet, and none of the new issue codes are ever produced.

- [ ] **Step 3: Implement the checkWiki changes**

In `plugins/openwiki/src/wiki.ts`, add the import:

```ts
import type { GraphIndexPort } from "./graph-index.js";
```

Widen `WikiCheckIssue` and add `WikiCheckOptions`:

```ts
export interface WikiCheckIssue {
  code: "BROKEN_LINK" | "DANGLING_NODE_REF" | "INVALID_STATE" | "MISSING_PAGE" | "MISSING_PAGE_EDGE" | "MISSING_PAGE_NODE" | "STALE_STATE" | "SYMLINK";
  message: string;
  page?: string;
}

export interface WikiCheckOptions {
  graph?: GraphIndexPort;
}
```

Change the `checkWiki` signature and insert the new invariant block right after the existing broken-link loop (which already computes `pages`), before the `if (state) {...}` stale-state check:

```ts
export async function checkWiki(
  location: WikiLocation,
  options: WikiCheckOptions = {},
): Promise<WikiCheckResult> {
  const issues: WikiCheckIssue[] = [];
  let state: WikiStateV1 | null = null;

  try {
    state = await readState(location);
  } catch {
    issues.push({
      code: "INVALID_STATE",
      message: "Wiki state is missing or invalid.",
    });
  }

  for (const page of REQUIRED_WIKI_PAGES) {
    try {
      await readPage(location, page);
    } catch {
      issues.push({
        code: "MISSING_PAGE",
        message: "Required wiki page is missing.",
        page,
      });
    }
  }

  let pages: string[] = [];
  try {
    pages = await listMarkdownPages(location);
  } catch (error) {
    if (error instanceof OpenWikiError && error.code === "SYMLINK_ESCAPE") {
      issues.push({
        code: "SYMLINK",
        message: "Wiki contains a symbolic link.",
      });
    } else {
      throw error;
    }
  }

  for (const page of pages) {
    const content = (await readPage(location, page)).content;
    for (const target of findMarkdownLinks(content)) {
      const resolvedTarget = resolveLinkedPage(page, target);
      if (resolvedTarget.kind === "skip") {
        continue;
      }
      if (resolvedTarget.kind === "invalid") {
        issues.push({
          code: "BROKEN_LINK",
          message: "Wiki page contains a local link outside the wiki root.",
          page,
        });
        continue;
      }
      try {
        await readPage(location, resolvedTarget.page);
      } catch {
        issues.push({
          code: "BROKEN_LINK",
          message: "Wiki page contains a broken local link.",
          page,
        });
      }
    }
  }

  if (options.graph !== undefined) {
    const graph = options.graph;
    const [allNodes, allEdges] = await Promise.all([graph.allNodes(), graph.allEdges()]);
    const nodeIds = new Set(allNodes.map((node) => node.id));
    for (const page of pages) {
      const pageNode = allNodes.find((node) => node.kind === "page" && node.path === page);
      if (pageNode === undefined) {
        issues.push({
          code: "MISSING_PAGE_NODE",
          message: "Wiki page has no corresponding page graph node.",
          page,
        });
        continue;
      }
      const hasEvidence = allEdges.some(
        (edge) => (edge.from === pageNode.id || edge.to === pageNode.id) && (edge.kind === "describes" || edge.kind === "mentions"),
      );
      if (!hasEvidence) {
        issues.push({
          code: "MISSING_PAGE_EDGE",
          message: "Wiki page node has no describes or mentions edge.",
          page,
        });
      }
    }
    for (const edge of allEdges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        issues.push({
          code: "DANGLING_NODE_REF",
          message: `Graph edge ${edge.id} references a node that does not exist.`,
        });
      }
    }
  }

  if (state) {
    try {
      if ((await createWikiContentHash(location)) !== state.contentHash) {
        issues.push({
          code: "STALE_STATE",
          message: "Wiki content differs from finalized state.",
        });
      }
    } catch (error) {
      if (error instanceof OpenWikiError && error.code === "SYMLINK_ESCAPE") {
        if (!issues.some((issue) => issue.code === "SYMLINK")) {
          issues.push({
            code: "SYMLINK",
            message: "Wiki contains a symbolic link.",
          });
        }
      } else {
        throw error;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
```

In `plugins/openwiki/src/adapter.ts`, add the static import:

```ts
import { openGraphIndex, probeGraphStorage, resolveGraphStorage } from "./graph-store.js";
import type { GraphIndexPort } from "./graph-index.js";
```

Update the `"check"` dispatch case and add the helper function right after `dispatchGraph`:

```ts
    case "check": {
      const location = await resolveWikiLocation(readLocation(input, ["mode", "root"]));
      const graphIndex = location.mode === "code" ? await tryOpenGraphIndexForCheck(location.workspaceRoot as string, hostHomeDir()) : undefined;
      return checkWiki(location, { ...(graphIndex === undefined ? {} : { graph: graphIndex }) });
    }
```

```ts
async function tryOpenGraphIndexForCheck(workspaceRoot: string, homeDir: string): Promise<GraphIndexPort | undefined> {
  const probe = await probeGraphStorage(workspaceRoot, homeDir);
  if (!probe.initialized) return undefined;
  const resolved = await resolveGraphStorage(workspaceRoot, homeDir);
  return openGraphIndex(resolved.storage);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/integration/wiki-graph-check.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm --prefix plugins/openwiki run typecheck && npm --prefix plugins/openwiki run lint && npm --prefix plugins/openwiki test`
Expected: PASS. (Every existing `checkWiki(location)` one-argument call site keeps compiling because `options` defaults to `{}`; the CLI `"check"` dispatch now opens the graph automatically only in code mode when one exists.)

- [ ] **Step 6: Commit**

```bash
git add plugins/openwiki/src/wiki.ts plugins/openwiki/src/adapter.ts plugins/openwiki/tests/integration/wiki-graph-check.test.mjs
git commit -m "feat(openwiki): enforce page-to-graph anchoring invariants in check"
```

---

## Task 8: Skill updates — mandatory enrichment step in init/update, cross-reference in ingest

**Files:**
- Modify: `plugins/openwiki/skills/openwiki-init/SKILL.md`
- Modify: `plugins/openwiki/skills/openwiki-update/SKILL.md`
- Modify: `plugins/openwiki/skills/openwiki-ingest/SKILL.md`

No test harness exists for skill prose; verification for this task is a careful manual diff review plus Task 9's e2e test, which exercises the actual `init` → `enrich` → `check` sequence these skills describe.

- [ ] **Step 1: Update `openwiki-init/SKILL.md`'s Procedure, Evidence, and Completion proof**

Replace the `## Procedure` section:

```markdown
## Procedure

1. Run `<cli> status --mode <mode> --root <root> --json`; continue on `NOT_INITIALIZED`, but stop for any other error.
2. In code mode, delegate graph freshness and compact repository structure evidence to `openwiki-graph` before requesting broad context. Do not reproduce graph build or refresh orchestration here. In personal mode, skip graph work.
3. Run `<cli> context --mode <mode> --root <root> --json` and bound synthesis to the returned evidence.
4. Run `<cli> init --mode <mode> --root <root> --json` once to create confined state and standard pages idempotently.
5. Write concise pages through the `write` operation: quickstart, architecture, source map, workflows, domain concepts, operations, integrations, and testing. Preserve unrelated instruction-file content byte-for-byte.
6. In code mode, extract concepts, entities, and decisions from every page written or changed in step 5. For each such page, submit one `enrich` envelope (`--stdin` or `--envelope-file`, schema `memex.enrich.v1`) declaring a `page` node for that page, `concept` nodes for the concepts it introduces, and `mentions`/`describes` edges linking the page to those concepts and to code symbols surfaced by `openwiki-graph`. Compute `sourceContentHash` from the page content actually on disk; the runtime rejects a mismatched hash with `INVALID_ARGUMENT`. Resubmitting an unchanged page's envelope is a safe no-op. Skip this step in personal mode, which has no graph.
7. Run `check`; fix every reported missing page, broken internal link, provenance gap, missing page node, missing page edge, dangling reference, or instruction-block mismatch.
8. Run `finalize` only after all writes, enrichment, and `check` succeed, then run `status` again.
```

Replace the `## Evidence` section:

```markdown
## Evidence

- Capture canonical mode/root, Git HEAD for code mode, written page paths, enrich results (sourcePath, applied, nodesWritten, edgesWritten) for code mode, `check` result, final content hash, and final run id.
- In code mode, preserve the delegated `openwiki-graph` status/action evidence and disclose its freshness, confidence, diagnostics, and truncation; personal mode has no graph evidence.
- Cite repository evidence used for synthesis; do not claim external connector coverage unless that connector was read through an authenticated host tool.
```

Replace the `## Mutation boundary` section:

```markdown
## Mutation boundary

Write only the selected wiki root, private OpenWiki state under `~/.openwiki/data/` (including enrichment shards under `~/.openwiki/data/<workspace-id>/graph/enrichment/`), and the idempotent OpenWiki blocks in code-mode `AGENTS.md` and `CLAUDE.md`. Never alter unrelated instruction content or provider credentials.
```

Replace the `## Completion proof` section:

```markdown
## Completion proof

Initialization completes only when every code-mode page has been enriched (or the run is personal mode, which has no graph to enrich), `check` passes, `finalize` records the run, final `status` is healthy, standard pages exist, and every changed path is inside the approved boundary.
```

- [ ] **Step 2: Update `openwiki-update/SKILL.md`'s Procedure, Evidence, and Completion proof**

Replace the `## Procedure` section:

```markdown
## Procedure

1. Run `status` using the same mode/root. In code mode, delegate graph freshness and changed-path mapping to `openwiki-graph`'s `changes` action; that skill owns graph status, authorized refresh, limits, and confidence reporting. In personal mode, skip graph work.
2. Run `context` using the same mode/root.
3. If context reports no changed evidence, run `check`, return a no-op result, and do not call `write`, `enrich`, or `finalize`.
4. Map changed evidence to affected pages; read those pages before generating replacements.
5. Write only changed markdown pages through the confined `write` operation and preserve unrelated page content.
6. In code mode, for every page written in step 5, submit one `enrich` envelope re-extracting its concepts, entities, and mentions, exactly as in `openwiki-init` step 6. Unchanged pages need no re-enrichment; resubmitting an unchanged page's envelope is a safe no-op. Skip in personal mode.
7. Run `check`; repair every failure before continuing.
8. Run `finalize` with a bounded summary and changed flag, then rerun `status` to confirm the new content hash and run id.
```

Replace the `## Evidence` section:

```markdown
## Evidence

- Capture before/after content hashes, before/after Git HEAD evidence, changed source ids, updated page paths, enrich results for each changed page in code mode (sourcePath, applied, nodesWritten, edgesWritten), `check` output, and the finalized run id.
- In code mode, preserve the delegated graph `changes` evidence, including freshness, confidence, diagnostics, unresolved edges, and truncation; personal mode has no graph evidence.
- For a no-op, preserve the unchanged hash and explicit `changed: false` proof.
```

Replace the `## Completion proof` section:

```markdown
## Completion proof

An update completes only when the no-op path proves no writes, or the changed path writes affected pages, enriches each in code mode, passes `check`, finalizes once, reports exact updated pages, and leaves `status` healthy.
```

- [ ] **Step 3: Update `openwiki-ingest/SKILL.md`'s cross-reference**

Replace step 5 of `## Procedure`:

```markdown
5. Use `openwiki-update` only when the user asks to synthesize ingested evidence into pages; that workflow performs the mandatory `enrich` step for any page it writes. Ingest itself never calls `enrich` since it does not write wiki pages. Otherwise report stored evidence without changing wiki content.
```

- [ ] **Step 4: Review the diffs**

Run: `git diff plugins/openwiki/skills/openwiki-init/SKILL.md plugins/openwiki/skills/openwiki-update/SKILL.md plugins/openwiki/skills/openwiki-ingest/SKILL.md`
Expected: the three surgical edits above and nothing else — confirm no other section was accidentally touched.

- [ ] **Step 5: Commit**

```bash
git add plugins/openwiki/skills/openwiki-init/SKILL.md plugins/openwiki/skills/openwiki-update/SKILL.md plugins/openwiki/skills/openwiki-ingest/SKILL.md
git commit -m "docs(openwiki): make enrich a mandatory step of init and update"
```

---

## Task 9: Full-suite gate and end-to-end verification

**Files:**
- Modify: `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–8. This task adds no new production code — it is the slice's exit-criteria proof.

- [ ] **Step 1: Write the failing e2e test**

In `plugins/openwiki/tests/e2e/runtime.e2e.test.mjs`, insert a new test at the end of the `describe("OpenWiki real runtime journey", ...)` block — immediately after the line `assertSemanticText(updatedQueryData, [/catalogDependencyMap/u, /src\/catalog\.mjs/u]);` and its enclosing test's `await assertGitNexusWasNotInvoked(harness);` / `});`, and before the block's own closing `});` (i.e., right before `describe("OpenWiki process-boundary security regressions", ...)` begins):

```js
  test("enrich grounds a wiki page in the graph with a real code-symbol mention, verified by check", async (t) => {
    const harness = await createRepositoryHarness(t);
    await initializeWiki(harness);
    const graphTarget = ["--mode", "code", "--root", harness.repositoryRoot];
    await runCliSuccess(harness, ["graph", ...graphTarget, "--action", "build", "--force"]);

    const symbolQuery = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "query",
      "--query",
      "listActiveProducts",
      "--limit",
      "5",
    ]);
    const symbolData = assertGraphResult(symbolQuery, "query", harness.repositoryRoot, 5);
    const symbolNode = symbolData.nodes.find((node) => node.name === "listActiveProducts");
    assert.ok(symbolNode, "expected the sample repository scanner to expose listActiveProducts");

    const pagePath = join(harness.repositoryRoot, "openwiki", "architecture.md");
    const pageContent = await readFile(pagePath, "utf8");
    const pageHash = createHash("sha256").update(pageContent).digest("hex");
    const enrichEnvelope = {
      schema: "memex.enrich.v1",
      sourcePath: "openwiki/architecture.md",
      sourceContentHash: pageHash,
      nodes: [{ kind: "page", name: "openwiki/architecture.md", path: "openwiki/architecture.md" }],
      edges: [{ kind: "mentions", from: "page:openwiki/architecture.md:openwiki/architecture.md", to: symbolNode.id, confidence: "inferred" }],
    };

    const enrichResult = await runCliSuccess(
      harness,
      ["enrich", "--root", harness.repositoryRoot, "--stdin"],
      { input: JSON.stringify(enrichEnvelope) },
    );
    assert.equal(enrichResult.json.data.applied, true);
    assert.equal(enrichResult.json.data.nodesWritten, 2);

    const secondEnrich = await runCliSuccess(
      harness,
      ["enrich", "--root", harness.repositoryRoot, "--stdin"],
      { input: JSON.stringify(enrichEnvelope) },
    );
    assert.equal(secondEnrich.json.data.applied, false);

    const context = await runCliSuccess(harness, [
      "graph",
      ...graphTarget,
      "--action",
      "context",
      "--target",
      symbolNode.id,
      "--limit",
      "10",
    ]);
    const contextData = assertGraphResult(context, "context", harness.repositoryRoot, 10);
    assert.equal(contextData.edges.some((edge) => edge.kind === "mentions" && edge.to === symbolNode.id), true);

    const check = await runCliSuccess(harness, ["check", "--mode", "code", "--root", harness.repositoryRoot]);
    assert.equal(
      check.json.data.issues.some((issue) => issue.code === "MISSING_PAGE_NODE" && issue.page === "architecture.md"),
      false,
    );

    await assertGitNexusWasNotInvoked(harness);
  });
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm --prefix plugins/openwiki run build && node --test plugins/openwiki/tests/e2e/runtime.e2e.test.mjs`
Expected: FAIL before Tasks 1–8 land (missing `enrich` operation); PASS once they are all in place. If this task is executed after Tasks 1–8 are already committed (the normal case for this plan's ordering), this step instead directly confirms PASS — run it anyway to prove the assertions are exercised, not vacuous (e.g., temporarily rename `enrich` to `enrichx` in `adapter.ts`'s `OPENWIKI_OPERATIONS`, rerun to confirm a FAIL, then revert).

- [ ] **Step 3: Run every quality gate**

Run, in order, and record the exit code of each:

```bash
npm --prefix plugins/openwiki run build
npm --prefix plugins/openwiki run typecheck
npm --prefix plugins/openwiki run lint
npm --prefix plugins/openwiki test
```

Expected: PASS for all four. `npm test` runs `node --test`, which picks up every `*.test.mjs` file under `plugins/openwiki/tests/` including every file this plan added or modified (Tasks 1–9).

- [ ] **Step 4: Broad non-regression pass on the pre-existing graph and wiki operations**

Run: `node --test plugins/openwiki/tests/unit/graph.test.mjs plugins/openwiki/tests/unit/graph-analysis.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs plugins/openwiki/tests/integration/operations.test.mjs plugins/openwiki/tests/integration/git-wiki.test.mjs plugins/openwiki/tests/integration/hook.test.mjs plugins/openwiki/tests/integration/installer.test.mjs plugins/openwiki/tests/packaging/structure.test.mjs`
Expected: PASS — these are the tests most likely to regress from a `CodeGraphV1.schemaVersion` bump or a `checkWiki`/`writeGraph` signature change, and none of them should need modification beyond what Task 1 already made (the `graph.test.mjs` fixture fix).

- [ ] **Step 5: First review cycle**

Perform a spec-compliance and code review pass against this plan and the PRD §7 slice 2a / §9–§12 sections: confirm every binding contract type name/signature matches exactly, confirm the two documented "no changes needed" schemaVersion locations (operation envelopes vs. data snapshot) were not conflated, confirm no new error code was introduced, confirm `enrichmentShards` backward-compatibility (missing field → `[]`) is exercised by a test, confirm the skill updates in Task 8 match the actual CLI flags implemented in Task 6. Fix every finding, then rerun Steps 3–4.

- [ ] **Step 6: Second, independent review cycle**

Repeat Step 5 with fresh eyes (or a fresh reviewing agent) after the Step 5 fixes are in. This slice is not done until this second review cycle is clean with no further findings. Rerun Steps 3–4 once more if anything changed.

- [ ] **Step 7: Commit**

```bash
git add plugins/openwiki/tests/e2e/runtime.e2e.test.mjs
git commit -m "test: verify enrich end-to-end through the CLI, including graph anchoring and idempotency"
```

---

## Self-review

**1. Spec coverage** (PRD §7 slice 2a, plus §9–§12):
- "Extend graph contracts (v2 schema): new node kinds concept|page|source" → Task 1.
- "new edge kinds mentions|describes|grounds|related|member-of" → Task 1.
- "Confidence model... dual confidence sets... validated per edge kind" → Task 1 (`validEdgeConfidence`).
- "New graph enrich operation... same envelope discipline as ingest: size caps, schema validation, redaction, atomic write" → Tasks 2 and 5.
- "Enrichment shards are keyed by source-content hash, so re-enrichment of unchanged files is a no-op" → Task 5 (`existing?.sourceContentHash === redacted.sourceContentHash` fast path), tested in Task 5 Step 1 and Task 6/9.
- "stale enrichments are detected via the existing freshness machinery" → Task 4 (`buildGraph` re-merges enrichment on every rebuild; a rebuild that removes a code node prunes the dangling mention/describes edge and records a diagnostic, exactly like the scanner's existing `UNRESOLVED_IMPORT`/`UNRESOLVED_SYMBOL` diagnostics).
- "Wiki lifecycle integration: init/update/ingest skills gain a mandatory enrichment step" → Task 8.
- "check gains validations: every wiki page is a page node; every page has ≥1 describes/mentions edge with provenance; no dangling node references" → Task 7.
- PRD §9 data model (`~/.memex/data/<workspace-id>/graph/` shard store + enrichment shards, atomic writes, single write lock, content-addressed segments, confined paths, manifests carrying schema/scanner versions) → Tasks 1, 3, 4, 5 all reuse the existing `atomic.ts`/write-lock/content-addressing discipline verbatim; no new storage primitive was invented.
- PRD §10 data flow ("agent extracts concepts+mentions from changed pages/docs (enrich) → runtime validates, redacts, caps, and atomically persists shards → runtime... `check` validates cross-plane invariants") → Tasks 5 and 7 together.
- PRD §11 error handling ("All external input (enrich envelopes, queries, paths) passes the existing validation/redaction/caps pipeline; UTF-8 validation... apply to the new operations too") → Task 2 (validation/caps), Task 5 (redaction via `redactSensitive`), Task 6 Step 4 (`enrich` added to the CLI's strict-UTF-8 stdin gate alongside `ingest`).
- PRD §12 testing ("contract validation for new kinds/labels" → Task 1; "enrich round-trip (envelope → shards → query)" → Task 5 and the MCP/CLI parity tests in Tasks 6 and 9; "CLI + MCP contract parity for every new action" → Task 6).
- Gap: none identified against PRD §7.2a specifically. The remainder of Phase 2 (embeddings/retrieval in 2b, communities/report in 2c) is explicitly out of this plan's scope per the master plan's task split.

**2. Placeholder scan:** every step above contains complete, concrete code (no `TODO`, no "add appropriate handling," no "similar to Task N" elision) — code that differs between similar tasks (e.g., the three enrich test files) is written out in full each time rather than referenced. The two most complex functions (`enrichGraph`, `mergeEnrichment`) are shown in their entirety, not sketched.

**3. Type consistency check:**
- `EnrichmentShardV1` (Task 1: `{ sourcePath, sourceContentHash, nodes: GraphNodeV1[], edges: GraphEdgeV1[], enrichedAt }`) is used identically in Task 3 (`readEnrichmentShard` return type, `writeGraph`'s 4th parameter), Task 4 (`mergeEnrichment` parameter), and Task 5 (`shard` construction) — same field names throughout.
- `EnrichEnvelopeV1` (Task 2) field names (`schema`, `sourcePath`, `sourceContentHash`, `nodes[].kind|name|path|summary`, `edges[].kind|from|to|confidence`) match exactly what Task 5's `enrichGraph` destructures (`redacted.sourcePath`, `redacted.nodes`, `node.kind`/`node.path`/`node.name`/`node.summary`, `redacted.edges`, `edge.kind`/`edge.from`/`edge.to`/`edge.confidence`).
- `validEdgeConfidence(kind, confidence)` (Task 1) is called with the same argument order in Task 1's own `parseEdge` and in Task 5's `enrichGraph`.
- `GraphIndexPort.allNodes()`/`allEdges()` (Task 3) are used with that exact method name by Task 7's `checkWiki`, both consistent with the interface Task 3 defines. Task 5's own edge-ref resolution deliberately does *not* use them — it targets one node via the existing `index.node(ref)` method instead, since resolving a single reference doesn't need a full-graph sweep.
- `isGraphNodeKind`/`isGraphEdgeKind`/`isGraphConfidence` (Task 1) are imported and called with these exact names in Task 3's revised `graph-index.ts`, replacing that file's own local `isNodeKind`/`isEdgeKind`/`isConfidence` — the single source of truth for the v2 vocabulary now lives in one place.
- The scoped-symbol discriminator `` `${scope}\u0000${startLine.toString()}` `` is identical in three places that must never drift apart: `graph.ts`'s pre-existing `node()` helper, Task 1's `parseNode` replacement in `graph-contracts.ts`, and Task 1's own regression test asserting the two agree.
- `writeGraph(storage, graph, shards, enrichmentShards = [])` (Task 3) keeps the pre-existing 3-argument call sites (in `graph.ts` prior to Task 4, and throughout the existing test suite) valid; Task 4's `buildGraph` and Task 5's `enrichGraph` both call it with all four arguments.
- `checkWiki(location, options = {})` (Task 7) keeps every pre-existing 1-argument call site valid; Task 7's own adapter wiring and Task 9's e2e test both exercise the 2-argument form indirectly (through the CLI's `"check"` operation, which now always supplies the graph when one exists).
- `assembleGraph` (exported in Task 4) signature `(workspaceId: string, generatedAt: string, source: CodeGraphV1["source"], shards: readonly GraphShard[]): CodeGraphV1` is called identically in `graph.ts#buildGraph` (already existing call, now just no longer calling a private function from within the same file — no signature change) and in Task 5's `enrichGraph`.
- `enforceEnvelopeByteLimit(input, maxBytes, label)` (Task 2, generalized from the pre-existing source-envelope-only helper) is called with matching argument order from both `parseSourceEnvelope` (`MAX_ENVELOPE_BYTES`, `"Source envelope"`) and `parseEnrichEnvelope` (`MAX_ENRICH_ENVELOPE_BYTES`, `"Enrich envelope"`).

## Coverage checklist (PRD item → task)

| PRD §7.2a item | Task(s) |
|---|---|
| Node kinds `concept\|page\|source` | 1 |
| Edge kinds `mentions\|describes\|grounds\|related\|member-of` | 1 |
| Confidence model validated per edge kind | 1 |
| `enrich` operation: validate → redact → cap → atomic write | 2, 5 |
| Enrichment shards keyed by `(sourcePath, sourceContentHash)`, no-op on unchanged hash | 3, 5 |
| Stale-detection via existing freshness machinery | 4 |
| `enrich` reachable from CLI `--stdin`/`--envelope-file` | 6 |
| `enrich` reachable from adapter dispatch | 6 |
| `enrich` reachable from MCP `tools/call` | 6 |
| `check`: every wiki page is a `page` node | 7 |
| `check`: every page has ≥1 `describes`/`mentions` edge | 7 |
| `check`: no dangling node references | 7 |
| `init`/`update`/`ingest` skills gain mandatory enrichment step | 8 |
| Full-suite gates + broad non-regression + two review cycles | 9 |

## Open risks and objections (see also the report at `.superpowers/sdd/tp1-report.md`)

- **Objection to the binding contract's "manifest gains schemaVersion: 2" wording**, flagged in design decision 2 above: `GraphManifest.schemaVersion` (the store/index format) already equals `2` today for an unrelated, pre-existing reason (the Stage-B lazy-index refactor), so this plan does not bump it again; the intended "v2" signal is instead carried by `CodeGraphV1.schemaVersion` bumping `1` → `2` inside the manifest's embedded snapshot. If the orchestrator intended a literal second bump of `GRAPH_STORE_SCHEMA_VERSION` to `3`, that is a one-constant change plus a mechanical rename of every `GRAPH_STORE_SCHEMA_VERSION` literal comparison in `graph-store.ts`/`graph-index.ts` tests — flagging rather than guessing, since it is a broader blast radius than this slice otherwise needs.
- **`enrich`'s from/to reference grammar** (design decision 4) is this plan's own invention, not spelled out in the PRD or master plan. It is fully deterministic and tested, but a future slice (2b/2c) that also needs to reference nodes from `search`/`ask` results should reuse the same two-form grammar rather than inventing a third.
- **Performance**: `enrich.ts` avoids rescanning the repository (it reuses the manifest's existing code shards and calls the already-cheap, pure `assembleGraph`), but it does re-run `mergeEnrichment` over *every* currently-known enrichment shard on *every* `enrich` call, and `checkWiki`'s new invariants call `allNodes()`/`allEdges()` (a full bucket sweep). Both are bounded by realistic repository/wiki scale (hundreds of pages, not millions) and are explicitly out of the performance-target scope defined for 2b (`search`/`ask` p95, incremental reindex time); if dogfooding on a large repository in Phase 2's exit criteria surfaces a real latency problem here, it is a 2b/2c follow-up, not a 2a regression.
