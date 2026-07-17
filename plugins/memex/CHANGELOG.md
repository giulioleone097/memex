# Changelog

All notable changes to the Memex dual-host plugin are recorded here.

## Unreleased

- Added a read-only Cypher query surface over the code graph, served by an
  in-process LadybugDB property-graph database synced from the same shards.
  Available as the `cypher` graph action via the CLI (`graph --action cypher
  --query "<cypher>"`) and the MCP graph tool.
- Added a three-tier graph backend selected by `MEMEX_GRAPH_BACKEND`
  (`auto`|`native`|`wasm`|`pure`): the optional native `@ladybugdb/core` turbo
  tier, the vendored self-sufficient `@ladybugdb/wasm-core` tier (default), and
  the pure built-in graph as the guaranteed fallback. The pre-existing
  `query`/`context`/`impact`/`path`/`map` actions are unchanged.
- Vendored the ~13 MB LadybugDB wasm nodejs variant and its pure-JS runtime
  dependencies so Cypher works with no install step or network access.
- Added a `graph-cypher` doctor check reporting the active Cypher tier, and a
  typed `GRAPH_CYPHER_UNAVAILABLE` error with an actionable message on the pure
  tier. Mutation Cypher is rejected with `GRAPH_CYPHER_READONLY`.

## 0.2.0 - 2026-07-16

- Renamed the plugin from `openwiki` to `memex` across manifests, skills, CLI, MCP server identity, storage roots, and documentation.
- Moved the default storage root from `~/.openwiki/` to `~/.memex/`, covering both the code-mode private data root and the personal-mode wiki root.
- Added the `migrate` operation to move an existing `~/.openwiki/` root to `~/.memex/` atomically (with a verified copy-and-remove fallback across filesystems), leaving a `~/.openwiki/MIGRATED.md` tombstone and reporting a safe no-op on repeated runs.
- Added a `doctor` check that detects an un-migrated legacy `~/.openwiki` root and instructs running `migrate`.

## 0.1.0 - 2026-07-11

- Added native Codex and Claude Code plugin manifests and repository marketplaces.
- Added shared host-neutral routing, initialization, update, query, ingestion, and operations skills.
- Added the host-neutral `openwiki-graph` skill and documented the seven bounded native graph actions.
- Documented installation, update, uninstall, security, privacy, proof boundaries, and upstream provenance.
- Pinned upstream assessment to `langchain-ai/openwiki` commit `326a307203345128a60b92a356978c46e2992df3`.
- Preserved upstream MIT terms and added independent plugin licensing.
