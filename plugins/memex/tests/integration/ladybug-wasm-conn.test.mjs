import { test, after } from "node:test";
import assert from "node:assert/strict";
import { openLadybugWasmConnection, shutdownLadybugWasm } from "../../dist/ladybug-wasm.js";

// The Ladybug wasm module spawns a worker thread that keeps the process alive;
// shut it down once, after all tests, so the test process exits cleanly.
after(async () => { await shutdownLadybugWasm(); });

test("opens a real wasm connection from vendored assets and runs Cypher", async () => {
  const conn = await openLadybugWasmConnection({ databasePath: ":memory:" });
  await conn.query("CREATE NODE TABLE T(id STRING PRIMARY KEY, n INT64)");
  await conn.query("CREATE (:T {id: 'a', n: 41})");
  const res = await conn.query("MATCH (t:T) RETURN t.id AS id, t.n + 1 AS m");
  assert.deepEqual(res.columns, ["id", "m"]);
  assert.equal(res.rows[0].id, "a");
  assert.equal(Number(res.rows[0].m), 42);
  await conn.close();
});

test("parameterized queries via $params work", async () => {
  const conn = await openLadybugWasmConnection({ databasePath: ":memory:" });
  await conn.query("CREATE NODE TABLE P(id STRING PRIMARY KEY, k STRING)");
  await conn.query("UNWIND $rows AS r CREATE (:P {id: r.id, k: r.k})", { rows: [{ id: "x", k: "file" }, { id: "y", k: "symbol" }] });
  const res = await conn.query("MATCH (p:P {id: $id}) RETURN p.k AS k", { id: "y" });
  assert.equal(res.rows[0].k, "symbol");
  await conn.close();
});

test("a failing query surfaces the engine error message", async () => {
  const conn = await openLadybugWasmConnection({ databasePath: ":memory:" });
  await assert.rejects(() => conn.query("MATCH (n:DoesNotExist) RETURN n"), /DoesNotExist|does not exist|Table|Binder/i);
  await conn.close();
});
