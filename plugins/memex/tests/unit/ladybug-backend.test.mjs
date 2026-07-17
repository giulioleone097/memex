import { test } from "node:test";
import assert from "node:assert/strict";
import { LadybugCypherEngine, syncGraphToLadybug } from "../../dist/ladybug-backend.js";

function fakeConn(handler) {
  const calls = [];
  return {
    calls,
    async query(cypher, params) {
      calls.push({ cypher, params });
      return handler?.(cypher, params) ?? { columns: [], rows: [], truncated: false };
    },
    async close() { this.closed = true; },
  };
}

test("cypher() runs read-only queries through the connection", async () => {
  const conn = fakeConn(() => ({ columns: ["c"], rows: [{ c: 2 }], truncated: false }));
  const engine = new LadybugCypherEngine(conn);
  const res = await engine.cypher("MATCH (n:Node) RETURN count(n) AS c", { });
  assert.deepEqual(res.rows, [{ c: 2 }]);
  assert.equal(conn.calls.length, 1);
});

test("cypher() rejects mutations before touching the connection", async () => {
  const conn = fakeConn();
  const engine = new LadybugCypherEngine(conn);
  await assert.rejects(() => engine.cypher("MATCH (n) DETACH DELETE n"), (err) => {
    assert.equal(err.code, "GRAPH_CYPHER_READONLY");
    assert.match(err.message, /read-only/i);
    return true;
  });
  assert.equal(conn.calls.length, 0);
});

test("cypher() wraps engine failures as GRAPH_CYPHER_FAILED", async () => {
  const conn = fakeConn(() => { throw new Error("syntax error near FOO"); });
  const engine = new LadybugCypherEngine(conn);
  await assert.rejects(() => engine.cypher("MATCH (n) RETURN n"), (err) => {
    assert.equal(err.code, "GRAPH_CYPHER_FAILED");
    assert.match(err.message, /syntax error near FOO/);
    return true;
  });
});

test("close() delegates to the connection", async () => {
  const conn = fakeConn();
  const engine = new LadybugCypherEngine(conn);
  await engine.close();
  assert.equal(conn.closed, true);
});

test("syncGraphToLadybug runs DDL, then node then edge inserts, batched", async () => {
  const conn = fakeConn();
  const nodes = Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, kind: "file", path: `f${i}.ts`, name: `f${i}` }));
  const edges = [{ id: "e", kind: "references", from: "n0", to: "n1", confidence: "exact" }];
  await syncGraphToLadybug(conn, { nodes, edges }, 2);
  const cyphers = conn.calls.map((c) => c.cypher);
  const text = cyphers.join("\n");
  assert.match(text, /CREATE NODE TABLE/i);
  assert.match(text, /CREATE REL TABLE/i);
  // 2 DDL + 2 node batches (3 nodes, batch 2) + 1 edge batch = 5 calls
  assert.equal(conn.calls.length, 5);
  const nodeCalls = conn.calls.filter((c) => /UNWIND \$rows AS r CREATE \(n:Node/.test(c.cypher));
  assert.equal(nodeCalls.length, 2);
  assert.equal(nodeCalls[0].params.rows.length, 2);
  assert.equal(nodeCalls[1].params.rows.length, 1);
  const edgeCalls = conn.calls.filter((c) => /UNWIND \$rows AS r MATCH \(a:Node/.test(c.cypher));
  assert.equal(edgeCalls.length, 1);
  assert.equal(edgeCalls[0].params.rows[0].from, "n0");
});

test("syncGraphToLadybug skips insert batches when the graph is empty", async () => {
  const conn = fakeConn();
  await syncGraphToLadybug(conn, { nodes: [], edges: [] });
  // only the 2 DDL statements
  assert.equal(conn.calls.length, 2);
});
