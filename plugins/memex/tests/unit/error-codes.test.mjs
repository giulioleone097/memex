import assert from "node:assert/strict";
import { test } from "node:test";

import { MEMEX_ERROR_CODES, MemexError } from "../../dist/errors.js";

test("errors: slice 2b introduces the model asset and retrieval error codes", () => {
  for (const code of ["MODEL_ASSET_MISSING", "MODEL_ASSET_CORRUPT", "EMBEDDING_FAILURE", "INDEX_INCOMPATIBLE"]) {
    assert.equal(MEMEX_ERROR_CODES.includes(code), true, `missing code ${code}`);
    const error = new MemexError(code, "test");
    assert.equal(error.code, code);
    assert.deepEqual(error.toJSON(), { code, message: "test" });
  }
});
