# Memex — LadybugDB Graph Backend

Status: Approved (2026-07-17), refined 2026-07-17 (evidence-driven — see below)
Supersedes/extends: `2026-07-14-memex-prd.md` (§11 soft-degrade, §16 vendor facts), `2026-07-14-memex-master-plan.md`

## 0. Design refinement (2026-07-17, evidence-driven)

Reading the real code showed `GraphIndexPort` is an 11-method, tuned interface
(`node`, `edge`, `rankedCandidates` with text scoring, `inbound`, `outbound`,
`changedPathSeeds`, `architectureSummary`, `allNodes`, `allEdges`, `metrics`,
`status`; `GraphAdjacency = {edges, total, truncated}`). Fully re-implementing
all of it in Cypher would be high-risk (behavioural divergence in ranking /
architecture summarisation) for no benefit — the pure-TS port is already
on-disk-bucketed, fast, and covered by 308 tests.

**Refinement:** LadybugDB is an **additive `CypherCapable` layer**, not a
replacement of the tuned port. The pure-TS `GraphIndexPort` stays the untouched
backbone for all existing consumers; LadybugDB adds the real Cypher power
surface (arbitrary declarative queries, the actual "massima potenza" ask),
synced from the same shards and exposed via CLI + MCP. The native/wasm/pure
"tiers" describe **Cypher availability**: native and wasm provide Cypher; pure
means no Cypher (port-only) and degrades honestly. This is the smallest strong
change that delivers the goal with zero regression risk. All other sections
below hold; where they say "GraphIndexPort backend / drop-in replacement", read
"additive CypherCapable layer selected by tier".

## 1. Goal

Give Memex a real in-process property-graph database with a Cypher query
surface ("maximum power") **without weakening the self-sufficiency posture** the
project mandates (zero external runtime, no compile step, works offline). The
existing pure-TS graph stays as a guaranteed fallback; LadybugDB becomes an
optional, higher-power backend behind the existing `GraphIndexPort` seam.

Founding principle, unchanged: **content-addressed shards are the source of
truth.** LadybugDB is a *derived, rebuildable* index — deleting it is always
safe. "Compile at write, answer at read" is extended to the backend.

## 2. Background & package facts (documentation-verified 2026-07-17)

LadybugDB (`@ladybugdb/*` v0.18.2, MIT, published 2026-07-15) is the current,
maintained successor to KuzuDB (`kuzu`/`kuzu-wasm` are now deprecated —
"Package no longer supported").

- **`@ladybugdb/wasm-core@0.18.2`** — MIT, `installScript:false` (no compile).
  Ships a dedicated Node.js entrypoint:
  `exports["./nodejs"].require = "./nodejs/index.js"`; built/tested on Node
  20.20.0. The full package (95.7 MB unpacked) bundles browser default +
  multithreaded + nodejs + sync variants; **only the `nodejs/` variant is needed
  and it is ~13 MB** (largest file `nodejs/lbug/lbug_wasm.wasm` = 12.9 MB).
  Node persistence via Emscripten NODEFS. Runtime deps: `threads`,
  `tiny-worker`, `uuid`. The Node worker thread stays alive until the module-
  level `close()` export is called — required for clean process exit.
  **Spike-verified 2026-07-17 (Node 25, darwin-arm64): 12/12 checks green** —
  require+init, in-memory DB, DDL, `getAllObjects`/`getColumnNames`,
  `prepare`+`execute` scalar params, `UNWIND $rows` list params, edge
  UNWIND+MATCH insert, and on-disk persistence (write→close→reopen→read).
  INT64 values return as boxed `Number` objects (`Number(v)` coerces correctly).
- **`@ladybugdb/core@0.18.2`** — MIT, JS wrapper (0.1 MB) + prebuilt native
  binaries via `optionalDependencies`: `@ladybugdb/core-{linux-x64, linux-arm64,
  darwin-x64, darwin-arm64, win32-x64}`. Platform packages are prebuilt
  (`install:false`, ~13–28 MB each); `cmake-js` is only a from-source fallback.
- Homepage `https://ladybugdb.com/`, repo `github.com/LadybugDB/ladybug`.

## 3. Architecture — three tiers behind `GraphIndexPort`

No consumer changes. `retrieve.ts` (graphSignal/graphProximity/relatedNodes) and
the analytics built on the returned graph speak only to `GraphIndexPort`
(`plugins/memex/src/graph-index.ts:50`): `node()`, `inbound()`, `outbound()`,
`allNodes()`, `allEdges()`.

A resolver `openGraphBackend(opts)` returns a `GraphIndexPort` (optionally also
`CypherCapable`). Auto-selection order:

```
1. native  → @ladybugdb/core prebuilt resolves for this platform   (turbo, opt-in npm)
2. wasm    → vendored Ladybug WASM assets load in Node             (Cypher in-box, self-sufficient)
3. pure    → existing pure-TS GraphIndexPort                        (guaranteed, 0 added bytes, fallback)
```

Explicit override: `MEMEX_GRAPH_BACKEND=auto|native|wasm|pure` (default `auto`).
`memex doctor` reports the active tier and the reason it was chosen (observable,
matching existing diagnostics).

Degradation is silent-safe *downward only*: a higher tier that fails to load
falls through to the next; it never blocks graph reads/writes.

## 4. Cypher capability

`GraphIndexPort` is unchanged (pure-TS cannot do Cypher). Add an **optional**
capability interface in `graph-index.ts`:

```ts
export interface CypherParam { /* string | number | boolean | null */ }
export interface CypherResult {
  columns: string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  truncated: boolean;
}
export interface CypherCapable {
  cypher(query: string, params?: Record<string, CypherParam>): Promise<CypherResult>;
}
```

Ladybug backends implement `GraphIndexPort & CypherCapable`. Consumers
feature-detect (`"cypher" in backend`).

Exposure:
- **MCP tool** `memex_graph_cypher` (parallel to `mcp__gitnexus__cypher`) — the
  agent queries the graph in Cypher.
- **CLI** `memex graph cypher "MATCH ..."`.

On the pure-TS tier the command/tool **degrades honestly**: returns a typed
"Cypher requires the LadybugDB backend — run `memex doctor`" error. **No
hand-rolled Cypher sub-parser** (that would be a fragile workaround). Existing
hand-coded traversals (query/context/impact/path) keep working on every tier;
Cypher is purely additive power on the Ladybug tiers.

Read-only guard: `cypher()` rejects statements that mutate the derived DB
(`CREATE/MERGE/SET/DELETE/DROP/COPY/ALTER` outside the internal sync path) so
agent/user Cypher cannot corrupt the index. Sync uses an internal privileged
path, not the public `cypher()`.

## 5. Ladybug schema (stable mapping)

Typed property graph:

- **`Node`** table: `id STRING PRIMARY KEY, kind STRING, path STRING, name STRING,
  scope STRING, symbolKind STRING, startLine INT64, endLine INT64, summary STRING`.
- **`Edge`** rel table `FROM Node TO Node`, properties `id STRING, kind STRING,
  confidence STRING`.

Cypher expresses everything the pure-TS algorithms do, plus arbitrary queries,
e.g. `MATCH (a:Node)-[e:Edge]->(b:Node) WHERE e.kind = 'calls' RETURN b.name`.
Per-edge confidence is preserved. Node/edge IDs are the existing content-
addressed IDs, so results are directly comparable to the pure-TS backend.

## 6. Data flow (compile-at-write + soft-degrade)

- **On write** (after shards are written): if the active tier is Ladybug, **sync
  from the just-written shards** (bulk load Node/Edge). If sync fails → emit a
  diagnostic and fall back to pure-TS for reads; **the write never blocks**
  (= soft-degrade-on-write, PRD §11).
- **On open/read**: Ladybug opens its persisted DB (fast) or **rebuilds from
  shards** if missing/stale. Staleness key = the shard manifest hash already
  produced by the store. Pure-TS path unchanged.
- The DB is fully derivable from shards; corruption/version mismatch ⇒ rebuild.

## 7. Persistence

- **Native**: on-disk DB directory `~/.memex/<workspaceId>/graph-db/`.
- **WASM (Node)**: mount Emscripten NODEFS to the same directory when the
  `nodejs` variant supports it; otherwise build **in-memory from shards on
  open** (correct, only a slower cold start). Exact NODEFS wiring is pinned
  during planning against the package's `nodejs` example.

## 8. Vendoring (WASM — self-sufficient)

- Vendor **only the `nodejs/` variant** directory tree of
  `@ladybugdb/wasm-core@0.18.2` under `plugins/memex/vendor/ladybug-wasm/nodejs/`
  (~13 MB total; largest file 12.9 MB). **No chunking is required** — every file
  is under the GitHub 50 MB warning threshold, so files are committed as-is.
- On first use, the loader **materializes the vendored dir into a cache under
  `~/.memex/cache/ladybug-wasm/<version>/` and verifies SHA-256 per file**
  (protects against iCloud dataless eviction of the in-repo copy and against
  corruption), then `require()`s `<cache>/nodejs/index.js`. The MANIFEST group
  reuses the existing `VendorManifestEntry` shape (`path` + `sha256` + `bytes`);
  the general part-assembly machinery in `embedder.ts` is extracted to a shared
  helper but the ladybug entries are unsplit.
- Record pinned version, file list, and SHAs in **PRD §16 (vendor facts)**, same
  governance as the embedding model. MIT attribution recorded.
- **Git LFS is deliberately NOT used** — it needs a network remote, which would
  break the self-sufficient clone and is inconsistent with the already-committed
  embedding assets.

## 9. Native tier (opt-in turbo)

- `@ladybugdb/core` declared as an **`optionalDependency`** of the memex package.
  If the prebuilt platform binary resolves → native tier auto-selected (fastest).
  If absent or platform unsupported → fall through to WASM. No compile step
  (prebuilt); a missing binary never breaks install.

## 10. Testing (real, non-mocked)

- **Equivalence oracle** (strongest proof): the same fixture graph, loaded into
  the WASM Ladybug backend and the pure-TS backend, MUST agree on `node`,
  `inbound`, `outbound`, `allNodes`, `allEdges`. Divergence fails the test.
- **Cypher E2E**: `memex graph cypher "MATCH (n:Node) RETURN count(n)"` on a real
  fixture repo returns correct rows via CLI and MCP.
- **Degrade**: `MEMEX_GRAPH_BACKEND=pure` ⇒ Cypher reports unavailable cleanly;
  corrupt/missing WASM assets ⇒ automatic fall-through to pure-TS, reads still
  succeed.
- **Native tier**: gated integration test that runs only when `@ladybugdb/core`
  resolves; otherwise **skips with a logged reason** (no silent skip).
- **Regression**: all existing tests (308 at HEAD `b3ba58a`) stay green because
  the pure-TS path and all consumers are unchanged.
- Build, lint, typecheck must pass.

## 11. Risks & limitations (stated honestly)

- **Repo weight**: +~13 MB vendored WASM (nodejs variant only; → ~155 MB
  vendored total with embeddings). The earlier ~96 MB estimate was the full
  multi-variant package; the spike showed only the ~13 MB nodejs variant is
  needed. Cache materialization mitigates iCloud dataless-eviction stalls.
- WASM single-thread default variant is slower than native — acceptable, native
  is the opt-in turbo.
- Ladybug is pre-1.0 (0.x): API churn risk. Pinned version + vendoring insulate
  the runtime; upgrades are deliberate, gated changes.
- Exact WASM Node persistence (NODEFS) confirmed capable but wired during
  planning; worst case is in-memory rebuild-from-shards on open (still correct).

## 12. Non-goals (YAGNI)

- No multithread WASM variant initially (start with the default single-thread
  `nodejs` variant).
- No rewrite of existing pure-TS algorithms into Cypher — additive only.
- No server/distributed mode — in-process only.
- No browser build usage — Node only for Memex.

## 13. Acceptance criteria

1. `openGraphBackend` resolves native → wasm → pure per `MEMEX_GRAPH_BACKEND`,
   defaulting to `auto`; `memex doctor` reports the active tier + reason.
2. WASM Ladybug backend implements `GraphIndexPort & CypherCapable` in Node 20,
   loaded from vendored chunked assets with SHA verification.
3. Cypher works via `memex graph cypher` (CLI) and `memex_graph_cypher` (MCP);
   pure-TS tier degrades with a typed, honest error.
4. Equivalence-oracle, Cypher-E2E, degrade, and native-gated tests pass; all
   pre-existing tests stay green; build + lint + typecheck pass.
5. Vendor facts (version, files, SHAs, MIT attribution) recorded in PRD §16.
6. Source of truth remains the shards; deleting the Ladybug DB and reopening
   rebuilds it and yields identical query results.
