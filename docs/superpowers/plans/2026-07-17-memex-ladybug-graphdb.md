# LadybugDB Graph Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real in-process property-graph database (LadybugDB) with a Cypher query surface behind the existing `GraphIndexPort`, keeping the pure-TS graph as a guaranteed fallback and the content-addressed shards as the source of truth.

**Architecture:** Three tiers resolved by `openGraphBackend()` — `native` (`@ladybugdb/core` prebuilt, opt-in), `wasm` (vendored `@ladybugdb/wasm-core` nodejs variant, self-sufficient), `pure` (existing pure-TS, fallback). A thin `LadybugConnection` interface adapts each Ladybug API to a uniform surface; `LadybugGraphBackend` implements `GraphIndexPort & CypherCapable` by issuing Cypher through that connection. The DB is derived from shards and rebuilt on staleness.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥20, `@ladybugdb/wasm-core@0.18.2` (MIT, vendored), `@ladybugdb/core@0.18.2` (MIT, optionalDependency), node:test + tsx, existing vendor chunk/assemble machinery in `plugins/memex/src/embedder.ts`.

## Global Constraints

- Node ≥ 20; ESM with NodeNext resolution; no `any`, no unsafe casts, strict TS.
- Self-sufficiency: no network at runtime; WASM assets vendored in-repo; native is opt-in only and its absence must never break install or runtime.
- Source of truth = content-addressed shards. The Ladybug DB is derived and rebuildable; deleting it must be safe.
- Soft-degrade downward only: a higher tier that fails to load/sync falls through to the next; graph reads/writes never block.
- Pure-TS path and all existing `GraphIndexPort` consumers stay behaviourally unchanged; all pre-existing tests (308 at HEAD `b3ba58a`) stay green.
- Vendored files committed as chunks < 95 MB each (GitHub 100 MB hard limit); Git LFS is NOT used.
- Package pins: `@ladybugdb/wasm-core` and `@ladybugdb/core` at exactly `0.18.2`.
- Ladybug WASM nodejs API (verified 2026-07-17): `require("@ladybugdb/wasm-core/nodejs")` → `{ Database, Connection, init, getVersion }`; `new Database(path?)` (`":memory:"`/`""` = in-memory, disk path = persistent via NODEFS); `new Connection(db)`; `await conn.query(cypher): Promise<QueryResult>`; `await conn.prepare(cypher)` + `await conn.execute(ps, params)`; `QueryResult.getAllObjects(): Promise<Record<string,unknown>[]>`, `.getColumnNames(): Promise<string[]>`, `.getNumTuples()`, `.isSuccess()`, `.getErrorMessage()`, `.close?`; `await conn.close()`.
- Reuse before new code: MANIFEST/part-assembly logic lives in `embedder.ts` (`loadVendorManifest`, `verifyVendorEntry`, `VendorManifestEntry`, `VendorManifestPart`); extend, do not duplicate.
- The GitNexus staleness hook is advisory — never run `npx gitnexus analyze`.

---

## File Structure

- `plugins/memex/src/graph-index.ts` (modify) — add Cypher capability types + `openGraphBackend` resolver + `GraphBackendSelection`. Pure-TS `GraphIndexPort` unchanged.
- `plugins/memex/src/ladybug-cypher.ts` (create) — pure, WASM-free Cypher/DDL/sync builders + row mappers + read-only guard.
- `plugins/memex/src/ladybug-backend.ts` (create) — `LadybugConnection` interface + `LadybugGraphBackend` + `syncGraphToLadybug`.
- `plugins/memex/src/ladybug-wasm.ts` (create) — assemble vendored nodejs WASM assets → `LadybugConnection`.
- `plugins/memex/src/ladybug-native.ts` (create) — resolve optional `@ladybugdb/core` → `LadybugConnection`.
- `plugins/memex/src/vendor-assets.ts` (create) — shared asset-assembly helper extracted from `embedder.ts` (assemble split parts into a verified runtime directory).
- `plugins/memex/vendor/ladybug-wasm/` (create) — vendored nodejs-variant assets (chunked) + entries in `plugins/memex/vendor/MANIFEST.json`.
- `plugins/memex/src/cli.ts`, `plugins/memex/src/mcp.ts`, `plugins/memex/src/doctor.ts` (modify) — Cypher CLI command, MCP tool, tier reporting.
- `plugins/memex/package.json` (modify) — `optionalDependencies` + `devDependencies`.
- Tests under `plugins/memex/tests/unit|integration|e2e`.

Build note: after every code change run the project build so `dist/` stays in sync (`dist/` is tracked). Use `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json` (the `rtk` wrapper hangs). Lint with `node node_modules/eslint/bin/eslint.js plugins/memex/src`.

---

### Task 1: Cypher capability types + `openGraphBackend` resolver (pure tier only)

**Files:**
- Modify: `plugins/memex/src/graph-index.ts` (add types + resolver near `openGraphIndexGeneration`)
- Test: `plugins/memex/tests/unit/graph-backend-resolver.test.mjs` (create)

**Interfaces:**
- Consumes: existing `openGraphIndexGeneration(...)` (inspect its exact signature in the file) which returns a `GraphIndexPort`; `GraphNodeKind`, `GraphNodeV1`, `GraphEdgeV1`.
- Produces:
  ```ts
  export type CypherParam = string | number | boolean | null;
  export interface CypherResult { columns: string[]; rows: ReadonlyArray<Record<string, unknown>>; truncated: boolean; }
  export interface CypherCapable { cypher(query: string, params?: Record<string, CypherParam>): Promise<CypherResult>; }
  export type GraphBackendTier = "native" | "wasm" | "pure";
  export interface GraphBackendSelection { tier: GraphBackendTier; reason: string; port: GraphIndexPort; cypher?: CypherCapable; close(): Promise<void>; }
  export interface OpenGraphBackendOptions {
    openPure: () => Promise<GraphIndexPort>;                 // caller supplies the existing pure factory, pre-bound
    preference?: GraphBackendTier | "auto";                 // default from env
    tryNative?: () => Promise<{ port: GraphIndexPort; cypher: CypherCapable; close(): Promise<void> } | null>;
    tryWasm?: () => Promise<{ port: GraphIndexPort; cypher: CypherCapable; close(): Promise<void> } | null>;
  }
  export function resolveBackendPreference(env?: NodeJS.ProcessEnv): GraphBackendTier | "auto"; // reads MEMEX_GRAPH_BACKEND
  export async function openGraphBackend(opts: OpenGraphBackendOptions): Promise<GraphBackendSelection>;
  ```
  Selection: if preference is a concrete tier, attempt only that (falling back to pure with a reason if it yields null); if `auto`, try native → wasm → pure in order. `tryNative`/`tryWasm` are injected (dependency inversion) so this function is unit-testable without the real backends and the real backends are wired by the caller in Task 6/7.

- [ ] **Step 1: Write the failing test**

```js
// plugins/memex/tests/unit/graph-backend-resolver.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { openGraphBackend, resolveBackendPreference } from "../../dist/graph-index.js";

const fakePort = { async node(){return undefined;}, async inbound(){return {edges:[],nodes:[]};}, async outbound(){return {edges:[],nodes:[]};}, async allNodes(){return [];}, async allEdges(){return [];} };
const ladybugStub = () => Promise.resolve({ port: fakePort, cypher: { async cypher(){ return { columns:[], rows:[], truncated:false }; } }, close: async () => {} });

test("resolveBackendPreference defaults to auto", () => {
  assert.equal(resolveBackendPreference({}), "auto");
  assert.equal(resolveBackendPreference({ MEMEX_GRAPH_BACKEND: "pure" }), "pure");
  assert.equal(resolveBackendPreference({ MEMEX_GRAPH_BACKEND: "bogus" }), "auto");
});

test("auto falls through native -> wasm -> pure", async () => {
  const sel = await openGraphBackend({ preference: "auto", openPure: async () => fakePort, tryNative: async () => null, tryWasm: async () => null });
  assert.equal(sel.tier, "pure");
  assert.equal(sel.cypher, undefined);
  assert.match(sel.reason, /native.*unavailable|wasm.*unavailable|fell back/i);
});

test("auto selects wasm when native null but wasm present", async () => {
  const sel = await openGraphBackend({ preference: "auto", openPure: async () => fakePort, tryNative: async () => null, tryWasm: ladybugStub });
  assert.equal(sel.tier, "wasm");
  assert.ok(sel.cypher);
});

test("explicit pure never attempts ladybug", async () => {
  let attempted = false;
  const sel = await openGraphBackend({ preference: "pure", openPure: async () => fakePort, tryNative: async () => { attempted = true; return null; }, tryWasm: async () => { attempted = true; return null; } });
  assert.equal(sel.tier, "pure");
  assert.equal(attempted, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/memex && node --test tests/unit/graph-backend-resolver.test.mjs`
Expected: FAIL — `openGraphBackend is not a function` / import error.

- [ ] **Step 3: Implement types + resolver in `graph-index.ts`**

Add the types from the Interfaces block. Implement:

```ts
export function resolveBackendPreference(env: NodeJS.ProcessEnv = process.env): GraphBackendTier | "auto" {
  const raw = (env.MEMEX_GRAPH_BACKEND ?? "").trim().toLowerCase();
  return raw === "native" || raw === "wasm" || raw === "pure" ? raw : "auto";
}

export async function openGraphBackend(opts: OpenGraphBackendOptions): Promise<GraphBackendSelection> {
  const preference = opts.preference ?? resolveBackendPreference();
  const reasons: string[] = [];
  const attempt = async (
    tier: "native" | "wasm",
    fn?: () => Promise<{ port: GraphIndexPort; cypher: CypherCapable; close(): Promise<void> } | null>,
  ): Promise<GraphBackendSelection | null> => {
    if (!fn) { reasons.push(`${tier}: not wired`); return null; }
    try {
      const r = await fn();
      if (!r) { reasons.push(`${tier}: unavailable`); return null; }
      return { tier, reason: `${tier} backend active`, port: r.port, cypher: r.cypher, close: r.close };
    } catch (err) {
      reasons.push(`${tier}: ${(err as Error).message}`);
      return null;
    }
  };
  const openPureSel = async (): Promise<GraphBackendSelection> => {
    const port = await opts.openPure();
    const reason = reasons.length ? `pure (fell back — ${reasons.join("; ")})` : "pure backend active";
    return { tier: "pure", reason, port, close: async () => {} };
  };
  if (preference === "pure") return openPureSel();
  if (preference === "native") return (await attempt("native", opts.tryNative)) ?? openPureSel();
  if (preference === "wasm") return (await attempt("wasm", opts.tryWasm)) ?? openPureSel();
  return (await attempt("native", opts.tryNative)) ?? (await attempt("wasm", opts.tryWasm)) ?? openPureSel();
}
```

- [ ] **Step 4: Build and run test to verify it passes**

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/unit/graph-backend-resolver.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/memex/src/graph-index.ts plugins/memex/dist/graph-index.js plugins/memex/dist/graph-index.d.ts plugins/memex/tests/unit/graph-backend-resolver.test.mjs
git commit -m "feat(memex): add graph backend resolver and Cypher capability types"
```

---

### Task 2: Pure Cypher/DDL/sync builders (`ladybug-cypher.ts`)

**Files:**
- Create: `plugins/memex/src/ladybug-cypher.ts`
- Test: `plugins/memex/tests/unit/ladybug-cypher.test.mjs`

**Interfaces:**
- Consumes: `GraphNodeV1`, `GraphEdgeV1`, `GraphNodeKind`, `GraphEdgeKind`, `CypherParam`, `CypherResult` from graph-contracts/graph-index.
- Produces:
  ```ts
  export const LADYBUG_SCHEMA_DDL: readonly string[];
  export const NODE_BY_ID_CYPHER: string;              // uses $id
  export function adjacencyCypher(direction: "inbound" | "outbound"): string;   // uses $id, $limit
  export function allNodesCypher(withKind: boolean): string;                    // uses $kind when withKind
  export const ALL_EDGES_CYPHER: string;
  export function nodeInsertCypher(): string;          // UNWIND $rows batch CREATE Node
  export function edgeInsertCypher(): string;          // UNWIND $rows batch MATCH+CREATE Edge
  export function nodeRowsParam(nodes: readonly GraphNodeV1[]): { rows: Record<string, CypherParam>[] };
  export function edgeRowsParam(edges: readonly GraphEdgeV1[]): { rows: Record<string, CypherParam>[] };
  export function rowToNode(row: Record<string, unknown>): GraphNodeV1;
  export function rowToEdge(row: Record<string, unknown>): GraphEdgeV1;
  export function isReadOnlyCypher(query: string): boolean;
  ```

- [ ] **Step 1: Write the failing test**

```js
// plugins/memex/tests/unit/ladybug-cypher.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { LADYBUG_SCHEMA_DDL, NODE_BY_ID_CYPHER, adjacencyCypher, allNodesCypher, ALL_EDGES_CYPHER, isReadOnlyCypher, rowToNode, nodeRowsParam } from "../../dist/ladybug-cypher.js";

test("schema declares Node and Edge tables", () => {
  const joined = LADYBUG_SCHEMA_DDL.join("\n");
  assert.match(joined, /CREATE NODE TABLE\s+Node/i);
  assert.match(joined, /CREATE REL TABLE\s+Edge/i);
  assert.match(joined, /id\s+STRING PRIMARY KEY/i);
});

test("adjacency cypher direction differs and is parameterized", () => {
  assert.match(adjacencyCypher("outbound"), /\(n:Node \{id: \$id\}\)-\[e:Edge\]->/);
  assert.match(adjacencyCypher("inbound"), /<-\[e:Edge\]-\(n:Node \{id: \$id\}\)/);
});

test("isReadOnlyCypher blocks mutations, allows MATCH", () => {
  assert.equal(isReadOnlyCypher("MATCH (n:Node) RETURN n"), true);
  assert.equal(isReadOnlyCypher("match (n) return count(n)"), true);
  for (const bad of ["CREATE (n:Node)", "MERGE (n)", "DELETE n", "SET n.x=1", "DROP TABLE Node", "COPY Node FROM 'x'", "ALTER TABLE Node", "MATCH (n) DETACH DELETE n"]) {
    assert.equal(isReadOnlyCypher(bad), false, bad);
  }
});

test("rowToNode maps columns and coerces line numbers", () => {
  const n = rowToNode({ id: "x", kind: "symbol", path: "a.ts", name: "f", scope: "m", symbolKind: "function", startLine: 3n ?? 3, endLine: 9, summary: "" });
  assert.equal(n.id, "x"); assert.equal(n.kind, "symbol"); assert.equal(n.startLine, 3); assert.equal(n.endLine, 9);
});

test("nodeRowsParam produces one row object per node with required keys", () => {
  const { rows } = nodeRowsParam([{ id: "a", kind: "file", path: "a.ts", name: "a.ts", confidence: undefined } ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["endLine","id","kind","name","path","scope","startLine","summary","symbolKind"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/memex && node --test tests/unit/ladybug-cypher.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ladybug-cypher.ts`**

```ts
import type { GraphNodeV1, GraphEdgeV1, GraphNodeKind } from "./graph-contracts.js";
import type { CypherParam } from "./graph-index.js";

export const LADYBUG_SCHEMA_DDL: readonly string[] = [
  `CREATE NODE TABLE IF NOT EXISTS Node(
     id STRING PRIMARY KEY, kind STRING, path STRING, name STRING,
     scope STRING, symbolKind STRING, startLine INT64, endLine INT64, summary STRING
   )`,
  `CREATE REL TABLE IF NOT EXISTS Edge(FROM Node TO Node, id STRING, kind STRING, confidence STRING)`,
];

export const NODE_BY_ID_CYPHER =
  `MATCH (n:Node {id: $id}) RETURN n.id AS id, n.kind AS kind, n.path AS path, n.name AS name, n.scope AS scope, n.symbolKind AS symbolKind, n.startLine AS startLine, n.endLine AS endLine, n.summary AS summary`;

export function adjacencyCypher(direction: "inbound" | "outbound"): string {
  const pattern = direction === "outbound"
    ? `(n:Node {id: $id})-[e:Edge]->(m:Node)`
    : `(m:Node)-[e:Edge]->(n:Node {id: $id})`;
  return `MATCH ${pattern} RETURN e.id AS edgeId, e.kind AS kind, e.confidence AS confidence, m.id AS otherId LIMIT $limit`;
}

export function allNodesCypher(withKind: boolean): string {
  const where = withKind ? ` WHERE n.kind = $kind` : ``;
  return `MATCH (n:Node)${where} RETURN n.id AS id, n.kind AS kind, n.path AS path, n.name AS name, n.scope AS scope, n.symbolKind AS symbolKind, n.startLine AS startLine, n.endLine AS endLine, n.summary AS summary`;
}

export const ALL_EDGES_CYPHER =
  `MATCH (a:Node)-[e:Edge]->(b:Node) RETURN e.id AS id, e.kind AS kind, e.confidence AS confidence, a.id AS \`from\`, b.id AS \`to\``;

export function nodeInsertCypher(): string {
  return `UNWIND $rows AS r CREATE (n:Node {id: r.id, kind: r.kind, path: r.path, name: r.name, scope: r.scope, symbolKind: r.symbolKind, startLine: r.startLine, endLine: r.endLine, summary: r.summary})`;
}
export function edgeInsertCypher(): string {
  return `UNWIND $rows AS r MATCH (a:Node {id: r.from}), (b:Node {id: r.to}) CREATE (a)-[:Edge {id: r.id, kind: r.kind, confidence: r.confidence}]->(b)`;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const int = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v));

export function nodeRowsParam(nodes: readonly GraphNodeV1[]): { rows: Record<string, CypherParam>[] } {
  return { rows: nodes.map((n) => ({ id: n.id, kind: n.kind, path: str(n.path), name: str(n.name), scope: str(n.scope), symbolKind: str(n.symbolKind), startLine: int(n.startLine), endLine: int(n.endLine), summary: str(n.summary) })) };
}
export function edgeRowsParam(edges: readonly GraphEdgeV1[]): { rows: Record<string, CypherParam>[] } {
  return { rows: edges.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, confidence: e.confidence })) };
}

export function rowToNode(row: Record<string, unknown>): GraphNodeV1 {
  const node: GraphNodeV1 = { id: String(row.id), kind: String(row.kind) as GraphNodeKind, path: str(row.path), name: str(row.name) };
  const scope = str(row.scope); if (scope) node.scope = scope;
  const symbolKind = str(row.symbolKind); if (symbolKind) node.symbolKind = symbolKind as GraphNodeV1["symbolKind"];
  const sl = int(row.startLine); if (sl) node.startLine = sl;
  const el = int(row.endLine); if (el) node.endLine = el;
  const summary = str(row.summary); if (summary) node.summary = summary;
  return node;
}
export function rowToEdge(row: Record<string, unknown>): GraphEdgeV1 {
  return { id: String(row.id), kind: String(row.kind) as GraphEdgeV1["kind"], from: String(row.from), to: String(row.to), confidence: String(row.confidence) as GraphEdgeV1["confidence"] };
}

const MUTATION = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|COPY|ALTER|INSTALL|LOAD|ATTACH|DETACH|CALL)\b/i;
export function isReadOnlyCypher(query: string): boolean {
  // Strip line/block comments and string literals before classifying.
  const stripped = query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return !MUTATION.test(stripped);
}
```

Note: verify `GraphNodeV1.symbolKind`/`GraphEdgeV1.confidence` union member names against `graph-contracts.ts` and cast accordingly. Line values stored as INT64 come back as `number` or `bigint` from Ladybug — `int()` handles both via `Number()`.

- [ ] **Step 4: Build and run test to verify it passes**

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/unit/ladybug-cypher.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/memex/src/ladybug-cypher.ts plugins/memex/dist/ladybug-cypher.js plugins/memex/dist/ladybug-cypher.d.ts plugins/memex/tests/unit/ladybug-cypher.test.mjs
git commit -m "feat(memex): add Ladybug Cypher and DDL builders with read-only guard"
```

---

### Task 3: `LadybugGraphBackend` over `LadybugConnection` (`ladybug-backend.ts`)

**Files:**
- Create: `plugins/memex/src/ladybug-backend.ts`
- Test: `plugins/memex/tests/unit/ladybug-backend.test.mjs`

**Interfaces:**
- Consumes: builders/mappers from Task 2; `GraphIndexPort`, `GraphAdjacency`, `CypherCapable`, `CypherResult`, `CypherParam` from graph-index; `GraphNodeV1`, `GraphEdgeV1`.
- Produces:
  ```ts
  export interface LadybugConnection {
    query(cypher: string, params?: Record<string, CypherParam>): Promise<CypherResult>;
    close(): Promise<void>;
  }
  export class LadybugGraphBackend implements GraphIndexPort, CypherCapable {
    constructor(conn: LadybugConnection);
    node(id: string): Promise<GraphNodeV1 | undefined>;
    inbound(id: string, limit: number): Promise<GraphAdjacency>;
    outbound(id: string, limit: number): Promise<GraphAdjacency>;
    allNodes(kind?: GraphNodeKind): Promise<GraphNodeV1[]>;
    allEdges(): Promise<GraphEdgeV1[]>;
    cypher(query: string, params?: Record<string, CypherParam>): Promise<CypherResult>;
    close(): Promise<void>;
  }
  export async function syncGraphToLadybug(conn: LadybugConnection, graph: { nodes: readonly GraphNodeV1[]; edges: readonly GraphEdgeV1[] }, batchSize?: number): Promise<void>;
  ```
  `GraphAdjacency` is `{ edges: GraphEdgeV1[]; nodes: GraphNodeV1[] }` (confirm exact shape at `graph-index.ts:44`).

- [ ] **Step 1: Write the failing test** (fake connection is a test double for the DB boundary; real execution proven in Task 6)

```js
// plugins/memex/tests/unit/ladybug-backend.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { LadybugGraphBackend, syncGraphToLadybug } from "../../dist/ladybug-backend.js";

function fakeConn(handler) {
  const calls = [];
  return { calls, async query(cypher, params) { calls.push({ cypher, params }); return handler(cypher, params) ?? { columns: [], rows: [], truncated: false }; }, async close() {} };
}

test("node() issues parameterized lookup and maps the row", async () => {
  const conn = fakeConn((c) => c.includes("{id: $id}") ? { columns: ["id"], rows: [{ id: "n1", kind: "file", path: "a.ts", name: "a.ts", scope: "", symbolKind: "", startLine: 0, endLine: 0, summary: "" }], truncated: false } : undefined);
  const be = new LadybugGraphBackend(conn);
  const n = await be.node("n1");
  assert.equal(n.id, "n1");
  assert.equal(conn.calls[0].params.id, "n1");
});

test("cypher() rejects mutations before touching the connection", async () => {
  const conn = fakeConn(() => ({ columns: [], rows: [], truncated: false }));
  const be = new LadybugGraphBackend(conn);
  await assert.rejects(() => be.cypher("CREATE (n:Node)"), /read-only|not allowed|mutation/i);
  assert.equal(conn.calls.length, 0);
});

test("syncGraphToLadybug runs DDL then node then edge inserts", async () => {
  const conn = fakeConn(() => ({ columns: [], rows: [], truncated: false }));
  await syncGraphToLadybug(conn, { nodes: [{ id: "a", kind: "file", path: "a.ts", name: "a" }, { id: "b", kind: "file", path: "b.ts", name: "b" }], edges: [{ id: "e", kind: "references", from: "a", to: "b", confidence: "exact" }] });
  const text = conn.calls.map((c) => c.cypher).join("\n");
  assert.match(text, /CREATE NODE TABLE/i);
  assert.match(text, /CREATE REL TABLE/i);
  assert.match(text, /UNWIND \$rows AS r CREATE \(n:Node/i);
  assert.match(text, /UNWIND \$rows AS r MATCH \(a:Node/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/memex && node --test tests/unit/ladybug-backend.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ladybug-backend.ts`**

```ts
import type { GraphIndexPort, GraphAdjacency, CypherCapable, CypherResult, CypherParam } from "./graph-index.js";
import type { GraphNodeKind, GraphNodeV1, GraphEdgeV1 } from "./graph-contracts.js";
import { MemexError } from "./errors.js";
import {
  LADYBUG_SCHEMA_DDL, NODE_BY_ID_CYPHER, adjacencyCypher, allNodesCypher, ALL_EDGES_CYPHER,
  nodeInsertCypher, edgeInsertCypher, nodeRowsParam, edgeRowsParam, rowToNode, rowToEdge, isReadOnlyCypher,
} from "./ladybug-cypher.js";

export interface LadybugConnection {
  query(cypher: string, params?: Record<string, CypherParam>): Promise<CypherResult>;
  close(): Promise<void>;
}

export class LadybugGraphBackend implements GraphIndexPort, CypherCapable {
  constructor(private readonly conn: LadybugConnection) {}

  async node(id: string): Promise<GraphNodeV1 | undefined> {
    const res = await this.conn.query(NODE_BY_ID_CYPHER, { id });
    const row = res.rows[0];
    return row ? rowToNode(row) : undefined;
  }

  private async adjacency(id: string, limit: number, direction: "inbound" | "outbound"): Promise<GraphAdjacency> {
    const res = await this.conn.query(adjacencyCypher(direction), { id, limit });
    const edges: GraphEdgeV1[] = [];
    const otherIds: string[] = [];
    for (const row of res.rows) {
      const otherId = String(row.otherId);
      otherIds.push(otherId);
      edges.push(rowToEdge(direction === "outbound"
        ? { id: row.edgeId, kind: row.kind, confidence: row.confidence, from: id, to: otherId }
        : { id: row.edgeId, kind: row.kind, confidence: row.confidence, from: otherId, to: id }));
    }
    const nodes = (await Promise.all(otherIds.map((n) => this.node(n)))).filter((n): n is GraphNodeV1 => n !== undefined);
    return { edges, nodes };
  }
  inbound(id: string, limit: number): Promise<GraphAdjacency> { return this.adjacency(id, limit, "inbound"); }
  outbound(id: string, limit: number): Promise<GraphAdjacency> { return this.adjacency(id, limit, "outbound"); }

  async allNodes(kind?: GraphNodeKind): Promise<GraphNodeV1[]> {
    const res = await this.conn.query(allNodesCypher(kind !== undefined), kind !== undefined ? { kind } : undefined);
    return res.rows.map(rowToNode);
  }
  async allEdges(): Promise<GraphEdgeV1[]> {
    const res = await this.conn.query(ALL_EDGES_CYPHER);
    return res.rows.map(rowToEdge);
  }

  async cypher(query: string, params?: Record<string, CypherParam>): Promise<CypherResult> {
    if (!isReadOnlyCypher(query)) {
      throw new MemexError("GRAPH_CYPHER_READONLY", "Only read-only Cypher (MATCH/RETURN) is allowed on the derived graph database.");
    }
    return this.conn.query(query, params);
  }
  close(): Promise<void> { return this.conn.close(); }
}

export async function syncGraphToLadybug(
  conn: LadybugConnection,
  graph: { nodes: readonly GraphNodeV1[]; edges: readonly GraphEdgeV1[] },
  batchSize = 5000,
): Promise<void> {
  for (const ddl of LADYBUG_SCHEMA_DDL) await conn.query(ddl);
  const nodeCypher = nodeInsertCypher();
  for (let i = 0; i < graph.nodes.length; i += batchSize) {
    await conn.query(nodeCypher, nodeRowsParam(graph.nodes.slice(i, i + batchSize)) as unknown as Record<string, CypherParam>);
  }
  const edgeCypher = edgeInsertCypher();
  for (let i = 0; i < graph.edges.length; i += batchSize) {
    await conn.query(edgeCypher, edgeRowsParam(graph.edges.slice(i, i + batchSize)) as unknown as Record<string, CypherParam>);
  }
}
```

Note: `nodeRowsParam` returns `{ rows: [...] }`; Ladybug accepts a list parameter `$rows`. Confirm `MemexError` code registration convention in `errors.ts` and add `GRAPH_CYPHER_READONLY` if codes are an enum/union. The `as unknown as` cast is only to satisfy the `Record<string,CypherParam>` param type for the list-valued `$rows`; if `CypherParam` needs a list arm, add `| readonly CypherParam[] | ReadonlyArray<Record<string, CypherParam>>` to `CypherParam` in Task 1 instead of casting (preferred — do this and drop the cast).

- [ ] **Step 4: Build and run test to verify it passes**

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/unit/ladybug-backend.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/memex/src/ladybug-backend.ts plugins/memex/dist/ladybug-backend.js plugins/memex/dist/ladybug-backend.d.ts plugins/memex/src/graph-index.ts plugins/memex/dist/graph-index.* plugins/memex/src/errors.ts plugins/memex/dist/errors.* plugins/memex/tests/unit/ladybug-backend.test.mjs
git commit -m "feat(memex): add LadybugGraphBackend mapping GraphIndexPort to Cypher"
```

---

### Task 4: Vendor the WASM nodejs assets + shared assembler (`vendor-assets.ts`, `vendor/ladybug-wasm/`)

**Files:**
- Create: `plugins/memex/vendor/ladybug-wasm/` (assets + local README)
- Modify: `plugins/memex/vendor/MANIFEST.json` (add a `ladybug-wasm` asset group)
- Create: `plugins/memex/src/vendor-assets.ts` (extract the part-assembly + sha-verify helper so both embedder and ladybug reuse it)
- Modify: `plugins/memex/src/embedder.ts` (import the extracted helper; no behaviour change)
- Modify: `docs/superpowers/specs/2026-07-14-memex-prd.md` (§16 vendor facts: add Ladybug WASM)
- Test: `plugins/memex/tests/integration/ladybug-vendor.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  // vendor-assets.ts
  export interface AssembledAsset { runtimeDir: string; }  // dir containing the ready-to-require nodejs module
  export async function assembleVendorGroup(vendorRoot: string, groupPath: string, cacheRoot: string): Promise<string>;
  // Assembles every file in the manifest group (copying whole files, concatenating `parts`),
  // verifies each part sha256 and any assembledSha256, writes into `${cacheRoot}/${groupPath}/<version>/`,
  // and returns that directory. Idempotent: if the target exists with a matching stamp file, skip.
  ```

- [ ] **Step 1: Acquire and place the vendored nodejs assets (mechanical, run once)**

Run (network + disk; heavy — expect minutes on this filesystem):
```bash
cd "$(mktemp -d)" && npm pack @ladybugdb/wasm-core@0.18.2 >/dev/null 2>&1 && tar xzf ladybugdb-wasm-core-0.18.2.tgz
# Inspect the nodejs variant layout and sizes:
ls -lAR package/nodejs
```
Copy ONLY the `nodejs/` variant files (index.js, the `.wasm`, and any worker/glue js it requires) into `plugins/memex/vendor/ladybug-wasm/`. For every copied file ≥ 90 MB, split into `<name>.partNN` chunks of ≤ 90 MB (`split -b 90m`) and DO NOT commit the whole file. Record SHAs.

- [ ] **Step 2: Write the MANIFEST group + failing assemble test**

Add to `plugins/memex/vendor/MANIFEST.json` `assets` array a group whose entries reuse the existing `VendorManifestEntry` shape: unsplit files carry `path` + `sha256` + `bytes`; the split `.wasm` carries `path` (logical), `assembledSha256`, and `parts: [{path, sha256, bytes}]`. Use snake_case `assembled_sha256` to match the real manifest parser.

```js
// plugins/memex/tests/integration/ladybug-vendor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleVendorGroup } from "../../dist/vendor-assets.js";

const vendorRoot = path.join(fileURLToPath(new URL("../../", import.meta.url)), "vendor");

test("assembles ladybug-wasm nodejs runtime dir with verified shas", async () => {
  const cache = await mkdtemp(path.join(tmpdir(), "lbug-"));
  const dir = await assembleVendorGroup(vendorRoot, "ladybug-wasm", cache);
  const files = await readdir(dir);
  assert.ok(files.includes("index.js"), "index.js present");
  assert.ok(files.some((f) => f.endsWith(".wasm")), "wasm present and reassembled");
  const wasm = files.find((f) => f.endsWith(".wasm"));
  assert.ok((await stat(path.join(dir, wasm))).size > 1_000_000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugins/memex && node --test tests/integration/ladybug-vendor.test.mjs`
Expected: FAIL — `assembleVendorGroup` not found.

- [ ] **Step 4: Extract the assembler into `vendor-assets.ts` and reuse in embedder**

Move the part-concatenation + sha256 verification logic out of `embedder.ts` into `vendor-assets.ts` as `assembleVendorGroup` (generalized over a manifest group), plus keep the existing single-buffer `loadModelBuffer` behaviour delegating to the shared verifier. `assembleVendorGroup`: read the manifest group, for each entry copy (unsplit) or concatenate parts (split) into `${cacheRoot}/${groupPath}/<version>/`, verifying `sha256` per part and `assembled_sha256` for the whole; write a `.stamp` file with the group version for idempotency. Import it back into `embedder.ts` so embeddings keep working unchanged (run the existing `embedder*.test.mjs` to prove no regression).

- [ ] **Step 5: Update PRD §16 and run tests**

Add to PRD §16 the Ladybug WASM facts: package `@ladybugdb/wasm-core@0.18.2`, MIT, vendored `nodejs` variant file list, part layout, and `assembled_sha256`.

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/integration/ladybug-vendor.test.mjs tests/embedder.test.mjs tests/tokenizer-vendor.test.mjs`
Expected: PASS (assemble test + embedder regression green).

- [ ] **Step 6: Commit**

```bash
git add plugins/memex/vendor/ladybug-wasm plugins/memex/vendor/MANIFEST.json plugins/memex/src/vendor-assets.ts plugins/memex/dist/vendor-assets.* plugins/memex/src/embedder.ts plugins/memex/dist/embedder.* docs/superpowers/specs/2026-07-14-memex-prd.md plugins/memex/tests/integration/ladybug-vendor.test.mjs
git commit -m "feat(memex): vendor LadybugDB wasm nodejs assets with shared verified assembler"
```

---

### Task 5: WASM connection adapter (`ladybug-wasm.ts`)

**Files:**
- Create: `plugins/memex/src/ladybug-wasm.ts`
- Test: `plugins/memex/tests/integration/ladybug-wasm-conn.test.mjs`

**Interfaces:**
- Consumes: `assembleVendorGroup` (Task 4); `LadybugConnection`, `CypherResult`, `CypherParam` (Task 3/1); `defaultVendorRoot` (embedder).
- Produces:
  ```ts
  export interface OpenWasmOptions { vendorRoot?: string; cacheRoot?: string; databasePath?: string; }
  export async function openLadybugWasmConnection(opts?: OpenWasmOptions): Promise<LadybugConnection | null>;
  // Returns null (never throws) if assets are absent/corrupt or the module fails to load — enables soft-degrade.
  ```

- [ ] **Step 1: Write the failing test** (real WASM in Node)

```js
// plugins/memex/tests/integration/ladybug-wasm-conn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLadybugWasmConnection } from "../../dist/ladybug-wasm.js";

test("opens a real wasm connection and runs Cypher", async () => {
  const conn = await openLadybugWasmConnection({ databasePath: ":memory:" });
  assert.ok(conn, "connection should open from vendored assets");
  await conn.query("CREATE NODE TABLE T(id STRING PRIMARY KEY, n INT64)");
  await conn.query("CREATE (:T {id: 'a', n: 41})");
  const res = await conn.query("MATCH (t:T) RETURN t.id AS id, t.n + 1 AS m");
  assert.deepEqual(res.columns, ["id", "m"]);
  assert.equal(res.rows[0].id, "a");
  assert.equal(Number(res.rows[0].m), 42);
  await conn.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/memex && node --test tests/integration/ladybug-wasm-conn.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ladybug-wasm.ts`**

```ts
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import type { LadybugConnection } from "./ladybug-backend.js";
import type { CypherResult, CypherParam } from "./graph-index.js";
import { assembleVendorGroup } from "./vendor-assets.js";
import { defaultVendorRoot } from "./embedder.js";

interface LbugQueryResult {
  isSuccess(): boolean;
  getErrorMessage(): Promise<string>;
  getColumnNames(): Promise<string[]>;
  getAllObjects(): Promise<Record<string, unknown>[]>;
  getNumTuples(): Promise<number>;
}
interface LbugModule {
  Database: new (path?: string) => unknown;
  Connection: new (db: unknown) => { query(q: string): Promise<LbugQueryResult>; prepare(q: string): Promise<unknown>; execute(ps: unknown, p?: Record<string, unknown>): Promise<LbugQueryResult>; close(): Promise<void> };
  init?: () => Promise<void>;
}

export interface OpenWasmOptions { vendorRoot?: string; cacheRoot?: string; databasePath?: string; }

export async function openLadybugWasmConnection(opts: OpenWasmOptions = {}): Promise<LadybugConnection | null> {
  let mod: LbugModule;
  try {
    const vendorRoot = opts.vendorRoot ?? defaultVendorRoot();
    const cacheRoot = opts.cacheRoot ?? path.join(os.homedir(), ".memex", "cache");
    const runtimeDir = await assembleVendorGroup(vendorRoot, "ladybug-wasm", cacheRoot);
    const req = createRequire(import.meta.url);
    mod = req(path.join(runtimeDir, "index.js")) as LbugModule;
    if (mod.init) await mod.init();
  } catch { return null; }

  try {
    const db = new mod.Database(opts.databasePath ?? ":memory:");
    const conn = new mod.Connection(db);
    return {
      async query(cypher: string, params?: Record<string, CypherParam>): Promise<CypherResult> {
        const raw = params ? await conn.execute(await conn.prepare(cypher), params as Record<string, unknown>) : await conn.query(cypher);
        if (!raw.isSuccess()) throw new Error(await raw.getErrorMessage());
        const [columns, rows] = await Promise.all([raw.getColumnNames(), raw.getAllObjects()]);
        return { columns, rows, truncated: false };
      },
      async close() { await conn.close(); },
    };
  } catch { return null; }
}
```

Note: confirm against the vendored `nodejs/index.js` whether raw string queries with parameters use `prepare`+`execute` (as typed) or a `query(cypher, params)` overload; adjust the `params ? ... : ...` branch accordingly. Keep the `null`-on-failure contract intact.

- [ ] **Step 4: Build and run test to verify it passes**

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/integration/ladybug-wasm-conn.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/memex/src/ladybug-wasm.ts plugins/memex/dist/ladybug-wasm.* plugins/memex/tests/integration/ladybug-wasm-conn.test.mjs
git commit -m "feat(memex): load vendored Ladybug wasm as a LadybugConnection in Node"
```

---

### Task 6: Wire WASM tier into `openGraphBackend` + equivalence oracle + degrade tests

**Files:**
- Modify: `plugins/memex/src/graph-index.ts` (add a `tryWasm` factory helper `openWasmTier(graph, dbPath?)` that opens the wasm connection, syncs the graph, returns `{port, cypher, close}` or null)
- Modify: the graph open call site (find where `openGraphIndexGeneration` is invoked — likely `adapter.ts`/`graph.ts`/`retrieve.ts` wiring) to route through `openGraphBackend`
- Test: `plugins/memex/tests/integration/ladybug-equivalence.test.mjs`

**Interfaces:**
- Consumes: `openLadybugWasmConnection` (Task 5), `LadybugGraphBackend` + `syncGraphToLadybug` (Task 3), `openGraphBackend` (Task 1), the pure factory.
- Produces: `export async function openWasmTier(graph: { nodes: readonly GraphNodeV1[]; edges: readonly GraphEdgeV1[] }, databasePath?: string): Promise<{ port: GraphIndexPort; cypher: CypherCapable; close(): Promise<void> } | null>;`

- [ ] **Step 1: Write the failing equivalence + degrade tests**

```js
// plugins/memex/tests/integration/ladybug-equivalence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { openWasmTier } from "../../dist/graph-index.js";
import { LadybugGraphBackend, syncGraphToLadybug } from "../../dist/ladybug-backend.js";
import { openLadybugWasmConnection } from "../../dist/ladybug-wasm.js";

const graph = {
  nodes: [
    { id: "f1", kind: "file", path: "a.ts", name: "a.ts" },
    { id: "s1", kind: "symbol", path: "a.ts", name: "foo", symbolKind: "function", startLine: 1, endLine: 9 },
    { id: "s2", kind: "symbol", path: "a.ts", name: "bar", symbolKind: "function", startLine: 11, endLine: 20 },
  ],
  edges: [
    { id: "e1", kind: "declares", from: "f1", to: "s1", confidence: "exact" },
    { id: "e2", kind: "calls", from: "s1", to: "s2", confidence: "resolved" },
  ],
};

test("wasm backend agrees with the seeded graph on port methods", async () => {
  const conn = await openLadybugWasmConnection({ databasePath: ":memory:" });
  assert.ok(conn);
  await syncGraphToLadybug(conn, graph);
  const be = new LadybugGraphBackend(conn);
  const n = await be.node("s1");
  assert.equal(n.name, "foo"); assert.equal(n.startLine, 1);
  const out = await be.outbound("s1", 10);
  assert.deepEqual(out.edges.map((e) => e.to).sort(), ["s2"]);
  const inb = await be.inbound("s2", 10);
  assert.deepEqual(inb.edges.map((e) => e.from).sort(), ["s1"]);
  assert.equal((await be.allNodes()).length, 3);
  assert.equal((await be.allEdges()).length, 2);
  const res = await be.cypher("MATCH (n:Node) WHERE n.kind = 'symbol' RETURN count(n) AS c");
  assert.equal(Number(res.rows[0].c), 2);
  await be.close();
});

test("degrade: forcing pure yields no cypher capability", async () => {
  const { openGraphBackend } = await import("../../dist/graph-index.js");
  const fakePort = { async node(){return undefined;}, async inbound(){return {edges:[],nodes:[]};}, async outbound(){return {edges:[],nodes:[]};}, async allNodes(){return [];}, async allEdges(){return [];} };
  const sel = await openGraphBackend({ preference: "pure", openPure: async () => fakePort, tryWasm: async () => { throw new Error("must not be called"); } });
  assert.equal(sel.tier, "pure");
  assert.equal(sel.cypher, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/memex && node --test tests/integration/ladybug-equivalence.test.mjs`
Expected: FAIL — `openWasmTier` not found.

- [ ] **Step 3: Implement `openWasmTier` and route the call site**

```ts
// in graph-index.ts
import { openLadybugWasmConnection } from "./ladybug-wasm.js";
import { LadybugGraphBackend, syncGraphToLadybug } from "./ladybug-backend.js";

export async function openWasmTier(
  graph: { nodes: readonly GraphNodeV1[]; edges: readonly GraphEdgeV1[] },
  databasePath?: string,
): Promise<{ port: GraphIndexPort; cypher: CypherCapable; close(): Promise<void> } | null> {
  const conn = await openLadybugWasmConnection({ databasePath });
  if (!conn) return null;
  try {
    await syncGraphToLadybug(conn, graph);
    const backend = new LadybugGraphBackend(conn);
    return { port: backend, cypher: backend, close: () => backend.close() };
  } catch {
    await conn.close().catch(() => {});
    return null;
  }
}
```

At the existing graph-open call site, replace the direct `openGraphIndexGeneration(...)` call with `openGraphBackend({ openPure: () => openGraphIndexGeneration(...), tryWasm: () => openWasmTier(loadedGraph), tryNative: /* Task 7 */ })` and thread `selection.port` to existing consumers, `selection.cypher` to the Cypher surface (Task 8). Keep `:memory:` for now (persistence path is Task 7/opt).

- [ ] **Step 4: Build and run to verify it passes**

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/integration/ladybug-equivalence.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Regression + commit**

Run: `cd plugins/memex && node --test tests/**/*.test.mjs` (full suite green).
```bash
git add plugins/memex/src/graph-index.ts plugins/memex/dist/graph-index.* plugins/memex/src/*.ts plugins/memex/dist/*.js plugins/memex/tests/integration/ladybug-equivalence.test.mjs
git commit -m "feat(memex): route graph opening through backend resolver with wasm tier"
```

---

### Task 7: Native tier (`ladybug-native.ts`, optionalDependency) + persistence

**Files:**
- Create: `plugins/memex/src/ladybug-native.ts`
- Modify: `plugins/memex/package.json` (`optionalDependencies["@ladybugdb/core"] = "0.18.2"`, `devDependencies["@ladybugdb/wasm-core"] = "0.18.2"` for rep/rebuild tooling only)
- Modify: `plugins/memex/src/graph-index.ts` (`openNativeTier`, on-disk `databasePath` for persistence)
- Test: `plugins/memex/tests/integration/ladybug-native.test.mjs` (gated)

**Interfaces:**
- Produces:
  ```ts
  export async function openLadybugNativeConnection(opts?: { databasePath?: string }): Promise<LadybugConnection | null>;
  export async function openNativeTier(graph, databasePath?): Promise<{ port; cypher; close } | null>;
  ```

- [ ] **Step 1: Write the gated test** (skips with a logged reason when the optional dep is absent — no silent skip)

```js
// plugins/memex/tests/integration/ladybug-native.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLadybugNativeConnection } from "../../dist/ladybug-native.js";

test("native connection runs Cypher when @ladybugdb/core is installed", async (t) => {
  const conn = await openLadybugNativeConnection({ databasePath: ":memory:" });
  if (!conn) { t.diagnostic("SKIP: @ladybugdb/core not installed for this platform"); return; }
  await conn.query("CREATE NODE TABLE T(id STRING PRIMARY KEY)");
  await conn.query("CREATE (:T {id: 'x'})");
  const res = await conn.query("MATCH (t:T) RETURN count(t) AS c");
  assert.equal(Number(res.rows[0].c), 1);
  await conn.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/memex && node --test tests/integration/ladybug-native.test.mjs`
Expected: FAIL — module not found (not a skip).

- [ ] **Step 3: Implement `ladybug-native.ts`** (adapt the native API — kuzu-style sync/async — to `LadybugConnection`)

```ts
import { createRequire } from "node:module";
import type { LadybugConnection } from "./ladybug-backend.js";
import type { CypherResult, CypherParam } from "./graph-index.js";

export async function openLadybugNativeConnection(opts: { databasePath?: string } = {}): Promise<LadybugConnection | null> {
  let core: { Database: new (p?: string) => unknown; Connection: new (db: unknown) => { query(q: string): Promise<{ getAll(): Promise<Record<string, unknown>[]>; getColumnNames?(): string[] }>; close?(): void } };
  try {
    const req = createRequire(import.meta.url);
    core = req("@ladybugdb/core") as typeof core;
  } catch { return null; }
  try {
    const db = new core.Database(opts.databasePath ?? ":memory:");
    const conn = new core.Connection(db);
    return {
      async query(cypher: string, params?: Record<string, CypherParam>): Promise<CypherResult> {
        // Native API: prefer parameterized prepare/execute when params present; confirm exact method names against installed @ladybugdb/core typings.
        const res = await conn.query(params ? applyParams(cypher, params) : cypher);
        const rows = await res.getAll();
        const columns = res.getColumnNames ? res.getColumnNames() : Object.keys(rows[0] ?? {});
        return { columns, rows, truncated: false };
      },
      async close() { conn.close?.(); },
    };
  } catch { return null; }
}
```

Note: `@ladybugdb/core` is an optionalDependency — its typings may be absent at build time, so this file must compile without them (use `createRequire` + local structural types as above, never a top-level `import "@ladybugdb/core"`). Determine the native parameter-binding API from the installed package and implement `applyParams`/prepared statements accordingly (do NOT do string interpolation of untrusted values — use the native prepared-statement API; if unavailable, restrict native params to the internal sync path only).

- [ ] **Step 4: Wire native tier + persistence, build, run**

Add `openNativeTier` mirroring `openWasmTier`, pass it as `tryNative` at the call site. Set `databasePath` to `~/.memex/<workspaceId>/graph-db` for both tiers so persistence works; add staleness check (rebuild when shard manifest hash differs from a stored stamp). Build and run the gated test.

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/integration/ladybug-native.test.mjs`
Expected: PASS or documented SKIP with diagnostic.

- [ ] **Step 5: Commit**

```bash
git add plugins/memex/src/ladybug-native.ts plugins/memex/dist/ladybug-native.* plugins/memex/src/graph-index.ts plugins/memex/dist/graph-index.* plugins/memex/package.json plugins/memex/tests/integration/ladybug-native.test.mjs
git commit -m "feat(memex): add optional native LadybugDB tier and on-disk persistence"
```

---

### Task 8: Cypher surface — CLI `memex graph cypher` + MCP `memex_graph_cypher` + doctor tier line

**Files:**
- Modify: `plugins/memex/src/cli.ts` (add `graph cypher <query>` subcommand)
- Modify: `plugins/memex/src/mcp.ts` (register `memex_graph_cypher` tool)
- Modify: `plugins/memex/src/doctor.ts` (report active graph tier + reason)
- Test: `plugins/memex/tests/e2e/graph-cypher.e2e.test.mjs`, extend `plugins/memex/tests/mcp.test.mjs`

**Interfaces:**
- Consumes: `openGraphBackend` selection (`selection.cypher`, `selection.tier`, `selection.reason`); `MemexError`.
- Produces: CLI `memex graph cypher "<query>" [--json]`; MCP tool `memex_graph_cypher({ query: string, params?: object })` returning `{ columns, rows, truncated, tier }`.

- [ ] **Step 1: Write the failing E2E test** (real repo fixture, real CLI, real wasm backend)

```js
// plugins/memex/tests/e2e/graph-cypher.e2e.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.join(fileURLToPath(new URL("../../", import.meta.url)), "dist", "cli.js");

test("memex graph cypher returns rows over a real indexed repo", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "memex-e2e-"));
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "a.ts"), "export function foo(){ return bar(); }\nfunction bar(){ return 1; }\n");
  const env = { ...process.env, MEMEX_GRAPH_BACKEND: "wasm" };
  execFileSync("node", [cli, "index", "--path", repo], { env, stdio: "pipe" });
  const out = execFileSync("node", [cli, "graph", "cypher", "MATCH (n:Node) RETURN count(n) AS c", "--json", "--path", repo], { env, stdio: "pipe" }).toString();
  const parsed = JSON.parse(out);
  assert.equal(parsed.tier, "wasm");
  assert.ok(Number(parsed.rows[0].c) > 0);
});

test("pure tier degrades honestly", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "memex-e2e-"));
  await writeFile(path.join(repo, "a.ts"), "export const x = 1;\n");
  const env = { ...process.env, MEMEX_GRAPH_BACKEND: "pure" };
  execFileSync("node", [cli, "index", "--path", repo], { env, stdio: "pipe" });
  let msg = "";
  try { execFileSync("node", [cli, "graph", "cypher", "MATCH (n) RETURN n", "--path", repo], { env, stdio: "pipe" }); }
  catch (e) { msg = (e.stderr?.toString() ?? "") + (e.stdout?.toString() ?? ""); }
  assert.match(msg, /Cypher requires the LadybugDB backend|doctor/i);
});
```

Adapt the `index` subcommand name/flags to the actual CLI (inspect `cli.ts`). If the CLI has no `--path`, run inside `cwd: repo`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd plugins/memex && node --test tests/e2e/graph-cypher.e2e.test.mjs`
Expected: FAIL — unknown subcommand / no rows.

- [ ] **Step 3: Implement CLI + MCP + doctor**

CLI `graph cypher`: open the backend via `openGraphBackend`; if `selection.cypher` is undefined, print to stderr `Cypher requires the LadybugDB backend — run \`memex doctor\`` and exit non-zero; else run `selection.cypher.cypher(query, params)` and print a table (or JSON with `{ columns, rows, truncated, tier }` when `--json`). MCP tool `memex_graph_cypher`: same, returning the structured object plus `tier`; on pure tier return a typed error result (not a throw that crashes the server). Doctor: add a check that opens the backend and reports `graph backend: <tier> (<reason>)`.

- [ ] **Step 4: Build and run to verify it passes**

Run: `node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json && cd plugins/memex && node --test tests/e2e/graph-cypher.e2e.test.mjs tests/mcp.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/memex/src/cli.ts plugins/memex/src/mcp.ts plugins/memex/src/doctor.ts plugins/memex/dist/cli.* plugins/memex/dist/mcp.* plugins/memex/dist/doctor.* plugins/memex/tests/e2e/graph-cypher.e2e.test.mjs plugins/memex/tests/mcp.test.mjs
git commit -m "feat(memex): expose graph Cypher via CLI and MCP with honest degrade"
```

---

### Task 9: Documentation + full regression sweep

**Files:**
- Modify: `plugins/memex/README.md` (or docs) — document `MEMEX_GRAPH_BACKEND`, the three tiers, `memex graph cypher`, and the opt-in native install (`npm i @ladybugdb/core`).
- Modify: `docs/superpowers/specs/2026-07-14-memex-prd.md` (link the new capability).

- [ ] **Step 1: Write/adjust docs** — no placeholders; include the exact env var, tier order, and a real Cypher example.
- [ ] **Step 2: Full suite + build + lint**

Run:
```bash
node node_modules/typescript/bin/tsc -p plugins/memex/tsconfig.json
node node_modules/eslint/bin/eslint.js plugins/memex/src
cd plugins/memex && node --test tests/**/*.test.mjs
```
Expected: build clean, lint clean, all tests green (pre-existing 308 + new).

- [ ] **Step 3: Commit**

```bash
git add plugins/memex/README.md docs/superpowers/specs/2026-07-14-memex-prd.md
git commit -m "docs(memex): document LadybugDB graph backend and Cypher surface"
```

---

## Self-Review

**Spec coverage:** §3 tiers → T1/T6/T7; §4 Cypher capability + read-only guard → T1/T2/T3/T8; §5 schema → T2; §6 compile-at-write sync + soft-degrade → T3/T6; §7 persistence → T7; §8 vendoring (reuse machinery, chunk <95MB, PRD §16) → T4; §9 native optionalDependency → T7; §10 tests (equivalence oracle, Cypher E2E, degrade, native gated, regression) → T6/T8/T7/T9; §13 acceptance criteria all mapped. No gaps.

**Placeholder scan:** No TBD/TODO. The few "confirm against installed package / actual CLI" notes are verification instructions with a concrete default already coded, not missing content.

**Type consistency:** `CypherResult{columns,rows,truncated}`, `CypherCapable.cypher`, `LadybugConnection.query/close`, `GraphBackendSelection{tier,reason,port,cypher?,close}`, `openWasmTier`/`openNativeTier` return `{port,cypher,close}` — consistent across T1/T3/T5/T6/T7/T8. `assembleVendorGroup(vendorRoot,groupPath,cacheRoot)` consistent T4/T5. Builder names (`nodeInsertCypher`, `edgeRowsParam`, `isReadOnlyCypher`, `rowToNode/Edge`) consistent T2/T3.

## Execution notes for the orchestrator

- Dependency DAG: T1, T2, T4 have no inter-deps (parallelizable). T3 needs T1+T2. T5 needs T4. T6 needs T3+T5. T7 needs T3+T6 (shares graph-index.ts call site). T8 needs T6. T9 last.
- `graph-index.ts` is touched by T1/T3/T6/T7 → serialize those or merge in strict order to avoid conflicts; T2/T4/T5 (new files) are conflict-free and can run in worktrees concurrently.
- Every worktree agent MUST first `git reset --hard <current main HEAD>` and re-materialize node_modules, then verify `git merge-base HEAD <main HEAD>` equals the current HEAD before working (past worktree-base bug).
- Never run `npx gitnexus analyze` (advisory hook).
