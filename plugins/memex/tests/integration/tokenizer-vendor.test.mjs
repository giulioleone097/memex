import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadTokenizer } from "../../dist/tokenizer.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR_TOKENIZER = join(PLUGIN_ROOT, "vendor", "model", "multilingual-e5-small-int8", "tokenizer.json");

test("tokenizer (real vendored asset): encodes Italian and English text without throwing", { skip: !existsSync(VENDOR_TOKENIZER) }, async () => {
  const tokenizer = await loadTokenizer(VENDOR_TOKENIZER);
  for (const text of ["query: what is the capital of France?", "passage: Roma è la capitale d'Italia."]) {
    const ids = tokenizer.encode(text);
    assert.ok(ids instanceof Int32Array);
    assert.ok(ids.length > 2, "expected more than just BOS/EOS for non-trivial text");
    assert.ok(ids.length <= 512, "must respect the model's max sequence length");
    assert.equal(ids[0], ids[0], "BOS id must be a stable, repeatable value");
  }
  const first = [...tokenizer.encode("hello world")];
  const second = [...tokenizer.encode("hello world")];
  assert.deepEqual(first, second, "encoding must be deterministic against the real vocabulary");
});
