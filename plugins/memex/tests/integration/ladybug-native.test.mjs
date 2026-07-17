import { test } from "node:test";
import assert from "node:assert/strict";
import { openLadybugNativeConnection, openNativeTier } from "../../dist/ladybug-native.js";

// Gated: @ladybugdb/core is an optionalDependency. When it (or a prebuilt binary
// for this platform) is absent, these tests skip with a logged reason rather
// than failing — the wasm tier remains the self-sufficient default.

test("native connection runs Cypher when @ladybugdb/core is installed", async (t) => {
  const conn = openLadybugNativeConnection({ databasePath: ":memory:" });
  if (!conn) {
    t.diagnostic("SKIP: @ladybugdb/core not installed / no prebuilt for this platform");
    return;
  }
  try {
    await conn.query("CREATE NODE TABLE T(id STRING PRIMARY KEY, n INT64)");
    await conn.query("CREATE (:T {id: 'a', n: 41})");
    const res = await conn.query("MATCH (t:T) RETURN t.id AS id, t.n + 1 AS m");
    assert.deepEqual(res.columns, ["id", "m"]);
    assert.equal(Number(res.rows[0].m), 42);
  } finally {
    await conn.close();
  }
});

test("openNativeTier syncs a graph and answers Cypher (or skips)", async (t) => {
  const graph = {
    nodes: [
      { id: "n1", kind: "file", path: "a.ts", name: "a.ts" },
      { id: "n2", kind: "symbol", path: "a.ts", name: "foo", symbolKind: "function", startLine: 1, endLine: 4 },
    ],
    edges: [{ id: "e1", kind: "declares", from: "n1", to: "n2", confidence: "exact" }],
  };
  const tier = await openNativeTier(graph);
  if (!tier) {
    t.diagnostic("SKIP: native tier unavailable");
    return;
  }
  try {
    const count = await tier.cypher.cypher("MATCH (n:Node) RETURN count(n) AS c");
    assert.equal(Number(count.rows[0].c), 2);
    const out = await tier.cypher.cypher("MATCH (n:Node {id: $id})-[:Edge]->(m:Node) RETURN m.id AS id", { id: "n1" });
    assert.deepEqual(out.rows.map((r) => String(r.id)), ["n2"]);
    // read-only guard still applies on the native tier
    await assert.rejects(() => tier.cypher.cypher("MATCH (n) DETACH DELETE n"), (err) => err.code === "GRAPH_CYPHER_READONLY");
  } finally {
    await tier.close();
  }
});
