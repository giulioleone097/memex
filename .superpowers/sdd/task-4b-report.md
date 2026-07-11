# Task 4B Adapter Report

## Delivered

- Dependency-free CLI with strict flag grammar, typed JSON envelopes, literal stdin/file transports, and safe exit statuses.
- Shared dispatch layer for CLI and newline-delimited JSON-RPC MCP stdio.
- MCP protocol support for `2025-11-25` and `2025-06-18`; thirteen closed tools; lifecycle gating; bounded native graph DTO projection.
- Read-only SessionStart hook with nearest-Git discovery, code-wiki precedence, personal fallback, and 300-character bounded context.
- Space-safe POSIX and Windows launchers.
- Separate Codex and Claude MCP configurations, each targeting the compiled local MCP server; SessionStart hook configuration.
- Graph public projection excludes internal snapshots, manifests, shards, and storage paths. Build exposes only the hardened public result. Changes exposes `changedPaths`, `changeState`, `head`, and `base`.

## Evidence

- Guard RED: adapter suites failed before implementation because `dist/cli.js`, `dist/mcp.js`, and `dist/hook.js` did not exist.
- Final verification from `plugins/openwiki`:
  - `npm run typecheck` passed.
  - `npm run lint` passed.
  - `npm run build` passed.
  - `npm test` passed: 109 tests passed, 0 failed, 2 live-client smoke tests skipped because `OPENWIKI_RUN_CLIENT_SMOKE` was not `1`.
  - `claude plugin validate --strict .` passed.
  - Codex installed CLI exposes no plugin validation subcommand; its manifest and MCP JSON parsed successfully.
- Runtime E2E passed: 7 tests passed, 0 failed. It covered real Git repositories, source ingestion, schedules, purge, graph build/query/context/impact/map/change-impact, process boundaries, path confinement, symlink protection, redaction, and no-GitNexus enforcement.

## Limits

- Real Codex and Claude client smoke tests were not authorized by `OPENWIKI_RUN_CLIENT_SMOKE=1`; fixture-process lifecycle coverage passed and the live smoke tests remain explicit skips.
