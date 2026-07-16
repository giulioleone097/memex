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
import { MemexError } from "../../dist/errors.js";

function baseGraph(overrides = {}) {
  return {
    schemaVersion: GRAPH_CONTRACTS_SCHEMA_VERSION,
    workspaceId: "workspace",
    generatedAt: "2026-07-11T00:00:00.000Z",
    source: { dirtyFingerprint: "b".repeat(64), scannerVersion: "memex-graph-v1" },
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
    assert.throws(() => parseCodeGraph({ ...baseGraph(), schemaVersion: 3 }), MemexError);
    assert.throws(() => parseCodeGraph({ ...baseGraph(), schemaVersion: 1 }), MemexError);
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
    })), MemexError);
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
    assert.throws(() => parseEnrichmentShard({ ...shard, sourceContentHash: "not-a-hash" }), MemexError);
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
    const discriminator = ["Service", String(3)].join(String.fromCharCode(0));
    const methodId = createGraphNodeId("symbol", "src/service.ts", "run", "function", discriminator);
    const parsed = parseCodeGraph(baseGraph({
      nodes: [
        { id: repositoryId, kind: "repository", path: ".", name: "workspace" },
        { id: methodId, kind: "symbol", path: "src/service.ts", name: "run", scope: "Service", symbolKind: "function", startLine: 3, endLine: 4 },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    }));
    assert.ok(parsed.nodes.some((node) => node.id === methodId));
  });
});
