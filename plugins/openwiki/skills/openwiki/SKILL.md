---
name: openwiki
description: Route OpenWiki requests to the correct code, personal, ingestion, query, update, or operations workflow. Use when a user asks to create, inspect, refresh, search, diagnose, schedule, or remove an OpenWiki and the correct specialized workflow is not yet selected.
---

# OpenWiki router

Select one workflow. Keep Codex and Claude Code on the same deterministic runtime and wiki state.

## Host paths

- Codex: derive the plugin root from this SKILL.md path by removing `/skills/openwiki/SKILL.md`; never derive it from the current working directory.
- Claude Code: use `${CLAUDE_PLUGIN_ROOT}` as the plugin root.
- Define `<cli>` as `node "<plugin-root>/dist/cli.js"` for Codex or `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` for Claude Code.

## Preconditions

- Require Node.js 20 or newer.
- Determine mode explicitly: `code` writes `<repository>/openwiki/`; `personal` writes `~/.openwiki/wiki/`.
- Resolve the requested root before any mutation. Do not infer personal mode from a missing Git repository.
- Confirm that external connector reads, when requested, use a host-authorized tool.

## Procedure

1. Run `<cli> status --mode <mode> --root <root> --json`; accept `NOT_INITIALIZED` only when initialization is the requested next action.
2. Route creation to `openwiki-init`, refresh to `openwiki-update`, grounded questions to `openwiki-query`, external-source reads to `openwiki-ingest`, and doctor, schedule, recovery, purge, privacy, or uninstall to `openwiki-ops`.
3. Load only the selected specialized skill and follow its operation order without substituting upstream OpenWiki commands.
4. Return the selected mode, root, workflow, mutation level, and expected proof before starting a mutating operation.

## Evidence

- Preserve the `status` JSON object and the specialized workflow's final `check`, search references, or doctor report.
- Distinguish source/runtime evidence from host-authenticated external connector evidence.
- Report exact page paths and safe machine error codes; never expose internal stacks or credentials.

## Error recovery

- On `MISSING_HOST_CAPABILITY`, stop connector work and identify the missing host tool without requesting a token.
- On `INVALID_STATE`, `PATH_OUTSIDE_ROOT`, or `SYMLINK_ESCAPE`, stop mutations and route to `openwiki-ops`.
- On `LOCKED`, report the active lock and retry only after the runtime says the stale-lock recovery condition is satisfied.

## Mutation boundary

This router is read-only. It may call `status` and choose a workflow. Only the selected specialized skill may mutate within its documented boundary.

## Completion proof

Complete routing only when mode, canonical root, selected skill, required host capability, mutation boundary, and proof target are explicit.
