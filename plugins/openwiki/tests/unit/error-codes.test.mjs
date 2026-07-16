import assert from "node:assert/strict";
import { test } from "node:test";

import { OPENWIKI_ERROR_CODES, OpenWikiError } from "../../dist/errors.js";

test("errors: slice 2b introduces the model asset and retrieval error codes", () => {
  for (const code of ["MODEL_ASSET_MISSING", "MODEL_ASSET_CORRUPT", "EMBEDDING_FAILURE", "INDEX_INCOMPATIBLE"]) {
    assert.equal(OPENWIKI_ERROR_CODES.includes(code), true, `missing code ${code}`);
    const error = new OpenWikiError(code, "test");
    assert.equal(error.code, code);
    assert.deepEqual(error.toJSON(), { code, message: "test" });
  }
});
