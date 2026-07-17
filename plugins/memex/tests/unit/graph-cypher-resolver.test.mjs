import { test } from "node:test";
import assert from "node:assert/strict";
import { openGraphCypher, resolveBackendPreference } from "../../dist/graph-index.js";

const cypherStub = () => Promise.resolve({
  cypher: { async cypher() { return { columns: [], rows: [], truncated: false }; } },
  close: async () => {},
});

test("resolveBackendPreference defaults to auto and validates the env", () => {
  assert.equal(resolveBackendPreference({}), "auto");
  assert.equal(resolveBackendPreference({ MEMEX_GRAPH_BACKEND: "pure" }), "pure");
  assert.equal(resolveBackendPreference({ MEMEX_GRAPH_BACKEND: "WASM" }), "wasm");
  assert.equal(resolveBackendPreference({ MEMEX_GRAPH_BACKEND: "native" }), "native");
  assert.equal(resolveBackendPreference({ MEMEX_GRAPH_BACKEND: "bogus" }), "auto");
});

test("auto falls through native -> wasm -> pure when none available", async () => {
  const sel = await openGraphCypher({ preference: "auto", tryNative: async () => null, tryWasm: async () => null });
  assert.equal(sel.tier, "pure");
  assert.equal(sel.cypher, undefined);
  assert.match(sel.reason, /unavailable|not wired|fell back/i);
  await sel.close();
});

test("auto selects wasm when native null but wasm present", async () => {
  const sel = await openGraphCypher({ preference: "auto", tryNative: async () => null, tryWasm: cypherStub });
  assert.equal(sel.tier, "wasm");
  assert.ok(sel.cypher);
  await sel.close();
});

test("auto prefers native over wasm when both present", async () => {
  let wasmTried = false;
  const sel = await openGraphCypher({ preference: "auto", tryNative: cypherStub, tryWasm: async () => { wasmTried = true; return null; } });
  assert.equal(sel.tier, "native");
  assert.equal(wasmTried, false);
  await sel.close();
});

test("explicit pure never attempts a Ladybug tier", async () => {
  let attempted = false;
  const sel = await openGraphCypher({ preference: "pure", tryNative: async () => { attempted = true; return null; }, tryWasm: async () => { attempted = true; return null; } });
  assert.equal(sel.tier, "pure");
  assert.equal(sel.cypher, undefined);
  assert.equal(attempted, false);
  await sel.close();
});

test("explicit wasm that fails degrades to pure with a reason", async () => {
  const sel = await openGraphCypher({ preference: "wasm", tryWasm: async () => { throw new Error("boom"); } });
  assert.equal(sel.tier, "pure");
  assert.match(sel.reason, /boom/);
  await sel.close();
});
