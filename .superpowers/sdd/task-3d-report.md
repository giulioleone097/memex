# Task 3D — graph semantic/API hardening

## Delivered semantic boundary

- Public `build` and `status` DTOs no longer expose `CodeGraphV1`, manifest paths, shard names, or storage paths. `build` exposes bounded incremental evidence through `buildMode`, `previousHead`, `head`, `changedPaths`, and `truncated`.
- Query/context/impact/changes/map apply the request byte limit to the complete public envelope. If mandatory metadata alone cannot fit, the operation fails with `SOURCE_TOO_LARGE` rather than returning an oversized result.
- Change analysis uses deterministic, depth-bounded inbound traversal; architecture maps include deterministic cycles, weighted module flows, hubs, and import-root entrypoints with per-collection truncation flags.
- Scanner output tracks qualified lexical scopes and relation sites. Calls on later lines and nested functions are assigned to their real enclosing scope. Language tiers that cannot prove relations report `LEXICAL_FILE_ONLY`.

## Storage handoff contract (owned by storage task)

This semantic task intentionally does not modify `graph-store.ts`. The store parser must preserve and validate these exact scanner payload fields across a shard write/read round trip:

```json
{
  "symbols": [{
    "name": "run",
    "qualifiedName": "Service.run",
    "scope": "Service",
    "kind": "method",
    "startLine": 2,
    "endLine": 2,
    "exported": false
  }],
  "relations": [{
    "kind": "calls",
    "fromQualifiedName": "Service.run",
    "target": "helper",
    "line": 3,
    "confidence": "resolved"
  }]
}
```

The executable store round-trip regression belongs to the storage owner, because the current store parser reconstructs only the legacy scanner fields. Semantic builds rescan files until that port contract is implemented, so a reused shard cannot silently erase scoped relations.

## Evidence

Focused RED cases covered scoped calls, DTO privacy, deterministic cycles/transitive dependents, language tiers, the response cap, entrypoints, and the exact semantic shard contract. The final focused graph suite and TypeScript build are green.
