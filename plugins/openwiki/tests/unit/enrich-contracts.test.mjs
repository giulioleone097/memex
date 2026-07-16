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
