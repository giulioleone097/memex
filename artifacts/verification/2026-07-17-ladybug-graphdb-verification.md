# LadybugDB graph backend — verification report

Date: 2026-07-17 · Feature: additive read-only Cypher graph tier for Memex
Base: `b3ba58a` → HEAD `790c3fd` (+ this report)

## What shipped

A real in-process property-graph database (LadybugDB, the maintained Kùzu
successor) added as an **additive `CypherCapable` layer** behind a tier resolver,
without changing the tuned pure-TS `GraphIndexPort`:

- **Tiers** (`MEMEX_GRAPH_BACKEND=auto|native|wasm|pure`, default auto):
  native `@ladybugdb/core` prebuilt (opt-in) → vendored `@ladybugdb/wasm-core`
  (self-sufficient default) → pure (no Cypher, honest degrade). Resolver:
  `openGraphCypher` (`graph-index.ts`).
- **Cypher surface**: `graph --action cypher --query "…"` (CLI) and the
  `graph` MCP tool (`action: "cypher"`), served by `cypherGraph` (`graph.ts`),
  synced from the shard-backed graph via `openGraphIndex` (non-deprecated path).
- **Vendored** the ~13 MB nodejs wasm variant + its pure-JS runtime deps in the
  shared `vendor/MANIFEST.json` (per-file sha256), MIT license under
  `vendor/licenses/`. No chunking needed; no native dependency required.
- **Doctor** `graph-cypher` check reports the active tier.

## Security (read-only guard) — the load-bearing control

The guard on the public Cypher surface went through three adversarial review
cycles, each with an independent subagent testing against the real engine:

1. **Cycle 1 (CRITICAL, fixed):** the initial strip-based regex guard was
   defeated by comment/string confusion
   (`RETURN '/*' AS a ; CREATE(...) ; RETURN '*/' AS b`), enabling DB mutation,
   host file read→write (`LOAD FROM`/`COPY … TO`), and extension-load RCE.
   Replaced with a single-pass **context-aware lexer** (`scanCypher`) that lexes
   strings/backtick identifiers/comments as the engine does + denylist over bare
   tokens + multi-statement rejection.
2. **Cycle 2 (LOW, fixed):** `COMMENT ON TABLE … IS …` (Kùzu catalog DDL) plus
   `UNINSTALL`/`ANALYZE` slipped the denylist. Added a **fail-safe leading-clause
   allowlist** (`MATCH/OPTIONAL/RETURN/UNWIND/WITH/EXPLAIN/PROFILE`) so any
   unknown/side-effecting statement verb is rejected by default, and extended
   the denylist.
3. **Cycle 3 (CLEAN):** exhaustive re-attack — enumerated all 32 engine
   statement-start keywords (every side-effecting verb is blocked, no starter
   missed) and all 1215 engine functions (no filesystem/exec reachable without a
   forbidden token); verified string/comment/escape/`;` semantics match the
   lexer; live battery of 10 guard-allowed reads (0 side effects) + 16 mutations
   (all rejected). **No bypass found.**

Additional: query params are bound as real prepared-statement parameters (no
injection); results are read through a **cursor capped at the requested limit**
(engine executes lazily — a 60⁴-row cartesian product returns in ~160 ms and is
never fully computed), bounding memory and compute; `boundedEnvelope` trims rows
for byte safety.

## Tests & commands (all run)

- `tsc -p tsconfig.json` → exit 0 (build clean; dist committed).
- `eslint .` → exit 0 (lint clean).
- Full suite `node --test` → **352 tests, 349 pass, 0 fail, 3 skip** (final
  foreground run). New tests: resolver 6, cypher builders 16 (incl. guard
  bypasses), backend 6, vendor 4, wasm-conn 3, equivalence+bypass+DoS 8, native
  gated 2, E2E CLI cypher 5, MCP cypher 2, doctor tier assertion.
- Real-engine proof: the equivalence oracle (wasm Cypher mirrors the ground-
  truth graph), the proven cycle-1/2 bypass strings rejected against the real
  engine with the graph unmutated, the cursor DoS bound, and the native tier
  (real `@ladybugdb/core`) all executed live.

## Regression

Pure-TS `GraphIndexPort` and all existing consumers unchanged; the 308-test
baseline plus the new tests pass. The repository self-validator
(`DIST_NOT_COMMITTED` / stray-vendor-file / manifest-schema invariants) passes.

## Known flakiness (environment, not product)

Under full-suite parallel load on the iCloud-synced working copy, one test may
intermittently exceed a timing threshold (observed: `atomic-lock` concurrency,
pre-existing; and the MCP cypher test's 3 s harness stdout window during wasm
cold-start — the latter fixed by allowing the cold-start latency). Each such test
passes deterministically in isolation.

## Limitations / honest notes

- Native tier requires the opt-in `npm i @ladybugdb/core`; verified here with a
  local `--no-save` install (gated test skips cleanly when absent). Not declared
  as a dependency, preserving the plugin's dependency-free posture.
- On-disk Cypher-DB persistence is deferred: the DB is rebuilt in `:memory:`
  from the shards per call (always fresh; no staleness surface). The
  `databasePath` param exists to add persistence later without an interface
  change.
- `QueryResult` handles are reclaimed via per-call connection teardown (tier
  rebuilt per call), not an explicit result `close()` — identical to the prior
  behavior; no cross-call leak.
