# Task 3C — native segmented graph store v2

## Delivered

- Schema v2, immutable content-addressed generations, atomic current/previous manifests, recovery fallback, confined 0700/0600 filesystem layout, and exclusive cross-process writer locking.
- Lazy node, edge, inbound, outbound, symbol, path, and bounded architecture buckets. Public graph query/context/impact/changes/map consume the lazy port; compatibility snapshot loading is build-only.
- Metadata-first incremental builds reuse clean Git-index and unchanged dirty worktree shards. Status probes without creating directories or reading clean source bodies.
- Scanner shards strictly preserve qualified names, scopes, and relation sites. NUL/binary sources remain omitted from graph state.
- LadybugDB v0.18.1 portability NO-GO recorded in ADR 0001; benchmark figures are directional only.

## Focused evidence

`npm run build` and focused storage/graph tests passed after the final change:

```text
17 tests passed, 0 failed
tests/integration/graph-store-concurrency.test.mjs
tests/unit/graph-store-v2.test.mjs
tests/integration/graph-repository.test.mjs
tests/unit/graph-analysis.test.mjs
```

## Directional local benchmark

Deterministic synthetic run, deliberately resource-scaled to 10,000 nodes / 30,000 edges (one tenth of the requested 100k / 300k target). No generated store was retained.

| Measure | Before optimization | After optimization |
| --- | ---: |
| Write/index | 16,003.7 ms | 1,569.5 ms |
| Reopen index | 3.3 ms | 1.0 ms |
| Exact symbol | 1.615 ms | 10.5 ms |
| One-hop adjacency | 0.053 ms | 0.482 ms |
| Depth-3 traversal | 0.693 ms | 1.051 ms |
| Lazy reads | 7 files / 69,842 bytes | 5 files / 508,801 bytes |
| Store size | 13,327,311 bytes | 13,311,315 bytes |
| RSS | 145,981,440 bytes | 156,270,592 bytes |

The 10.2x write improvement comes from sixteen packed deterministic buckets, direct immutable `wx` generation files, one directory-sync pass before manifest publication, and linear hub calculation. The packed balance trades larger lazy bucket reads and slower exact lookup for the required write efficiency; results remain bounded and reopen avoids a full snapshot parse.

Evaluator baseline at 100k / 300k was monolithic reopen/full parse 1,092 ms, exact 21.4 ms, context 40.5 ms, 977 MB RSS, 96.8 MB store. The scales differ; this is directional evidence only, not a normalized comparison. The local run demonstrates bounded reopen/read behavior, not a claim of 100k-scale equivalence.

## Boundaries

- The full benchmark artifact is intentionally left to the orchestrator performance run; no benchmark-specific behavior is encoded.
- Global quality gate and integration review remain orchestrator-owned.
