import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadTokenizer } from "../../dist/tokenizer.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tokenizer", "mini-unigram.tokenizer.json");

test("tokenizer: golden vectors for whole-piece matches", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  assert.deepEqual([...tokenizer.encode("hello world")], [1, 4, 5, 2]);
  assert.deepEqual([...tokenizer.encode("ciao mondo")], [1, 6, 7, 2]);
});

test("tokenizer: falls back to per-character UNK for out-of-vocabulary text", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  // The fixture's leading "▁" (added-prefix-space marker) is itself a scored
  // vocab piece (id 8, score -6.0) — strictly better than paying the UNK
  // penalty (-19.0) for it too — so the correct Viterbi segmentation of
  // "▁xyz" is [▁, UNK(x), UNK(y), UNK(z)], not four bare UNKs.
  assert.deepEqual([...tokenizer.encode("xyz")], [1, 8, 0, 0, 0, 2]);
});

test("tokenizer: is deterministic and always wraps with BOS/EOS", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  const first = [...tokenizer.encode("hello world")];
  const second = [...tokenizer.encode("hello world")];
  assert.deepEqual(first, second);
  assert.equal(first[0], 1);
  assert.equal(first.at(-1), 2);
});

test("tokenizer: truncates to the configured max_length, keeping BOS and EOS", async () => {
  const tokenizer = await loadTokenizer(FIXTURE);
  const long = Array.from({ length: 20 }, () => "hello world").join(" ");
  const ids = [...tokenizer.encode(long)];
  assert.equal(ids.length, 16);
  assert.equal(ids[0], 1);
  assert.equal(ids.at(-1), 2);
});

test("tokenizer: MODEL_ASSET_MISSING when the path does not exist", async () => {
  await assert.rejects(loadTokenizer(join(FIXTURE, "..", "does-not-exist.json")), { code: "MODEL_ASSET_MISSING" });
});

test("tokenizer: MODEL_ASSET_CORRUPT on malformed JSON or wrong model type", async (t) => {
  const badJson = join(t.name.replace(/[^a-z0-9]/giu, "-"), "bad.json");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-tokenizer-bad-"));
  const notJson = path.join(root, "not-json.json");
  await writeFile(notJson, "{ not valid", "utf8");
  await assert.rejects(loadTokenizer(notJson), { code: "MODEL_ASSET_CORRUPT" });
  const wrongType = path.join(root, "wrong-type.json");
  await writeFile(wrongType, JSON.stringify({ model: { type: "BPE", vocab: [] } }), "utf8");
  await assert.rejects(loadTokenizer(wrongType), { code: "MODEL_ASSET_CORRUPT" });
  void mkdir; void badJson;
});
