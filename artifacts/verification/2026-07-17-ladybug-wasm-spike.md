# LadybugDB WASM spike — evidence

Date: 2026-07-17 · Env: Node v25.9.0, darwin arm64 · Package: `@ladybugdb/wasm-core@0.18.2` (MIT)

Purpose: de-risk the load-bearing assumption of the WASM tier (real load + query
+ persistence in Node) before implementing the plan.

## Result: 12/12 checks GREEN

```
[spike] PASS require(nodejs) :: keys=init,getVersion,getStorageVersion,setWorkerPath,close,Database,Connection,PreparedStatement,QueryResult,FS
[spike] PASS init()
[spike] PASS getVersion :: 0.18.2
[spike] PASS Database+Connection(:memory:)
[spike] PASS DDL create tables
[spike] PASS getColumnNames :: ["id","sl"]
[spike] PASS getAllObjects :: [{"id":"a","sl":7}]
[spike] PASS INT64 return type :: typeof startLine = object (value 7)
[spike] PASS prepare+execute scalar param :: [{"kind":"file"}]
[spike] PASS UNWIND $rows list param :: count=3
[spike] PASS edge UNWIND+MATCH insert :: [{"to":"b","kind":"calls"}]
[spike] PASS on-disk persistence :: rows=[{"id":"persisted"}]
[spike] SUMMARY: 12/12 passed
[spike] ALL GREEN
```

## Findings that shaped the implementation

1. **Node.js support confirmed.** `require("@ladybugdb/wasm-core/nodejs")` loads
   in Node 25 / arm64. Exports include `Database`, `Connection`,
   `PreparedStatement`, `QueryResult`, `init`, `getVersion`, `close`, `FS`.
2. **API shape (verified):** `new Database(":memory:" | "<disk path>")`,
   `new Connection(db)`, `await conn.query(cypher)`, `await conn.prepare(cypher)`
   + `await conn.execute(ps, params)`, `res.getAllObjects()`,
   `res.getColumnNames()`, `res.isSuccess()`, `res.getErrorMessage()`,
   `conn.close()`.
3. **Bulk sync works:** `UNWIND $rows AS r CREATE (...)` with a list-of-objects
   param inserted 2 nodes in one call; edge insert via `UNWIND $rows MATCH
   (a),(b) CREATE (a)-[:Edge]->(b)` works.
4. **On-disk persistence works** via a real filesystem path (NODEFS): wrote in
   one `Database`, closed, reopened a new `Database` on the same path, read the
   row back. The WASM tier can persist to `~/.memex/<workspaceId>/graph-db`.
5. **INT64 returns as a boxed `Number`** (`typeof === "object"`,
   `constructor === Number`); `Number(v)` coerces correctly — the `int()` mapper
   in the plan is correct.
6. **Clean exit requires module close.** The module spawns a worker thread that
   keeps the event loop alive; the process only exits after
   `await conn.close(); await lbug.close();` (measured: exits in 0s). The wasm
   backend `close()` must call the module-level `close()` for one-shot CLI runs.
7. **Vendoring footprint is ~13 MB, not ~96 MB.** Only the `nodejs/` variant is
   needed: `nodejs/lbug/lbug_wasm.wasm` = 12.9 MB is the largest file, so no
   chunking is required.
