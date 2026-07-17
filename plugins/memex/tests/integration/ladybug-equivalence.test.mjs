import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openWasmTier, shutdownLadybugWasm } from "../../dist/ladybug-wasm.js";
import { openGraphCypher } from "../../dist/graph-index.js";

after(async () => { await shutdownLadybugWasm(); });

// Ground-truth fixture graph — the source of truth the Ladybug tier must mirror.
const graph = {
  nodes: [
    { id: "f1", kind: "file", path: "a.ts", name: "a.ts" },
    { id: "s1", kind: "symbol", path: "a.ts", name: "foo", symbolKind: "function", startLine: 1, endLine: 9 },
    { id: "s2", kind: "symbol", path: "a.ts", name: "bar", symbolKind: "function", startLine: 11, endLine: 20 },
    { id: "f2", kind: "file", path: "b.ts", name: "b.ts" },
    { id: "s3", kind: "symbol", path: "b.ts", name: "baz", symbolKind: "function", startLine: 1, endLine: 5 },
  ],
  edges: [
    { id: "e1", kind: "declares", from: "f1", to: "s1", confidence: "exact" },
    { id: "e2", kind: "declares", from: "f1", to: "s2", confidence: "exact" },
    { id: "e3", kind: "calls", from: "s1", to: "s2", confidence: "resolved" },
    { id: "e4", kind: "calls", from: "s1", to: "s3", confidence: "resolved" },
    { id: "e5", kind: "declares", from: "f2", to: "s3", confidence: "exact" },
  ],
};

// Independent reference implementation over the raw arrays.
const refOutbound = (id) => graph.edges.filter((e) => e.from === id).map((e) => e.to).sort();
const refNode = (id) => graph.nodes.find((n) => n.id === id);

test("wasm Cypher mirrors the ground-truth graph (equivalence oracle)", async () => {
  const tier = await openWasmTier(graph);
  try {
    // node count
    const count = await tier.cypher.cypher("MATCH (n:Node) RETURN count(n) AS c");
    assert.equal(Number(count.rows[0].c), graph.nodes.length);

    // edge count
    const ecount = await tier.cypher.cypher("MATCH (:Node)-[e:Edge]->(:Node) RETURN count(e) AS c");
    assert.equal(Number(ecount.rows[0].c), graph.edges.length);

    // outbound neighbours of s1 must match the reference exactly
    const out = await tier.cypher.cypher("MATCH (n:Node {id: $id})-[:Edge]->(m:Node) RETURN m.id AS id", { id: "s1" });
    assert.deepEqual(out.rows.map((r) => String(r.id)).sort(), refOutbound("s1"));

    // node property round-trip
    const node = await tier.cypher.cypher("MATCH (n:Node {id: $id}) RETURN n.name AS name, n.kind AS kind, n.startLine AS sl", { id: "s2" });
    const ref = refNode("s2");
    assert.equal(node.rows[0].name, ref.name);
    assert.equal(node.rows[0].kind, ref.kind);
    assert.equal(Number(node.rows[0].sl), ref.startLine);

    // edge kind filter + confidence preserved
    const calls = await tier.cypher.cypher("MATCH (a:Node)-[e:Edge]->(b:Node) WHERE e.kind = 'calls' RETURN a.id AS from, b.id AS to, e.confidence AS conf");
    assert.equal(calls.rows.length, 2);
    assert.ok(calls.rows.every((r) => r.conf === "resolved"));
  } finally {
    await tier.close();
  }
});

test("read-only guard rejects mutation Cypher through the tier", async () => {
  const tier = await openWasmTier(graph);
  try {
    await assert.rejects(() => tier.cypher.cypher("MATCH (n:Node) DETACH DELETE n"), (err) => {
      assert.equal(err.code, "GRAPH_CYPHER_READONLY");
      return true;
    });
    // graph is intact after the rejected mutation
    const count = await tier.cypher.cypher("MATCH (n:Node) RETURN count(n) AS c");
    assert.equal(Number(count.rows[0].c), graph.nodes.length);
  } finally {
    await tier.close();
  }
});

test("read-only guard blocks the comment/string-confusion bypasses against the real engine", async () => {
  // Exact bypass strings proven to slip past a strip-based guard and execute on
  // the real engine (security review). Each must be rejected here, and the graph
  // must be unchanged afterward.
  const bypasses = [
    "RETURN '/*' AS a ; CREATE (:Node {id:'PWNED'}) ; RETURN '*/' AS b",
    "RETURN '/*' AS a ; COPY (LOAD FROM '/etc/passwd' RETURN column0) TO '/tmp/exfil.csv' ; RETURN '*/' AS b",
    "MATCH (n:Node) WITH '/*' AS c, n CREATE (m:Node {id:'NOSEMI2'}) RETURN '*/' AS z",
    "MATCH (n) RETURN n ; INSTALL httpfs",
    "COMMENT ON TABLE Node IS 'pwned'",   // Kùzu catalog write (cycle-2 confirmed bypass)
    "UNINSTALL httpfs",
    "ANALYZE",
  ];
  const tier = await openWasmTier(graph);
  try {
    for (const attack of bypasses) {
      await assert.rejects(() => tier.cypher.cypher(attack), (err) => {
        assert.equal(err.code, "GRAPH_CYPHER_READONLY", attack);
        return true;
      });
    }
    // No injected node exists and the node count is unchanged.
    const pwned = await tier.cypher.cypher("MATCH (n:Node) WHERE n.id = 'PWNED' OR n.id = 'NOSEMI2' RETURN count(n) AS c");
    assert.equal(Number(pwned.rows[0].c), 0);
    const total = await tier.cypher.cypher("MATCH (n:Node) RETURN count(n) AS c");
    assert.equal(Number(total.rows[0].c), graph.nodes.length);
  } finally {
    await tier.close();
  }
});

test("maxRows bounds an unbounded (cartesian) result via the cursor", async () => {
  const tier = await openWasmTier(graph);
  try {
    // 5 nodes → 5^3 = 125 rows unbounded; the cursor must stop at maxRows.
    const res = await tier.cypher.cypher("MATCH (a:Node),(b:Node),(c:Node) RETURN a.id AS x, b.id AS y, c.id AS z", {}, 10);
    assert.equal(res.rows.length, 10, "rows are capped at maxRows");
    assert.equal(res.truncated, true, "truncation is reported");
  } finally {
    await tier.close();
  }
});

test("degrade: forcing pure yields no Cypher capability, wasm never attempted", async () => {
  let attempted = false;
  const sel = await openGraphCypher({
    preference: "pure",
    tryWasm: async () => { attempted = true; return null; },
  });
  assert.equal(sel.tier, "pure");
  assert.equal(sel.cypher, undefined);
  assert.equal(attempted, false);
  await sel.close();
});

test("auto selects the wasm tier when the factory succeeds", async () => {
  const sel = await openGraphCypher({
    preference: "auto",
    tryNative: async () => null,
    tryWasm: () => openWasmTier(graph),
  });
  try {
    assert.equal(sel.tier, "wasm");
    assert.ok(sel.cypher);
    const res = await sel.cypher.cypher("MATCH (n:Node) RETURN count(n) AS c");
    assert.equal(Number(res.rows[0].c), graph.nodes.length);
  } finally {
    await sel.close();
  }
});
