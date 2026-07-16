# Changelog

All notable changes to the Memex dual-host plugin are recorded here.

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
