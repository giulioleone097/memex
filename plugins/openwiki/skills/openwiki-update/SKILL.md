---
name: openwiki-update
description: Refresh an existing OpenWiki from deterministic Git, wiki, or authorized-source changes while preserving unaffected content. Use when a user asks to update stale documentation, reconcile changed code, run a no-op freshness check, or finalize new source evidence.
---

# Update OpenWiki

Detect changes first. Write only affected pages and record a run only after successful validation.

## Host paths

- Codex: derive the plugin root from this SKILL.md path by removing `/skills/openwiki-update/SKILL.md`; never derive it from the current working directory.
- Claude Code: use `${CLAUDE_PLUGIN_ROOT}` as the plugin root.
- Define `<cli>` as `node "<plugin-root>/dist/cli.js"` for Codex or `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` for Claude Code.

## Preconditions

- Require a healthy initialized wiki and explicit mode/root.
- Record current `status`, content hash, last finalized Git HEAD, and dirty working-tree state before writes.
- For external-source changes, require already-ingested, redacted evidence; never fetch a connector implicitly.

## Procedure

1. Run `status` using the same mode/root. In code mode, delegate graph freshness and changed-path mapping to `openwiki-graph`'s `changes` action; that skill owns graph status, authorized refresh, limits, and confidence reporting. In personal mode, skip graph work.
2. Run `context` using the same mode/root.
3. If context reports no changed evidence, run `check`, return a no-op result, and do not call `write` or `finalize`.
4. Map changed evidence to affected pages; read those pages before generating replacements.
5. Write only changed markdown pages through the confined `write` operation and preserve unrelated page content.
6. Run `check`; repair every failure before continuing.
7. Run `finalize` with a bounded summary and changed flag, then rerun `status` to confirm the new content hash and run id.

## Evidence

- Capture before/after content hashes, before/after Git HEAD evidence, changed source ids, updated page paths, `check` output, and the finalized run id.
- In code mode, preserve the delegated graph `changes` evidence, including freshness, confidence, diagnostics, unresolved edges, and truncation; personal mode has no graph evidence.
- For a no-op, preserve the unchanged hash and explicit `changed: false` proof.

## Error recovery

- Never finalize after a failed write or failed `check`.
- On concurrent change or `LOCKED`, discard stale synthesis, refresh context, and retry only through the runtime lock protocol.
- On malformed state, stop and use `openwiki-ops`; do not reconstruct state from guesses.

## Mutation boundary

Modify only affected markdown pages, OpenWiki-owned instruction blocks, and the selected wiki's state. Do not rewrite unrelated repository files, private raw data, or connector configuration.

## Completion proof

An update completes only when the no-op path proves no writes, or the changed path passes `check`, finalizes once, reports exact updated pages, and leaves `status` healthy.
