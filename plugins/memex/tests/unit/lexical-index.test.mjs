import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { openLexicalIndex } from "../../dist/lexical-index.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-lexical-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function chunkRef(id, contentHash, path_ = "docs/a.md") {
  return { id, path: path_, startLine: 1, endLine: 3, plane: "wiki", contentHash };
}

test("lexical index: BM25 ranks a chunk with more query-term occurrences higher", async () => {
  const root = await temporaryRoot("bm25");
  const index = await openLexicalIndex(root);
  const strong = chunkRef("a".repeat(64), "1".repeat(64));
  const weak = chunkRef("b".repeat(64), "2".repeat(64));
  const unrelated = chunkRef("c".repeat(64), "3".repeat(64));
  await index.upsert([
    { ref: strong, text: "graph retrieval graph retrieval hybrid graph search retrieval fusion" },
    { ref: weak, text: "graph theory basics for newcomers to computer science" },
    { ref: unrelated, text: "the quick brown fox jumps over the lazy dog" },
  ]);
  const results = await index.search("graph retrieval", 10);
  assert.equal(results[0].ref.id, strong.id);
  assert.equal(results[1].ref.id, weak.id);
  assert.ok(!results.some((entry) => entry.ref.id === unrelated.id) || results.at(-1).ref.id === unrelated.id);
});

test("lexical index: reindexing a changed chunk updates aggregate statistics correctly", async () => {
  const root = await temporaryRoot("update");
  const index = await openLexicalIndex(root);
  const chunk = chunkRef("a".repeat(64), "1".repeat(64));
  await index.upsert([{ ref: chunk, text: "alpha beta gamma" }]);
  const changed = chunkRef("a".repeat(64), "2".repeat(64));
  await index.upsert([{ ref: changed, text: "delta epsilon zeta" }]);
  assert.deepEqual(await index.search("alpha", 10), []);
  const results = await index.search("delta", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref.contentHash, "2".repeat(64));
});

test("lexical index: unchanged content is a no-op on re-upsert", async () => {
  const root = await temporaryRoot("noop");
  const index = await openLexicalIndex(root);
  const chunk = chunkRef("a".repeat(64), "1".repeat(64));
  await index.upsert([{ ref: chunk, text: "stable content here" }]);
  await index.upsert([{ ref: chunk, text: "stable content here" }]);
  const results = await index.search("stable", 10);
  assert.equal(results.length, 1);
});

test("lexical index: trigram fallback surfaces a near-match term BM25 alone would miss", async () => {
  const root = await temporaryRoot("trigram");
  const index = await openLexicalIndex(root);
  const target = chunkRef("a".repeat(64), "1".repeat(64));
  await index.upsert([{ ref: target, text: "retrieval augmented generation pipeline" }]);
  const results = await index.search("retrievals", 10);
  assert.equal(results.length, 1, "a near-miss token should still surface via trigram overlap");
  assert.equal(results[0].ref.id, target.id);
});

test("lexical index: reopening reads persisted state back from disk", async () => {
  const root = await temporaryRoot("reopen");
  const chunk = chunkRef("a".repeat(64), "1".repeat(64));
  await (await openLexicalIndex(root)).upsert([{ ref: chunk, text: "persisted searchable text" }]);
  const results = await (await openLexicalIndex(root)).search("persisted", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref.id, chunk.id);
});

test("lexical index: rejects an empty query and an out-of-range limit", async () => {
  const root = await temporaryRoot("validate");
  const index = await openLexicalIndex(root);
  await assert.rejects(index.search("   ", 10), { code: "INVALID_ARGUMENT" });
  await assert.rejects(index.search("term", 0), { code: "INVALID_ARGUMENT" });
});
