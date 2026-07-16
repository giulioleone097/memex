import assert from "node:assert/strict";
import { test } from "node:test";

import { createGraphNodeId } from "../../dist/graph-contracts.js";
import { chunkMarkdown, chunkSymbols, estimateTokens, parseChunkRef } from "../../dist/chunk.js";

test("chunk: chunkMarkdown splits at heading boundaries and keeps line ranges accurate", () => {
  // Each section's body is long enough (repeated filler) to cross the
  // MAX_CHUNK_TOKENS budget on its own, so the 200-400-estimated-token
  // chunker (chunk.ts's documented design, not a naive "always split at
  // heading" rule) actually flushes more than once for this fixture.
  const filler = "Lorem word repetition testing token estimate boundaries carefully. ".repeat(35).trim();
  const text = [
    "# Title",
    "",
    "Intro paragraph one.",
    "",
    "## Section A",
    "",
    filler,
    "",
    "## Section B",
    "",
    filler,
  ].join("\n");
  const chunks = chunkMarkdown("docs/page.md", text);
  assert.ok(chunks.length >= 2, "expected at least one chunk per heading-delimited section");
  for (const chunk of chunks) {
    assert.equal(chunk.path, "docs/page.md");
    assert.equal(chunk.plane, "wiki");
    assert.equal(chunk.nodeId, undefined);
    assert.equal(typeof chunk.startLine, "number");
    assert.equal(typeof chunk.endLine, "number");
    assert.ok(chunk.endLine >= chunk.startLine);
    assert.match(chunk.contentHash, /^[a-f0-9]{64}$/u);
    assert.match(chunk.id, /^[a-f0-9]{64}$/u);
    const sliced = text.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n");
    assert.ok(sliced.length > 0);
  }
  const ids = chunks.map((chunk) => chunk.id);
  assert.equal(new Set(ids).size, ids.length, "chunk ids must be unique within a page");
});

test("chunk: chunkMarkdown is deterministic and targets 200-400 estimated tokens", () => {
  const paragraph = "Lorem word repetition testing token estimate boundaries carefully. ".repeat(40);
  const text = `# Heading\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n`;
  const first = chunkMarkdown("docs/big.md", text);
  const second = chunkMarkdown("docs/big.md", text);
  assert.deepEqual(first, second);
  for (const chunk of first.slice(0, -1)) {
    const chunkText = text.split("\n").slice(chunk.startLine - 1, chunk.endLine).join("\n");
    assert.ok(estimateTokens(chunkText) <= 500, `chunk exceeded the target band: ${String(estimateTokens(chunkText))}`);
  }
});

test("chunk: chunkSymbols embeds signature+name+path metadata only, never a source body", () => {
  const id = createGraphNodeId("symbol", "src/service.ts", "run", "method", `Service${String.fromCharCode(0)}${String(10)}`);
  const nodes = [
    { id, kind: "symbol", path: "src/service.ts", name: "run", scope: "Service", symbolKind: "method", startLine: 10, endLine: 42 },
    { id: createGraphNodeId("file", "src/service.ts", "service.ts"), kind: "file", path: "src/service.ts", name: "service.ts" },
  ];
  const chunks = chunkSymbols(nodes);
  assert.equal(chunks.length, 1, "only symbol-kind nodes produce chunks");
  const [chunk] = chunks;
  assert.equal(chunk.plane, "code");
  assert.equal(chunk.nodeId, id);
  assert.equal(chunk.path, "src/service.ts");
  assert.equal(chunk.startLine, 10);
  assert.equal(chunk.endLine, 42);
  assert.doesNotThrow(() => parseChunkRef(chunk));
});

test("chunk: symbolChunkText regenerates the exact text chunkSymbols hashed", async () => {
  const { symbolChunkText } = await import("../../dist/chunk.js");
  const node = { id: createGraphNodeId("symbol", "src/service.ts", "run", "method", "Service 10"), kind: "symbol", path: "src/service.ts", name: "run", scope: "Service", symbolKind: "method", startLine: 10, endLine: 42 };
  const [chunk] = chunkSymbols([node]);
  const { createHash } = await import("node:crypto");
  const expectedContentHash = createHash("sha256").update(symbolChunkText(node), "utf8").digest("hex");
  assert.equal(chunk.contentHash, expectedContentHash);
});

test("chunk: parseChunkRef rejects malformed references", () => {
  assert.throws(() => parseChunkRef({ id: "not-hex", path: "a", startLine: 1, endLine: 1, plane: "wiki", contentHash: "b".repeat(64) }), { code: "INVALID_STATE" });
  assert.throws(() => parseChunkRef({ id: "a".repeat(64), path: "a", startLine: 2, endLine: 1, plane: "wiki", contentHash: "b".repeat(64) }), { code: "INVALID_STATE" });
  assert.throws(() => parseChunkRef({ id: "a".repeat(64), path: "a", startLine: 1, endLine: 1, plane: "unknown", contentHash: "b".repeat(64) }), { code: "INVALID_STATE" });
});
