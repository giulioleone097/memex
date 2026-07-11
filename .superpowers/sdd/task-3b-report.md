# Task 3B — Native code graph evidence

## Scope

- Added dependency-free OpenWiki graph contracts, scanner, private shard store, bounded queries, and seven graph operations.
- Private state only: `~/.openwiki/data/<workspace-id>/graph/`.
- No GitNexus runtime/package/configuration reference; no source bodies written to graph state.

## RED evidence

Before implementation, `node --test plugins/openwiki/tests/unit/graph.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs` failed with `ERR_MODULE_NOT_FOUND` for the unimplemented `dist/graph*.js` modules. The first build attempt also exposed absent local plugin dev dependencies; `npm --prefix plugins/openwiki install --ignore-scripts` installed only the existing declared dev dependencies.

## GREEN verification

Run from repository root:

```text
npm --prefix plugins/openwiki run build       PASS
npm --prefix plugins/openwiki run typecheck   PASS
npm --prefix plugins/openwiki run lint        PASS
node --test plugins/openwiki/tests/unit/graph.test.mjs plugins/openwiki/tests/integration/graph-repository.test.mjs
8 pass, 0 fail
git diff --check                              PASS
```

## Coverage proved

- Deterministic hashed identities, canonical schema ordering, unknown/corrupt schema rejection, and duplicate declaration identities.
- Comment/literal isolation, TypeScript and Python semantic extraction, imports/exports/calls/inheritance, ambiguity diagnostics, and no source-body fields in shards.
- Real Git repository enumeration of tracked plus non-ignored untracked files; generated/vendor/wiki exclusion; symlink and cap rejection.
- Atomic immutable shard/snapshot persistence, content-addressed incremental reuse, delete/rename handling, dirty-content fingerprints, corrupt manifest recovery, and rename porcelain parsing.
- Bounded query/context/impact/change/map results and explicit truncation.

## Known boundary

The scanner is intentionally lexical and dependency-free. Relationships that cannot be proven are emitted as unresolved/ambiguous diagnostics instead of asserted exact edges.
