# Task 7 — real Codex and Claude Code host validation

Date: 2026-07-11 (EEST)
Branch state validated: `feature/openwiki-dual-plugin` integration worktree
Scope: disposable homes and marketplace copies only; no normal user host configuration or credentials were read or mutated.

## Host versions and command surface

| Command | Exit | Evidence |
|---|---:|---|
| `codex --version` | 0 | `codex-cli 0.144.1` |
| `claude --version` | 0 | `2.1.207 (Claude Code)` |
| `codex plugin --help` | 0 | exposes `add`, `list`, `marketplace`, and `remove`; this version has no separate plugin validator |
| `claude plugin --help` | 0 | exposes `validate`, `marketplace`, `install`, `details`, `list`, and `uninstall` |
| `claude plugin validate --help` | 0 | confirms `--strict` validates either a plugin or marketplace manifest |

The live E2E preserves the normal `PATH` but gives every mutation a fresh `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`. Test-only fixture variables are removed from live environments. No environment dump, credential, token, or raw client stderr is included in lifecycle JSON errors.

## Real lifecycle proof

Command:

```text
OPENWIKI_RUN_CLIENT_SMOKE=1 node --test plugins/openwiki/tests/e2e/plugin-clients.e2e.test.mjs
```

Final result: exit 0; 5 tests, 5 pass, 0 fail, 0 skipped. The run executes:

- Codex marketplace list/add, plugin list/add, readiness list, plugin remove, and marketplace remove.
- Claude strict plugin validation, marketplace list/add, plugin list/install, readiness list, plugin details, plugin uninstall, and marketplace remove.
- Claude strict marketplace validation in the installed-copy test.
- A caller-timeout regression and the exact fixture argv lifecycle contract.

Historical measurements from prior exclusive runs were 1.81s for Codex lifecycle, 31.82s for Claude lifecycle including `details`, 5.59s for the two-host installed-copy proof, and 57.20s for Claude lifecycle. A later historical exclusive Claude `plugin install openwiki@openwiki-local --scope user` took 62.17s, exceeded the previous 60s mutation bound, and hit `CLIENT_TIMEOUT`; the other four live tests passed and no orphan process or capture remained. These observations are historical, not evidence from this task. Lifecycle commands retain 30s for read-only discovery and use a 90s bound only for host mutations/copies. The live caller outer bound is 120s: 90s mutation budget, 15s readiness budget, and cleanup margin; it introduces no retry, sleep, or unbounded widening.

## Installed-copy and source-removal proof

The live-gated test creates a marketplace checkout whose path contains spaces, copies no `.git` directory or `node_modules`, and installs both hosts into one disposable home. Real client list output supplies the installed version and, for Claude, the `installPath`. The asserted installed roots are:

```text
<isolated CODEX_HOME>/plugins/cache/openwiki-local/openwiki/0.1.0
<isolated CLAUDE_CONFIG_DIR>/plugins/cache/openwiki-local/openwiki/0.1.0
```

These are distinct from the disposable local-source path:

```text
<isolated root>/marketplace checkout with spaces/plugins/openwiki
```

After both clients report installation readiness, the test removes the entire marketplace checkout and verifies it no longer exists. It then clears the isolated npm cache, enables npm offline mode, and invokes each installed copy directly:

- `node <cache>/dist/mcp.js` receives a real `initialize`, `notifications/initialized`, and `tools/list` JSON-RPC handshake.
- `<cache>/bin/openwiki init --mode code --root <temporary Git repository with spaces>` succeeds for both hosts.
- The npm cache remains empty after both runtime journeys.
- A recursive scan of installed `bin/` and `dist/` rejects `npx`, `npm`, `tsc`, `GitNexus`, and `Ladybug` references.

Every readiness check requires regular, non-symlink files in the canonical host cache, with an executable POSIX launcher:

```text
bin/openwiki
dist/cli.js
dist/mcp.js
skills/openwiki/SKILL.md
.codex-plugin/plugin.json  (Codex)
.codex-plugin/mcp.json     (Codex)
.claude-plugin/plugin.json (Claude)
.claude-plugin/mcp.json    (Claude)
hooks/hooks.json           (Claude)
dist/hook.js               (Claude)
```

Malformed/traversing versions and roots and symlinked artifacts fail immediately. Incomplete atomic copies poll for at most 15s and return typed `INSTALL_NOT_READY`; tests use explicit pure-function clock/policy injection, never hidden globals, public flags, or environment hooks.

## Shared MCP and hook surface

Both installed MCP copies negotiated protocol `2025-06-18` and returned the same exact 13-tool order:

```text
init, status, context, search, read, write, ingest, finalize, check, doctor, schedule, purge, graph
```

The installed `graph` schema contains exactly seven closed `oneOf` action branches:

```text
build, status, query, context, impact, changes, map
```

The installed Claude `dist/hook.js` was invoked as a real `SessionStart` hook against the initialized repository. It returned `hookEventName: SessionStart`, bounded `additionalContext` to at most 300 UTF-8 bytes, and left every file in the isolated home and repository byte-size/mtime identical before and after invocation.

Observed installed modes on POSIX are executable for `bin/openwiki` (0755) and regular non-executable JavaScript/manifest files (0644). Canonical realpath containment is used so macOS `/var` versus `/private/var` aliases cannot produce a false outside-cache result.

## Regression and quality gates

From `plugins/openwiki`:

| Command | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build green |
| `npm run typecheck` | 0 | no type errors |
| `npm run lint` | 0 | no lint findings |
| `npm test` | 0 | 127 tests; 124 pass, 0 fail, 3 live-gated skips |
| live E2E command above | 0 | 5 pass, 0 fail, 0 skip |

Lifecycle integration coverage includes regular-file-backed 0600 stdout/stderr capture, a 1 MiB output cap, timeout precedence, typed cleanup/teardown failures, explicit POSIX process-group teardown on failure, orphan absence after nonzero/timeout/oversized output, command-specific timeout selection, default `~/.codex` and `~/.claude` resolution, delayed readiness, every required artifact, traversal, symlink, incomplete cache, idempotency, and marketplace collision behavior. The focused lifecycle suite reports 26/26 pass after the timeout/readiness additions.

After live runs, process scans found no residual real or fixture `plugin install` processes. Temporary capture scans were empty after removing one stale, unopened capture from an earlier externally interrupted focused run.

## Slice review record

- Clean review A: lifecycle implementation, timeout/teardown behavior, capture cleanup, canonical cache containment, required artifacts, isolated environments, hidden test-hook absence, and process/temp residue scans produced no findings.
- Clean review B: report-to-command evidence, tracked scope, file modes, secret-pattern scan, client-versus-fixture claims, offline-copy assertions, and final diff checks produced no findings.

## Client proof versus fixture proof

- Client proof: the gated tests invoke installed Codex CLI 0.144.1 and Claude Code 2.1.207, inspect their real JSON list schemas/caches, perform real lifecycle commands, and execute the copied installed runtime after source removal.
- Fixture proof: deterministic argv ordering, idempotency, collision, timeout, oversized-output, orphan, and failure-envelope regressions use repository fixture binaries. These fixtures are not counted as host install proof.

## Limitations

- External connector live access is intentionally out of scope; all runtime proof is local and network-independent.
- Validation is on this macOS POSIX host. Failure-path process-group teardown is covered here. Windows uses bounded `taskkill /t /f` plus typed fallback reporting; successful commands are not followed by `taskkill` because a dead leader is reported as failure on Windows. Readiness polling, rather than killing successful cache writers, protects successful asynchronous installation.
- Codex 0.144.1 has no standalone validator command; its real add/list/remove lifecycle and installed runtime are the validator-equivalent proof for this host version.
- Remote default-branch switching and final global reviews remain orchestrator-owned.
