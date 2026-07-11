---
name: openwiki-ops
description: Diagnose, schedule, recover, purge, uninstall, and explain privacy boundaries for OpenWiki. Use when a user reports unhealthy state, stale locks, schedule problems, path or symlink errors, secret leakage risk, or requests destructive cleanup or plugin removal.
---

# Operate OpenWiki safely

Prefer read-only diagnosis. Require explicit scope and confirmation for destructive operations.

## Host paths

- Codex: derive the plugin root from this SKILL.md path by removing `/skills/openwiki-ops/SKILL.md`; never derive it from the current working directory.
- Claude Code: use `${CLAUDE_PLUGIN_ROOT}` as the plugin root.
- Define `<cli>` as `node "<plugin-root>/dist/cli.js"` for Codex or `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` for Claude Code.

## Preconditions

- Resolve mode/root and requested operation before running tools.
- Start with `doctor` for recovery, path, state, retention, secret, or schedule concerns.
- Require explicit user confirmation immediately before `purge` or marketplace/plugin removal.
- Never infer destructive scope from conversation history.

## Procedure

1. Run `doctor --mode <mode> --root <root> --json` and classify each finding as healthy, warning, recoverable error, or blocker.
2. For recovery, apply only the action named by the doctor result, then rerun doctor before any other mutation.
3. For schedules, call `schedule` with one host-neutral intent and verify idempotent stored state; host automation creation remains a separate authorized action.
4. For purge, show exact scope (`raw-data`, `schedules`, or `personal-wiki`), paths, and consequences; obtain confirmation, call `purge` once, then verify targets without following symlinks.
5. For uninstall, follow `README.md`, remove the host plugin before optionally removing its marketplace, and state that user wiki/data deletion is separate.

## Evidence

- Preserve doctor checks, stable error codes, canonical paths, schedule id, purge scope, removed paths, and post-operation verification.
- Separate deterministic local proof from any unavailable host automation or external connector proof.

## Error recovery

- On `SYMLINK_ESCAPE` or `PATH_OUTSIDE_ROOT`, stop; never delete or rewrite the target.
- On `LOCKED`, use only doctor-provided stale-lock recovery and verify ownership/age first.
- On malformed state, preserve the file for diagnosis and restore only from a verified backup or explicit reinitialization.
- On partial purge failure, report every removed and retained path; never claim full deletion.

## Mutation boundary

Doctor is read-only. Schedule writes only host-neutral schedule state. Purge deletes only the explicitly confirmed confined scope and never follows symlinks. Uninstall removes plugin configuration/cache but not user wiki or private data unless separately requested.

## Completion proof

Operations complete only when the final doctor or targeted verification is healthy, every mutation matches confirmed scope, partial results are explicit, and no provider credential or unrelated path was touched.
