import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { openVectorStore } from "../../dist/vector-store.js";

const roots = [];
async function temporaryRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `memex-vector-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function chunkRef(id, contentHash) {
  return { id, path: "docs/a.md", startLine: 1, endLine: 5, plane: "wiki", contentHash };
}

function unitVector(seed, dims = 384) {
  const vector = new Float32Array(dims);
  for (let index = 0; index < dims; index += 1) vector[index] = Math.sin(seed + index);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < dims; index += 1) vector[index] /= norm;
  return vector;
}

const MODEL = { modelId: "test-model", modelRevision: "rev-1", dims: 384 };

test("vector store: upserts, deduplicates by contentHash, and ranks search results deterministically", async () => {
  const root = await temporaryRoot("basic");
  const store = await openVectorStore(root, MODEL);
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  const b = chunkRef("b".repeat(64), "2".repeat(64));
  const first = await store.upsert([{ ref: a, vector: unitVector(1) }, { ref: b, vector: unitVector(2) }]);
  assert.deepEqual(first, { written: 2, reused: 0 });
  const second = await store.upsert([{ ref: a, vector: unitVector(1) }]);
  assert.deepEqual(second, { written: 0, reused: 1 });
  const status = await store.status();
  assert.deepEqual(status, { modelId: "test-model", dims: 384, chunks: 2, compatible: true, embeddingsAvailable: true });
  const results = await store.search(unitVector(1), 10);
  assert.equal(results[0].ref.id, a.id);
  assert.ok(results[0].score > (results[1]?.score ?? -Infinity));
});

test("vector store: reindexes a chunk whose contentHash changed and reuses others", async () => {
  const root = await temporaryRoot("update");
  const store = await openVectorStore(root, MODEL);
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  await store.upsert([{ ref: a, vector: unitVector(1) }]);
  const changed = chunkRef("a".repeat(64), "3".repeat(64));
  const result = await store.upsert([{ ref: changed, vector: unitVector(5) }]);
  assert.deepEqual(result, { written: 1, reused: 0 });
  const status = await store.status();
  assert.equal(status.chunks, 1);
  const results = await store.search(unitVector(5), 1);
  assert.equal(results[0].ref.contentHash, "3".repeat(64));
});

test("vector store: reopening reads persisted state back from disk", async () => {
  const root = await temporaryRoot("reopen");
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  await (await openVectorStore(root, MODEL)).upsert([{ ref: a, vector: unitVector(1) }]);
  const reopened = await openVectorStore(root, MODEL);
  assert.equal((await reopened.status()).chunks, 1);
  const results = await reopened.search(unitVector(1), 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].ref.id, a.id);
});

test("vector store: a model mismatch reports INDEX_INCOMPATIBLE on search and upsert", async () => {
  const root = await temporaryRoot("incompatible");
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  await (await openVectorStore(root, MODEL)).upsert([{ ref: a, vector: unitVector(1) }]);
  const mismatched = await openVectorStore(root, { modelId: "other-model", modelRevision: "rev-1", dims: 384 });
  assert.equal((await mismatched.status()).compatible, false);
  await assert.rejects(mismatched.search(unitVector(1), 5), { code: "INDEX_INCOMPATIBLE" });
  await assert.rejects(mismatched.upsert([{ ref: a, vector: unitVector(1) }]), { code: "INDEX_INCOMPATIBLE" });
});

test("vector store: an empty store returns no results and reports zero chunks", async () => {
  const root = await temporaryRoot("empty");
  const store = await openVectorStore(root, MODEL);
  assert.deepEqual(await store.search(unitVector(1), 5), []);
  assert.deepEqual(await store.status(), { modelId: "test-model", dims: 384, chunks: 0, compatible: true, embeddingsAvailable: true });
});

test("vector store: persists a file name and contentHash alongside count for every manifest segment (binding-contract shape)", async () => {
  const root = await temporaryRoot("segment-shape");
  const store = await openVectorStore(root, MODEL);
  await store.upsert([{ ref: chunkRef("a".repeat(64), "1".repeat(64)), vector: unitVector(1) }]);
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.segments.length, 1);
  const [segment] = manifest.segments;
  assert.equal(segment.file, `${segment.bucket}.bin`);
  assert.match(segment.contentHash, /^[a-f0-9]{64}$/u);
  assert.equal(segment.count, 1);
});

test("vector store: markEmbeddingsUnavailable records a non-silent skip reason without touching chunks, and a later successful upsert clears it", async () => {
  const { markEmbeddingsUnavailable } = await import("../../dist/vector-store.js");
  const root = await temporaryRoot("unavailable");
  await markEmbeddingsUnavailable(root, MODEL, "MODEL_ASSET_MISSING");
  const store = await openVectorStore(root, MODEL);
  const status = await store.status();
  assert.equal(status.embeddingsAvailable, false);
  assert.equal(status.unavailableReason, "MODEL_ASSET_MISSING");
  assert.equal(status.chunks, 0);
  const result = await store.upsert([{ ref: chunkRef("a".repeat(64), "1".repeat(64)), vector: unitVector(1) }]);
  assert.deepEqual(result, { written: 1, reused: 0 });
  const after = await store.status();
  assert.equal(after.embeddingsAvailable, true, "a successful upsert must clear the unavailable flag");
  assert.equal(after.unavailableReason, undefined);
});

test("vector store: readVectorChunkDigest exposes id->contentHash without needing a matching model", async () => {
  const { readVectorChunkDigest } = await import("../../dist/vector-store.js");
  const root = await temporaryRoot("digest");
  assert.deepEqual([...(await readVectorChunkDigest(root)).entries()], [], "an unopened store has an empty digest");
  const a = chunkRef("a".repeat(64), "1".repeat(64));
  const b = chunkRef("b".repeat(64), "2".repeat(64));
  await (await openVectorStore(root, MODEL)).upsert([{ ref: a, vector: unitVector(1) }, { ref: b, vector: unitVector(2) }]);
  const digest = await readVectorChunkDigest(root);
  assert.equal(digest.size, 2);
  assert.equal(digest.get(a.id), a.contentHash);
  assert.equal(digest.get(b.id), b.contentHash);
});

test("vector store: upsert carries an untouched bucket's contentHash forward byte-identically and recomputes only the touched bucket's (TP.2 review round 2, N2)", async () => {
  const root = await temporaryRoot("carry-forward");
  const store = await openVectorStore(root, MODEL);
  const one = chunkRef("1".repeat(64), "1".repeat(64)); // bucket "1"
  const alpha = chunkRef("a".repeat(64), "a".repeat(64)); // bucket "a"
  await store.upsert([{ ref: one, vector: unitVector(1) }, { ref: alpha, vector: unitVector(2) }]);
  const { readFile } = await import("node:fs/promises");
  const before = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const bucketOneHashBefore = before.segments.find((segment) => segment.bucket === "1").contentHash;
  const bucketAlphaHashBefore = before.segments.find((segment) => segment.bucket === "a").contentHash;

  // Second upsert touches only the "a" bucket: same chunk id, changed
  // contentHash, still bucket "a" (first hex char unchanged).
  const alphaChanged = chunkRef("a".repeat(64), `a2${"a".repeat(62)}`);
  await store.upsert([{ ref: alphaChanged, vector: unitVector(3) }]);

  const after = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const bucketOneHashAfter = after.segments.find((segment) => segment.bucket === "1").contentHash;
  const bucketAlphaHashAfter = after.segments.find((segment) => segment.bucket === "a").contentHash;
  assert.equal(bucketOneHashAfter, bucketOneHashBefore, "bucket 1 was never touched by the second upsert and must carry its contentHash forward byte-for-byte");
  assert.notEqual(bucketAlphaHashAfter, bucketAlphaHashBefore, "bucket a's encoded bytes changed, so its contentHash must be recomputed, not carried forward");
});
