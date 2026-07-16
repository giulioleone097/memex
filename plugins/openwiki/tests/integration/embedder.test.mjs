import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { defaultVendorRoot, loadEmbedder } from "../../dist/embedder.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL_DIR = join(PLUGIN_ROOT, "vendor", "model", "multilingual-e5-small-int8");
// The real vendored model ships chunked (model.onnx.part0/.part1, per PRD §16
// amendment 2 — GitHub's 100MB per-file push limit) and the flat, unsplit
// "model.onnx" logical path never exists on disk (see embedder.ts's
// loadModelBuffer, which assembles parts in memory and never writes them
// back). Detect either shape so this test actually runs once real assets
// exist, instead of perpetually skipping against a shape that no longer ships.
const MODEL_PRESENT = existsSync(join(MODEL_DIR, "model.onnx")) || existsSync(join(MODEL_DIR, "model.onnx.part0"));

function cosine(a, b) {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot;
}

test("embedder (real vendored asset): produces unit-normalized 384-dim vectors with correct semantic ordering", { skip: !MODEL_PRESENT }, async () => {
  const embedder = await loadEmbedder(defaultVendorRoot());
  assert.equal(embedder.modelId, "multilingual-e5-small-int8");
  assert.equal(embedder.dims, 384);
  const query = await embedder.embedQuery("What is the capital of France?");
  assert.equal(query.length, 384);
  const norm = Math.sqrt([...query].reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `query embedding must be L2-normalized, got norm ${String(norm)}`);
  const [relevant, unrelated] = await embedder.embedPassages(["Paris is the capital of France.", "Bananas are a good source of potassium."]);
  assert.ok(cosine(query, relevant) > cosine(query, unrelated), "the relevant passage must score higher than an unrelated one");
});

test("embedder (real vendored asset): is deterministic across calls", { skip: !MODEL_PRESENT }, async () => {
  const embedder = await loadEmbedder(defaultVendorRoot());
  const first = await embedder.embedQuery("hello world");
  const second = await embedder.embedQuery("hello world");
  assert.deepEqual([...first], [...second]);
});
