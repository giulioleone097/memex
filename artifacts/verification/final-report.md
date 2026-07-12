# OpenWiki dual-host plugin — final verification report

## Verification target

- Evidence date: 2026-07-12 (EEST, UTC+03:00)
- Implementation SHA: `21dbe7d7e1d88ad5cc0429262fc435f0becabbe9`
- Repository: `giulioleone097/openwiki-codex-claude-plugin`
- Visibility observed: `PRIVATE`
- Default branch observed: `main`
- Published refs observed before this report commit: `main` and `feature/openwiki-dual-plugin` both at the implementation SHA
- Runtime versions: Node.js `v25.9.0`, npm `11.12.1`, Codex CLI `0.144.1`, Claude Code `2.1.207`

This report supersedes intermediate task reports for final-state claims. Earlier counts remain historical evidence only.

## Delivered system

OpenWiki is packaged as separate canonical plugins for Codex and Claude Code while sharing one deterministic Node.js runtime. The shipped plugin includes CLI, MCP server, host manifests, installer and uninstaller, lifecycle hooks, source adapters, documentation, security and privacy contracts, and tests.

The code graph is OpenWiki-owned. It is a dependency-free, segmented, immutable-on-generation store under `~/.openwiki/data/<workspace-id>/graph`, with incremental rebuilds and bounded lazy reads. It exposes `build`, `status`, `query`, `context`, `impact`, `changes`, and `map`. LadybugDB and GitNexus are not runtime dependencies or fallbacks. The architectural decision is recorded in `documentation/adr/0001-native-segmented-graph-store.md`.

Codex uses the canonical root `.mcp.json`. Claude Code retains its separate `.claude-plugin` contract. The obsolete `.codex-plugin/mcp.json` was removed after the canonical Codex validator identified the mismatch.

## Final verification matrix

| Surface | Command or proof | Result |
| --- | --- | --- |
| Build | `npm run build` | PASS |
| Type safety | `npm run typecheck` | PASS |
| Lint | `npm run lint` | PASS |
| Repository contract | `node scripts/validate.mjs --root ../.. --json` | PASS, 0 errors, 0 warnings |
| Codex canonical plugin | `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .` | PASS |
| Claude plugin | `claude plugin validate --strict .` | PASS |
| Claude marketplace | `claude plugin validate --strict ../../.claude-plugin/marketplace.json` | PASS |
| Dependency audit | `npm audit --omit=dev --json` | PASS, 0 vulnerabilities at every severity |
| Deterministic regression suite | `npm test` | PASS: 134 tests, 19 suites, 131 pass, 0 fail, 3 live-gated skips |
| Real host lifecycle | `OPENWIKI_RUN_CLIENT_SMOKE=1 node --test tests/e2e/plugin-clients.e2e.test.mjs` | PASS: 5/5, 0 fail, 0 skip, 77.703 s total |
| Post-live cleanup | process and temp-artifact scan | PASS: 0 mutation processes, 0 OpenWiki temp/capture residue |
| Clean clone | exact implementation SHA, then `npm ci --ignore-scripts`, build, typecheck, lint, repository validator, Codex validator, tests | PASS: 134 tests, 131 pass, 0 fail, 3 live-gated skips |
| Publication | `gh repo view` plus fetched remote refs | PASS: private repository, default `main`, both published refs at implementation SHA |

No `design:lint`, standalone `test:e2e`, or `format:check` script exists in the package; the table records the repository's actual canonical commands rather than inventing unavailable gates.

## Regression coverage

Coverage includes:

- Codex and Claude install/list/details/uninstall lifecycle against real host CLIs;
- installed-copy execution and MCP handshake/tool discovery;
- canonical host manifests, marketplaces, hooks, artifact selection, permissions, and offline npm-cache installation;
- CLI and MCP contracts, malformed and oversized input, fatal UTF-8 decoding, output bounds, timeouts, signals, and cleanup;
- source ingest/query/update/removal for git repositories, Gmail, Hacker News, Notion, Slack, web search, and X;
- wiki init/update/query/audit/schedule/purge behavior and atomic state transitions;
- native graph full and incremental builds, persistence, corruption handling, query/context/impact/change/map operations, lazy segmented reads, response limits, and storage compatibility;
- secrets and unsafe-path rejection, symlink/path containment, subprocess `shell: false`, and zero production dependency vulnerabilities.

## Review record

- Exact-tip review `019f5559-86a9-7df2-aff1-c42cc812f1fd` found one P1 at SHA `6993175`: noncanonical Codex MCP path. The finding was reproduced with the canonical validator and fixed by task `019f555f-47b4-7c43-8ad5-d45c67edd0d9`; implementation landed as `21dbe7d`.
- Global review 1 `019f556c-dd0e-7c20-9505-47dc14a36e15` on `21dbe7d`: CLEAN.
- Global review 2 `019f5559-86a9-7df2-aff1-c42cc812f1fd` (second turn, Terra/high) on the authoritative central worktree at `21dbe7d`: CLEAN.
- First report-inclusive review was CLEAN. Its consecutive review found that the report did not explain why it cannot embed its own containing commit hash. This documentation finding was corrected before restarting the final review pair.

Because this report is itself a tracked deliverable, a final pair of consecutive reviews is run again after its last content change. A file cannot embed the SHA of the commit that contains that exact content without creating a self-reference. The final handoff therefore records and live-verifies the containing publication SHA against `origin/main` and `origin/feature/openwiki-dual-plugin`; the implementation SHA inside this report remains the immutable code-evidence target.

## Historical evidence, not final counts

- Task 4b checkpoint: 109 tests with 2 skips.
- Task 7 host-validation checkpoint: 127 tests, 124 pass, 3 skips; live lifecycle 5/5.
- Later hardening checkpoints changed totals as tests were added and consolidated.

Only the final verification matrix above represents the implementation SHA named by this report.

## Limitations and unverified external surfaces

- Authenticated live access to Gmail, Notion, Slack, web-search providers, and X was not exercised because external credentials/accounts were not placed in scope. Their schemas, envelopes, redaction, persistence, and error paths are covered locally.
- Windows was not available for a live host run. Windows launchers and path policy are covered by automated tests; macOS host lifecycles are the real-host evidence.
- Codex and Claude model reasoning quality is host-provided. OpenWiki verifies deterministic tool/runtime contracts and does not bundle or emulate a model.

These limitations do not introduce a hidden fallback or runtime dependency.
