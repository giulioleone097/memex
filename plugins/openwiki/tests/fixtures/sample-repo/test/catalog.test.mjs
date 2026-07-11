import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  findProductBySku,
  listActiveProducts,
  summarizeCatalog,
} from "../src/catalog.mjs";

describe("catalog", () => {
  test("lists only active products without exposing mutable storage", () => {
    const first = listActiveProducts();
    assert.deepEqual(
      first.map(({ sku }) => sku),
      ["CAM-100", "TRI-200"],
    );

    first[0].name = "Changed by caller";
    assert.equal(findProductBySku("cam-100")?.name, "Northstar Field Camera");
  });

  test("normalizes SKU lookup and summarizes active inventory", () => {
    assert.equal(findProductBySku(" tri-200 ")?.category, "mounts");
    assert.deepEqual(summarizeCatalog(), {
      activeCount: 2,
      inventoryValueCents: 33800,
    });
  });
});
